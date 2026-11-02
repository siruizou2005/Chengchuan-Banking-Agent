import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBank } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { billReport, classifyRow, enrich, ledgerFor, resolveRange } from '../server/agent/analytics.mjs';
import { accrue } from '../server/earnings.mjs';
import { maskIdentifiers, maskPersonalMerchants, maskPrivateTransfers, PSEUDONYMS } from '../scripts/build-demo-accounts.mjs';

const ZOU = '18662995523', WANQI = '15040147842';
const tempDb = t => { const dir = mkdtempSync(join(tmpdir(), 'demo-accounts-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'bank.sqlite'); };
const user = (bank, phone) => bank.get('SELECT * FROM users WHERE phone=?', phone);

test('演示模式只有邹瑞和万奇，流水与余额逐笔一致', t => {
  const bank = createBank(':memory:', { accounts: 'demo' });
  t.after(() => bank.db.close());
  assert.deepEqual(bank.all('SELECT phone,name FROM users ORDER BY name').map(u => u.name).sort(), ['万奇', '邹瑞'].sort());
  for (const [phone, rows, closing] of [[ZOU, 518, 10228206], [WANQI, 979, 15000054]]) {
    const account = bank.get("SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.phone=? AND a.type='debit'", phone);
    assert.equal(account.balance, closing); assert.match(account.number, /^621880\d{13}$/);
    const ledger = bank.all('SELECT * FROM ledger WHERE account_id=? ORDER BY id', account.id);
    assert.equal(ledger.length, rows); assert.equal(ledger[0].category, 'opening');
    ledger.reduce((previous, row) => { assert.equal(previous + row.amount, row.balance_after); return row.balance_after; }, 0);
  }
  assert.equal(bank.get('SELECT SUM(amount) AS value FROM ledger').value, 0);
  assert.match(user(bank, ZOU).email, /@example\.com$/); assert.match(user(bank, WANQI).email, /@example\.com$/);
  assert.deepEqual(bank.all('SELECT name FROM payees WHERE user_id=?', user(bank, ZOU).id).map(p => p.name), ['万奇']);
});

test('演示账户互为收款人：缺失时按账户对补齐，重启幂等，客户删除后不再恢复', t => {
  const path = tempDb(t), open = () => createBank(path, { accounts: 'demo' });
  let bank = open();
  const payees = () => bank.all('SELECT user_id,number FROM payees ORDER BY user_id').map(p => p.user_id + p.number), complete = payees();
  assert.equal(complete.length, 2);
  // What an interrupted first import used to leave behind: both accounts present, payees never created.
  bank.run('DELETE FROM payees'); bank.run("DELETE FROM schema_migrations WHERE version='demo-payees-v1'"); bank.db.close();
  bank = open(); assert.deepEqual(payees(), complete); bank.db.close();
  bank = open(); assert.deepEqual(payees(), complete);
  // Only the missing direction is added.
  bank.run('DELETE FROM payees WHERE user_id=?', user(bank, ZOU).id); bank.run("DELETE FROM schema_migrations WHERE version='demo-payees-v1'"); bank.db.close();
  bank = open(); assert.deepEqual(payees(), complete);
  // Once in place, a payee the customer removes stays removed.
  bank.run('DELETE FROM payees WHERE user_id=?', user(bank, ZOU).id); bank.db.close();
  bank = open(); assert.equal(payees().length, 1); bank.db.close();
});

test('邹瑞有三个按月扣费的订阅：扣款已在流水里且有标注，下次扣款在每月 14 日', t => {
  const bank = createBank(':memory:', { accounts: 'demo' });
  t.after(() => bank.db.close());
  const zou = user(bank, ZOU);
  const subs = bank.all('SELECT s.merchant,s.amount,s.next_at,m.status,m.period FROM subscriptions s JOIN subscription_mandates m ON m.subscription_id=s.id WHERE s.user_id=? ORDER BY s.amount', zou.id);
  assert.deepEqual(subs.map(s => [s.merchant, s.amount, s.status, s.period]), [['音乐', 1500, 'active', 'monthly'], ['云盘', 2100, 'active', 'monthly'], ['视频会员', 2500, 'active', 'monthly']]);
  assert.ok(subs.every(s => s.next_at > new Date().toISOString() && new Date(s.next_at).getUTCDate() === 14), JSON.stringify(subs));
  assert.equal(bank.get('SELECT COUNT(*) n FROM subscriptions WHERE user_id=?', user(bank, WANQI).id).n, 0);
  const charges = ledgerFor(bank, zou.id).filter(r => r.title.startsWith('消费 · 订阅 · '));
  assert.equal(charges.length, 12);
  assert.ok(charges.every(r => /演示订阅/.test(r.source_detail) && classifyRow(r).tag === '教育文娱'));
  // October as the film shows it: 9,579.43 spent, with the subscriptions under 教育文娱.
  const october = billReport(ledgerFor(bank, zou.id), resolveRange({ period: '2026-10' }, '2026-11-01'));
  assert.equal(october.totals.consumption, 957943);
  assert.equal(october.categories.find(c => c.name === '教育文娱').amount, 281970);
});

test('演示数据的日期：邹瑞对账单到 11 月 1 日，万奇整体后移 31 天，没有未来流水', t => {
  const bank = createBank(':memory:', { accounts: 'demo' });
  t.after(() => bank.db.close());
  const rows = phone => ledgerFor(bank, user(bank, phone).id).map(enrich).reverse();
  const zou = rows(ZOU), wanqi = rows(WANQI);
  assert.equal(zou[0].bj_time.slice(0, 10), '2025-11-01'); assert.equal(zou.at(-1).bj_time.slice(0, 10), '2026-11-01');
  assert.equal(wanqi[1].bj_time, '2025-11-02 12:14'); assert.equal(wanqi.at(-1).bj_time, '2026-10-30 14:28');
  assert.ok([...zou, ...wanqi].every(r => r.created_at <= '2026-11-01T23:59:59.000Z'));
  for (const list of [zou, wanqi]) {
    const topup = list.find(r => r.amount === 15000000);
    assert.equal(topup.kind, 'self'); assert.equal(topup.bj_time.slice(0, 10), '2026-10-01');
    assert.match(topup.source_detail, /演示资金/);
  }
  const purchase = zou.find(r => r.amount === -5000000);
  assert.equal(purchase.kind, 'investment'); assert.equal(purchase.bj_time, '2026-10-17');
  // Rows stay in time order, so the running balance moves by exactly each amount.
  zou.slice(1).forEach((row, i) => assert.equal(zou[i].balance_after + row.amount, row.balance_after));
  // Moving money between one's own accounts is not income, and buying a product is not spending.
  const october = billReport(ledgerFor(bank, user(bank, ZOU).id), resolveRange({ period: '2026-10' }, '2026-11-01'));
  assert.ok(october.totals.income < 15000000 && october.totals.consumption < 5000000);
});

// Fingerprints rather than literals, so this test does not itself publish what it guards.
const SECRETS = new Set(["0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000","0000000000000000"]);
const fingerprint = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

test('邹瑞的持仓只存本金，收益按基金真实净值逐日计算', async t => {
  const app = createApp(':memory:', { accounts: 'demo', products: { remote: false } });
  t.after(async () => { await app.channels.stop(); app.bank.db.close(); });
  const { bank, services } = app, zou = user(bank, ZOU);
  const holding = bank.get('SELECT * FROM holdings WHERE user_id=?', zou.id);
  assert.equal(holding.product_id, 'fund-003474'); assert.equal(holding.principal, 5000000); assert.equal(holding.earnings, 0);
  assert.equal(holding.created_at, '2026-10-17T04:00:00.000Z');
  assert.equal(bank.get('SELECT COUNT(*) n FROM holdings').n, 1);
  // A money fund accrues daily at that day's 7-day yield, so a fixed 3.65% earns one ten-thousandth a day on 50,000.
  bank.run("INSERT INTO product_history(id,range,data,fetched_at) VALUES('fund-003474','1y',?,?)", JSON.stringify([{ date: '2026-10-01', value: 3.65 }]), new Date().toISOString());
  const result = accrue(holding, services.catalog.forHolding(holding), services.catalog.cachedPoints('fund-003474'), '2026-10-31');
  assert.equal(result.rows.length, 14); assert.equal(result.rows[0].date, '2026-10-18');
  assert.ok(result.earnings >= 7000 && result.earnings < 7100, String(result.earnings));
});

test('种子文件不含真实卡号、手机号和姓名，对方账号都已打码', () => {
  const text = readFileSync(new URL('../server/seed/demo-accounts.json', import.meta.url), 'utf8');
  const windows = new Set();
  for (const size of [2, 3, 8, 11, 19]) for (let i = 0; i + size <= text.length; i++) windows.add(text.slice(i, i + size));
  assert.deepEqual([...windows].filter(window => SECRETS.has(fingerprint(window))), []);
  const { columns, users } = JSON.parse(text), rows = users.flatMap(u => u.rows);
  for (const field of ['counterparty_account', 'title', 'merchant', 'memo', 'counterparty']) {
    const at = columns.indexOf(field);
    assert.deepEqual(rows.filter(row => /\d{7,}/.test(row[at] || '')).length, 0, field);
  }
});

test('私人转账对象和个人收款码都是化名且账号全遮，公司和学校保持原名', () => {
  const { columns, users } = JSON.parse(readFileSync(new URL('../server/seed/demo-accounts.json', import.meta.url), 'utf8'));
  const at = name => columns.indexOf(name), rows = users.flatMap(u => u.rows);
  const transfers = rows.filter(row => ['转入', '转出'].includes(row[at('txn_type')]) && /^[一-龥]{2,4}$/.test(row[at('counterparty')] || ''));
  const people = transfers.filter(row => !['邹瑞', '万奇'].includes(row[at('counterparty')]));
  assert.ok(people.length >= 30);
  for (const row of people) {
    assert.ok(PSEUDONYMS.includes(row[at('counterparty')]), row[at('counterparty')]);
    assert.equal(row[at('counterparty_account')], '****');
    assert.ok(row[at('title')].includes(row[at('counterparty')]));
  }
  assert.ok(new Set(people.map(row => row[at('counterparty')])).size === 9);
  assert.ok(rows.some(row => row[at('counterparty')] === '西南财经大学'));
  const vendors = rows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))).filter(row => classifyRow({ ...row, id: 0 }).tag === '个人收款码');
  assert.ok(vendors.length >= 150);
  for (const row of vendors) {
    assert.ok(PSEUDONYMS.includes(row.merchant), row.merchant);
    assert.ok(row.title.includes(row.merchant));
    if (row.counterparty === row.merchant) assert.equal(row.counterparty_account, '****');
  }
  assert.ok(new Set(vendors.map(row => row.merchant)).size > 100);
  // Transfers between the two demo accounts keep their names.
  assert.ok(rows.some(row => row[at('txn_type')] === '转出' && row[at('counterparty')] === '万奇'));
});

