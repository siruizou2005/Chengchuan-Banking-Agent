import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { accrue, beijingDate, createEarnings } from '../server/earnings.mjs';

const DAY = 86400000, ago = days => new Date(Date.now() - days * DAY).toISOString(), ahead = days => new Date(Date.now() + days * DAY).toISOString();
const dateAgo = days => beijingDate(Date.now() - days * DAY);
const holding = (over = {}) => ({ id: 'H', principal: 100000, earnings: 0, accrual_carry: 0, settled_through: null, created_at: ago(10), unlock_at: ahead(100), ...over });

async function fixture(t) {
  const instance = createApp(':memory:');
  const server = instance.app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13800138000', password: 'Bank123456' }) })).json();
  const call = async (path, body, method = body ? 'POST' : 'GET', headers = {}) => { const r = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${login.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json() }; };
  const user = instance.bank.get('SELECT * FROM users WHERE id=?', login.user.id);
  const seed = (productId, principal, days, unlock = 100) => { const id = `H${randomUUID().replaceAll('-', '')}`; instance.bank.run('INSERT INTO holdings(id,user_id,product_id,principal,created_at,unlock_at) VALUES(?,?,?,?,?,?)', id, user.id, productId, principal, ago(days), ahead(unlock)); return id; };
  return { ...instance, call, user, seed };
}
const redeem = async (f, holdingId, amount) => {
  const tx = await f.call('/transactions', { type: 'redeem', holdingId, amount }, 'POST', { 'Idempotency-Key': randomUUID() });
  if (tx.status !== 201) return tx;
  return f.call(`/transactions/${tx.data.id}/confirm`, { pin: '123456' });
};

test('定期按本金逐日计息，到期后停止，不足一分的余数累计', () => {
  const product = { type: 'deposit', rate: 1.65 };
  const through = dateAgo(1), start = dateAgo(10);
  const running = accrue(holding({ principal: 100000000, settled_through: start }), product, [], through);
  assert.equal(running.rows.length, 9);
  assert.equal(running.rows[0].date, dateAgo(9));
  assert.equal(running.settledThrough, through);
  assert.ok(running.rows.every(r => [4520, 4521].includes(r.amount)), '1,000,000 × 1.65% / 365 ≈ 45.21 元');

  const matured = accrue(holding({ principal: 100000000, settled_through: start, unlock_at: ago(7) }), product, [], through);
  assert.equal(matured.rows.at(-1).date, beijingDate(Date.now() - 7 * DAY));
  assert.equal(matured.settledThrough, through, '到期后不再重复检查');

  let small = holding({ principal: 5000, settled_through: dateAgo(400) }), total = 0;
  const year = accrue(small, product, [], dateAgo(35));
  total = year.rows.reduce((s, r) => s + r.amount, 0);
  assert.ok(total > 0, '小额持仓的余数会累计成收益');
  assert.ok(Math.abs(total + year.carry - 5000 * 0.0165 / 365 * 365) < 1e-3, "累计金额与余数之和等于应计利息");
});

test('基金按净值涨跌结算，可为负，只在交易日产生，只结算到昨天', () => {
  const product = { code: '000001', type: 'wealth', category: 'mixed' };
  const points = [{ date: dateAgo(5), value: 0, acc: 1 }, { date: dateAgo(4), value: 1, acc: 1.01 }, { date: dateAgo(2), value: -0.99, acc: 0.9999 }, { date: dateAgo(0), value: 5, acc: 1.05 }];
  const result = accrue(holding({ principal: 100000, settled_through: dateAgo(5) }), product, points, dateAgo(1));
  assert.deepEqual(result.rows.map(r => r.date), [dateAgo(4), dateAgo(2)]);
  assert.equal(result.rows[0].amount, 1000);
  assert.ok(result.rows[1].amount < 0);
  assert.equal(result.settledThrough, dateAgo(2));
  assert.equal(accrue(holding({ principal: 100000, settled_through: dateAgo(5) }), product, [], dateAgo(1)).changed, false, '没有净值时等下次再补');
});

test('货币基金按当日七日年化计息，缺历史时用当前年化', () => {
  const product = { code: '000198', type: 'wealth', category: 'money', rate: 2 };
  const missing = accrue(holding({ principal: 36500000, settled_through: dateAgo(2) }), product, [], dateAgo(1));
  assert.equal(missing.rows[0].amount, 2000);
  const history = accrue(holding({ principal: 36500000, settled_through: dateAgo(2) }), product, [{ date: dateAgo(3), value: 1 }], dateAgo(1));
  assert.equal(history.rows[0].amount, 1000);
});

