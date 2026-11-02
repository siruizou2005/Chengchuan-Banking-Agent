import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, llm } from './helpers.mjs';

const MONTH = '2020-06';
const answer = value => llm([], JSON.stringify(value));
const inputOf = request => JSON.parse(request.messages[1].content);

async function setup(t, options) {
  const f = await fixture(t, { products: { remote: false }, ...options });
  const account = f.services.accountFor(f.user).id;
  let serial = 0;
  const pay = (title, amount, at, detail) => f.bank.post('HIDDEN-' + ++serial, account, 'system', amount, title, 'payment', at, detail);
  const analyze = (period = MONTH) => f.call('/ledger/bills/hidden', { period });
  // Row numbers follow the order of this list, which is the order of time.
  pay('消费 · 视频会员', 2500, '2020-06-02T02:00:00Z');
  pay('消费 · 瑞幸咖啡', 1200, '2020-06-03T02:00:00Z');
  pay('消费 · 瑞幸咖啡', 1500, '2020-06-04T02:00:00Z');
  pay('消费 · 大额家电', 300000, '2020-06-05T02:00:00Z');
  return { f, pay, analyze };
}

test('隐形消费：金额由服务端按流水计算，模型写的金额和非法序号都不算数', async t => {
  const { f, analyze } = await setup(t);
  f.queue.push(answer({
    summary: '本月主要是会员和咖啡。',
    findings: [
      { type: 'frequent_small', reason: '反复买咖啡，累计明显', rows: [1, 2, 2], amount: 999999 },
      { type: 'auto_renew', reason: '每月固定 25 元', rows: [0, 1] },
      { type: 'made_up', reason: '不存在的类型', rows: [3] },
      { type: 'other', reason: '序号不存在', rows: [99, -1, '3', 1.5] },
    ],
    tips: ['核对会员是否还在用', '少买咖啡能省 100 元'],
  }));
  const { status, data } = await analyze();
  assert.equal(status, 200);
  assert.equal(data.total, 5200);
  assert.deepEqual(data.groups.map(g => [g.type, g.name, g.amount]), [['auto_renew', '自动续费与周期扣款', 2500], ['frequent_small', '小额高频', 2700]]);
  const [renew, small] = data.groups.map(g => g.findings[0]);
  assert.equal(small.title, '瑞幸咖啡');
  assert.equal(small.ids.length, 2);
  // A row already counted stays with its first finding, so nothing is summed twice.
  assert.equal(renew.ids.length, 1);
  assert.equal(renew.title, '视频会员');
  // Prose carrying money would show through the hide-amounts switch.
  assert.equal(renew.reason, '');
  assert.equal(small.reason, '反复买咖啡，累计明显');
  assert.deepEqual(data.tips, ['核对会员是否还在用']);
});

test('隐形消费：发给模型的内容不含身份、账号和个人姓名，也不含其他月份的明细', async t => {
  const { f, pay, analyze } = await setup(t);
  pay('消费 · 张小明', 800, '2020-06-06T02:00:00Z', { txn_type: '消费', merchant: '张小明', platform: '微信支付' });
  pay('消费 · 手机13812345678', 800, '2020-06-06T03:00:00Z');
  pay('消费 · 视频会员', 2500, '2020-05-02T02:00:00Z');
  pay('消费 · 视频会员', 2500, '2020-04-02T02:00:00Z');
  pay('消费 · 视频会员', 2500, '2019-06-02T02:00:00Z');
  pay('消费 · 下月才出现的商户', 2500, '2020-07-02T02:00:00Z');
  f.queue.push(answer({ summary: '', findings: [], tips: [] }));
  assert.equal((await analyze()).status, 200);
  const raw = f.requests.at(-1).messages[1].content, input = inputOf(f.requests.at(-1));
  for (const secret of ['张小明', '13812345678', f.user.name, f.user.phone, f.services.accountFor(f.user).number, '下月才出现']) assert.equal(raw.includes(secret), false, secret);
  const member = input.merchants.find(m => m.name === '视频会员');
  // Two earlier months count; the one from a year ago is outside the six-month window.
  assert.equal(member.prior_months, 2);
  assert.deepEqual(member.rows, [[0, '06-02', 25, 2]]);
  const hidden = input.merchants.filter(m => m.name === null);
  assert.deepEqual(hidden.map(m => m.label).sort(), ['个人收款码', '其他消费']);
  assert.equal(f.requests.at(-1).stream, false);
  const call = f.bank.get("SELECT step,trigger_source,status FROM inference_calls WHERE step='hidden_spend'");
  assert.deepEqual({ ...call }, { step: 'hidden_spend', trigger_source: 'app', status: 'succeeded' });
});

