// Isolated demo only: never opens data/bank.sqlite or contacts a payment provider.
import { createApp } from '../server/app.mjs';
import { createRiskTransfers } from '../server/risk/transfers.mjs';
import { createMockPaymentAdapter } from '../server/risk/payment.mjs';
import { applyAgePolicy, DEFAULT_AGE_POLICY } from '../server/risk/age.mjs';

const app = createApp(':memory:', { products: { remote: false } });
try {
  const user = app.bank.get('SELECT * FROM users WHERE phone=?', '13800138000');
  const recipient = app.services.resolveRecipients(user, { name: '陈屿' })[0].recipient;
  const adapter = createMockPaymentAdapter(app.bank, { initialStatus: 'PENDING' });
  const flow = createRiskTransfers(app.bank, app.services, app.services.risk, { adapter });
  const d = flow.drafts.create(user, { sourceAccountRef: app.services.accountFor(user).id, beneficiaryRef: recipient, amountMinor: 10000, currency: 'CNY', memo: '模拟日常转账' });
  const i = flow.approvals.intent(user, d.id, { version: d.version, payloadHash: d.payloadHash });
  const approved = flow.approvals.approve(user, d.id, { challengeId: i.challengeId, version: d.version, payloadHash: d.payloadHash, pin: '123456' });
  const pending = flow.executor.submit(user, d.id);
  const payment = app.bank.get('SELECT provider_key FROM risk_payments WHERE draft_id=?', d.id);
  flow.executor.applyEvent(adapter.advance(payment.provider_key, 'SETTLED'));
  const settled = flow.drafts.view(user, d.id);
  console.log(JSON.stringify({ simulation: true, stages: [d.status, approved.status, pending.status, settled.status], amountMinor: d.amountMinor, recipient: d.beneficiaryMasked,
    agePolicy: [64, 65, 80].map(age => ({ age, ...applyAgePolicy('WARN', [
      { objective: true, group: 'beneficiary_change', evidenceRef: 'payee' },
      { objective: true, group: 'unusual_outflow', evidenceRef: 'amount' }
    ], { dob: `${2026 - age}-01-01`, verified: true, sourceRef: 'demo-kyc' }, '2026-10-27T12:00:00Z', { ...DEFAULT_AGE_POLICY, mode: 'enforce' }) })) }, null, 2));
} finally { await app.channels.stop(); app.bank.db.close(); }
