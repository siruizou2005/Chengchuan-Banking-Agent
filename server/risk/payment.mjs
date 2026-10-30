import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireThat } from '../errors.mjs';

// Sandbox-only adapter. No live-provider credential or endpoint is accepted.
export function createMockPaymentAdapter(bank, options = {}) {
  requireThat(!options.live && process.env.LIVE_PAYMENT_ENABLED !== 'true', '本版本不支持真实支付', 503, 'LIVE_PAYMENT_DISABLED');
  bank.run('INSERT OR IGNORE INTO risk_mock_secret VALUES(1,?)', randomBytes(32).toString('hex'));
  const secret = bank.get('SELECT secret FROM risk_mock_secret WHERE id=1').secret;
  const sign = payload => createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  function envelope(row) {
    const p = JSON.parse(row.payload);
    const payload = { ...p, providerReference: `mock:${row.payment_id}`, eventId: `mock:${row.payment_id}:${row.sequence}`,
      sequence: row.sequence, status: row.status, simulation: true };
    return { payload, signature: sign(payload) };
  }
  function submit(request) {
    const previous = bank.get('SELECT * FROM risk_mock_provider WHERE provider_key=?', request.providerKey);
    if (previous) { requireThat(previous.payload === JSON.stringify(request), '支付幂等键冲突', 409, 'PROVIDER_CONFLICT'); return envelope(previous); }
    const status = options.initialStatus || 'SETTLED';
    requireThat(['PENDING', 'SETTLED', 'FAILED'].includes(status), '模拟支付状态无效');
    bank.run('INSERT INTO risk_mock_provider VALUES(?,?,?,?,0)', request.providerKey, request.paymentId, JSON.stringify(request), status);
    if (options.timeoutAfterAccept) throw new Error('Simulated uncertain provider response');
    return envelope(bank.get('SELECT * FROM risk_mock_provider WHERE provider_key=?', request.providerKey));
  }
  function verify(event) {
    const p = event?.payload, signature = event?.signature;
    requireThat(p && typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature)
      && timingSafeEqual(Buffer.from(sign(p), 'hex'), Buffer.from(signature, 'hex')), '支付回调签名无效', 403, 'INVALID_PROVIDER_SIGNATURE');
    requireThat(p.simulation === true && ['PENDING', 'SETTLED', 'FAILED'].includes(p.status) && Number.isSafeInteger(p.sequence) && p.sequence >= 0, '支付回调无效', 400, 'INVALID_PROVIDER_EVENT');
    return p;
  }
  function query(key) { const row = bank.get('SELECT * FROM risk_mock_provider WHERE provider_key=?', key); return row ? envelope(row) : null; }
  // Trusted test/demo driver only; never registered as a public HTTP operation.
  function advance(key, status) {
    requireThat(['SETTLED', 'FAILED'].includes(status), '无效最终状态');
    const row = bank.get('SELECT * FROM risk_mock_provider WHERE provider_key=?', key);
    requireThat(row?.status === 'PENDING', '模拟渠道已结束', 409, 'PROVIDER_TERMINAL');
    bank.run('UPDATE risk_mock_provider SET status=?,sequence=sequence+1 WHERE provider_key=?', status, key);
    return query(key);
  }
  return { mode: 'mock', submit, verify, query, advance };
}
