import test from 'node:test';
import assert from 'node:assert/strict';
import { createBank } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { createProductCatalog, normalizeFund, FUND_CODES } from '../server/products.mjs';
import { executeTool } from '../server/agent/tools.mjs';

const CODES = ['000198', '110020', '501018'];
const raw = (code, extra = {}) => ({ FCODE: code, SHORTNAME: `基金${code}`, FTYPE: code === '000198' ? '货币型-普通货币' : '指数型-股票', DWJZ: '1.2345', LJJZ: '2.1', SYI: '1.5', FSRQ: '2026-10-19', SYL_Y: '1', SYL_3Y: '2', SYL_6Y: '3', SYL_1N: '4.5', SGZT: '开放申购', SHZT: '开放赎回', RATE: '0.12%', MINSG: '10', RISKLEVEL: '4', JJGS: '测试基金', ...extra });
const snapshot = { capturedAt: '2026-10-01T00:00:00.000Z', funds: CODES.map(c => normalizeFund(raw(c, { SHORTNAME: `快照${c}` }), '2026-10-01T00:00:00.000Z')), market: [] };
const json = body => ({ ok: true, json: async () => body });
// Tencent quote line: field 1 name, 3 price, 4 prev close, 5 open, 31 change, 32 change %, 33 high, 34 low, 35 price/volume/amount.
const quote = () => { const f = Array(40).fill('0'); Object.assign(f, { 1: '沪深300', 2: '000300', 3: '4000', 4: '3980', 5: '3990', 31: '20', 32: '0.50', 33: '4010', 34: '3975', 35: '4000/1/150000000000' }); return { ok: true, text: async () => `v_sh000300="${f.join('~')}";\n` }; };
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push(url); return handler(url, init); };
  fn.calls = calls; return fn;
}
const fundOk = (overrides = {}) => fakeFetch(async url => {
  if (url.includes('qt.gtimg')) return quote();
  const code = new URL(url).searchParams.get('FCODE');
  if (overrides[code] === 'fail') throw new Error('boom');
  return json({ Datas: raw(code, overrides[code]) });
});
function catalogWith(options) {
  const bank = createBank(':memory:');
  return { bank, catalog: createProductCatalog(bank, { snapshot, codes: CODES, ...options }) };
}

test('未开启外部数据时只用内置快照并标注可能不是最新', async t => {
  const { bank, catalog } = catalogWith({ remote: false, fetch: () => assert.fail('不应访问外网') });
  t.after(() => bank.db.close());
  await catalog.ready();
  assert.equal(catalog.list().filter(p => p.type === 'wealth').length, 3);
  assert.ok(catalog.list().some(p => p.id === 'deposit-90'));
  const meta = catalog.meta();
  assert.equal(meta.stale, true); assert.equal(meta.fallback, 'snapshot'); assert.match(meta.notice, /可能不是最新/);
});

test('按需拉取一次后缓存到期前不再请求，并发请求共享同一次刷新', async t => {
  const fetch = fundOk({ '110020': { SYL_1N: '9.9' } });
  const { bank, catalog } = catalogWith({ remote: true, fetch, ttlMs: 3600000 });
  t.after(() => bank.db.close());
  await Promise.all([catalog.ready(), catalog.ready(), catalog.ready()]);
  // One fund refresh (funds + indices) plus one index-quote refresh, shared by all three callers.
  assert.equal(fetch.calls.length, CODES.length + 2);
  const fund = catalog.get('fund-110020');
  assert.equal(fund.rate, 9.9); assert.equal(fund.name, '基金110020'); assert.equal(fund.source, '东方财富天天基金');
  assert.equal(catalog.meta().stale, false); assert.equal(catalog.meta().notice, null);
  assert.equal(catalog.market()[0].name, '沪深300');
  await catalog.ready();
  assert.equal(fetch.calls.length, CODES.length + 2);
  // A restarted process reads the SQLite cache instead of the bundled snapshot.
  assert.equal(createProductCatalog(bank, { snapshot, codes: CODES }).get('fund-110020').rate, 9.9);
});

