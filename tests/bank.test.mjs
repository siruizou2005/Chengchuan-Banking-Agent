import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, cents } from '../server/app.mjs';
import { createBank } from '../server/db.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const { app, bank } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); bank.db.close(); });
  async function request(path, body, token, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(url + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const type = response.headers.get('content-type');
    const data = type?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  const login = async (phone = '13800138000') => (await request('/auth/login', { phone, password: 'Bank123456' })).data;
  const alice = await login(), bob = await login('13900139000');
  const req = (path, body, method, headers) => request(path, body, alice.token, method, headers);
  const state = async () => (await req('/dashboard')).data;
  const create = (body, key = randomUUID()) => req('/transactions', body, 'POST', { 'Idempotency-Key': key });
  async function strong(path, body) {
    const intent = (await req('/verify/intent', { path, body })).data;
    if (!intent.required) return body;
    const v = (await req('/verify/start', { actionId: intent.actionId })).data;
    const code = bank.get("SELECT body FROM notifications WHERE user_id=? AND title='模拟手机验证码' ORDER BY rowid DESC LIMIT 1", alice.user.id).body.match(/验证码 (\d{6})/)[1];
    await req('/verify/face', { id: v.id, skipped: true, reason: 'unavailable' });
    const result = (await req('/verify/complete', { id: v.id, code })).data;
    return { ...body, verificationActionId: intent.actionId, verificationToken: result.verificationToken };
  }
  const confirm = async (tx, pin = '123456') => req(`/transactions/${tx.id}/confirm`, await strong(`/transactions/${tx.id}/confirm`, { pin }));
  const transfer = (amount = '100.01', extras = {}) => create({ type: 'transfer', amount, recipientName: '陈屿', recipientAccount: '6218808888000088096', bank: '澄川银行', ...extras });
  function balanced() {
    assert.equal(bank.get('SELECT SUM(amount) AS value FROM ledger').value, 0);
    assert.equal(bank.get('SELECT SUM(balance) AS value FROM accounts').value, 0);
    assert.deepEqual(bank.all('SELECT transaction_id FROM ledger GROUP BY transaction_id HAVING SUM(amount)<>0'), []);
    assert.deepEqual(bank.all('SELECT id FROM accounts WHERE user_id IS NOT NULL AND (balance<held OR held<0 OR balance<0)'), []);
  }
  return { strong, bank, request, login, alice, bob, req, state, create, confirm, transfer, balanced };
}

test('金额使用整数分，拒绝浮点边界、负数和非法格式', () => {
  assert.equal(cents('0.29'), 29); assert.equal(cents('123.45'), 12345);
  for (const value of ['0', '-1', '0.001', '1e3', 'NaN', 'Infinity', '', ' 1', '10000001']) assert.throws(() => cents(value));
});

test('登录使用隔离会话，密码和原始token不落库', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/dashboard')).status, 401);
  assert.equal((await f.request('/auth/login', { phone: '13800138000', password: 'wrong' })).status, 401);
  const login = await f.request('/auth/login', { phone: '13800138000', password: 'Bank123456' });
  assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(f.bank.get('SELECT token FROM sessions WHERE token=?', login.data.token), undefined);
  const snapshot = await f.state(); assert.equal(snapshot.user.password_hash, undefined); assert.equal(snapshot.user.pin_hash, undefined);
  assert.notEqual(f.bank.get('SELECT password_hash FROM users WHERE id=?', f.alice.user.id).password_hash, 'Bank123456');
  assert.equal((await f.request('/auth/logout', {}, f.alice.token)).status, 200);
  assert.equal((await f.req('/dashboard')).status, 401);
});

test('行内转账先预留、后双边入账，重复及并发确认只扣一次', async t => {
  const f = await fixture(t), before = await f.state(), bobBefore = (await f.request('/accounts', undefined, f.bob.token)).data[0];
  const { data: tx, status } = await f.transfer('100.01'); assert.equal(status, 201); assert.equal(tx.status, 'pending');
  const reserved = (await f.state()).accounts[0]; assert.equal(reserved.balance, before.accounts[0].balance); assert.equal(reserved.held, 10001);
  assert.equal((await f.confirm(tx, '000000')).status, 403); assert.equal((await f.req(`/transactions/${tx.id}`)).data.status, 'pending');
  const results = await Promise.all([f.confirm(tx), f.confirm(tx), f.confirm(tx)]); results.forEach(r => assert.equal(r.data.status, 'completed'));
  const after = (await f.state()).accounts[0], bobAfter = (await f.request('/accounts', undefined, f.bob.token)).data[0];
  assert.equal(after.balance, before.accounts[0].balance - 10001); assert.equal(after.held, 0); assert.equal(bobAfter.balance, bobBefore.balance + 10001);
  assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM ledger WHERE transaction_id=?', tx.id).n, 2); f.balanced();
});

