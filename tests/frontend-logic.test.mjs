import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { messagesForRetry, withNewMessageId } from '../src/chat/retry.ts';

// Match the frontend's TypeScript build without adding a test runner dependency.
const load = path => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
};
const { api, ApiError, retryWrongPin, yuan, masked } = await load('../src/api.ts');
const { liveAdapter, ChatError } = await load('../src/chat/adapter.ts');

const respond = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
const failureOf = promise => promise.then(() => assert.fail('应当失败'), e => e);
const reply = (messages, signal = new AbortController().signal) => liveAdapter.reply(messages, signal, 'U1');
const chat = [{ id: 'welcome', role: 'assistant', welcome: true, text: '你好' }, { id: 'user-message-1', role: 'user', text: '查余额' }];

test('金额格式化：空的负数合计显示 0.00，不带负号', () => {
  const emptyExpense = -[].reduce((sum, amount) => sum + amount, 0);
  assert.ok(Object.is(emptyExpense, -0));
  assert.equal(yuan(emptyExpense), '0.00');
  assert.equal(yuan(-12345), '-123.45');
  assert.equal(yuan(123456789), '1,234,567.89');
});

test('隐藏金额：隐藏时不露出原文', () => {
  assert.equal(masked(true, '¥50,000.00'), '****');
  assert.equal(masked(false, '¥50,000.00'), '¥50,000.00');
});

test('接口封装：断网和网关错误页显示中文提示，业务错误保留服务端内容', async () => {
  const offline = await withFetch(async () => { throw new TypeError('Failed to fetch'); }, () => failureOf(api('/dashboard')));
  assert.ok(offline instanceof ApiError);
  assert.deepEqual([offline.message, offline.status, offline.code], ['网络连接失败，请重试', 0, 'NETWORK_ERROR']);

  const gateway = await withFetch(respond(502, '<html>502 Bad Gateway</html>'), () => failureOf(api('/dashboard')));
  assert.deepEqual([gateway.message, gateway.status, gateway.code], ['请求未完成，请稍后重试', 502, 'UNKNOWN']);

  const empty = await withFetch(respond(200, ''), () => failureOf(api('/dashboard')));
  assert.equal(empty.message, '请求未完成，请稍后重试');

  const business = await withFetch(respond(403, { error: { code: 'INVALID_PIN', message: '支付密码不正确' } }), () => failureOf(api('/x', 'POST', {})));
  assert.deepEqual([business.message, business.status, business.code], ['支付密码不正确', 403, 'INVALID_PIN']);

  assert.deepEqual(await withFetch(respond(200, { ok: true }), () => api('/x')), { ok: true });
});

test('对话接口：只有服务器的 JSON 答复算明确报错，网关错误页和断网都算结果未知', async () => {
  const explicit = await withFetch(respond(502, { error: { code: 'PROVIDER_ERROR', message: '模型服务暂时不可用' } }), () => failureOf(reply(chat)));
  assert.ok(explicit instanceof ChatError);
  assert.deepEqual([explicit.message, explicit.status, explicit.code], ['模型服务暂时不可用', 502, 'PROVIDER_ERROR']);

  const gateway = await withFetch(respond(502, '<html>502</html>'), () => failureOf(reply(chat)));
  assert.ok(!(gateway instanceof ChatError));
  assert.equal(gateway.message, '回复暂时未能送达，请重试。');

  const offline = await withFetch(async () => { throw new TypeError('Failed to fetch'); }, () => failureOf(reply(chat)));
  assert.ok(!(offline instanceof ChatError));
  assert.equal(offline.message, '网络连接失败，请重试');

  // The stop button aborts on purpose: the caller recognises the abort, so it must not be rewritten as a network error.
  const stop = new AbortController(); stop.abort();
  const aborted = await withFetch(async () => { throw new DOMException('stopped', 'AbortError'); }, () => failureOf(reply(chat, stop.signal)));
  assert.equal(aborted.name, 'AbortError');
});

test('对话重试：明确报错换新编号，结果未知沿用原编号，已受理不再重试', async () => {
  let next = 0; const newId = () => `retry-message-${++next}`;
  const explicit = messagesForRetry(chat, new ChatError('模型服务暂时不可用', 502, 'PROVIDER_ERROR'), newId);
  assert.equal(explicit.at(-1).id, 'retry-message-1');
  assert.equal(explicit.at(-1).text, '查余额');
  assert.equal(explicit[0].id, 'welcome');
  assert.equal(chat.at(-1).id, 'user-message-1');

  for (const unknown of [new Error('网络连接失败，请重试'), new DOMException('stopped', 'AbortError')]) {
    assert.deepEqual(messagesForRetry(chat, unknown, newId).map(m => m.id), ['welcome', 'user-message-1']);
  }
  assert.equal(next, 1);

  assert.equal(messagesForRetry(chat, new ChatError('该消息正在处理或已中断', 409, 'REQUEST_ALREADY_ACCEPTED'), newId), null);

  // The server keys its dedupe on this field, so the fresh id has to be what the retry actually sends.
  let sent;
  await withFetch(async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ text: 'ok' })); }, () => reply(explicit));
  assert.equal(sent.messageId, 'retry-message-1');
  await withFetch(async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ text: 'ok' })); }, () => reply(messagesForRetry(chat, new Error('断网'), newId)));
  assert.equal(sent.messageId, 'user-message-1');
});

