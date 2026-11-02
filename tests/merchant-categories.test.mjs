import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { billReport, classifyRow, enrich, ledgerFor, resolveRange } from '../server/agent/analytics.mjs';

// Beijing 03:00 on 2026-11-02 and the minute before it.
const DUE = '2026-11-01T19:00:00.000Z', BEFORE = '2026-11-01T18:59:00.000Z';
const minutes = (at, n) => new Date(Date.parse(at) + n * 60000).toISOString();
const config = () => ({ apiKey: 'test', baseUrl: 'https://llm.test/v1', model: 'deepseek-test' });
const reply = (items, usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ items }) } }], usage }) });

async function setup(t, { answer = () => '其他消费', extra = {}, ...options } = {}) {
  const requests = [];
  const respond = options.respond || (names => reply(names.map((name, i) => ({ i, category: answer(name) }))));
  const f = await fixture(t, { products: { remote: false }, merchantCategories: { enabled: true, config, fetch: async (_url, init) => {
    const body = JSON.parse(init.body), names = JSON.parse(body.messages[1].content).merchants.map(m => m.name);
    requests.push({ body, names });
    return respond(names, requests.length);
  }, ...extra } });
  const account = f.services.accountFor(f.user).id;
  let serial = 0;
  const pay = (title, detail, amount = 1000, from = account) => f.bank.post('MC-' + ++serial, from, 'system', amount, title, 'payment', '2026-10-15T02:00:00.000Z', detail);
  const run = at => f.services.merchantCategories.runDue(at);
  const runRow = date => f.bank.get('SELECT * FROM merchant_category_runs WHERE business_date=?', date);
  const tagOf = title => ledgerFor(f.bank, f.user.id).map(enrich).find(r => r.title === title);
  const cached = key => f.bank.get('SELECT * FROM merchant_categories WHERE merchant_key=?', key);
  return { f, requests, account, pay, run, runRow, tagOf, cached, sent: () => requests.flatMap(r => r.names) };
}

test('分类规则：平台词不算分类，多类命中归其他消费，固定标题不受影响', () => {
  const merchant = (name, extra = {}) => classifyRow({ title: '消费 · ' + name, amount: -100, category: 'payment', txn_type: '消费', merchant: name, ...extra }).tag;
  assert.equal(merchant('拼多多平台商户'), '其他消费');
  assert.equal(merchant('杭州某某商贸有限公司'), '其他消费');
  assert.equal(merchant('京东便利店成都东站店'), '食品');
  assert.equal(merchant('小朵颐上海同济大学店'), '其他消费');
  assert.equal(merchant('同济大学嘉定游泳馆'), '教育文娱');
  assert.equal(merchant('携程旅行'), '教育文娱');
  assert.equal(merchant('优衣库'), '衣着');
  assert.equal(merchant('农业银行'), '其他消费');
  assert.equal(merchant('会员超市'), '食品');
  assert.equal(merchant('石油大学食堂'), '其他消费');
  assert.equal(merchant('中石化加油站'), '交通通信');
  assert.equal(merchant('王小明'), '个人收款码');
  assert.equal(classifyRow({ title: '消费', amount: -100, category: 'payment', txn_type: '消费', platform: '支付宝' }).tag, '支付宝支出');
  assert.equal(classifyRow({ title: '消费', amount: -100, category: 'payment', txn_type: '消费', platform: '某平台', counterparty: '某公司' }).tag, '其他消费');
  const native = title => classifyRow({ title, amount: -100, category: 'payment' });
  assert.equal(native('购物 · 超市').tag, '食品');
  assert.equal(native('消费 · 订阅 · 音乐').tag, '教育文娱');
  assert.equal(native('消费 · 陌生商户').tag_source, 'fallback');
});

test('分类优先级：手动高于关键词，关键词高于模型，且都不改变类型和总额', async t => {
  const base = { title: '消费 · 瑞幸', amount: -100, category: 'payment' };
  assert.deepEqual(classifyRow({ ...base, model_tag: '衣着' }), { kind: 'consumption', tag: '食品', tag_source: 'rule' });
  assert.deepEqual(classifyRow({ ...base, model_tag: '衣着', user_tag: '居住' }), { kind: 'consumption', tag: '居住', tag_source: 'user' });
  assert.deepEqual(classifyRow({ ...base, title: '消费 · 陌生', model_tag: '衣着' }), { kind: 'consumption', tag: '衣着', tag_source: 'model' });
  // Tags never move a transfer or income row, so totals and risk features cannot shift.
  assert.equal(classifyRow({ title: '转账 · 陈屿', amount: -100, category: 'transfer', user_tag: '食品', model_tag: '食品' }).tag, '转账给他人');
  const { f, pay, run } = await setup(t, { answer: () => '衣着' });
  pay('消费 · 陌生总额商户');
  const range = resolveRange({ from: '2026-10-01', to: '2026-10-31' }, '2026-11-01');
  const before = billReport(ledgerFor(f.bank, f.user.id), range).totals;
  await run(DUE);
  const row = ledgerFor(f.bank, f.user.id).map(enrich).find(r => r.title === '消费 · 陌生总额商户');
  f.services.merchantCategories.setCategory(f.user, String(row.id), { category: '居住' });
  assert.deepEqual(billReport(ledgerFor(f.bank, f.user.id), range).totals, before);
});