test('创建接口幂等，重复键冲突不创建额外交易', async t => {
  const f = await fixture(t), key = randomUUID(), body = { type: 'payment', amount: '20.00', billType: 'water', billNumber: '10010001' };
  const a = await f.create(body, key), b = await f.create(body, key); assert.equal(a.data.id, b.data.id);
  assert.equal((await f.create({ ...body, amount: '21.00' }, key)).status, 409);
  assert.equal((await f.state()).accounts[0].held, 2000);
  assert.equal((await f.req(`/transactions/${a.data.id}/cancel`, {})).data.status, 'cancelled');
  assert.equal((await f.state()).accounts[0].held, 0);
  assert.equal((await f.confirm(a.data)).status, 409); f.balanced();
});

test('跨用户交易、账户、持仓与操作记录隔离', async t => {
  const f = await fixture(t), tx = (await f.transfer()).data, snapshot = await f.state();
  assert.equal((await f.request(`/transactions/${tx.id}`, undefined, f.bob.token)).status, 404);
  assert.equal((await f.request(`/transactions/${tx.id}/confirm`, { pin: '123456' }, f.bob.token)).status, 404);
  assert.equal((await f.request(`/accounts/${snapshot.accounts[0].id}`, { status: 'frozen', pin: '123456' }, f.bob.token, 'PATCH')).status, 404);
  const redeem = { type: 'redeem', amount: '1', holdingId: snapshot.holdings[0].id };
  assert.equal((await f.request('/transactions', redeem, f.bob.token, 'POST', { 'Idempotency-Key': randomUUID() })).status, 409);
  const audit = (await f.request('/audit', undefined, f.bob.token)).data; assert.ok(audit.every(x => x.user_id === f.bob.user.id));
});

test('并发预留不允许余额透支', async t => {
  const f = await fixture(t), before = await f.state();
  const amount = ((before.accounts[0].available - 100) / 100).toFixed(2);
  const results = await Promise.all([f.create({ type: 'payment', amount, billType: 'water', billNumber: '10010001' }), f.create({ type: 'payment', amount, billType: 'water', billNumber: '10010002' })]);
  assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
  assert.equal((await f.state()).accounts[0].available, 100); f.balanced();
});

test('交易失败和超时均释放资金且不生成扣款流水', async t => {
  const f = await fixture(t), before = (await f.state()).accounts[0].balance;
  const tx = (await f.transfer('88.88', { scenario: 'bank_rejected' })).data;
  assert.equal((await f.confirm(tx)).data.status, 'failed');
  assert.equal((await f.state()).accounts[0].available, before);
  assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM ledger WHERE transaction_id=?', tx.id).n, 0);
  const expires = (await f.transfer('50')).data;
  f.bank.run('UPDATE transactions SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', expires.id);
  assert.equal((await f.req(`/transactions/${expires.id}`)).data.status, 'expired');
  assert.equal((await f.state()).accounts[0].available, before); f.balanced();
});

test('冻结后复验待确认交易，姓名和限额均由后端验证', async t => {
  const f = await fixture(t), a = (await f.state()).accounts[0];
  assert.equal((await f.transfer('10', { recipientName: '错误姓名' })).status, 400);
  assert.equal((await f.transfer('50001')).data.error.code, 'DAILY_LIMIT');
  const tx = (await f.transfer()).data;
  assert.equal((await f.req(`/accounts/${a.id}`, { pin: '123456', status: 'frozen' }, 'PATCH')).status, 200);
  assert.equal((await f.confirm(tx)).data.status, 'failed'); assert.equal((await f.state()).accounts[0].held, 0);
  assert.equal((await f.transfer()).data.error.code, 'ACCOUNT_FROZEN'); f.balanced();
});

