import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { createResendProvider, isReservedEmail, maskEmail } from '../server/email.mjs';
import { createSmsDelivery } from '../server/sms.mjs';
import { hashPassword, verifyPassword } from '../server/db.mjs';
import { OWNER_PASSWORD_HASH } from '../server/demo-users.mjs';

function fakeEmail() {
  const sent = [];
  return { sent, provider: { channel: 'resend_email', async sendVerificationCode(message) { await Promise.resolve(); sent.push(message); } } };
}
// 邹瑞's real password exists only as a hash, so tests give the account a throwaway password first.
async function login(f, phone) {
  f.bank.run('UPDATE users SET password_hash=? WHERE phone=?', hashPassword('Bank123456'), phone);
  const token = (await f.req('/auth/login', { phone, password: 'Bank123456' })).data.token;
  return (path, body) => f.req(path, body, token);
}

test('Resend适配器：鉴权、幂等键、收件人与失败不泄漏内容', async () => {
  let request;
  const ok = createResendProvider({ apiKey: 're_test', from: '澄川银行 <otp@mail.example.org>', fetch: async (url, init) => { request = { url, init }; return { ok: true, status: 200 }; } });
  await ok.sendVerificationCode({ email: 'owner@example.com', code: '123456', expiresIn: 300, verificationId: 'V1', actionTitle: '调整每日限额' });
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.init.headers.Authorization, 'Bearer re_test');
  assert.equal(request.init.headers['Idempotency-Key'], 'V1');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.to, ['owner@example.com']); assert.equal(body.from, '澄川银行 <otp@mail.example.org>');
  assert.match(body.text, /验证码 123456/); assert.match(body.subject, /调整每日限额/);
  const bad = createResendProvider({ apiKey: 're_test', fetch: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(bad.sendVerificationCode({ email: 'a@b.cn', code: '654321', expiresIn: 300, verificationId: 'V2', actionTitle: 'x' }), error => !/654321|a@b\.cn/.test(error.message));
  assert.throws(() => createResendProvider({}), TypeError);
  assert.ok(isReservedEmail('wanjin@example.com') && isReservedEmail('x@demo.test') && !isReservedEmail('owner@example.com'));
  assert.equal(maskEmail('owner@example.com'), 's***@163.com');
});