test('隐形消费：流水不变不再调模型，流水变了才重新分析，同时打开只调一次', async t => {
  const { f, pay, analyze } = await setup(t);
  f.queue.push(answer({ summary: '第一次', findings: [{ type: 'auto_renew', reason: '会员', rows: [0] }], tips: [] }));
  const [first, second] = await Promise.all([analyze(), analyze()]);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(first.data, second.data);
  assert.deepEqual((await analyze()).data, first.data);
  assert.equal(f.requests.length, 1);
  // Reading the monthly bill never reaches the model.
  assert.equal((await f.call('/ledger/bills?period=' + MONTH)).status, 200);
  assert.equal(f.requests.length, 1);
  pay('消费 · 新商户', 700, '2020-06-20T02:00:00Z');
  f.queue.push(answer({ summary: '第二次', findings: [], tips: [] }));
  const changed = await analyze();
  assert.equal(f.requests.length, 2);
  // Nothing to point at, so the model's prose is not shown either.
  assert.equal(changed.data.summary, '');
  assert.equal(f.bank.all('SELECT 1 FROM hidden_spend_analyses WHERE user_id=?', f.user.id).length, 1);
});

test('隐形消费：没有消费的月份不调模型，模型输出无效时报错且不留存', async t => {
  const { f, analyze } = await setup(t);
  assert.deepEqual((await analyze('2010-01')).data, { period: '2010-01', total: 0, summary: '', tips: [], groups: [] });
  assert.equal(f.requests.length, 0);
  assert.equal((await analyze('2026-13')).status, 400);
  f.queue.push(llm([], '这不是 JSON'));
  const bad = await analyze();
  assert.equal(bad.status, 502);
  assert.equal(bad.data.error.code, 'HIDDEN_ANALYSIS_INVALID');
  assert.equal(f.bank.all('SELECT 1 FROM hidden_spend_analyses').length, 0);
  f.queue.push(answer({ summary: '恢复', findings: [{ type: 'fee', reason: '手续费', rows: [0] }], tips: [] }));
  assert.equal((await analyze()).data.total, 2500);
});

test('隐形消费：需开通智能助手和读取授权，清空助手数据时一并删除', async t => {
  const { f, analyze } = await setup(t);
  f.queue.push(answer({ summary: '', findings: [{ type: 'fee', reason: '手续费', rows: [0] }], tips: [] }));
  assert.equal((await analyze()).status, 200);
  assert.equal((await f.req('/ledger/bills/hidden', { period: MONTH })).status, 401);
  const calls = f.requests.length;
  f.services.puma.consents.update(f.user, { scope: 'data_read', granted: false });
  assert.equal((await analyze()).data.error.code, 'DATA_READ_DENIED');
  f.services.puma.consents.update(f.user, { scope: 'data_read', granted: true, pin: '123456' });
  // A stored result is the assistant's output, so it stops being served with the assistant.
  assert.equal((await f.call('/agent/enrollment/disable', {})).status, 200);
  assert.equal((await analyze()).data.error.code, 'AGENT_NOT_ENABLED');
  assert.equal(f.requests.length, calls);
  assert.equal(f.bank.all('SELECT 1 FROM hidden_spend_analyses').length, 1);
  const { data: { documents } } = await f.call('/agent/enrollment');
  await f.call('/agent/enrollment', { documents: documents.map(d => ({ id: d.id, version: d.version })) });
  assert.equal((await f.call('/agent/enrollment/disable', { clearData: true, pin: '123456' })).status, 200);
  assert.equal(f.bank.all('SELECT 1 FROM hidden_spend_analyses').length, 0);
});