test('定期存款购买与部分支取保持本金及余额一致', async t => {
  const f = await fixture(t), before = (await f.state()).accounts[0].balance;
  const tx = (await f.create({ type: 'deposit', productId: 'deposit-90', amount: '1000' })).data;
  assert.equal((await f.confirm(tx)).data.status, 'completed');
  const h = (await f.state()).holdings.find(h => h.product_id === 'deposit-90'); assert.equal(h.principal, 100000);
  const redemption = (await f.create({ type: 'redeem', holdingId: h.id, amount: '250' })).data;
  assert.equal((await f.confirm(redemption)).data.status, 'completed');
  assert.equal((await f.state()).holdings.find(x => x.id === h.id).principal, 75000);
  assert.equal((await f.state()).accounts[0].balance, before - 75000); f.balanced();
});

test('风险测评按五题总分给出R1至R5', async t => {
  const f = await fixture(t);
  for (const [answers, level] of [[[1, 1, 1, 1, 1], 1], [[2, 2, 2, 1, 1], 2], [[3, 3, 3, 2, 2], 3], [[4, 3, 3, 3, 3], 4], [[4, 4, 4, 4, 4], 5]]) assert.equal((await f.req('/risk-assessment', { answers })).data.level, level);
  assert.equal((await f.req('/risk-assessment', { answers: [3, 3, 3] })).status, 400);
  assert.equal((await f.req('/risk-assessment', { answers: [5, 1, 1, 1, 1] })).status, 400);
});