test('重复读取不重复记账，存量持仓首次读取自动补算', async t => {
  const f = await fixture(t), id = f.seed('deposit-365', 10000000, 6);
  const first = (await f.call('/holdings')).data.find(h => h.id === id);
  assert.equal(first.earnings, f.bank.get('SELECT SUM(amount) AS n FROM holding_earnings WHERE holding_id=?', id).n);
  assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM holding_earnings WHERE holding_id=?', id).n, 5);
  assert.equal(first.value, 10000000 + first.earnings);
  assert.ok(first.yesterdayEarning > 0);
  assert.equal(first.accrual_carry, undefined);
  await f.call('/holdings'); await f.call('/dashboard');
  assert.equal(f.bank.get('SELECT earnings FROM holdings WHERE id=?', id).earnings, first.earnings);
  assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM holding_earnings WHERE holding_id=?', id).n, 5);
  const snapshot = (await f.call('/dashboard')).data;
  assert.equal(snapshot.earningsSummary.total, f.bank.get('SELECT SUM(amount) AS n FROM holding_earnings WHERE user_id=?', f.user.id).n);
});

test('部分赎回按比例拆分，全额赎回清零，到账金额和明细对得上', async t => {
  const f = await fixture(t), id = f.seed('deposit-365', 10000000, 31);
  const before = (await f.call('/holdings')).data.find(h => h.id === id);
  assert.ok(before.earnings > 0);
  const balance = () => f.bank.get("SELECT balance FROM accounts WHERE user_id=? AND type='debit'", f.user.id).balance;
  const start = balance();
  const half = await redeem(f, id, (before.value / 200).toFixed(2));
  assert.equal(half.data.status, 'completed');
  const amount = Math.round(before.value / 2);
  assert.equal(balance(), start + amount);
  const after = f.bank.get('SELECT principal,earnings FROM holdings WHERE id=?', id);
  assert.equal(after.principal + after.earnings, before.value - amount);
  assert.ok(Math.abs(after.earnings - before.earnings / 2) <= 1);
  assert.match(f.bank.get("SELECT body FROM notifications WHERE user_id=? AND title='交易完成' ORDER BY rowid DESC LIMIT 1", f.user.id).body, /含收益/);

  const over = await redeem(f, id, ((after.principal + after.earnings + 100) / 100).toFixed(2));
  assert.equal(over.data.error.code, 'HOLDING_UNAVAILABLE');
  assert.match(over.data.error.message, /当前可赎回/);

  const full = await redeem(f, id, ((after.principal + after.earnings) / 100).toFixed(2));
  assert.equal(full.data.status, 'completed');
  assert.equal(balance(), start + before.value);
  const gone = f.bank.get('SELECT principal,earnings FROM holdings WHERE id=?', id);
  assert.deepEqual({ ...gone }, { principal: 0, earnings: 0 });
  assert.ok(!(await f.call('/holdings')).data.some(h => h.id === id));
  assert.equal((await f.call('/wealth/earnings?view=all')).data.summary.total > 0, true, '赎回后收益明细保留');
});

test('基金亏损时全额赎回按持有金额到账', async t => {
  const f = await fixture(t);
  const product = f.services.catalog.list().find(p => p.code && p.category !== 'money');
  const id = f.seed(product.id, 100000, 4, -1);
  f.bank.run("INSERT INTO product_history(id,range,data,fetched_at) VALUES(?,'1y',?,?)", product.id, JSON.stringify([{ date: dateAgo(4), value: 0, acc: 1 }, { date: dateAgo(2), value: -10, acc: 0.9 }]), new Date().toISOString());
  const h = (await f.call('/holdings')).data.find(x => x.id === id);
  assert.equal(h.earnings, -10000); assert.equal(h.value, 90000);
  const start = f.bank.get("SELECT balance FROM accounts WHERE user_id=? AND type='debit'", f.user.id).balance;
  assert.equal((await redeem(f, id, '900.00')).data.status, 'completed');
  assert.equal(f.bank.get("SELECT balance FROM accounts WHERE user_id=? AND type='debit'", f.user.id).balance, start + 90000);
  assert.deepEqual({ ...f.bank.get('SELECT principal,earnings FROM holdings WHERE id=?', id) }, { principal: 0, earnings: 0 });
});

