import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { createBank } from '../server/db.mjs';
import { createProductCatalog, normalizeFund } from '../server/products.mjs';
import { wealthAdvice, financeProfile, compactAdvice, seriesMetrics } from '../server/wealth.mjs';
import { billReport, ledgerFor, resolveRange } from '../server/agent/analytics.mjs';
import { eventsText } from '../server/channels/router.mjs';
import { fixture, llm } from './helpers.mjs';

const NOW = Date.parse('2026-10-20T04:00:00Z'), TODAY = '2026-10-20';
const strip = a => ({ ...a, asOf: undefined });
function app(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const instance = createApp(':memory:', { channels: { secret: 'a'.repeat(64) } });
  t.after(async () => { await instance.channels.stop(); instance.bank.db.close(); });
  const user = phone => instance.bank.get('SELECT * FROM users WHERE phone=?', phone);
  const setRisk = (u, level) => instance.bank.run('UPDATE users SET risk_level=? WHERE id=?', level, u.id);
  return { ...instance, user, setRisk };
}
const products = a => a.plan?.buckets.flatMap(b => b.products) ?? [];

test('资金体检按近3个整月计算月均支出、应急资金与可投资金额', async t => {
  const { services, bank, user } = app(t);
  const u = user('13500135000'), p = financeProfile(services, u, TODAY);
  const report = billReport(ledgerFor(bank, u.id), resolveRange({ from: '2026-07-01', to: '2026-09-30' }, TODAY));
  assert.equal(p.months, 3);
  assert.equal(p.monthlySpend, Math.round((report.totals.consumption + report.totals.transferOut) / 3));
  assert.equal(p.emergency.target, p.monthlySpend * 6);
  assert.equal(p.investable, Math.floor(Math.max(0, p.available - Math.max(0, p.emergency.target - p.holdings.liquid) - p.commitments.creditCard) / 10000) * 10000);
  assert.ok(p.emergency.gap > 0);
});

test('未做风险测评只给测评引导，不推荐产品', async t => {
  const { services, user } = app(t);
  const a = await wealthAdvice(services, user('13800138000'), { horizon: 'long' }, TODAY);
  assert.equal(a.stage, 'risk_assessment'); assert.equal(a.plan, null); assert.equal(a.gate.action.route, 'risk');
  assert.ok(a.profile.available > 0);
});

test('应急资金不足时只推荐随时可取的R1货币基金，不推荐定期或波动产品', async t => {
  const { services, bank, user, setRisk } = app(t);
  const u = user('13500135000'); setRisk(u, 5);
  bank.run("UPDATE accounts SET balance=balance+1000000 WHERE user_id=? AND type='debit'", u.id);
  const a = await wealthAdvice(services, u, { horizon: 'long' }, TODAY);
  assert.equal(a.stage, 'emergency'); assert.match(a.gate.title, /应急资金还差/);
  assert.ok(products(a).length > 0);
  assert.ok(products(a).every(p => p.category === '货币基金' && p.riskLevel === 1));
  assert.equal(a.params.horizon, 'short');
  // Without enough cash to move, the advice explains how long saving the surplus would take.
  bank.run("UPDATE accounts SET balance=balance-1000000 WHERE user_id=? AND type='debit'", u.id);
  const poor = await wealthAdvice(services, u, {}, TODAY);
  assert.equal(poor.stage, 'emergency'); assert.equal(poor.plan, null); assert.match(poor.gate.text, /个月可补足/);
});

test('推荐不超过风险等级，并按资金期限限制产品', async t => {
  const { services, user, setRisk } = app(t);
  const u = user('13800138000');
  for (const level of [1, 2, 3, 4, 5]) {
    setRisk(u, level);
    for (const horizon of ['short', 'mid', 'long']) {
      const a = await wealthAdvice(services, u, { horizon }, TODAY), list = products(a);
      assert.equal(a.stage, 'plan', `${level}/${horizon}`);
      assert.ok(list.length, `${level}/${horizon} has products`);
      assert.ok(list.every(p => p.riskLevel <= level), `${level}/${horizon} within risk`);
      if (horizon === 'short') assert.ok(list.every(p => p.category === '货币基金'));
      if (horizon === 'mid') assert.ok(list.every(p => p.id !== 'deposit-365' && (p.category === '货币基金' || p.riskLevel <= (a.plan.buckets.find(b => b.products.includes(p)).id === 'growth' ? 3 : 2))));
      assert.equal(a.plan.buckets.reduce((n, b) => n + b.amount, 0), a.params.amount);
      assert.ok(list.every(p => p.amount >= p.minimum && p.reason));
    }
  }
});

test('相同输入得到相同方案与理由；金额与期限参数生效', async t => {
  const { services, user, setRisk } = app(t);
  const u = user('13800138000'); setRisk(u, 3);
  const first = await wealthAdvice(services, u, { horizon: 'long', amount: 5000000 }, TODAY);
  const second = await wealthAdvice(services, u, { horizon: 'long', amount: 5000000 }, TODAY);
  assert.deepEqual(strip(first), strip(second));
  assert.equal(first.params.amount, 5000000); assert.equal(first.params.horizonSource, 'selected');
  assert.deepEqual(first.plan.template, { liquid: 15, stable: 55, growth: 30 });
  assert.equal(first.suggestions.length, 3);
  const over = await wealthAdvice(services, u, { horizon: 'long', amount: first.profile.available + 100 }, TODAY);
  assert.equal(over.params.amount, first.profile.available); assert.match(over.warnings[0], /超过活期可用/);
});

