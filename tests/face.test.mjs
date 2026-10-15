import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, llm } from './helpers.mjs';
import { createBank } from '../server/db.mjs';
import { createIdentityCrypto, createIdentityStore, normalizeIdentity } from '../server/identity.mjs';
import { createFaceVerification } from '../server/face.mjs';
import { redact } from '../server/agent/guard.mjs';
import { eventsText } from '../server/channels/router.mjs';
import { channelText } from '../server/channels/preferences.mjs';

// Published checksum example, only passed to in-memory fake providers.
const IDENTITY = { realName: '测试用户', idNumber: '11010519491231002X' };
const KEY = 'c'.repeat(64);
function fakeProvider(overrides = {}) {
  const starts = [], queries = [];
  const provider = {
    channel: 'tencent_face', allowedOrigins: ['https://face.test'], starts, queries,
    async start(input) {
      const bizToken = 'test-' + randomUUID();
      starts.push({ ...input, bizToken });
      return { bizToken, url: `https://face.test/verify?token=${bizToken}` };
    },
    async result(input) {
      queries.push(input);
      const original = starts.find(item => item.bizToken === input.bizToken);
      return { status: 'passed', bizToken: input.bizToken, realName: original.realName, idNumber: original.idNumber, providerReference: 'SEQ-' + randomUUID(), photo: 'DO_NOT_STORE_FACE_PHOTO' };
    },
    ...overrides,
  };
  return provider;
}
async function faceFixture(t, { provider = fakeProvider(), timeoutMs, configured = true, enrolled = true } = {}) {
  const f = await fixture(t, { face: { ...(configured ? { provider } : {}), encryptionKey: KEY, returnUrl: 'https://bank.test/#face-return', ...(timeoutMs ? { timeoutMs } : {}) } });
  const userId = f.bank.newUser('13700000002', '核身接口测试', 'Bank123456', '123456');
  const user = f.bank.get('SELECT * FROM users WHERE id=?', userId);
  const token = (await f.req('/auth/login', { phone: user.phone, password: 'Bank123456' })).data.token;
  const call = (path, body) => f.req(path, body, token);
  if (enrolled && configured) assert.equal((await call('/verify/identity', IDENTITY)).status, 200);
  const action = (await call('/agent/actions', { tool: 'propose_set_daily_limit', args: { amount: '60000' } })).data;
  async function begin() {
    const verification = await call('/verify/start', { actionId: action.id });
    assert.equal(verification.status, 200);
    const started = await call('/verify/face/start', { id: verification.data.id });
    const input = provider.starts.at(-1);
    const state = input ? new URLSearchParams(new URL(input.redirectUrl).hash.split('?')[1]).get('state') : undefined;
    return { verification: verification.data, started, body: { sessionId: started.data.sessionId, state } };
  }
  return { ...f, user, call, token, provider, action, begin };
}

test('未配置及演示账户保留模拟，不要求收集真实身份', async t => {
  const f = await faceFixture(t, { configured: false });
  assert.deepEqual((await f.call('/verify/identity')).data, { enrolled: false, channel: 'simulated_face', required: false });
  assert.equal((await f.call('/verify/identity', IDENTITY)).data.error.code, 'SIMULATED_IDENTITY');
  const v = (await f.call('/verify/start', { actionId: f.action.id })).data;
  assert.equal(v.faceChannel, 'simulated_face');
  assert.equal((await f.call('/verify/face', { id: v.id, skipped: true, reason: 'unavailable' })).status, 200);
  assert.equal((await f.call('/verify/face/start', { id: v.id })).data.error.code, 'FACE_MODE_MISMATCH');
  const configured = await faceFixture(t);
  const demo = await configured.req('/verify/identity', undefined, configured.alice.token);
  assert.equal(demo.data.required, false);
  assert.equal(demo.data.channel, 'simulated_face');
});

