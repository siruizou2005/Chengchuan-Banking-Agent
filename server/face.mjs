import { randomBytes } from 'node:crypto';
import { id, now } from './db.mjs';
import { hash, requireThat, idField, BusinessError } from './errors.mjs';
import { createIdentityCrypto, createIdentityStore } from './identity.mjs';

/** Server-only H5 adapter; see docs/FACE.md. No Tencent SDK is installed. */
export function createFaceVerification(bank, options = {}, { challenge }) {
  const { provider, returnUrl, timeoutMs = 10000 } = options;
  const crypto = createIdentityCrypto(options.encryptionKey);
  const identity = createIdentityStore(bank, crypto);
  if (provider) {
    if (provider.channel !== 'tencent_face' || typeof provider.start !== 'function' || typeof provider.result !== 'function' || !Array.isArray(provider.allowedOrigins) || !provider.allowedOrigins.length) throw new TypeError('Invalid face provider');
    const target = new URL(returnUrl);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash !== '#face-return') throw new TypeError('Face returnUrl must be HTTPS and end in /#face-return');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new TypeError('Invalid face provider timeout');
    crypto.assertConfigured();
  }
  const mode = user => bank.isDemoUser(user) || !provider ? 'simulated_face' : 'tencent_face';
  const profile = user => ({ ...identity.view(user), channel: mode(user), required: mode(user) === 'tencent_face' && !identity.view(user).enrolled });
  function assertIdentity(user) {
    if (mode(user) === 'tencent_face') requireThat(identity.view(user).enrolled, '请先录入实名资料', 403, 'IDENTITY_REQUIRED');
  }
  function enroll(user, body) {
    requireThat(mode(user) === 'tencent_face', '当前为模拟验证，无需提交真实身份信息', 409, 'SIMULATED_IDENTITY');
    return { ...identity.enroll(user, body), channel: mode(user), required: false };
  }
  async function call(method, payload) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => provider[method]({ ...payload, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs); }),
      ]);
    } catch {
      // Never expose supplier errors, which may contain identity data or tokens.
      throw new BusinessError(controller.signal.aborted ? '核身服务请求超时，请重新开始验证' : '核身服务暂不可用，请重新开始验证', 503, controller.signal.aborted ? 'FACE_PROVIDER_TIMEOUT' : 'FACE_PROVIDER_FAILED');
    } finally { clearTimeout(timer); }
  }
  const detail = session => ({ channel: 'tencent_face', faceSessionId: session.id, ...(session.biz_token_hash ? { bizTokenHash: session.biz_token_hash } : {}), ...(session.provider_reference ? { providerReference: session.provider_reference } : {}) });
  function finish(session, status, event) {
    bank.atomic(() => {
      bank.run('UPDATE face_sessions SET status=? WHERE id=?', status, session.id);
      if (status !== 'passed') bank.run("UPDATE verifications SET face_status='failed' WHERE id=?", session.verification_id);
      bank.audit(session.user_id, event, session.verification_id, detail(session));
    });
  }
  function ownedSession(user, sessionId) {
    const session = bank.get('SELECT * FROM face_sessions WHERE id=? AND user_id=?', idField(sessionId, '核身记录编号'), user.id);
    requireThat(session, '核身记录不存在', 404, 'FACE_NOT_FOUND');
    return session;
  }
  function current(user, session) {
    if (session.expires_at <= now() && ['starting', 'pending', 'checking'].includes(session.status)) {
      finish(session, 'expired', 'verification.face_expired');
      requireThat(false, '核身已过期，请重新开始验证', 403, 'FACE_EXPIRED');
    }
    const v = challenge(user, session.verification_id);
    requireThat(v.face_channel === 'tencent_face' && v.face_session_id === session.id, '核身记录与当前验证不匹配', 403, 'INVALID_VERIFICATION');
    return v;
  }
  async function start(user, verificationId) {
    const v = challenge(user, verificationId);
    requireThat(v.face_channel === 'tencent_face' && provider, '当前验证使用摄像头模拟', 409, 'FACE_MODE_MISMATCH');
    const data = identity.read(user), sessionId = id('FACE'), state = randomBytes(32).toString('hex');
    const redirect = new URL(returnUrl);
    redirect.hash = `face-return?sessionId=${sessionId}&state=${state}`;
    bank.atomic(() => {
      requireThat(!bank.get('SELECT id FROM face_sessions WHERE verification_id=?', v.id), '该验证已发起核身，请继续原流程或重新开始验证', 409, 'FACE_ALREADY_STARTED');
      bank.run('INSERT INTO face_sessions(id,user_id,verification_id,state_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)', sessionId, user.id, v.id, hash(state), 'starting', v.expires_at, now());
      bank.run('UPDATE verifications SET face_session_id=? WHERE id=?', sessionId, v.id);
    });
    let session = ownedSession(user, sessionId);
    try {
      const response = await call('start', { ...data, redirectUrl: redirect.href, reference: sessionId, expiresAt: v.expires_at });
      requireThat(typeof response?.bizToken === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(response.bizToken), '核身服务返回无效', 503, 'FACE_PROVIDER_FAILED');
      let url;
      try { url = new URL(response.url); } catch { /* rejected below */ }
      requireThat(url && url.protocol === 'https:' && !url.username && !url.password && provider.allowedOrigins.includes(url.origin), '核身链接不可用', 503, 'FACE_PROVIDER_FAILED');
      const expiry = response.expiresAt === undefined ? v.expires_at : new Date(Math.min(Date.parse(response.expiresAt), Date.parse(v.expires_at)));
      const expiresAt = typeof expiry === 'string' ? expiry : Number.isFinite(expiry.getTime()) ? expiry.toISOString() : '';
      requireThat(expiresAt > now(), '核身链接已过期，请重新开始验证', 403, 'FACE_EXPIRED');
      bank.atomic(() => {
        current(user, session);
        const digest = hash(response.bizToken);
        requireThat(!bank.get('SELECT id FROM face_sessions WHERE biz_token_hash=?', digest), '核身凭据已使用，请重新开始验证', 409, 'FACE_TOKEN_REUSED');
        bank.run("UPDATE face_sessions SET biz_token_hash=?,biz_token_ciphertext=?,status='pending',expires_at=? WHERE id=?", digest, crypto.encrypt(response.bizToken, `face:${user.id}:${sessionId}`), expiresAt, sessionId);
        session = ownedSession(user, sessionId);
        bank.audit(user.id, 'verification.face_started', v.id, detail(session));
      });
      return { sessionId, url: url.href, expiresAt, simulated: false };
    } catch (error) {
      finish(session, error.code === 'FACE_EXPIRED' ? 'expired' : 'failed', 'verification.face_start_failed');
      throw error;
    }
  }
  async function result(user, { sessionId, state }) {
    const session = ownedSession(user, sessionId);
    requireThat(typeof state === 'string' && /^[a-f\d]{64}$/.test(state) && hash(state) === session.state_hash, '核身回跳校验失败', 403, 'FACE_STATE_INVALID');
    current(user, session);
    bank.atomic(() => {
      requireThat(bank.run("UPDATE face_sessions SET status='checking' WHERE id=? AND status='pending'", session.id).changes === 1, '核身结果已处理或当前不可用', 409, 'FACE_TOKEN_USED');
    });
    try {
      const bizToken = crypto.decrypt(session.biz_token_ciphertext, `face:${user.id}:${session.id}`);
      const response = await call('result', { bizToken, reference: session.id });
      return bank.atomic(() => {
        current(user, session);
        requireThat(response?.bizToken === bizToken && ['pending', 'passed', 'rejected'].includes(response.status), '核身结果无效', 503, 'FACE_PROVIDER_FAILED');
        if (response.status === 'pending') {
          bank.run("UPDATE face_sessions SET status='pending' WHERE id=?", session.id);
          return { status: 'pending', sessionId: session.id };
        }
        const expected = identity.read(user);
        if (response.status !== 'passed' || response.realName !== expected.realName || typeof response.idNumber !== 'string' || response.idNumber.toUpperCase() !== expected.idNumber) {
          throw new BusinessError('核身未通过，请重新开始验证', 403, 'FACE_REJECTED');
        }
        requireThat(typeof response.providerReference === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(response.providerReference) && !response.providerReference.toUpperCase().includes(expected.idNumber), '核身流水号无效', 503, 'FACE_PROVIDER_FAILED');
        bank.run("UPDATE face_sessions SET status='passed',provider_reference=? WHERE id=?", response.providerReference, session.id);
        bank.run("UPDATE verifications SET face_status='completed',face_reference=?,frame_hash=NULL,face_reason=NULL WHERE id=?", response.providerReference, session.verification_id);
        bank.audit(user.id, 'verification.face_verified', session.verification_id, detail({ ...session, provider_reference: response.providerReference }));
        return { status: 'passed', sessionId: session.id };
      });
    } catch (error) {
      finish(session, error.code === 'FACE_REJECTED' ? 'rejected' : error.code === 'FACE_EXPIRED' || error.code === 'VERIFICATION_EXPIRED' ? 'expired' : 'failed', 'verification.face_rejected');
      throw error;
    }
  }
  function status(user, sessionId) {
    const session = ownedSession(user, sessionId);
    current(user, session);
    return { sessionId, verificationId: session.verification_id, status: session.status, expiresAt: session.expires_at };
  }
  function assertPassed(v) {
    if (v.face_channel !== 'tencent_face') return;
    requireThat(bank.get("SELECT id FROM face_sessions WHERE id=? AND verification_id=? AND user_id=? AND status='passed' AND consumed_at IS NULL", v.face_session_id, v.id, v.user_id), '请先完成人脸核身', 403, 'FACE_REQUIRED');
  }
  function consume(v) {
    assertPassed(v);
    if (v.face_channel === 'tencent_face') bank.run("UPDATE face_sessions SET status='consumed',consumed_at=?,biz_token_ciphertext=NULL WHERE id=?", now(), v.face_session_id);
  }
  return { mode, profile, assertIdentity, enroll, start, result, status, assertPassed, consume };
}