test('发送范围：只发商户名，排除人名、掩码、长数字、平台支出和已识别流水', async t => {
  const { requests, pay, run, sent } = await setup(t);
  pay('消费 · 陌生公司甲');
  pay('消费 · 瑞幸咖啡');
  pay('消费', { txn_type: '消费', merchant: '王小明' });
  pay('消费', { txn_type: '消费', merchant: '宁小禾' });
  pay('消费', { txn_type: '消费', platform: '支付宝', counterparty: '支付宝（中国）网络技术有限公司' });
  pay('消费', { txn_type: '消费', platform: '微信支付', counterparty: '财付通支付科技有限公司' });
  pay('消费', { txn_type: '消费', merchant: '***公司' });
  pay('消费 · 账号6222021234');
  await run(DUE);
  const names = sent();
  assert.ok(names.includes('陌生公司甲'));
  for (const name of ['瑞幸咖啡', '王小明', '宁小禾', '***公司', '账号6222021234']) assert.ok(!names.includes(name), name);
  assert.ok(!names.some(name => /支付宝|财付通/.test(name)));
  assert.equal(requests[0].body.model, 'deepseek-test');
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  const content = requests[0].body.messages[1].content;
  assert.deepEqual(Object.keys(JSON.parse(content)), ['merchants']);
  assert.deepEqual(Object.keys(JSON.parse(content).merchants[0]).sort(), ['i', 'name']);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /13800138000|Alice|user_id/);
});

test('授权范围：未同意当前协议或撤回数据授权的用户不发送，其余用户的同名商户只发一次', async t => {
  const { f, pay, run, sent } = await setup(t);
  const bob = f.bank.get('SELECT * FROM users WHERE id=?', f.bob.user.id), bobAccount = f.services.accountFor(bob).id;
  pay('消费 · 共同商户');
  pay('消费 · 共同商户', undefined, 1000, bobAccount);
  pay('消费 · 鲍勃独有商户', undefined, 1000, bobAccount);
  f.services.puma.consents.update(bob, { scope: 'data_read', granted: false });
  await run(DUE);
  assert.equal(sent().filter(name => name === '共同商户').length, 1);
  assert.ok(!sent().includes('鲍勃独有商户'));
  // Enrolment reset: same exclusion for a customer who has not accepted the current agreements.
  const later = await setup(t);
  later.f.bank.run("UPDATE agent_consents SET version='0.9' WHERE user_id=? AND document='privacy'", later.f.user.id);
  later.pay('消费 · 待同意商户');
  await later.run(DUE);
  assert.ok(!later.sent().includes('待同意商户'));
});

test('分批：120 个商户按 50/50/20 串行发送，不设每日总数上限', async t => {
  const { pay, run, requests, runRow } = await setup(t);
  for (let i = 0; i < 120; i++) pay(`消费 · 批量商户${String.fromCharCode(0x4e00 + i)}`);
  await run(DUE);
  assert.deepEqual(requests.map(r => r.names.length), [50, 50, 20]);
  const row = runRow('2026-11-02');
  assert.equal(row.status, 'succeeded'); assert.equal(row.sent, 120); assert.equal(row.batches, 3);
  assert.equal(row.input_tokens, 30); assert.equal(row.output_tokens, 15);
});