test('实名录入校验、加密及脱敏；重启可解密且不能换用户或换密钥解密', async t => {
  const f = await faceFixture(t, { enrolled: false });
  assert.equal((await f.call('/verify/start', { actionId: f.action.id })).data.error.code, 'IDENTITY_REQUIRED');
  assert.equal((await f.call('/verify/identity', { ...IDENTITY, idNumber: '110105194912310021' })).status, 400);
  const saved = await f.call('/verify/identity', IDENTITY);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.maskedIdNumber, '**************002X');
  assert.equal(saved.data.maskedName, '测***');
  assert.ok(!JSON.stringify(saved.data).includes(IDENTITY.idNumber));
  assert.equal((await f.call('/verify/identity', IDENTITY)).data.error.code, 'IDENTITY_ALREADY_ENROLLED');
  const row = f.bank.get('SELECT * FROM verification_identities WHERE user_id=?', f.user.id);
  assert.ok(!JSON.stringify(row).includes(IDENTITY.idNumber));
  assert.ok(!JSON.stringify(row).includes(IDENTITY.realName));
  assert.throws(() => createIdentityCrypto(KEY).decrypt(row.identity_ciphertext, 'identity:' + f.bob.user.id), /暂不可用/);
  assert.throws(() => createIdentityCrypto('d'.repeat(64)).decrypt(row.identity_ciphertext, 'identity:' + f.user.id), /暂不可用/);
  const dir = await mkdtemp(join(tmpdir(), 'face-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bank.sqlite');
  await backup(f.bank.db, path);
  const reopened = createBank(path);
  try { assert.deepEqual(createIdentityStore(reopened, createIdentityCrypto(KEY)).read(f.user), IDENTITY); }
  finally { reopened.db.close(); }
  assert.ok(!JSON.stringify(f.bank.all('SELECT * FROM audit')).includes(IDENTITY.idNumber));
});

test('H5回跳由服务端核对身份，核身因素贯通短信与操作授权且不保存照片', async t => {
  const f = await faceFixture(t), b = await f.begin();
  assert.equal(b.started.status, 200);
  assert.equal(b.verification.faceChannel, 'tencent_face');
  const input = f.provider.starts[0];
  assert.equal(input.idNumber, IDENTITY.idNumber);
  assert.equal(input.realName, IDENTITY.realName);
  assert.ok(input.redirectUrl.startsWith('https://bank.test/#face-return?'));
  assert.ok(!input.redirectUrl.includes(IDENTITY.idNumber));
  const session = f.bank.get('SELECT * FROM face_sessions WHERE id=?', b.body.sessionId);
  assert.ok(!JSON.stringify(session).includes(input.bizToken));
  assert.equal(f.bank.get('SELECT face_session_id FROM verifications WHERE id=?', b.verification.id).face_session_id, session.id);
  assert.equal((await f.call('/verify/face', { id: b.verification.id, frameHash: 'a'.repeat(64) })).status, 403);
  assert.equal((await f.call('/verify/face', { id: b.verification.id, skipped: true, reason: 'denied' })).status, 403);
  const code = f.bank.get("SELECT body FROM notifications WHERE user_id=? AND title='模拟短信验证码'", f.user.id).body.match(/验证码 (\d{6})/)[1];
  assert.equal((await f.call('/verify/complete', { id: b.verification.id, code })).data.error.code, 'FACE_REQUIRED');
  assert.equal((await f.call('/verify/face/result', { ...b.body, status: 'passed' })).data.status, 'passed');
  assert.equal(f.provider.queries.length, 1);
  const reference = f.bank.get('SELECT face_reference FROM verifications WHERE id=?', b.verification.id).face_reference;
  assert.match(reference, /^SEQ-/);
  assert.equal(JSON.parse(f.bank.get("SELECT detail FROM audit WHERE action='verification.face_verified' AND resource_id=?", b.verification.id).detail).providerReference, reference);
  const proof = await f.call('/verify/complete', { id: b.verification.id, code });
  assert.equal(proof.status, 200);
  const confirmed = await f.call(`/agent/actions/${f.action.id}/confirm`, { pin: '123456', verificationToken: proof.data.verificationToken });
  assert.equal(confirmed.data.status, 'completed');
  const factors = JSON.parse(f.bank.get('SELECT factors FROM operation_authorizations WHERE action_id=?', f.action.id).factors);
  assert.ok(factors.includes('tencent_face'));
  assert.ok(!factors.includes('simulated_face'));
  assert.equal(f.bank.get('SELECT status FROM face_sessions WHERE id=?', session.id).status, 'consumed');
  assert.equal(f.bank.get('SELECT biz_token_ciphertext FROM face_sessions WHERE id=?', session.id).biz_token_ciphertext, null);
  const stored = JSON.stringify([...f.bank.all('SELECT * FROM face_sessions'), ...f.bank.all('SELECT * FROM verifications'), ...f.bank.all('SELECT * FROM audit')]);
  assert.ok(!stored.includes('DO_NOT_STORE_FACE_PHOTO'));
  assert.ok(!stored.includes(IDENTITY.idNumber));
  assert.ok(stored.includes(session.id));
});

