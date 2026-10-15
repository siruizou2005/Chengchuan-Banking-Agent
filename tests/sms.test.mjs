import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { hash } from '../server/errors.mjs';
import { createSmsDelivery } from '../server/sms.mjs';

async function regularFixture(t, provider) {
  const f = await fixture(t, { sms: { provider } });
  const userId = f.bank.newUser('13700000001', '短信接口测试', 'Bank123456', '123456');
  const user = f.bank.get('SELECT * FROM users WHERE id=?', userId);
  const login = await f.req('/auth/login', { phone: user.phone, password: 'Bank123456' });
  const call = (path, body) => f.req(path, body, login.data.token);
  const action = (await call('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } })).data;
  assert.equal(action.level, 'red');
  return { ...f, user, call, action };
}

test('无适配器仍发模拟验证码，返回渠道并记录回退原因', async t => {
  const f = await regularFixture(t);
  const r = await f.call('/verify/start', { actionId: f.action.id });
  assert.equal(r.status, 200);
  assert.equal(r.data.simulated, true);
  assert.equal(r.data.channel, 'simulated_sms');
  assert.equal(r.data.expiresIn, 300);
  const body = f.bank.get("SELECT body FROM notifications WHERE user_id=? AND title='模拟短信验证码'", f.user.id).body;
  const code = body.match(/验证码 (\d{6})/)[1];
  const v = f.bank.get('SELECT * FROM verifications WHERE id=?', r.data.id);
  assert.equal(v.code_hash, hash(code));
  assert.equal(Date.parse(v.expires_at) - Date.parse(v.created_at), 300000);
  const audit = JSON.parse(f.bank.get("SELECT detail FROM audit WHERE action='verification.started' AND user_id=?", f.user.id).detail);
  assert.deepEqual(audit, { id: r.data.id, channel: 'simulated_sms', reason: 'provider_not_configured' });
  assert.ok(!JSON.stringify(r.data).includes(code));
});

test('注入外部适配器后所有内置演示账户仍强制模拟', async t => {
  let calls = 0;
  const f = await fixture(t, { sms: { provider: { channel: 'tencent_sms', async sendVerificationCode() { calls++; } } } });
  const delivery = createSmsDelivery(f.bank, { provider: { channel: 'tencent_sms', async sendVerificationCode() { calls++; } } });
  for (const user of f.bank.all('SELECT * FROM users')) {
    assert.equal(delivery.forUser(user).channel, 'simulated_sms');
    assert.equal(delivery.forUser(user).reason, 'demo_account');
  }
  const action = (await f.propose('propose_virtual_card', { limit: '100' })).data;
  const r = await f.call('/verify/start', { actionId: action.id });
  assert.equal(r.data.simulated, true);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(f.bank.get("SELECT detail FROM audit WHERE action='verification.started'").detail).reason, 'demo_account');
});

test('异步外部适配器接收注册手机号，真实渠道贯通验证码及红色操作授权', async t => {
  let message;
  const f = await regularFixture(t, { channel: 'tencent_sms', async sendVerificationCode(value) {
    await Promise.resolve();
    message = value;
  } });
  const r = await f.call('/verify/start', { actionId: f.action.id, phone: '13999999999' });
  assert.equal(r.status, 200);
  assert.equal(r.data.simulated, false);
  assert.equal(r.data.channel, 'tencent_sms');
  assert.equal(message.phone, f.user.phone);
  assert.match(message.code, /^\d{6}$/);
  assert.equal(message.expiresIn, 300);
  assert.equal(message.verificationId, r.data.id);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='模拟短信验证码'", f.user.id).n, 0);
  assert.equal(f.bank.get('SELECT code_hash FROM verifications WHERE id=?', r.data.id).code_hash, hash(message.code));
  assert.equal((await f.call('/verify/face', { id: r.data.id, skipped: true, reason: 'unavailable' })).status, 200);
  const proof = await f.call('/verify/complete', { id: r.data.id, code: message.code });
  assert.equal(proof.status, 200);
  const confirmed = await f.call(`/agent/actions/${f.action.id}/confirm`, { pin: '123456', verificationToken: proof.data.verificationToken });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.status, 'completed');
  const factors = JSON.parse(f.bank.get('SELECT factors FROM operation_authorizations WHERE action_id=?', f.action.id).factors);
  assert.ok(factors.includes('tencent_sms'));
  assert.ok(!factors.includes('simulated_sms'));
  assert.ok(!JSON.stringify(f.bank.all('SELECT * FROM audit WHERE user_id=?', f.user.id)).includes(message.code));
  assert.equal((await f.call('/verify/complete', { id: r.data.id, code: message.code })).status, 403);
});

