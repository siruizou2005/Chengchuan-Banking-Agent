import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { billReport, resolveRange } from '../server/agent/analytics.mjs';
import { executeTool } from '../server/agent/tools.mjs';

const FACE = { provider: { channel: 'tencent_face', start() {}, result() {}, allowedOrigins: ['https://face.test'] }, returnUrl: 'https://bank.test/#face-return', encryptionKey: 'a'.repeat(64) };

test('账单时段拒绝离谱年份和过长区间，合法历史查询不变', async t => {
  const today = '2026-11-01';
  for (const bad of [{ period: '9999' }, { period: '9999-12' }, { from: '9999-12-31', to: '9999-12-31' }, { period: '1999' }, { from: '1999-12-31', to: '2000-01-02' }, { period: '2028' }, { period: '2028-01-01' }, { from: '2010-01-01', to: '2026-10-31' }, { preset: '__proto__' }, { preset: 'constructor' }, { period: ['2026-10'] }, { from: ['2026-10-01'], to: '2026-10-02' }])
    assert.throws(() => resolveRange(bad, today), e => e.status === 400, JSON.stringify(bad));
  for (const good of [{ period: '2000' }, { period: '2027' }, { period: '2026-10' }, { from: '2017-01-01', to: '2026-10-31' }, { preset: 'this_year' }, { preset: 'last_3_months' }]) assert.ok(resolveRange(good, today).from, JSON.stringify(good));
  // A period still in progress ends today, so the span is measured on what is actually read.
  assert.equal(resolveRange({ period: '2026' }, today).to, today);
  const f = await fixture(t);
  for (const path of ['/ledger/report?period=9999', '/ledger/report?from=9999-12-31&to=9999-12-31', '/ledger?period=9999', '/ledger/export?period=1999', '/ledger/report?from=2000-01-01&to=2026-10-31']) assert.equal((await f.call(path)).status, 400, path);
  assert.equal((await f.call('/ledger/report?period=2026')).status, 200);
  for (const [tool, args] of [['bill_report', { period: '9999' }], ['spending_stats', { by: 'day', period: '9999-12' }], ['get_ledger', { period: '9999' }], ['detect_anomalies', { period: '9999' }]])
    await assert.rejects(executeTool(f.services, f.user, tool, args), e => e.status === 400, tool);
});

test('账单趋势按跨度计数，未校验的区间也一定结束', () => {
  const range = extra => ({ label: 'x', period: 'x', ...extra });
  assert.equal(billReport([], range({ from: '9999-12-01', to: '9999-12-31', days: 31, granularity: 'day' })).trend.length, 31);
  assert.equal(billReport([], range({ from: '9999-01-01', to: '9999-12-31', days: 365, granularity: 'month' })).trend.length, 12);
  assert.deepEqual(billReport([], range({ from: '2026-11-01', to: '2027-02-10', days: 102, granularity: 'month' })).trend.map(p => p.key), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('登录失败不再因为登录自己的账号清零', async t => {
  const f = await fixture(t);
  const statuses = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 7; i++) statuses.push((await f.req('/auth/login', { phone: '13900139000', password: 'guess' + i })).status);
    await f.req('/auth/login', { phone: '13800138000', password: 'Bank123456' });
  }
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(401));
  assert.ok(statuses.slice(8).every(status => status === 429));
});

test('登录失败按手机号计数：换IP也挡得住，只影响这个手机号', async t => {
  const f = await fixture(t, { trustProxy: true });
  let ip = 0;
  const login = (phone, password) => f.req('/auth/login', { phone, password }, undefined, 'POST', { 'X-Forwarded-For': `10.0.0.${++ip}` });
  for (let i = 0; i < 8; i++) assert.equal((await login('13900139000', 'wrong')).status, 401);
  const blocked = await login('13900139000', 'Bank123456');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error.code, 'RATE_LIMITED');
  assert.equal((await login('13800138000', 'Bank123456')).status, 200);
});

test('成功登录只清本人的手机号计数', async t => {
  const f = await fixture(t, { trustProxy: true });
  let ip = 0;
  const login = (phone, password) => f.req('/auth/login', { phone, password }, undefined, 'POST', { 'X-Forwarded-For': `10.0.1.${++ip}` });
  for (let i = 0; i < 7; i++) assert.equal((await login('13900139000', 'wrong')).status, 401);
  // The attacker's own login must not help: one more failure still locks the target.
  assert.equal((await login('13800138000', 'Bank123456')).status, 200);
  assert.equal((await login('13900139000', 'wrong')).status, 401);
  assert.equal((await login('13900139000', 'wrong')).status, 429);
  // The owner's own success does reset that number.
  for (let i = 0; i < 7; i++) assert.equal((await login('13800138000', 'wrong')).status, 401);
  assert.equal((await login('13800138000', 'Bank123456')).status, 200);
  for (let i = 0; i < 8; i++) assert.equal((await login('13800138000', 'wrong')).status, 401);
});