test('邹瑞收真实邮件验证码并完成红色授权；example邮箱演示账户在页面显示验证码', async t => {
  const { sent, provider } = fakeEmail();
  const f = await fixture(t, { sms: { email: provider } });
  const zou = await login(f, '19900000000');
  const action = (await zou('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } })).data;
  assert.equal(action.level, 'red');
  const r = await zou('/verify/start', { actionId: action.id });
  assert.equal(r.status, 200);
  assert.equal(r.data.channel, 'resend_email'); assert.equal(r.data.simulated, false); assert.equal(r.data.target, 's***@163.com');
  assert.equal(r.data.demoCode, undefined);
  assert.equal(sent.length, 1); assert.equal(sent[0].email, 'owner@example.com'); assert.equal(sent[0].actionTitle, action.title);
  const zouId = f.bank.get("SELECT id FROM users WHERE phone='19900000000'").id;
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='模拟验证码'", zouId).n, 0);
  await zou('/verify/face', { id: r.data.id, skipped: true, reason: 'unavailable' });
  const done = await zou('/verify/complete', { id: r.data.id, code: sent[0].code });
  assert.ok(done.data.verificationToken);
  const confirmed = await zou(`/agent/actions/${action.id}/confirm`, { pin: '123456', verificationActionId: action.id, verificationToken: done.data.verificationToken });
  assert.equal(confirmed.status, 200);
  assert.equal(f.bank.get('SELECT daily_limit FROM users WHERE id=?', zouId).daily_limit, 6000000);
  // 林知夏 uses linzhixia@example.com: no email is sent and the page shows the code.
  const demo = (await f.propose('propose_virtual_card', { limit: '100' })).data;
  const d = await f.call('/verify/start', { actionId: demo.id });
  assert.equal(d.data.simulated, true); assert.equal(d.data.reason, 'demo_email'); assert.match(d.data.demoCode, /^\d{6}$/);
  assert.equal(sent.length, 1);
});

test('真实邮件60秒内不能重发、每个邮箱每天有上限（邹瑞不限次数），发送失败返回503', async t => {
  let fail = false;
  const sent = [];
  const f = await fixture(t, { sms: { email: { channel: 'resend_email', async sendVerificationCode(m) { if (fail) throw new Error('boom 123456'); sent.push(m); } } } });
  f.bank.newUser('13700000009', '限流测试', 'Bank123456', '123456', undefined, undefined, 'tester@163.com');
  const step = () => { f.bank.run('UPDATE otp_sends SET created_at=0'); f.bank.run("UPDATE verifications SET created_at='2000-01-01'"); };
  for (const [phone, unlimited] of [['13700000009', false], ['19900000000', true]]) {
    const call = await login(f, phone);
    const action = (await call('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } })).data;
    assert.equal((await call('/verify/start', { actionId: action.id })).status, 200);
    f.bank.run("UPDATE verifications SET created_at='2000-01-01'");
    const again = await call('/verify/start', { actionId: action.id });
    assert.equal(again.status, 429); assert.match(again.data.error.message, /秒后再试/);
    for (let i = 0; i < 9; i++) { step(); assert.equal((await call('/verify/start', { actionId: action.id })).status, 200); }
    step();
    const eleventh = await call('/verify/start', { actionId: action.id });
    if (unlimited) assert.equal(eleventh.status, 200);
    else { assert.equal(eleventh.status, 429); assert.match(eleventh.data.error.message, /今日验证码发送次数已达上限/); }
  }
  assert.equal(sent.filter(m => m.email === 'tester@163.com').length, 10);
  assert.equal(sent.filter(m => m.email === 'owner@example.com').length, 11);
  const call = await login(f, '13700000009');
  const action = (await call('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } })).data;
  f.bank.run('DELETE FROM otp_sends'); fail = true;
  const failed = await call('/verify/start', { actionId: action.id });
  assert.equal(failed.status, 503); assert.equal(failed.data.error.code, 'SMS_SEND_FAILED'); assert.ok(!JSON.stringify(failed.data).includes('123456'));
  // The overall daily cap protects the provider quota.
  const delivery = createSmsDelivery(f.bank, { email: { channel: 'resend_email', async sendVerificationCode() {} }, limits: { daily: 0 } });
  assert.throws(() => f.bank.atomic(() => delivery.forEmail('someone@163.com').reserve()), /今日验证码发送量已达上限/);
});

test('邹瑞不再使用公开的演示密码', async t => {
  const f = await fixture(t);
  const owner = f.bank.get("SELECT password_hash FROM users WHERE phone='19900000000'");
  assert.equal(owner.password_hash, OWNER_PASSWORD_HASH);
  assert.equal(verifyPassword('Bank123456', owner.password_hash), false);
  assert.equal((await f.req('/auth/login', { phone: '19900000000', password: 'Bank123456' })).status, 401);
  assert.equal((await f.req('/auth/login', { phone: '13500135000', password: 'Bank123456' })).status, 200);
});

test('注册必须验证邮箱：错码计数、失效、重复邮箱，真实邮箱发真实邮件', async t => {
  const { sent, provider } = fakeEmail();
  const f = await fixture(t, { sms: { email: provider } });
  const base = { phone: '13700137001', name: '注册测试', password: 'Test123456', pin: '654321' };
  assert.equal((await f.req('/auth/register', { ...base, email: 'new@example.com' })).status, 403);
  const demo = (await f.req('/auth/email-code', { email: 'New@Example.com ' })).data;
  assert.equal(demo.simulated, true); assert.match(demo.demoCode, /^\d{6}$/); assert.equal(demo.target, 'n***@example.com');
  const wrong = await f.req('/auth/register', { ...base, email: 'new@example.com', emailCodeId: demo.id, emailCode: demo.demoCode === '000000' ? '111111' : '000000' });
  assert.equal(wrong.data.error.code, 'INVALID_CODE');
  assert.equal(f.bank.get('SELECT attempts FROM email_codes WHERE id=?', demo.id).attempts, 1);
  const ok = await f.req('/auth/register', { ...base, email: 'new@example.com', emailCodeId: demo.id, emailCode: demo.demoCode });
  assert.equal(ok.status, 201); assert.equal(ok.data.user.email, 'n***@example.com');
  assert.equal(f.bank.get("SELECT email FROM users WHERE phone='13700137001'").email, 'new@example.com');
  assert.equal((await f.req('/auth/register', { ...base, phone: '13700137002', email: 'new@example.com', emailCodeId: demo.id, emailCode: demo.demoCode })).status, 403);
  assert.equal((await f.req('/auth/email-code', { email: 'new@example.com' })).data.error.code, 'EMAIL_EXISTS');
  assert.equal((await f.req('/auth/email-code', { email: 'not-an-email' })).status, 400);
  const real = (await f.req('/auth/email-code', { email: 'someone@163.com' })).data;
  assert.equal(real.simulated, false); assert.equal(real.demoCode, undefined);
  assert.equal(sent.at(-1).email, 'someone@163.com'); assert.equal(sent.at(-1).actionTitle, '注册澄川银行账户');
  // Five wrong codes retire the code (set directly: the per-IP register limit would stop a loop first).
  f.bank.run('UPDATE email_codes SET attempts=5 WHERE id=?', real.id);
  assert.equal((await f.req('/auth/register', { ...base, phone: '13700137003', email: 'someone@163.com', emailCodeId: real.id, emailCode: sent.at(-1).code })).data.error.code, 'VERIFICATION_EXPIRED');
});

test('演示账户自动登记邮箱：邹瑞为真实邮箱，其余为example.com', async t => {
  const f = await fixture(t);
  const emails = Object.fromEntries(f.bank.all('SELECT phone,email FROM users').map(u => [u.phone, u.email]));
  assert.equal(emails['19900000000'], 'owner@example.com');
  for (const phone of ['13800138000', '13900139000', '13500135000', '13300133000']) assert.match(emails[phone], /@example\.com$/);
  assert.equal((await f.call('/me')).data.email, 'l***@example.com');
});