test('隐形消费：当月流水不变时，隔天打开和改分类都不重新调模型', async t => {
  const f = await fixture(t, { products: { remote: false } });
  const account = f.services.accountFor(f.user).id, realNow = Date.now();
  const period = new Date(realNow + 8 * 3600000).toISOString().slice(0, 7);
  f.bank.post('HIDDEN-NOW', account, 'system', 1200, '消费 · 瑞幸咖啡', 'payment', new Date(realNow - 3600000).toISOString());
  f.queue.push(answer({ summary: '有一笔', findings: [{ type: 'other', reason: '咖啡', rows: [0] }], tips: [] }));
  const first = await f.call('/ledger/bills/hidden', { period });
  assert.ok(first.data.total > 0);
  const calls = f.requests.length, row = f.bank.get("SELECT l.id FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE l.transaction_id='HIDDEN-NOW' AND a.user_id=?", f.user.id);
  assert.equal((await f.call(`/ledger/${row.id}/category`, { category: '其他消费' }, 'PUT')).status, 200);
  assert.deepEqual((await f.call('/ledger/bills/hidden', { period })).data, first.data);
  assert.equal(f.requests.length, calls);
  const RealDate = globalThis.Date, offset = 86400000;
  globalThis.Date = class extends RealDate { constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); } static now() { return RealDate.now() + offset; } };
  t.after(() => { globalThis.Date = RealDate; });
  const session = (await f.req('/auth/login', { phone: f.user.phone, password: 'Bank123456' })).data;
  const again = await f.req('/ledger/bills/hidden', { period }, session.token);
  globalThis.Date = RealDate;
  assert.deepEqual(again.data, first.data);
  assert.equal(f.requests.length, calls);
});

test('隐形消费：发现全部无效或回答被截断时报错且不留存，之后可以重新分析', async t => {
  const { f, analyze } = await setup(t);
  f.queue.push(answer({ summary: '有两项', findings: [{ type: '订阅', reason: 'x', rows: ['0'] }, { type: 'auto_renew', reason: 'x', rows: [99] }], tips: ['看看'] }));
  assert.equal((await analyze()).data.error.code, 'HIDDEN_ANALYSIS_INVALID');
  const cut = answer({ summary: '有一项', findings: [{ type: 'fee', reason: '手续费', rows: [0] }], tips: [] });
  cut.choices[0].finish_reason = 'length';
  f.queue.push(cut);
  assert.equal((await analyze()).data.error.code, 'HIDDEN_ANALYSIS_INVALID');
  assert.equal(f.bank.all('SELECT 1 FROM hidden_spend_analyses').length, 0);
  f.queue.push(answer({ summary: '恢复', findings: [{ type: 'fee', reason: '手续费', rows: [0] }], tips: [] }));
  assert.equal((await analyze()).data.total, 2500);
});

test('隐形消费：带金额、联系方式或链接的文字不显示', async t => {
  const { f, analyze } = await setup(t);
  const unsafe = ['每月三十多元', '约30多块', '每次5美元', '占比百分之二十', '３０元一次', '请致电400-123-4567退订', '访问 pay.example.com 退订', '加微信 abc123 退款', '回复验证码取消'];
  f.queue.push(answer({ summary: unsafe[0], findings: [{ type: 'auto_renew', reason: unsafe[1], rows: [0] }], tips: [...unsafe.slice(2), '多元化消费可以分类记录'] }));
  const { data } = await analyze();
  assert.equal(data.summary, '');
  assert.equal(data.groups[0].findings[0].reason, '');
  // Only three tips are read, and each of them is unsafe.
  assert.deepEqual(data.tips, []);
  for (const text of unsafe) {
    f.bank.post('HIDDEN-X' + unsafe.indexOf(text), f.services.accountFor(f.user).id, 'system', 100, '消费 · 文字检查' + unsafe.indexOf(text), 'payment', '2020-06-20T02:00:00Z');
    f.queue.push(answer({ summary: text, findings: [{ type: 'other', reason: '正常理由', rows: [0] }], tips: [] }));
    assert.equal((await analyze()).data.summary, '', text);
  }
  f.bank.post('HIDDEN-OK', f.services.accountFor(f.user).id, 'system', 100, '消费 · 文字检查通过', 'payment', '2020-06-21T02:00:00Z');
  f.queue.push(answer({ summary: '多元化消费可以分类记录', findings: [{ type: 'other', reason: '正常理由', rows: [0] }], tips: [] }));
  assert.equal((await analyze()).data.summary, '多元化消费可以分类记录');
});

test('隐形消费：流水超出模型输入或行数上限时直接说明，不提示开始新对话', async t => {
  const { f, analyze } = await setup(t, { inference: { maxInputTokens: 2000 } });
  const bad = await analyze();
  assert.deepEqual([bad.status, bad.data.error.code], [422, 'HIDDEN_ANALYSIS_TOO_LARGE']);
  assert.equal(f.requests.length, 0);
});