test('外部接口超时或失败时立即返回缓存，并提示数据可能不是最新', async t => {
  const hang = fakeFetch((_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')))));
  const { bank, catalog } = catalogWith({ remote: true, fetch: hang, timeoutMs: 50, waitMs: 20 });
  t.after(() => bank.db.close());
  const started = Date.now();
  await catalog.ready();
  assert.ok(Date.now() - started < 500);
  assert.equal(catalog.get('fund-110020').name, '快照110020');
  await catalog.ensureFresh();
  const meta = catalog.meta();
  assert.equal(meta.stale, true); assert.match(meta.notice, /内置数据/);
  assert.match(bank.get("SELECT error FROM product_sync WHERE source='eastmoney'").error, /all fund requests failed/);
});

test('部分基金失败时保留其旧数据，其余正常更新；刷新失败后保留上次成功数据', async t => {
  const { bank, catalog } = catalogWith({ remote: true, fetch: fundOk({ '501018': 'fail' }) });
  t.after(() => bank.db.close());
  await catalog.refresh();
  assert.equal(catalog.get('fund-110020').name, '基金110020');
  assert.equal(catalog.get('fund-501018').name, '快照501018');
  assert.equal(catalog.meta().stale, false);
  const down = createProductCatalog(bank, { snapshot, codes: CODES, remote: true, fetch: async () => { throw new Error('down'); }, ttlMs: 0 });
  await down.refresh();
  assert.equal(down.get('fund-110020').name, '基金110020');
  assert.equal(down.meta().stale, true); assert.match(down.meta().notice, /缓存数据/);
});

test('暂停申购与单日上限从申购状态解析', () => {
  const paused = normalizeFund(raw('501018', { SGZT: '暂停申购(单日投资上限1元)', RISKLEVEL: '5' }), 'x');
  assert.equal(paused.purchasable, false); assert.equal(paused.risk, 'R5 高风险');
  const limited = normalizeFund(raw('110020', { SGZT: '限大额(单日投资上限500万元)' }), 'x');
  assert.equal(limited.purchasable, true); assert.equal(limited.purchaseLimit, 500000000);
  const money = normalizeFund(raw('000198', { MINSG: '0.01', DWJZ: '0.2231', SYI: '0.814', RISKLEVEL: '1' }), 'x');
  assert.equal(money.rateLabel, '7日年化'); assert.equal(money.rate, 0.814); assert.equal(money.perTenThousand, 0.2231); assert.equal(money.minimum, 1);
});

test('产品下架后持仓仍按快照展示且可赎回判断', async t => {
  const bank = createBank(':memory:');
  t.after(() => bank.db.close());
  const user = bank.get("SELECT id FROM users WHERE phone='13800138000'").id;
  const product = normalizeFund(raw('999999'), 'x');
  bank.run('INSERT INTO holdings(id,user_id,product_id,principal,created_at,unlock_at,product_snapshot) VALUES(?,?,?,?,?,?,?)', 'HX', user, product.id, 1000, 'x', 'x', JSON.stringify({ id: product.id, type: 'wealth', name: product.name, risk: product.risk, days: 0 }));
  const catalog = createProductCatalog(bank, { snapshot, codes: CODES });
  const shown = catalog.forHolding(bank.get("SELECT * FROM holdings WHERE id='HX'"));
  assert.equal(shown.name, '基金999999'); assert.equal(shown.purchasable, false); assert.equal(shown.purchaseStatus, '已下架');
});

test('内置快照覆盖R1至R5并与基金代码清单一致', () => {
  const bank = createBank(':memory:');
  const catalog = createProductCatalog(bank);
  const funds = catalog.list().filter(p => p.type === 'wealth');
  assert.ok(funds.length >= 50 && funds.length <= FUND_CODES.length);
  assert.deepEqual([...new Set(funds.map(p => p.riskLevel))].sort(), [1, 2, 3, 4, 5]);
  assert.ok(funds.every(p => p.source && p.updatedAt && p.navDate && Number.isInteger(p.minimum)));
  bank.db.close();
});

test('智能助手产品工具支持筛选且结果不超过4096字节', async t => {
  const { services, bank, channels } = createApp(':memory:', { channels: { secret: 'a'.repeat(64) } });
  t.after(async () => { await channels.stop(); bank.db.close(); });
  const user = bank.get("SELECT * FROM users WHERE phone='13800138000'");
  const all = await executeTool(services, user, 'get_products_and_holdings', { limit: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(all.data)) < 4096);
  assert.ok(all.data.shown > 0 && all.data.total > 50 && all.data.catalog.source && all.data.holdings.length === 1);
  const bonds = await executeTool(services, user, 'get_products_and_holdings', { category: 'bond', maxRisk: 2, sort: 'return' });
  assert.ok(bonds.data.products.every(p => p.category === '债券基金' && /R[12]/.test(p.risk)));
  const rates = bonds.data.products.map(p => p['近一年收益']);
  assert.deepEqual(rates, [...rates].sort((a, b) => b - a));
  const ids = services.catalog.list().filter(p => p.type === 'wealth').slice(0, 8).map(p => p.id);
  const compared = await executeTool(services, user, 'compare_products', { ids: [...ids.slice(0, 7), 'fund-nope'] });
  assert.ok(Buffer.byteLength(JSON.stringify(compared.data)) < 4096);
  assert.deepEqual(compared.data.missing, ['fund-nope']);
  assert.ok(compared.data.products[0].returns && compared.data.products[0].navDate);
  assert.equal(compared.event.data.products.length, 7);
});

test('走势按需拉取并缓存：非货币基金按累计净值算区间收益，货币基金取7日年化，失败时回退缓存', async t => {
  let down = false;
  const fetch = fakeFetch(async url => {
    if (down) throw new Error('down');
    if (!url.includes('FundNetDiagram')) return fundOk()(url);
    const code = new URL(url).searchParams.get('FCODE');
    return json({ Datas: code === '000198'
      ? [{ FSRQ: '2026-10-17', DWJZ: '0.23', LJJZ: '0.85' }, { FSRQ: '2026-10-18', DWJZ: '0.22', LJJZ: '0.81' }]
      : [{ FSRQ: '2026-10-17', DWJZ: '1.0', LJJZ: '2.0' }, { FSRQ: '2026-10-18', DWJZ: '1.1', LJJZ: '2.2' }, { FSRQ: '2026-10-19', DWJZ: '0.9', LJJZ: '1.9' }] });
  });
  const { bank, catalog } = catalogWith({ remote: true, fetch, ttlMs: 0 });
  t.after(() => bank.db.close());
  const fund = await catalog.history('fund-110020', '3m');
  assert.deepEqual(fund.points.map(p => p.value), [0, 10, -5]);
  assert.equal(fund.metric, '累计收益率'); assert.equal(fund.stale, false); assert.equal(fund.points[1].nav, 1.1);
  const money = await catalog.history('fund-000198', '1m');
  assert.deepEqual(money.points.map(p => p.value), [0.85, 0.81]); assert.equal(money.metric, '7日年化');
  down = true;
  const cached = await catalog.history('fund-110020', '3m');
  assert.equal(cached.stale, true); assert.equal(cached.points.length, 3); assert.match(cached.notice, /可能不是最新/);
  const none = await catalog.history('fund-501018', '1y');
  assert.equal(none.points.length, 0); assert.match(none.notice, /暂时无法获取/);
  assert.equal(await catalog.history('deposit-90', '3m'), null);
  assert.equal(await catalog.history('fund-110020', '5y'), null);
});

test('指数走势取腾讯日线并缓存，行情断连时重试一次', async t => {
  let resets = 1;
  const fetch = fakeFetch(async url => {
    if (url.includes('fqkline')) return json({ data: { sh000300: { day: [['2026-10-17', '4100', '4120.5', '4130', '4090', '1'], ['2026-10-18', '4120', '4150.25', '4160', '4110', '2']] } } });
    if (url.includes('qt.gtimg') && resets-- > 0) throw Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    return fundOk()(url);
  });
  const { bank, catalog } = catalogWith({ remote: true, fetch });
  t.after(() => bank.db.close());
  await catalog.refresh();
  const [index] = catalog.market();
  assert.equal(index.name, '沪深300'); assert.equal(index.price, 4000); assert.equal(index.high, 4010); assert.equal(index.amount, 150000000000);
  const series = await catalog.indexHistory('000300', '1m');
  assert.deepEqual(series.points.map(p => p.value), [4120.5, 4150.25]);
  assert.equal(series.source, '腾讯财经'); assert.equal(series.metric, '收盘点位'); assert.equal(series.points[1].high, 4160);
  const calls = fetch.calls.length;
  await catalog.indexHistory('000300', '1m');
  assert.equal(fetch.calls.length, calls);
  assert.equal(await catalog.indexHistory('600519', '1m'), null);
});

test('缓存来自旧版本格式时立即刷新一次，之后照常遵守缓存期限', async t => {
  const fetch = fundOk();
  const { bank, catalog } = catalogWith({ remote: true, fetch, ttlMs: 3600000 });
  t.after(() => bank.db.close());
  await catalog.refresh();
  const old = catalog.get('fund-110020');
  bank.run('UPDATE product_cache SET data=? WHERE id=?', JSON.stringify({ ...old, schema: undefined, navChange: undefined }), old.id);
  const reloaded = createProductCatalog(bank, { snapshot, codes: CODES, remote: true, fetch, ttlMs: 3600000 });
  const before = fetch.calls.length;
  await reloaded.ready();
  // One fund refresh (funds plus index quotes); the quote TTL itself has not expired.
  assert.equal(fetch.calls.length - before, CODES.length + 1);
  assert.equal(reloaded.get('fund-110020').schema, 2);
  await reloaded.ready();
  assert.equal(fetch.calls.length - before, CODES.length + 1);
});