test('基金申购执行风险匹配、起购额、申购状态与单日上限，旧持有期产品仍受到期限制', async t => {
  const f = await fixture(t);
  const products = (await f.req('/products')).data;
  const fund = test => products.find(p => p.type === 'wealth' && test(p));
  const low = fund(p => p.riskLevel === 1 && p.purchasable && !p.purchaseLimit && p.minimum >= 100);
  const high = fund(p => p.riskLevel === 4 && p.purchasable && !p.purchaseLimit);
  const suspended = fund(p => !p.purchasable), limited = fund(p => p.purchasable && p.purchaseLimit && p.purchaseLimit <= 2000000);
  assert.ok(low && high && suspended && limited);
  assert.equal(products.find(p => p.id === 'wealth-flex'), undefined);
  const buy = (p, amount) => f.create({ type: 'investment', productId: p.id, amount });
  assert.equal((await buy(low, '100')).data.error.code, 'RISK_ASSESSMENT_REQUIRED');
  assert.equal((await f.req('/risk-assessment', { answers: [1, 1, 1, 1, 1] })).data.level, 1);
  assert.equal((await buy(high, '100')).data.error.code, 'RISK_MISMATCH');
  assert.equal((await buy(low, ((low.minimum - 1) / 100).toFixed(2))).status, 400);
  await f.req('/risk-assessment', { answers: [4, 4, 4, 4, 4] });
  assert.equal((await buy(suspended, '1000')).data.error.code, 'PRODUCT_UNAVAILABLE');
  assert.equal((await buy(limited, ((limited.purchaseLimit + 100) / 100).toFixed(2))).data.error.code, 'PURCHASE_LIMIT');
  const tx = (await buy(high, '1000')).data;
  assert.equal((await f.confirm(tx)).data.status, 'completed');
  const h = (await f.state()).holdings.find(x => x.product_id === high.id);
  assert.equal(h.product.name, high.name);
  assert.equal((await f.confirm((await f.create({ type: 'redeem', holdingId: h.id, amount: '400' })).data)).data.status, 'completed');
  f.bank.run("INSERT INTO holdings(id,user_id,product_id,principal,created_at,unlock_at) VALUES('HLEGACY',?,'wealth-180',100000,?,?)", f.alice.user.id, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
  assert.equal((await f.state()).holdings.find(x => x.id === 'HLEGACY').product.name, '澄享稳进180天');
  assert.equal((await f.create({ type: 'redeem', holdingId: 'HLEGACY', amount: '1000' })).data.error.code, 'HOLDING_LOCKED');
  f.bank.run("UPDATE holdings SET unlock_at='2000-01-01T00:00:00.000Z' WHERE id='HLEGACY'");
  assert.equal((await f.confirm((await f.create({ type: 'redeem', holdingId: 'HLEGACY', amount: '1000' })).data)).data.status, 'completed'); f.balanced();
});

test('贷款确认时复验额度，支持部分还款与结清', async t => {
  const f = await fixture(t);
  const first = (await f.create({ type: 'loan_draw', amount: '150000', months: 12 })).data;
  const second = (await f.create({ type: 'loan_draw', amount: '150000', months: 12 })).data;
  assert.equal((await f.confirm(first)).data.status, 'completed'); assert.equal((await f.confirm(second)).data.status, 'failed');
  const loan = (await f.state()).loans[0];
  for (const amount of ['50000', '100000']) assert.equal((await f.confirm((await f.create({ type: 'loan_repay', loanId: loan.id, amount })).data)).data.status, 'completed');
  assert.equal((await f.state()).loans[0].outstanding, 0); assert.equal((await f.state()).loans[0].status, 'paid'); f.balanced();
});

test('信用卡还款恢复额度，重复待还不造成负债越界', async t => {
  const f = await fixture(t);
  const a = (await f.create({ type: 'credit_repay', amount: '2386.50' })).data, b = (await f.create({ type: 'credit_repay', amount: '2386.50' })).data;
  assert.equal((await f.confirm(a)).data.status, 'completed'); assert.equal((await f.confirm(b)).data.status, 'failed');
  assert.equal((await f.state()).creditCard.used, 0); assert.equal((await f.state()).accounts[0].held, 0);
  assert.equal((await f.confirm((await f.create({ type: 'credit_spend', amount: '90', merchant: '模拟商店' })).data)).data.status, 'completed');
  assert.equal((await f.state()).creditCard.used, 9000);
  await f.req('/credit-card', { pin: '123456', status: 'frozen' }, 'PATCH');
  assert.equal((await f.create({ type: 'credit_spend', amount: '10', merchant: '模拟商店' })).status, 409); f.balanced();
});

test('生活缴费入账，手机号和户号格式验证', async t => {
  const f = await fixture(t);
  assert.equal((await f.create({ type: 'payment', amount: '50', billType: 'mobile', billNumber: '123456' })).status, 400);
  const tx = (await f.create({ type: 'payment', amount: '50', billType: 'mobile', billNumber: '13800138000' })).data;
  assert.equal((await f.confirm(tx)).data.status, 'completed');
  assert.equal((await f.req('/ledger?q=手机')).status, 200);
  assert.match((await f.req('/ledger/export')).data, /生活缴费/); f.balanced();
});

test('流水按北京时间时段、分类筛选，导出遵守同一筛选', async t => {
  const f = await fixture(t), token = (await f.login('13300133000')).token, get = path => f.request(path, undefined, token);
  const may = (await get('/ledger?from=2026-05-01&to=2026-05-01')).data;
  assert.ok(may.some(r => r.created_at === '2026-04-30T16:29:25.000Z' && r.bj_time === '2026-05-01 00:29'));
  assert.ok(!(await get('/ledger?period=2026-04')).data.some(r => r.created_at === '2026-04-30T16:29:25.000Z'));
  const food = (await get(`/ledger?period=2026-09&category=${encodeURIComponent('餐饮美食')}`)).data;
  assert.ok(food.length > 0 && food.every(r => r.tag === '餐饮美食' && r.kind === 'consumption' && r.bj_time.startsWith('2026-09')));
  const recent = (await get('/ledger?preset=last_30_days')).data, from = new Date(Date.now() + 8 * 3600000 - 29 * 86400000).toISOString().slice(0, 10);
  assert.ok(recent.every(r => r.bj_time.slice(0, 10) >= from));
  assert.equal((await get('/ledger?from=2026-02-30&to=2026-03-01')).status, 400);
  const csv = (await get(`/ledger/export?period=2026-09&category=${encodeURIComponent('餐饮美食')}`)).data.trim().split('\r\n');
  assert.match(csv[0], /分类/); assert.equal(csv.length, food.length + 1);
});

test('注册新用户、收款人、客服和预约可保存且隔离', async t => {
  const f = await fixture(t);
  const emailCode = (await f.request('/auth/email-code', { email: 'mock.test@example.com' })).data;
  const user = await f.request('/auth/register', { phone: '13700137000', name: '模拟测试', password: 'Test123456', pin: '654321', email: 'mock.test@example.com', emailCodeId: emailCode.id, emailCode: emailCode.demoCode }); assert.equal(user.status, 201);
  const snapshot = (await f.request('/dashboard', undefined, user.data.token)).data; assert.equal(snapshot.user.name, '模拟测试'); assert.equal(snapshot.accounts.length, 1); assert.equal(snapshot.holdings.length, 0);
  const payee = await f.req('/payees', { name: '测试收款人', number: '6222000000000033333', bank: '其他银行' }); assert.equal(payee.status, 201);
  assert.equal((await f.req(`/payees/${payee.data.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await f.req('/support', { subject: '转账问题', content: '这是一个测试问题描述' })).status, 201);
  assert.equal((await f.request('/support', undefined, f.bob.token)).data.length, 0);
  const appointment = { branch: '城中支行', service: '账户咨询', date: new Date().toISOString().slice(0, 10) };
  const booked = await f.req('/appointments', appointment); assert.equal(booked.status, 201); assert.equal((await f.req('/appointments', appointment)).status, 409);
  assert.equal((await f.req(`/appointments/${booked.data.id}/cancel`, {})).status, 200);
  assert.equal((await f.state()).appointments[0].status, 'cancelled');
});

test('修改密码使其他会话失效且不将密码写入日志', async t => {
  const f = await fixture(t), secondSession = await f.login();
  assert.equal((await f.req('/settings', await f.strong('/settings', { pin: '123456', newPin: '654321', dailyLimit: '30000' }), 'PATCH')).status, 200);
  assert.equal((await f.request('/me', undefined, secondSession.token)).status, 401);
  assert.equal((await f.state()).user.dailyLimit, 3000000);
  const tx = (await f.transfer()).data; assert.equal((await f.confirm(tx, '654321')).data.status, 'completed');
  const audit = (await f.req('/audit')).data; assert.ok(!JSON.stringify(audit).includes('654321'));
});

test('阻止跨站写入，OpenAPI公开但业务需要认证', async t => {
  const f = await fixture(t);
  const result = await f.request('/notifications/read', {}, f.alice.token, 'POST', { Origin: 'https://untrusted.example' }); assert.equal(result.status, 403);
  const spec = (await f.request('/openapi.json')).data; assert.equal(spec.openapi, '3.1.0'); assert.ok(spec.paths['/api/transactions/{id}/confirm']);
  assert.ok((await f.request('/agent/manifest')).data.simulation);
});

test('SQLite重启保留用户与资金，不重复生成开户数据', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chengchuan-bank-test-')), 'bank.sqlite');
  let bank = createBank(path);
  const initial = bank.all('SELECT id,balance FROM accounts ORDER BY id'); bank.db.close();
  bank = createBank(path); assert.deepEqual(bank.all('SELECT id,balance FROM accounts ORDER BY id'), initial);
  assert.equal(bank.get('SELECT COUNT(*) AS count FROM users').count, 5); bank.db.close();
});

test('导入流水使用模拟卡号，逐笔余额与原对账单一致', () => {
  const bank = createBank(':memory:');
  for (const [phone, name, rows, closing] of [['19900000000', '邹瑞', 131, 147848], ['13500135000', '万锦', 507, 568413], ['13300133000', '万奇', 472, 54]]) {
    const account = bank.get("SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.phone=? AND u.name=? AND a.type='debit'", phone, name);
    assert.match(account.number, /^621880\d{13}$/); assert.equal(account.balance, closing);
    const ledger = bank.all('SELECT * FROM ledger WHERE account_id=? ORDER BY id', account.id);
    assert.equal(ledger.length, rows); assert.equal(ledger[0].category, 'opening');
    ledger.reduce((previous, row) => { assert.equal(previous + row.amount, row.balance_after); return row.balance_after; }, 0);
    assert.ok(ledger.slice(1).every(row => row.txn_type && row.source_bank && row.time_precision));
  }
  assert.equal(bank.get('SELECT SUM(amount) AS value FROM ledger').value, 0);
  assert.equal(bank.get("SELECT COUNT(*) AS n FROM ledger WHERE counterparty LIKE '%思瑞%' OR counterparty LIKE '%锦奇%' OR counterparty_account GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'").n, 0);
  bank.db.close();
});