test('收益明细接口：日历、构成、明细与参数校验', async t => {
  const f = await fixture(t), id = f.seed('deposit-365', 10000000, 40);
  const asOf = dateAgo(1);
  const day = (await f.call(`/wealth/earnings?view=day&period=${asOf.slice(0, 7)}`)).data;
  assert.equal(day.selected.key, asOf);
  assert.equal(day.selected.items[0].holdingId, id);
  assert.equal(day.selected.composition[0].label, '定期存款');
  assert.equal(day.selected.total, f.bank.get('SELECT SUM(amount) AS n FROM holding_earnings WHERE user_id=? AND date=?', f.user.id, asOf).n);
  const chosen = day.series[0].key;
  assert.equal((await f.call(`/wealth/earnings?view=day&period=${asOf.slice(0, 7)}&key=${chosen}`)).data.selected.key, chosen);
  const all = (await f.call('/wealth/earnings?view=all')).data;
  assert.equal(all.selected.total, all.summary.total);
  assert.ok((await f.call(`/wealth/earnings?view=month&period=${asOf.slice(0, 4)}`)).data.series.length >= 1);
  assert.ok((await f.call('/wealth/earnings?view=year')).data.series.length >= 1);
  assert.equal((await f.call('/wealth/earnings?view=week')).status, 400);
  assert.equal((await f.call('/wealth/earnings?view=day&period=2026')).status, 400);
});

test('createEarnings 只结算当前用户', async t => {
  const f = await fixture(t), other = f.bank.get("SELECT id FROM users WHERE phone='13900139000'").id;
  f.bank.run('INSERT INTO holdings(id,user_id,product_id,principal,created_at,unlock_at) VALUES(?,?,?,?,?,?)', 'HOTHER', other, 'deposit-365', 10000000, ago(5), ahead(100));
  createEarnings(f.bank, f.services.catalog).settle(f.user.id);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM holding_earnings WHERE holding_id='HOTHER'").n, 0);
  assert.equal(f.bank.get("SELECT settled_through FROM holdings WHERE id='HOTHER'").settled_through, null);
});

test('单条消息已读：只影响自己的那一条', async t => {
  const f = await fixture(t);
  f.bank.notify(f.user.id, '甲', '内容甲'); f.bank.notify(f.user.id, '乙', '内容乙');
  const other = f.bank.get("SELECT id FROM users WHERE phone='13900139000'").id;
  f.bank.notify(other, '他人', '他人的消息');
  const mine = f.bank.get("SELECT id FROM notifications WHERE user_id=? AND title='甲'", f.user.id).id, theirs = f.bank.get("SELECT id FROM notifications WHERE user_id=? AND title='他人'", other).id;
  assert.equal((await f.call(`/notifications/${mine}/read`, {})).status, 200);
  assert.equal(f.bank.get('SELECT is_read FROM notifications WHERE id=?', mine).is_read, 1);
  assert.equal(f.bank.get("SELECT is_read FROM notifications WHERE user_id=? AND title='乙'", f.user.id).is_read, 0);
  assert.equal((await f.call(`/notifications/${theirs}/read`, {})).status, 404);
  assert.equal(f.bank.get('SELECT is_read FROM notifications WHERE id=?', theirs).is_read, 0);
});

test('头像：校验格式与大小，可读回；首页模块：校验并保存', async t => {
  const f = await fixture(t);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
  assert.equal((await f.call('/me/avatar', { image: 'data:image/jpeg;base64,' + Buffer.from('not an image').toString('base64') })).status, 400);
  assert.equal((await f.call('/me/avatar', { image: 'data:image/gif;base64,R0lGODlh' })).status, 400);
  assert.equal((await f.call('/me/avatar', { image: 'data:image/jpeg;base64,' + Buffer.concat([jpeg, Buffer.alloc(130 * 1024)]).toString('base64') })).status, 413);
  const before = (await f.call('/dashboard')).data.user;
  assert.equal(before.avatarVersion, null);
  assert.equal(before.nickname, '林知夏');
  assert.deepEqual(before.homeModules, ['bill_daily', 'recommend']);
  assert.equal((await f.call('/me/avatar', { image: 'data:image/jpeg;base64,' + jpeg.toString('base64') })).status, 200);
  assert.ok((await f.call('/dashboard')).data.user.avatarVersion);
  assert.equal((await f.call('/me/home-modules', { modules: ['nope'] })).status, 400);
  assert.equal((await f.call('/me/home-modules', { modules: ['recommend', 'recommend'] })).status, 400);
  assert.equal((await f.call('/me/home-modules', { modules: ['spend_tips', 'bill_daily'] })).status, 200);
  assert.deepEqual((await f.call('/dashboard')).data.user.homeModules, ['spend_tips', 'bill_daily']);
  assert.equal((await f.call('/me/home-modules', { modules: [] })).status, 200);
  assert.deepEqual((await f.call('/dashboard')).data.user.homeModules, []);
});