test('未传期限时按风险测评第3题预选，没有测评期限则停在选期限一步', async t => {
  const f = await fixture(t);
  const before = (await f.call('/wealth/advice')).data;
  assert.equal(before.stage, 'risk_assessment');
  await f.call('/risk-assessment', { answers: [2, 2, 1, 2, 2] });
  const short = (await f.call('/wealth/advice')).data;
  assert.equal(short.params.horizon, 'short'); assert.equal(short.params.horizonSource, 'assessment');
  f.bank.run("DELETE FROM audit WHERE action='risk.assessed'");
  assert.equal((await f.call('/wealth/advice')).data.stage, 'horizon');
  assert.equal((await f.call('/wealth/advice?horizon=forever')).status, 400);
});

// A bank with no ledger history, one account and a custom fund list makes ranking fully controlled.
function controlled(t, funds) {
  const bank = createBank(':memory:');
  t.after(() => bank.db.close());
  const u = bank.get("SELECT * FROM users WHERE phone='13800138000'");
  bank.run('UPDATE users SET risk_level=2 WHERE id=?', u.id);
  const snapshot = { capturedAt: '2026-10-19T00:00:00.000Z', funds: funds.map(f => normalizeFund(f, '2026-10-19T00:00:00.000Z')), market: [] };
  const catalog = createProductCatalog(bank, { snapshot, codes: funds.map(f => f.FCODE) });
  const services = { bank, catalog, state: () => ({ accounts: [{ status: 'active', type: 'debit', available: 10000000 }], holdings: [], creditCard: { used: 0 } }) };
  return { services, user: u };
}
const fund = (code, extra = {}) => ({ FCODE: code, SHORTNAME: `债基${code}`, FTYPE: '债券型-中短债', DWJZ: '1.1', LJJZ: '1.2', FSRQ: '2026-10-17', SYL_Y: '0.2', SYL_3Y: '0.6', SYL_6Y: '1.2', SYL_1N: '2.5', SGZT: '开放申购', SHZT: '开放赎回', RATE: '0.05%', MINSG: '10', RISKLEVEL: '2', JJGS: '测试基金', ...extra });

test('块内按收益、费率打分排序，同分按产品id排序', async t => {
  const { services, user } = controlled(t, [fund('200002'), fund('200001'), fund('300001', { SYL_1N: '4.0', SYL_6Y: '2.0' }), fund('100001', { FTYPE: '货币型-普通货币', RISKLEVEL: '1', SYI: '1.2' })]);
  const a = await wealthAdvice(services, user, { horizon: 'long', amount: 5000000 }, TODAY);
  const stable = a.plan.buckets.find(b => b.id === 'stable');
  assert.deepEqual(stable.products.map(p => p.id), ['fund-300001', 'fund-200001']);
  assert.match(stable.products[0].reason, /5款候选中综合第1/); assert.equal(stable.products[0].metric.value, 4);
  assert.ok(a.plan.notes.some(n => /暂缺净值走势/.test(n)));
});

test('净值走势计算最大回撤、波动率与夏普比率', () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ value: i < 15 ? i : 28 - i }));
  const m = seriesMetrics(points);
  // Peak 1.14 on day 14, trough 0.99 on day 29: 1 − 0.99/1.14 = 13.16%.
  assert.equal(m.maxDrawdown, 13.16);
  assert.ok(m.volatility > 0);
  assert.equal(seriesMetrics(points.slice(0, 5)), null);
});

test('智能助手推荐理财调用wealth_advice，一轮一张卡片，IM有文字摘要', async t => {
  const f = await fixture(t, { responses: [llm([['wealth_advice', { horizon: 'long' }], ['bill_report', {}]]), llm([], '建议先看卡片。')] });
  f.bank.run('UPDATE users SET risk_level=3 WHERE id=?', f.user.id);
  const r = await f.chat('推荐一个理财');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.events.map(e => e.type), ['advice']);
  assert.match(r.data.trace[1].result, /ONE_CARD_PER_TURN/);
  assert.match(f.requests[0].messages[0].content, /调用wealth_advice/);
  const toolMessage = f.requests[1].messages.find(m => m.role === 'tool');
  assert.ok(Buffer.byteLength(toolMessage.content) < 4096); assert.match(toolMessage.content, /完整方案/);
  const advice = r.data.events[0].data;
  assert.equal(advice.stage, 'plan');
  const text = eventsText({ text: '', events: r.data.events });
  assert.match(text, /【配置建议·R3 中风险】/); assert.match(text, /稳健\d+%：/);
  assert.ok(compactAdvice(advice).plan.length > 0);
});

test('下一到期日按北京时间：UTC 跨日的定期显示北京日期，到期当天仍算未到期', t => {
  const { services, bank, user } = app(t), u = user('13800138000');
  bank.run('DELETE FROM holdings WHERE user_id=?', u.id);
  // 2026-12-31 17:00 UTC is 2027-01-01 01:00 in Beijing.
  bank.run("INSERT INTO holdings(id,user_id,product_id,principal,created_at,unlock_at) VALUES('HNEXT',?,'deposit-90',100000,'2026-10-02T17:00:00.000Z','2026-12-31T17:00:00.000Z')", u.id);
  assert.equal(financeProfile(services, u, TODAY).holdings.nextMaturity.date, '2027-01-01');
  assert.equal(financeProfile(services, u, '2027-01-01').holdings.nextMaturity.date, '2027-01-01');
  assert.equal(financeProfile(services, u, '2027-01-02').holdings.nextMaturity, null);
});