test('缓存：结果按商户生效，非法分类丢弃，拿不准 90 天内不重发，响应缺项累计 3 次后停发', async t => {
  const categories = { 甲餐厅样本: '食品', 拿不准公司: '其他消费', 乱答商户: '不存在的分类' };
  const { f, pay, run, tagOf, cached, requests } = await setup(t, { respond: names => reply(names.flatMap((name, i) => name === '漏答商户' ? [] : [{ i, category: categories[name] || '其他消费' }])) });
  pay('消费 · 乱答商户'); pay('消费 · 拿不准公司'); pay('消费 · 漏答商户'); pay('消费 · 新潮样本商户');
  categories.新潮样本商户 = '衣着';
  await run(DUE);
  assert.equal(tagOf('消费 · 新潮样本商户').tag, '衣着');
  assert.equal(tagOf('消费 · 新潮样本商户').tag_source, 'model');
  assert.equal(cached('新潮样本商户').status, 'classified');
  assert.equal(tagOf('消费 · 拿不准公司').tag, '其他消费');
  assert.equal(cached('拿不准公司').status, 'unknown');
  assert.equal(Date.parse(cached('拿不准公司').retry_after), Date.parse(DUE) + 90 * 86400000);
  assert.equal(cached('乱答商户').status, 'pending'); assert.equal(cached('乱答商户').tag, null);
  // A new row from a cached merchant is categorized on the next read, without waiting for the nightly run.
  pay('消费 · 新潮样本商户', undefined, 2000);
  assert.ok(ledgerFor(f.bank, f.user.id).map(enrich).filter(r => r.title === '消费 · 新潮样本商户').every(r => r.tag === '衣着'));
  const namesOn = async at => { const from = requests.length; await run(at); return requests.slice(from).flatMap(r => r.names); };
  const day2 = await namesOn(minutes(DUE, 1440));
  assert.ok(day2.includes('漏答商户') && day2.includes('乱答商户'));
  assert.ok(!day2.includes('拿不准公司') && !day2.includes('新潮样本商户'));
  const day3 = await namesOn(minutes(DUE, 2880));
  assert.ok(day3.includes('漏答商户'));
  assert.equal(cached('漏答商户').status, 'unknown');
  assert.equal((await namesOn(minutes(DUE, 4320))).length, 0);
  // Past the 90-day window the merchant is asked about again.
  assert.ok((await namesOn(minutes(DUE, 91 * 1440))).includes('拿不准公司'));
});

test('调度：03:00 才到期，每天只跑一次，失败每 30 分钟重试且最多 3 次，已完成批次保留', async t => {
  let failing = 0;
  const { f, pay, run, runRow, cached, requests } = await setup(t, { extra: { batchSize: 1 }, respond: (names, n) => n === 2 || failing ? { ok: false, status: 402, json: async () => ({}) } : reply(names.map((_, i) => ({ i, category: '食品' }))) });
  pay('消费 · 调度商户甲'); pay('消费 · 调度商户乙');
  assert.equal(run(BEFORE), undefined);
  assert.equal(runRow('2026-11-02'), undefined);
  await run(DUE);
  let row = runRow('2026-11-02');
  assert.equal(row.status, 'failed'); assert.equal(row.error_code, 'PROVIDER_BALANCE'); assert.equal(row.attempts, 1); assert.equal(row.batches, 1);
  assert.equal(row.next_at, minutes(DUE, 30));
  assert.equal(f.bank.get("SELECT COUNT(*) n FROM merchant_categories WHERE status='classified'").n, 1);
  assert.equal(run(minutes(DUE, 29)), undefined);
  failing = 1;
  await run(minutes(DUE, 30));
  assert.equal(runRow('2026-11-02').attempts, 2);
  await run(minutes(DUE, 60));
  row = runRow('2026-11-02');
  assert.equal(row.attempts, 3); assert.equal(row.status, 'failed');
  const calls = requests.length;
  assert.equal(run(minutes(DUE, 90)), undefined);
  assert.equal(requests.length, calls);
  // Provider errors do not count against merchants, so the next day starts clean.
  failing = 0;
  await run(minutes(DUE, 1440));
  assert.equal(runRow('2026-11-03').status, 'succeeded');
  assert.ok(cached('调度商户甲') && cached('调度商户乙'));
  const done = requests.length;
  assert.equal(run(minutes(DUE, 1441)), undefined);
  assert.equal(requests.length, done);
});

test('调度：服务器错过 03:00 会补跑，运行中断等租约过期后重试', async t => {
  const { f, pay, run, runRow } = await setup(t);
  pay('消费 · 补跑商户');
  await run(minutes(DUE, 600));
  assert.equal(runRow('2026-11-02').status, 'succeeded');
  f.bank.run("INSERT INTO merchant_category_runs(business_date,status,attempts,lease_until,started_at) VALUES('2026-11-03','running',1,?,?)", minutes(DUE, 1445), minutes(DUE, 1440));
  assert.equal(run(minutes(DUE, 1444)), undefined);
  assert.equal(runRow('2026-11-03').status, 'running');
  await run(minutes(DUE, 1445));
  const row = runRow('2026-11-03');
  assert.equal(row.status, 'succeeded'); assert.equal(row.attempts, 2);
});

test('开关：关闭时不发请求不写记录，未配置密钥时跳过并记录原因', async t => {
  const off = await setup(t, { extra: { enabled: false } });
  off.pay('消费 · 关闭商户');
  assert.equal(off.run(DUE), undefined);
  off.f.maintenance();
  assert.equal(off.requests.length, 0);
  assert.equal(off.f.bank.get('SELECT COUNT(*) n FROM merchant_category_runs').n, 0);
  const missing = await setup(t, { extra: { config: () => ({ apiKey: '', baseUrl: 'https://llm.test/v1', model: 'deepseek-test' }) } });
  assert.equal(missing.run(DUE), undefined);
  assert.equal(missing.requests.length, 0);
  assert.equal(missing.runRow('2026-11-02').status, 'skipped');
  assert.equal(missing.runRow('2026-11-02').error_code, 'NOT_CONFIGURED');
});