test('跨用户、错误回跳状态和伪造成功参数均不能通过核身', async t => {
  const provider = fakeProvider({ async result(input) { return { status: 'pending', bizToken: input.bizToken }; } });
  const f = await faceFixture(t, { provider }), b = await f.begin();
  assert.equal((await f.req('/verify/face/result', b.body, f.bob.token)).status, 404);
  assert.equal((await f.req(`/verify/face/sessions/${b.body.sessionId}`, undefined, f.bob.token)).status, 404);
  assert.equal((await f.call('/verify/face/result', { ...b.body, state: 'f'.repeat(64) })).data.error.code, 'FACE_STATE_INVALID');
  const r = await f.call('/verify/face/result', { ...b.body, status: 'passed', realName: IDENTITY.realName, idNumber: IDENTITY.idNumber });
  assert.equal(r.data.status, 'pending');
  assert.equal(f.bank.get('SELECT face_status FROM verifications WHERE id=?', b.verification.id).face_status, 'pending');
});

for (const condition of ['rejected', 'mismatch', 'wrong_token']) test(`核身拒绝或结果不匹配：${condition}`, async t => {
  const provider = fakeProvider({ async result(input) { return { status: condition === 'rejected' ? 'rejected' : 'passed', bizToken: condition === 'wrong_token' ? 'other-token' : input.bizToken, ...IDENTITY, ...(condition === 'mismatch' ? { realName: '其他用户' } : {}) }; } });
  const f = await faceFixture(t, { provider }), b = await f.begin();
  const r = await f.call('/verify/face/result', b.body);
  assert.ok(r.status >= 400);
  assert.equal(f.bank.get('SELECT face_status FROM verifications WHERE id=?', b.verification.id).face_status, 'failed');
  assert.equal((await f.call('/verify/complete', { id: b.verification.id, code: '123456' })).data.error.code, 'FACE_REQUIRED');
  assert.equal((await f.call('/verify/face/result', b.body)).data.error.code, 'FACE_TOKEN_USED');
});

test('核身会话过期拒绝查询，供应商结果不能延长验证码有效期', async t => {
  const f = await faceFixture(t), b = await f.begin();
  f.bank.run("UPDATE face_sessions SET expires_at='2000-01-01' WHERE id=?", b.body.sessionId);
  assert.equal((await f.call('/verify/face/result', b.body)).data.error.code, 'FACE_EXPIRED');
  assert.equal(f.provider.queries.length, 0);
  assert.equal(f.bank.get('SELECT status FROM face_sessions WHERE id=?', b.body.sessionId).status, 'expired');
});

test('核身创建及查询超时均失败，不降级、不暴露供应商原始异常', async t => {
  const provider = fakeProvider({ start() { return new Promise(() => {}); } });
  const f = await faceFixture(t, { provider, timeoutMs: 20 });
  const b = await f.begin();
  assert.equal(b.started.data.error.code, 'FACE_PROVIDER_TIMEOUT');
  const other = await faceFixture(t, { provider: fakeProvider({ result() { return new Promise(() => {}); } }), timeoutMs: 20 });
  const started = await other.begin();
  assert.equal((await other.call('/verify/face/result', started.body)).data.error.code, 'FACE_PROVIDER_TIMEOUT');
  assert.equal(other.bank.get('SELECT face_status FROM verifications WHERE id=?', started.verification.id).face_status, 'failed');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const failed = await faceFixture(t, { provider: fakeProvider({ async result() { throw new Error('secret ' + IDENTITY.idNumber); } }) });
  const startedFailure = await failed.begin();
  assert.equal((await failed.call('/verify/face/result', startedFailure.body)).data.error.code, 'FACE_PROVIDER_FAILED');
  assert.ok(!JSON.stringify(errors).includes(IDENTITY.idNumber));
  assert.ok(!JSON.stringify(failed.bank.all('SELECT * FROM audit')).includes(IDENTITY.idNumber));
});