test('发送失败不降级、不泄漏异常内容，新挑战不可用且旧挑战仍有效', async t => {
  let shouldFail = false;
  const f = await regularFixture(t, { channel: 'tencent_sms', async sendVerificationCode() {
    if (shouldFail) throw new Error('SecretKey=private-key code=123456');
  } });
  const first = await f.call('/verify/start', { actionId: f.action.id });
  f.bank.run("UPDATE verifications SET created_at='2000-01-01' WHERE id=?", first.data.id);
  shouldFail = true;
  const r = await f.call('/verify/start', { actionId: f.action.id });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.code, 'SMS_SEND_FAILED');
  assert.ok(!JSON.stringify(r.data).includes('private-key'));
  const failed = f.bank.get("SELECT * FROM verifications WHERE delivery_status='failed' AND user_id=?", f.user.id);
  assert.equal(failed.used, 1);
  assert.equal((await f.call('/verify/face', { id: failed.id, skipped: true, reason: 'unavailable' })).status, 403);
  assert.equal((await f.call('/verify/face', { id: first.data.id, skipped: true, reason: 'unavailable' })).status, 200);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='模拟短信验证码'", f.user.id).n, 0);
  const audits = JSON.stringify(f.bank.all('SELECT * FROM audit WHERE user_id=?', f.user.id));
  assert.ok(audits.includes('verification.send_failed'));
  assert.ok(!audits.includes('private-key'));
});

test('异步发送未完成时不能验证或重复发送；发送期间参数变化使挑战失效', async t => {
  const gate = Promise.withResolvers();
  const f = await regularFixture(t, { channel: 'tencent_sms', sendVerificationCode: () => gate.promise });
  const sending = f.services.verification.start(f.user, f.action.id);
  const rejected = assert.rejects(sending, error => error.code === 'AUTHORIZATION_MISMATCH');
  t.after(() => gate.resolve());
  const pending = f.bank.get("SELECT * FROM verifications WHERE user_id=?", f.user.id);
  assert.equal(pending.delivery_status, 'pending');
  // Bypass the existing one-second cooldown to exercise the in-flight guard.
  f.bank.run("UPDATE verifications SET created_at='2000-01-01' WHERE id=?", pending.id);
  assert.equal((await f.call('/verify/start', { actionId: f.action.id })).status, 429);
  assert.equal((await f.call('/verify/face', { id: pending.id, skipped: true, reason: 'unavailable' })).status, 403);
  assert.equal((await f.call('/verify/complete', { id: pending.id, code: '123456' })).status, 403);
  f.bank.run('UPDATE agent_actions SET revision=revision+1 WHERE id=?', f.action.id);
  gate.resolve();
  await rejected;
  assert.equal(f.bank.get('SELECT used FROM verifications WHERE id=?', pending.id).used, 1);
  assert.ok(f.bank.get("SELECT id FROM audit WHERE action='verification.invalidated' AND user_id=?", f.user.id));
});

test('适配器必须显式声明支持的渠道与发送方法', () => {
  assert.throws(() => createSmsDelivery({}, { provider: { channel: 'unknown', sendVerificationCode() {} } }), TypeError);
  assert.throws(() => createSmsDelivery({}, { provider: { channel: 'tencent_sms' } }), TypeError);
});