test('手动修改：单笔、同商户、恢复自动分类，只影响本人且不进缓存和模型请求', async t => {
  const { f, pay, run, tagOf, cached, sent } = await setup(t);
  pay('消费 · 手改商户'); pay('消费 · 手改商户', undefined, 2000);
  const rows = () => ledgerFor(f.bank, f.user.id).map(enrich).filter(r => r.title === '消费 · 手改商户');
  const [first, second] = rows(), path = id => `/ledger/${id}/category`;
  let res = await f.call(path(first.id), { category: '衣着' }, 'PUT');
  assert.equal(res.status, 200); assert.deepEqual(res.data, { tag: '衣着', tag_source: 'user' });
  assert.equal(rows().find(r => r.id === second.id).tag, '其他消费');
  res = await f.call(path(second.id), { category: '居住', applyToMerchant: true }, 'PUT');
  assert.deepEqual(res.data, { tag: '居住', tag_source: 'user' });
  // A new row from the merchant follows the rule, the earlier single-row edit still wins.
  pay('消费 · 手改商户', undefined, 3000);
  assert.deepEqual(rows().map(r => r.tag).sort(), ['居住', '居住', '衣着'].sort());
  assert.equal(rows().find(r => r.id === first.id).tag, '衣着');
  const bob = f.bank.get('SELECT * FROM users WHERE id=?', f.bob.user.id), bobAccount = f.services.accountFor(bob).id;
  pay('消费 · 手改商户', undefined, 1000, bobAccount);
  assert.equal(ledgerFor(f.bank, bob.id).map(enrich).find(r => r.title === '消费 · 手改商户').tag, '其他消费');
  // Bob's own row still goes to the model, Alice's correction does not travel with it and never enters the cache.
  await run(DUE);
  assert.equal(sent().filter(name => name === '手改商户').length, 1);
  assert.equal(cached('手改商户').status, 'unknown');
  assert.notEqual(cached('手改商户').tag, '居住');
  res = await f.call(path(first.id), {}, 'DELETE');
  assert.deepEqual(res.data, { tag: '居住', tag_source: 'user' });
  res = await f.call(path(first.id), {}, 'DELETE');
  assert.deepEqual(res.data, { tag: '其他消费', tag_source: 'fallback' });
  assert.ok(rows().every(r => r.tag === '其他消费'));
  assert.ok(f.bank.get("SELECT 1 FROM audit WHERE action='ledger.category.updated'"));
  assert.equal(tagOf('消费 · 手改商户').tag_source, 'fallback');
});

test('手动修改的边界：别人的流水、非消费流水、非法分类、无商户流水和撤回授权都被拒绝', async t => {
  const { f, pay } = await setup(t);
  pay('消费', { txn_type: '消费', platform: '支付宝', counterparty: '支付宝（中国）网络技术有限公司' });
  const mine = ledgerFor(f.bank, f.user.id).map(enrich), path = id => `/ledger/${id}/category`;
  const spend = mine.find(r => r.kind === 'consumption'), income = mine.find(r => r.kind === 'income');
  const platform = mine.find(r => r.tag === '支付宝支出');
  assert.equal((await f.req(path(spend.id), { category: '食品' }, f.bob.token, 'PUT')).status, 404);
  assert.equal((await f.call(path('abc'), { category: '食品' }, 'PUT')).status, 404);
  assert.equal((await f.call(path(income.id), { category: '食品' }, 'PUT')).data.error.code, 'CATEGORY_NOT_EDITABLE');
  assert.equal((await f.call(path(spend.id), { category: '餐饮美食' }, 'PUT')).data.error.code, 'INVALID_CATEGORY');
  assert.equal((await f.call(path(platform.id), { category: '食品', applyToMerchant: true }, 'PUT')).data.error.code, 'MERCHANT_REQUIRED');
  assert.equal((await f.call(path(platform.id), { category: '食品' }, 'PUT')).status, 200);
  assert.equal((await f.req(path(spend.id), { category: '食品' }, undefined, 'PUT')).status, 401);
  const { data: { entries } } = await f.call('/ledger/bills?period=2026-10');
  assert.equal(entries.find(r => r.id === platform.id).has_merchant, false);
  assert.equal(entries.find(r => r.id === platform.id).tag_source, 'user');
  f.services.puma.consents.update(f.user, { scope: 'data_read', granted: false });
  assert.equal((await f.call(path(spend.id), { category: '食品' }, 'PUT')).status, 403);
});