test('同一BizToken不能重复完成或绑定另一条验证；并发结果查询只能放行一次', async t => {
  const f = await faceFixture(t), b = await f.begin();
  const gate = Promise.withResolvers(), original = f.provider.result;
  f.provider.result = async input => { await gate.promise; return original(input); };
  const pending = f.services.verification.faceVerification.result(f.user, b.body);
  t.after(() => gate.resolve());
  assert.equal((await f.call('/verify/face/result', b.body)).data.error.code, 'FACE_TOKEN_USED');
  gate.resolve();
  assert.equal((await pending).status, 'passed');
  assert.equal((await f.call('/verify/face/result', b.body)).data.error.code, 'FACE_TOKEN_USED');
  f.bank.run("UPDATE verifications SET created_at='2000-01-01' WHERE id=?", b.verification.id);
  f.provider.start = async () => ({ bizToken: f.provider.starts[0].bizToken, url: 'https://face.test/verify' });
  const next = await f.begin();
  assert.equal(next.started.data.error.code, 'FACE_TOKEN_REUSED');
});

test('核身期间修改操作参数会使结果无效，第三方跳转地址必须在白名单中', async t => {
  const f = await faceFixture(t), b = await f.begin();
  f.bank.run('UPDATE agent_actions SET revision=revision+1 WHERE id=?', f.action.id);
  assert.equal((await f.call('/verify/face/result', b.body)).data.error.code, 'INVALID_VERIFICATION');
  assert.equal(f.provider.queries.length, 0);
  const bad = await faceFixture(t, { provider: fakeProvider({ async start() { return { bizToken: 'rejected-token-12345', url: 'https://untrusted.test/verify' }; } }) });
  assert.equal((await bad.begin()).started.data.error.code, 'FACE_PROVIDER_FAILED');
});

test('身份证号不会进入模型上下文、审计、历史或IM输出，覆盖X结尾及中文相邻文本', async t => {
  const f = await faceFixture(t);
  const text = `查银行余额，身份证${IDENTITY.idNumber}请保密`;
  f.queue.push(llm([], text));
  const response = await f.call('/agent/chat', { messages: [{ role: 'user', content: text }] });
  assert.equal(response.status, 200);
  for (const value of [f.requests, response.data, f.bank.all('SELECT * FROM agent_runs'), f.bank.all('SELECT * FROM agent_sessions'), f.bank.all('SELECT * FROM audit'), (await f.call('/dashboard')).data]) assert.ok(!JSON.stringify(value).includes(IDENTITY.idNumber));
  for (const channel of ['feishu', 'wechat']) assert.ok(!channelText(f.bank, f.user.id, channel, text).includes(IDENTITY.idNumber));
  assert.ok(!eventsText({ text, events: [] }).includes(IDENTITY.idNumber));
  assert.deepEqual(redact({ realName: '秘密姓名', idNumber: IDENTITY.idNumber, text }), { text: '查银行余额，身份证**************002X请保密' });
  f.bank.audit(f.user.id, 'privacy.test', '', { raw: text, idNumber: IDENTITY.idNumber });
  assert.ok(!JSON.stringify(f.bank.all('SELECT * FROM audit')).includes(IDENTITY.idNumber));
});

test('真实适配器要求独立加密密钥；身份证格式及校验位错误被拒绝', () => {
  assert.throws(() => createFaceVerification({}, { provider: fakeProvider(), returnUrl: 'https://bank.test/#face-return', encryptionKey: '' }, { challenge() {} }), /未配置/);
  assert.throws(() => createFaceVerification({}, { provider: fakeProvider(), returnUrl: 'http://bank.test/#face-return', encryptionKey: KEY }, { challenge() {} }), /HTTPS/);
  assert.throws(() => normalizeIdentity('测试用户', '11010519490231002X'), /校验失败/);
});