test('种子打码规则：姓名只在本行或独立出现时替换，机构和品牌不动，重复执行结果不变', () => {
  const columns = ['title', 'txn_type', 'counterparty', 'counterparty_account', 'merchant', 'memo'];
  const row = (title, txn_type, counterparty, counterparty_account, merchant, memo) => [title, txn_type, counterparty, counterparty_account, merchant, memo];
  const users = [{ name: '邹瑞', rows: [
    row('消费 · 王小龙', '消费', '王小龙', '6222020012345678', '王小龙', null),
    row('消费 · 支付宝-淘宝-陈默', '消费', '支付宝（中国）网络技术有限公司', '1234****5678', '陈默', '支付宝-淘宝-陈默'),
    row('消费 · 陈默 · 小陈默店', '消费', null, null, '小陈默店', '陈默店铺 陈默'),
    row('转账 · 同济大学', '转出', '同济大学', '6222020012345678', '同济大学', null),
    row('消费 · 小红书', '消费', '小红书', null, '小红书', null),
    row('消费 · 邹瑞', '消费', '邹瑞', null, '邹瑞', null),
    row('转账 · 赵四', '转出', '赵四', '12345678', '赵四', '赵四还款 流水1234567'),
  ] }];
  maskIdentifiers(users, columns);
  maskPrivateTransfers(users, columns);
  maskPersonalMerchants(users, columns);
  const once = JSON.stringify(users), rows = users[0].rows, at = name => columns.indexOf(name);
  assert.ok(PSEUDONYMS.includes(rows[0][at('merchant')])); assert.equal(rows[0][at('counterparty_account')], '****');
  assert.equal(rows[0][at('title')], '消费 · ' + rows[0][at('merchant')]);
  const alias = rows[1][at('merchant')];
  assert.ok(PSEUDONYMS.includes(alias)); assert.equal(rows[1][at('memo')], '支付宝-淘宝-' + alias);
  // A processor's account is not the person's, so it keeps its mask.
  assert.equal(rows[1][at('counterparty_account')], '1234****5678');
  // A two-character name inside a longer word is left alone; standing alone it is replaced.
  assert.equal(rows[2][at('merchant')], '小陈默店'); assert.equal(rows[2][at('memo')], '陈默店铺 ' + alias); assert.equal(rows[2][at('title')], `消费 · ${alias} · 小陈默店`);
  assert.equal(rows[3][at('counterparty')], '同济大学');
  assert.equal(rows[4][at('merchant')], '小红书');
  assert.equal(rows[5][at('merchant')], '邹瑞');
  assert.ok(PSEUDONYMS.includes(rows[6][at('counterparty')])); assert.equal(rows[6][at('counterparty_account')], '****');
  assert.equal(rows[6][at('memo')], rows[6][at('counterparty')] + '还款 流水12****67');
  assert.equal(rows[3][at('counterparty_account')], '6222****5678');
  maskIdentifiers(users, columns); maskPrivateTransfers(users, columns); maskPersonalMerchants(users, columns);
  assert.equal(JSON.stringify(users), once);
});