test('登录失败按IP计数：成功登录不清零，也不影响其他IP', async t => {
  const f = await fixture(t, { trustProxy: true });
  const login = (phone, password, ip) => f.req('/auth/login', { phone, password }, undefined, 'POST', { 'X-Forwarded-For': ip });
  for (let i = 0; i < 7; i++) assert.equal((await login(`1370000000${i}`, 'wrong', '10.0.2.1')).status, 401);
  assert.equal((await login('13800138000', 'Bank123456', '10.0.2.1')).status, 200);
  assert.equal((await login('13700000008', 'wrong', '10.0.2.1')).status, 401);
  assert.equal((await login('13800138000', 'Bank123456', '10.0.2.1')).status, 429);
  assert.equal((await login('13800138000', 'Bank123456', '10.0.2.2')).status, 200);
});

test('限流表洪水挤不掉支付密码和登录计数', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.call('/agent/unlock', { pin: '000000' })).status, 403);
  for (let i = 0; i < 8; i++) assert.equal((await f.req('/auth/login', { phone: '13900139000', password: 'wrong' })).status, 401);
  const stillLocked = async () => {
    assert.equal((await f.call('/agent/unlock', { pin: '123456' })).status, 429);
    assert.equal((await f.req('/auth/login', { phone: '13900139000', password: 'Bank123456' })).status, 429);
  };
  await stillLocked();
  for (let i = 0; i < 10010; i++) f.services.badAttempt(`risk:flood:${i}`);
  for (let i = 0; i < 10010; i++) f.services.badAttempt(`email-code:10.1.${i >> 8}.${i & 255}`);
  await stillLocked();
});

test('限流表按键族分开：满了先淘汰过期的，账户级计数不被淘汰', async t => {
  const { createRateLimiter } = await import('../server/rate-limit.mjs');
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const limiter = createRateLimiter({ capacity: 3 });
  const lock = key => { for (let i = 0; i < 8; i++) limiter.badAttempt(key); };
  const locked = key => { try { limiter.checkRate(key); return false; } catch (error) { assert.equal(error.code, 'RATE_LIMITED'); return true; } };
  lock('throttle:expired'); lock('pin:U1'); lock('login-phone:U1'); lock('verify:U1');
  t.mock.timers.tick(600000);
  lock('throttle:live');
  t.mock.timers.tick(300001);
  // The first key is past its window by now, the second is not: filling the family drops only the expired one.
  limiter.badAttempt('throttle:a'); limiter.badAttempt('throttle:b');
  assert.equal(locked('throttle:live'), true);
  assert.equal(locked('throttle:expired'), false);
  // A family full of live keys gives up its oldest, and only its own.
  limiter.badAttempt('throttle:c');
  assert.equal(locked('throttle:live'), false);
  // Per-account families have one key per user, so more users than the capacity still all stay counted.
  t.mock.timers.tick(1);
  const before = ['pin:U1', 'login-phone:U1', 'verify:U1'].map(locked);
  assert.deepEqual(before, [false, false, false], 'these reached the end of their own window');
  for (let i = 0; i < 10; i++) lock(`pin:U${i}`);
  for (let i = 0; i < 10; i++) assert.equal(locked(`pin:U${i}`), true);
  limiter.clearRate('pin:U0');
  assert.equal(locked('pin:U0'), false);
});

test('风控路由只记失败，且按路由模式计数', async t => {
  const f = await fixture(t);
  const acct = f.services.accountFor(f.user).id;
  const draft = () => f.call('/v1/transfers/drafts', { sourceAccountRef: acct, beneficiaryRef: f.recipient, amountMinor: 100, currency: 'CNY' });
  for (let i = 0; i < 12; i++) assert.equal((await draft()).status, 201, `draft ${i}`);
  // Probing other ids shares one counter, so it cannot mint a fresh key per path, or per letter case.
  for (let i = 0; i < 8; i++) assert.equal((await f.call(`/v1/transfers/drafts/junk${i}/cancel`, {})).status, 403);
  assert.equal((await f.call('/v1/transfers/drafts/another/cancel', {})).status, 429);
  assert.equal((await f.call('/V1/TRANSFERS/DRAFTS/another/CANCEL', {})).status, 429);
  // Other routes and other users keep their own budget.
  assert.equal((await draft()).status, 201);
  assert.equal((await f.req('/v1/transfers/drafts/junk/cancel', {}, f.bob.token)).status, 403);
});

