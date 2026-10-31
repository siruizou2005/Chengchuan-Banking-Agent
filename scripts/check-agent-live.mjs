// Opt-in real-model smoke test; all banking data is isolated in memory.
// node --env-file=.env scripts/check-agent-live.mjs
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { loadChatConfig } from '../server/chat.mjs';
import { businessDate } from '../server/agent/policy.mjs';

const config = loadChatConfig();
assert.ok(config.apiKey && config.baseUrl, 'Configure CHAT_API_KEY and CHAT_BASE_URL');
const f = createApp(':memory:');
const server = f.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
let token;
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, data: await response.json() };
}
async function chat(prompt) {
  const result = await request('/agent/chat', { messages: [{ role: 'user', content: prompt }] });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  console.log(JSON.stringify({ prompt, text: result.data.text, tools: result.data.trace.map(t => ({ tool: t.tool, ok: t.ok })), events: result.data.events.map(e => ({ type: e.type, level: e.data?.level })) }));
  assert.ok(result.data.trace.some(t => t.ok), 'Expected a successful real-model tool call');
  return result.data;
}
function action(result, tool) {
  const a = result.events.find(e => e.type === 'action' && e.data.tool === tool)?.data;
  assert.ok(a, `Expected ${tool} proposal`);
  return a;
}
try {
  const login = await request('/auth/login', { phone: '13800138000', password: 'Bank123456' });
  assert.equal(login.status, 200);
  token = login.data.token;
  const user = f.bank.get('SELECT * FROM users WHERE id=?', login.data.user.id);
  // A fresh in-memory bank starts with the assistant closed; this check runs as an already enrolled user.
  f.services.enrollment.enable(user, f.services.enrollment.status(user.id).documents); f.services.onboarding.end(user);
  const balance = () => f.bank.get("SELECT balance FROM accounts WHERE user_id=? AND type='debit'", user.id).balance;
  console.log(JSON.stringify({ model: config.model, endpoint: new URL(config.baseUrl).host, database: ':memory:' }));
  const reportMonth = businessDate().slice(0, 7);
  const report = await chat('分析本月账单，生成账单报告');
  assert.ok(report.events.some(e => e.type === 'report'));
  assert.equal(report.events.find(e => e.type === 'report').data.period, reportMonth);
  console.log('PASS green bill report');

  const before = balance();
  const yellow = action(await chat('给陈屿转200元，备注午饭，请生成转账确认卡片'), 'propose_transfer');
  assert.equal(yellow.level, 'yellow');
  assert.equal(balance(), before);
  assert.equal((await request(`/agent/actions/${yellow.id}/confirm`, { pin: '123456' })).data.status, 'completed');
  assert.equal(balance(), before - 20000);
  console.log('PASS yellow proposal does not debit; PIN confirmation settles');

  const query = action(await chat('有哪些订阅扣费？请生成查询授权卡片'), 'list_subscriptions');
  assert.equal(query.level, 'yellow');
  assert.equal(query.result, null);
  const authorized = await request(`/agent/actions/${query.id}/confirm`, { pin: '123456' });
  assert.equal(authorized.data.status, 'completed');
  assert.ok(authorized.data.result.detected.length > 0);
  console.log('PASS subscriptions revealed only after authorization');

  const redBefore = balance();
  const red = action(await chat('给陈屿转1001元，备注测试大额，请生成转账确认卡片'), 'propose_transfer');
  assert.equal(red.level, 'red');
  assert.equal((await request(`/agent/actions/${red.id}/confirm`, { pin: '123456' })).status, 403);
  assert.equal(balance(), redBefore);
  const verification = await request('/verify/start', { actionId: red.id });
  assert.equal(verification.status, 200);
  const id = verification.data.id;
  assert.equal((await request('/verify/face', { id, skipped: true, reason: 'unavailable' })).status, 200);
  const message = f.bank.get("SELECT body FROM notifications WHERE user_id=? AND title='模拟手机验证码' ORDER BY rowid DESC LIMIT 1", user.id).body;
  const verified = await request('/verify/complete', { id, code: message.match(/验证码 (\d{6})/)[1] });
  assert.equal(verified.status, 200);
  assert.equal((await request(`/agent/actions/${red.id}/confirm`, { pin: '123456', verificationToken: verified.data.verificationToken })).data.status, 'completed');
  assert.equal(balance(), redBefore - 100100);
  assert.equal((await request(`/agent/actions/${red.id}/confirm`, { pin: '123456' })).data.status, 'completed');
  assert.equal(balance(), redBefore - 100100);
  console.log('PASS red blocks PIN-only; simulated verification settles exactly once');
  console.log('PASS real-model Agent smoke (4 scenarios)');
} finally {
  await f.channels.stop();
  await new Promise(resolve => server.close(resolve));
  f.bank.db.close();
}