test('对话重试：重试的是最后一条用户消息，不改更早的消息', () => {
  const history = [{ id: 'first-question', role: 'user', text: '一' }, { id: 'first-reply', role: 'assistant', text: '二' }, { id: 'second-question', role: 'user', text: '三' }];
  const retried = messagesForRetry(history, { status: 500, code: 'INTERNAL_ERROR' }, () => 'fresh-message-id');
  assert.deepEqual(retried.map(m => m.id), ['first-question', 'first-reply', 'fresh-message-id']);
});

test('前端表单 pattern 在浏览器使用的 v 标志下都能编译', () => {
  const patterns = new Map();
  const collect = (node, file) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'pattern' && node.initializer) {
      const visit = child => { if (ts.isStringLiteralLike(child)) patterns.set(child.text, file); ts.forEachChild(child, visit); };
      visit(node.initializer);
    }
    ts.forEachChild(node, child => collect(child, file));
  };
  const root = new URL('../src/', import.meta.url);
  for (const file of readdirSync(root, { recursive: true }).filter(name => name.endsWith('.tsx'))) {
    collect(ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX), file);
  }
  assert.ok(patterns.size >= 5);
  // An invalid pattern does not fail loudly: the browser logs a warning and silently skips the check.
  for (const [pattern, file] of patterns) assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, 'v'), `${file}: ${pattern}`);

  const billNumber = new RegExp(`^(?:${[...patterns.keys()].find(p => p.includes('A-Za-z'))})$`, 'v');
  assert.ok(billNumber.test('AB-12345'));
  assert.ok(!billNumber.test('@@'));
});

test('对话重新生成：主动停止算这次尝试已结束，换新编号', () => {
  const stopped = withNewMessageId(chat, () => 'after-stop-message');
  assert.deepEqual(stopped.map(m => m.id), ['welcome', 'after-stop-message']);
  assert.equal(chat.at(-1).id, 'user-message-1');
});

test('支付密码确认：错 PIN 留在流程内重输，沿用同一凭证', async () => {
  const proofs = [{ pin: '000000', token: 'T' }, { pin: '111111', token: 'T' }, { pin: '123456', token: 'T' }], submitted = [], wrong = [];
  const done = await retryWrongPin(async () => proofs.shift(), async proof => {
    submitted.push(proof);
    if (proof.pin !== '123456') throw new ApiError('支付密码不正确', 403, 'INVALID_PIN');
    return 'settled';
  }, e => wrong.push(e.message));
  assert.deepEqual(done, { result: 'settled' });
  assert.deepEqual(submitted.map(p => p.token), ['T', 'T', 'T']);
  assert.deepEqual(wrong, ['支付密码不正确', '支付密码不正确']);
});

test('支付密码确认：限流和其他错误退出流程，取消不提交', async () => {
  const reject = error => async () => { throw error; };
  const once = () => { let asked = 0; return async () => (asked++ ? assert.fail('不应再次询问') : { pin: '123456' }); };
  const limited = await failureOf(retryWrongPin(once(), reject(new ApiError('尝试次数过多', 429, 'RATE_LIMITED')), () => assert.fail('不是错 PIN')));
  assert.equal(limited.code, 'RATE_LIMITED');
  const expired = await failureOf(retryWrongPin(once(), reject(new ApiError('验证令牌无效', 403, 'INVALID_VERIFICATION')), () => assert.fail('不是错 PIN')));
  assert.equal(expired.code, 'INVALID_VERIFICATION');
  assert.equal(await retryWrongPin(async () => null, () => assert.fail('取消后不提交'), () => assert.fail('没有提交')), null);
  // Cancelling after a wrong PIN ends the flow too.
  const answers = [{ pin: '000000' }, null], wrong = [];
  assert.equal(await retryWrongPin(async () => answers.shift(), reject(new ApiError('支付密码不正确', 403, 'INVALID_PIN')), e => wrong.push(e.code)), null);
  assert.deepEqual(wrong, ['INVALID_PIN']);
});

const sources = () => {
  const root = new URL('../src/', import.meta.url);
  return readdirSync(root, { recursive: true }).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, root), 'utf8')]);
};

test('前端读写本地存储都在 try 保护内，存储被禁时不白屏', () => {
  const unguarded = [];
  for (const [name, text] of sources()) {
    const visit = node => {
      if (ts.isIdentifier(node) && ['localStorage', 'sessionStorage'].includes(node.text)) {
        let inside = node;
        while (inside.parent && !(ts.isTryStatement(inside.parent) && inside.parent.tryBlock === inside)) inside = inside.parent;
        if (!inside.parent) unguarded.push(`${name}: ${node.parent.getText().slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  }
  assert.deepEqual(unguarded, []);
});

test('前端不把 UTC 时间戳直接切成日期显示', () => {
  const sliced = sources().flatMap(([name, text]) => [...text.matchAll(/\b\w+_at\)?\.slice\(/g)].map(m => `${name}: ${m[0]}`));
  assert.deepEqual(sliced, []);
});