test('12000个中文字符的对话能通过，超限返回明确错误码', async t => {
  const f = await fixture(t);
  const messages = [{ role: 'user', content: '账'.repeat(6000) }, { role: 'assistant', content: '单'.repeat(5998) }, { role: 'user', content: '你好' }];
  assert.ok(Buffer.byteLength(JSON.stringify({ messages })) > 32 * 1024);
  for (const path of ['/agent/chat', '/chat']) assert.equal((await f.call(path, { messages })).status, 200, path);
  const oversized = await f.call('/agent/chat', { messages, padding: 'x'.repeat(70 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.data.error.code, 'BODY_TOO_LARGE');
  assert.match(oversized.data.error.message, /过大/);
  const other = await f.call('/support', { subject: '问题类型', content: '账'.repeat(12000) });
  assert.equal(other.status, 413);
  assert.equal(other.data.error.code, 'BODY_TOO_LARGE');
  assert.ok(!/entity/.test(other.data.error.message));
});

test('PUT 和其他写请求一样校验来源与JSON', async t => {
  const f = await fixture(t);
  const row = f.bank.get("SELECT l.id FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=? AND l.amount<0 AND l.title LIKE '消费%' LIMIT 1", f.user.id);
  const put = (headers, body) => fetch(`${f.url}/ledger/${row.id}/category`, { method: 'PUT', headers: { Authorization: `Bearer ${f.alice.token}`, ...headers }, body });
  const evil = await put({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, JSON.stringify({ category: '食品' }));
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error.code, 'ORIGIN_REJECTED');
  assert.equal((await put({ 'Content-Type': 'text/plain' }, 'x')).status, 415);
  assert.equal((await put({ 'Content-Type': 'application/json' }, JSON.stringify({ category: '食品' }))).status, 200);
  const spec = (await f.call('/openapi.json')).data;
  assert.ok(spec.paths['/api/ledger/{id}/category'].put.requestBody);
});

test('缴费类型只接受登记的取值', async t => {
  const f = await fixture(t);
  const before = f.bank.get('SELECT COUNT(*) n FROM transactions').n;
  for (const billType of ['constructor', '__proto__', 'toString', ['water'], {}, 1]) {
    const r = await f.req('/transactions', { type: 'payment', amount: '1.00', billType, billNumber: '123456' }, f.alice.token, 'POST', { 'Idempotency-Key': 'bill-type-' + JSON.stringify(billType) });
    assert.equal(r.status, 400, JSON.stringify(billType));
  }
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM transactions').n, before);
});

test('密码按原样保存，首尾空格不会让用户登录不上', async t => {
  const f = await fixture(t);
  const password = ' Abc12345 ';
  const code = (await f.req('/auth/email-code', { email: 'spacey@example.com' })).data;
  const registered = await f.req('/auth/register', { phone: '13712345678', name: '测试', password, pin: '123456', email: 'spacey@example.com', emailCodeId: code.id, emailCode: code.demoCode });
  assert.equal(registered.status, 201);
  assert.equal((await f.req('/auth/login', { phone: '13712345678', password })).status, 200);
  assert.equal((await f.req('/auth/login', { phone: '13712345678', password: password.trim() })).status, 401);
  const body = { oldPassword: 'Bank123456', newPassword: '  Xyz12345' };
  const intent = (await f.call('/verify/intent', { path: '/settings', body })).data;
  const token = await f.verify(intent.actionId);
  assert.equal((await f.call('/settings', { pin: '123456', ...body, verificationActionId: intent.actionId, verificationToken: token }, 'PATCH')).status, 200);
  assert.equal((await f.req('/auth/login', { phone: '13800138000', password: '  Xyz12345' })).status, 200);
  // Length counts what is stored, so spaces cannot pad a too-short password past the rule either way.
  const short = (await f.req('/auth/email-code', { email: 'short@example.com' })).data;
  assert.equal((await f.req('/auth/register', { phone: '13712345679', name: '测试', password: 'x'.repeat(70) + '1a  ', pin: '123456', email: 'short@example.com', emailCodeId: short.id, emailCode: short.demoCode })).status, 400);
});

test('类型错误或缺失的参数返回4xx，不是500', async t => {
  const f = await fixture(t);
  const object = { a: 1 }, array = ['x'], T = f.alice.token;
  const cases = [
    ['/verify/start', {}], ['/verify/start', { actionId: object }], ['/verify/start', { actionId: array }],
    ['/verify/face', {}], ['/verify/face', { id: object }], ['/verify/face', { id: array }],
    ['/verify/complete', {}], ['/verify/complete', { id: object }], ['/verify/face/start', {}], ['/verify/face/start', { id: array }],
    ['/verify/face/result', {}], ['/verify/face/result', { sessionId: object }],
    ['/verify/intent', { path: ['/transactions/TX1/confirm'], body: {} }], ['/verify/intent', { path: object }], ['/verify/intent', {}],
    ['/agent/actions', { tool: 'constructor', args: {} }], ['/agent/actions', { tool: '__proto__', args: {} }], ['/agent/actions', { tool: 'toString', args: {} }], ['/agent/actions', { tool: ['propose_set_daily_limit'], args: { amount: '100' } }],
    ['/agent/chat', { messages: [{ role: 'user', content: '你好' }], sessionId: object }], ['/agent/chat', { messages: [{ role: 'user', content: '你好' }], sessionId: array }],
    ['/agent/onboarding/answer', { field: 'channels', value: 'constructor', skip: false }],
    ['/v1/risk/appeals', {}], ['/v1/risk/appeals', { flagId: object, rationale: 'long enough' }], ['/v1/risk/appeals', { flagId: array, rationale: 'long enough' }],
    ['/ledger/bills/hidden', { period: ['2026-10'] }],
  ];
  for (const [path, body] of cases) {
    if (path === '/agent/onboarding/answer') await f.call('/agent/onboarding/reset', {});
    const r = await f.call(path, body);
    assert.ok(r.status >= 400 && r.status < 500, `${path} ${JSON.stringify(body)} => ${r.status}`);
  }
  const transaction = (extra, key) => f.req('/transactions', { amount: '1.00', ...extra }, T, 'POST', { 'Idempotency-Key': key });
  assert.equal((await transaction({ type: 'redeem' }, 'missing-holding')).status, 400);
  assert.equal((await transaction({ type: 'redeem', holdingId: object }, 'object-holding')).status, 400);
  assert.equal((await transaction({ type: 'loan_repay' }, 'missing-loan')).status, 400);
  assert.equal((await transaction({ type: 'loan_repay', loanId: array }, 'array-loan')).status, 400);
  assert.equal((await transaction({ type: 'payment', billType: 'water', billNumber: '123456', accountId: object }, 'object-account')).status, 404);
  assert.equal((await transaction({ type: 'payment', billType: 'water', billNumber: '123456', accountId: array }, 'array-account')).status, 404);
  for (const path of ['/ledger?preset=__proto__', '/ledger?preset=constructor', '/ledger/export?preset=constructor', '/ledger/report?preset=__proto__']) assert.equal((await f.call(path)).status, 400, path);
  for (const body of [{ pin: '123456', newPin: 654321 }, { pin: '123456', newPin: ['654321'] }]) assert.equal((await f.call('/settings', body, 'PATCH')).status, 400, JSON.stringify(body));
  const noProof = await f.call('/settings', { pin: '123456', newPin: '654321', verificationActionId: object, verificationToken: 'x' }, 'PATCH');
  assert.equal(noProof.status, 403);
  assert.equal(noProof.data.error.code, 'VERIFICATION_REQUIRED');
  const code = (await f.req('/auth/email-code', { email: 'digits@example.com' })).data;
  for (const pin of [123456, ['123456']]) assert.equal((await f.req('/auth/register', { phone: '13712345670', name: '测试', password: 'Abc12345', pin, email: 'digits@example.com', emailCodeId: code.id, emailCode: code.demoCode })).status, 400, JSON.stringify(pin));
});

test('请求体和路径解析失败是客户端错误，免登录也不记成服务异常', async t => {
  const f = await fixture(t);
  const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const post = (headers, body) => fetch(`${f.url}/auth/login`, { method: 'POST', headers, body });
  const expected = [
    [{ 'Content-Type': 'application/json; charset=foo' }, '{}', 415, 'UNSUPPORTED_ENCODING'],
    [{ 'Content-Type': 'application/json', 'Content-Encoding': 'foo' }, '{}', 415, 'UNSUPPORTED_ENCODING'],
    [{ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, 'notgzip', 400, 'INVALID_REQUEST'],
    [{ 'Content-Type': 'application/json' }, '{bad', 400, 'INVALID_JSON'],
  ];
  for (const [headers, body, status, code] of expected) {
    const r = await post(headers, body), data = await r.json();
    assert.equal(r.status, status, JSON.stringify(headers));
    assert.equal(data.error.code, code);
    assert.ok(/[一-鿿]/.test(data.error.message), data.error.message);
  }
  for (const headers of [{}, { Authorization: `Bearer ${f.alice.token}` }]) assert.equal((await fetch(`${f.url}/transactions/%E0%A4%A`, { headers })).status, 400);
  assert.deepEqual(errors, []);
});

async function demoApp(t, options = {}) {
  const app = createApp(':memory:', { accounts: 'demo', products: { remote: false }, channels: { secret: 'a'.repeat(64) }, ...options });
  const server = app.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await app.channels.stop(); await new Promise(r => server.close(r)); app.bank.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (path, body, token) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  return { ...app, post };
}

test('运行模式下夹具手机号是普通号码，真正的演示账户绝不走真实短信', async t => {
  const sent = [];
  const f = await demoApp(t, { sms: { provider: { channel: 'tencent_sms', async sendVerificationCode({ phone }) { sent.push(phone); } } } });
  for (const phone of ['13800138000', '13900139000', '13500135000']) {
    const email = `u${phone}@qq.com`;
    const code = (await f.post('/auth/email-code', { email })).data;
    const registered = await f.post('/auth/register', { phone, name: '普通用户', password: 'Abc12345', pin: '123456', email, emailCodeId: code.id, emailCode: code.demoCode });
    assert.equal(registered.status, 201, phone);
    assert.equal(f.bank.isDemoUser({ phone }), false, phone);
    const action = (await f.post('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } }, registered.data.token)).data;
    const started = await f.post('/verify/start', { actionId: action.id }, registered.data.token);
    assert.equal(started.data.simulated, false, phone);
    assert.equal(started.data.channel, 'tencent_sms', phone);
    assert.ok(sent.includes(phone), phone);
  }
  sent.length = 0;
  for (const { phone } of JSON.parse(readFileSync(new URL('../server/seed/demo-accounts.json', import.meta.url), 'utf8')).users) {
    assert.equal(f.bank.isDemoUser({ phone }), true, phone);
    // Even with an address that could receive mail, a demo account stays simulated.
    f.bank.run('UPDATE users SET email=? WHERE phone=?', `u${phone}@qq.com`, phone);
    const token = (await f.post('/auth/login', { phone, password: 'Bank123456' })).data.token;
    const action = (await f.post('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } }, token)).data;
    const started = await f.post('/verify/start', { actionId: action.id }, token);
    assert.equal(started.data.simulated, true, phone);
    assert.equal(started.data.reason, 'demo_account', phone);
  }
  assert.deepEqual(sent, []);
});

test('人脸模式跟随运行模式：夹具手机号只在夹具模式下模拟', async t => {
  const demo = await demoApp(t, { face: FACE });
  const mode = (app, phone) => app.services.verification.faceVerification.mode({ phone });
  for (const phone of ['18662995523', '15040147842']) assert.equal(mode(demo, phone), 'simulated_face', phone);
  for (const phone of ['13800138000', '13900139000', '13500135000']) assert.equal(mode(demo, phone), 'tencent_face', phone);
  const fixtures = await fixture(t, { face: FACE });
  for (const phone of ['13800138000', '13900139000', '13500135000', '18662995523', '15040147842']) assert.equal(mode(fixtures, phone), 'simulated_face', phone);
  assert.equal(mode(fixtures, '13700000001'), 'tencent_face');
});

test('公开演示账户：输错密码不会把其他访客锁在外面，登录和支付密码也不能被访客改掉', async t => {
  const app = createApp(':memory:', { accounts: 'demo', trustProxy: true, products: { remote: false } });
  const server = app.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await app.channels.stop(); await new Promise(r => server.close(r)); app.bank.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let ip = 0;
  const login = password => fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.2.${++ip}` }, body: JSON.stringify({ phone: '18662995523', password }) });
  for (let i = 0; i < 9; i++) assert.equal((await login('wrong')).status, 401);
  const session = await login('Bank123456');
  assert.equal(session.status, 200);
  const { token } = await session.json();
  const patch = body => fetch(base + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pin: '123456', ...body }) });
  for (const body of [{ newPin: '654321' }, { oldPassword: 'Bank123456', newPassword: 'Other123456' }]) {
    const response = await patch(body);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'DEMO_CREDENTIALS_FIXED');
  }
  assert.equal((await login('Bank123456')).status, 200);
});