test('新增的流水类型归入正确类型', () => {
  const row = (txn_type, amount, extra = {}) => classifyRow({ title: 't', amount, category: amount > 0 ? 'income' : 'transfer', txn_type, ...extra });
  assert.equal(row('工资', 40000).tag, '工资收入');
  assert.equal(row('理财买入', -100000).kind, 'investment');
  assert.equal(row('理财赎回', 100000).kind, 'investment');
  assert.equal(row('提现', 100000).kind, 'wallet');
});

test('切换到演示模式清空全部旧数据，只执行一次，并保留共享数据', async t => {
  const path = tempDb(t);
  const old = createApp(path, { products: { remote: false } });
  const alice = old.bank.get("SELECT * FROM users WHERE phone='13800138000'");
  old.bank.run("INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES('old-token',?,'2099-01-01T00:00:00.000Z','2026-01-01')", alice.id);
  old.bank.run("INSERT INTO agent_sessions(id,user_id,channel,updated_at) VALUES('S1',?,'app','2026-01-01')", alice.id);
  old.bank.run("INSERT INTO merchant_categories(merchant_key,tag,status,model,prompt_version,created_at,updated_at) VALUES('共享商户','食品','classified','m',1,'2026-01-01','2026-01-01')");
  const productRows = old.bank.get('SELECT COUNT(*) n FROM product_cache').n, tenant = old.bank.get('SELECT tenant_id FROM personalization_instance').tenant_id;
  await old.channels.stop(); old.bank.db.close();

  const first = createApp(path, { accounts: 'demo', products: { remote: false } });
  const { bank } = first;
  assert.deepEqual(bank.all('SELECT name FROM users').map(u => u.name).sort(), ['万奇', '邹瑞'].sort());
  for (const table of ['sessions', 'agent_sessions', 'agent_memory', 'channel_bindings', 'transactions'])
    assert.equal(bank.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
  // Only the demo customer's own three subscriptions remain, none from before the reset.
  assert.deepEqual(bank.all('SELECT DISTINCT user_id FROM subscriptions').map(r => r.user_id), [user(bank, ZOU).id]);
  assert.equal(bank.get('SELECT COUNT(*) n FROM subscriptions').n, 3);
  assert.equal(bank.get('SELECT COUNT(*) n FROM holdings').n, 1);
  assert.equal(bank.get('SELECT COUNT(*) n FROM accounts WHERE user_id IS NULL').n, 1);
  assert.equal(bank.get('SELECT tag FROM merchant_categories').tag, '食品');
  assert.equal(bank.get('SELECT COUNT(*) n FROM product_cache').n, productRows);
  assert.equal(bank.get('SELECT tenant_id FROM personalization_instance').tenant_id, tenant);
  // Immutable audit tables keep their guards after the reset.
  const triggers = bank.all("SELECT name FROM sqlite_master WHERE type='trigger'").map(r => r.name);
  assert.ok(triggers.includes('puma_events_no_delete') && triggers.includes('risk_evaluations_immutable_delete'));
  assert.equal(bank.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const server = first.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = async (phone, password = 'Bank123456') => fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password }) });
  assert.equal((await login('13800138000')).status, 401);
  assert.equal((await login(WANQI)).status, 200);
  const session = await (await login(ZOU)).json();
  assert.equal((await fetch(base + '/ledger/bills?period=2026-10', { headers: { Authorization: `Bearer ${session.token}` } })).status, 200);
  // A later restart keeps what happened since the reset.
  const zou = user(bank, ZOU);
  bank.run("INSERT INTO agent_sessions(id,user_id,channel,updated_at) VALUES('S2',?,'app','2026-11-01')", zou.id);
  await new Promise(r => server.close(r)); await first.channels.stop(); bank.db.close();

  const again = createApp(path, { accounts: 'demo', products: { remote: false } });
  assert.equal(again.bank.get('SELECT id FROM users WHERE phone=?', ZOU).id, zou.id);
  assert.equal(again.bank.get('SELECT COUNT(*) n FROM agent_sessions').n, 1);
  assert.equal(again.bank.get('SELECT COUNT(*) n FROM payees').n, 2);
  await again.channels.stop(); again.bank.db.close();
});
