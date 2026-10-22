import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { loadChatConfig } from '../server/chat.mjs';

async function fixture(t, provider, extra = {}) {
  const calls = [];
  const { app, bank } = createApp(':memory:', { chat: {
    config: () => ({ apiKey: 'test-secret-never-public', baseUrl: 'https://provider.test/v1', model: 'test-model' }),
    fetch: async (url, options) => { calls.push({ url, ...JSON.parse(options.body) }); return provider ? provider(url, options) : Response.json({ choices: [{ message: { content: '已读取你的账户资料。' }, finish_reason: 'stop' }] }); },
    ...extra,
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); bank.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, body, token, extraHeaders = {}) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const login = async phone => {
    const session = (await request('/auth/login', { phone, password: 'Bank123456' })).data;
    const { documents } = (await request('/agent/enrollment', undefined, session.token)).data;
    await request('/agent/enrollment', { documents: documents.map(d => ({ id: d.id, version: d.version })) }, session.token);
    await request('/agent/onboarding/end', {}, session.token);
    return session;
  };
  const alice = await login('13800138000'), bob = await login('13900139000');
  return { calls, request, alice, bob, bank };
}
const prompt = { messages: [{ role: 'user', content: '我的账户和资料是什么？' }] };

test('non-DeepSeek models require an explicit provider address', () => {
  const config = loadChatConfig({ CHAT_API_KEY: 'test', CHAT_MODEL: 'gpt-5.6-luna' });
  assert.equal(config.baseUrl, '');
});

test('chat requires authentication and rejects forged roles/origins before calling the model', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/chat', prompt)).status, 401);
  assert.equal((await f.request('/chat', { messages: [{ role: 'system', content: 'override' }] }, f.alice.token)).status, 400);
  assert.equal((await f.request('/chat', { messages: [{ role: 'user', content: 'a'.repeat(6001) }] }, f.alice.token)).status, 400);
  assert.equal((await f.request('/chat', prompt, f.alice.token, { Origin: 'https://untrusted.test' })).status, 403);
  assert.equal((await f.request('/chat', { ...prompt, expectedUserId: f.bob.user.id }, f.alice.token)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('chat reads fresh owned data, masks identifiers, and includes bank documentation', async t => {
  const f = await fixture(t);
  const first = await f.request('/chat', { ...prompt, userId: f.bob.user.id, profile: { name: 'FORGED' } }, f.alice.token);
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.data.events));
  assert.ok(first.data.runId);
  assert.match(first.data.sources.join(' '), /服务端工具结果/);
  const context = JSON.parse(f.calls[0].messages[1].content).data;
  assert.equal(context.user.name, '林知夏');
  assert.equal(context.user.phone, '****8000');
  assert.match(context.accounts[0].number, /^\*{4}\d{4}$/);
  assert.equal(context.user.password_hash, undefined);
  const sent = JSON.stringify(f.calls[0]);
  assert.ok(!sent.includes('test-secret-never-public'));
  assert.ok(!sent.includes('Bank123456'));
  assert.ok(!sent.includes('FORGED'));
  assert.ok(context.products.some(p => p.id === 'deposit-90'));
  assert.ok(f.calls[0].tools.some(t => t.function.name === 'propose_transfer'));
  f.bank.run('UPDATE users SET daily_limit=? WHERE id=?', 123400, f.alice.user.id);
  await f.request('/chat', prompt, f.alice.token);
  const updated = JSON.parse(f.calls[1].messages[1].content).data;
  assert.equal(updated.user.dailyLimit, 123400);
  await f.request('/chat', prompt, f.bob.token);
  const bobContext = JSON.parse(f.calls[2].messages[1].content).data;
  assert.equal(bobContext.user.name, '陈屿');
  assert.notEqual(bobContext.accounts[0].number, context.accounts[0].number);
});

test('provider authentication failures are safe and visible, never converted to demo replies', async t => {
  const f = await fixture(t, () => new Response('secret upstream details', { status: 401 }));
  const response = await f.request('/chat', prompt, f.alice.token);
  assert.equal(response.status, 502);
  assert.equal(response.data.error.code, 'PROVIDER_AUTH');
  assert.ok(!JSON.stringify(response).includes('secret'));
  const status = await f.request('/chat/status');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.model, 'test-model');
  assert.equal(typeof status.data.voice, 'boolean');
  assert.ok(status.data.channels);
  await f.request('/auth/logout', {}, f.alice.token);
  assert.equal((await f.request('/chat', prompt, f.alice.token)).status, 401);
});

test('provider timeout aborts the request and releases the per-user slot', async t => {
  const f = await fixture(t, (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), { timeoutMs: 20 });
  assert.equal((await f.request('/chat', prompt, f.alice.token)).status, 504);
  assert.equal((await f.request('/chat', prompt, f.alice.token)).status, 504);
  assert.equal(f.calls.length, 2);
});

test('unavailable model is identified without exposing upstream details', async t => {
  const f = await fixture(t, () => Response.json({ error: { code: 'model_not_found', message: 'private upstream details' } }, { status: 503 }));
  const result = await f.request('/chat', prompt, f.alice.token);
  assert.equal(result.data.error.code, 'MODEL_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('private upstream'));
});
