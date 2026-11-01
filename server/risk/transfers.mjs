import { id, now } from '../db.mjs';
import { hash, requireThat } from '../errors.mjs';
import { paramsDigest, actionParams } from '../authorization.mjs';
import { decide } from '../agent/policy.mjs';
import { enforcing } from '../puma/config.mjs';
import { createMockPaymentAdapter } from './payment.mjs';

const editable = ['RISK_CHECKED', 'AWAITING_APPROVAL', 'USER_APPROVED', 'HOLD_REVIEW', 'BLOCKED'];
const fields = ['sourceAccountRef', 'beneficiaryRef', 'amountMinor', 'currency', 'memo'];
export function createRiskTransfers(bank, services, risk, options = {}) {
  const provider = options.adapter || createMockPaymentAdapter(bank, options.payment);
  requireThat(provider.mode === 'mock' && process.env.LIVE_PAYMENT_ENABLED !== 'true', '本版本仅支持模拟支付', 503, 'LIVE_PAYMENT_DISABLED');
  const policy = services.puma?.policy;
  const adaptive = enforcing(policy?.flags.risk_adaptive_auth);
  function authPlan(user, d, e, session) {
    const decision = decide(bank, user, 'propose_transfer', { amount: (d.amount_minor / 100).toFixed(2) });
    const legacyStrong = e.finalAction === 'STEP_UP' || decision.level === 'red';
    const reasons = [...e.reasonCodes];
    if (decision.level === 'red') reasons.push('DAILY_THRESHOLD_EXCEEDED');
    if (decision.amounts.total > user.daily_limit) reasons.push('DAILY_LIMIT');
    if (!session?.trusted) reasons.push('BROWSER_ASSURANCE_REQUIRED');
    if (provider.allowsSinglePin !== true) reasons.push('PROVIDER_STEP_UP');
    let tier = 'L1';
    if (e.finalAction === 'BLOCK' || decision.amounts.total > user.daily_limit) tier = 'L3';
    else if (legacyStrong || e.finalAction === 'HOLD_REVIEW' || services.puma?.delegates.status(d).length) tier = 'L2';
    else if (!legacyStrong && e.finalAction === 'ALLOW' && !e.reasonCodes.length && e.familiarPayee && e.adequateSample
      && session?.trusted && provider.allowsSinglePin === true && (enforcing(policy?.flags.l0_single_password)
        || !adaptive && policy?.flags.l0_single_password === 'shadow')
      && services.verification.faceVerification.mode(user) === 'simulated_face' && e.modelStatus !== 'UNAVAILABLE') tier = 'L0';
    return { tier, reasons, strong: adaptive ? tier !== 'L0' : legacyStrong, version: adaptive ? e.policyVersion + '/' + policy.version + '/adaptive' : e.policyVersion };
  }
  function owned(user, draftId) {
    const d = bank.get('SELECT * FROM risk_drafts WHERE id=? AND user_id=?', draftId, user.id);
    if (!d) bank.audit(user.id, 'risk.access.denied', hash(String(draftId)));
    requireThat(d, '无权访问此草稿', 403, 'DRAFT_FORBIDDEN');
    const p = JSON.parse(d.payload);
    requireThat(d.payload_hash === digest(d.user_id, d.id, d.version, p) && d.amount_minor === p.amountMinor && d.currency === p.currency
      && d.source_account_ref === p.sourceAccountRef && d.beneficiary_ref === p.beneficiaryRef, '草稿完整性检查失败', 403, 'DRAFT_INTEGRITY');
    if (editable.includes(d.status) && d.expires_at <= now()) {
      bank.atomic(() => { invalidate(d); bank.run("UPDATE risk_drafts SET status='EXPIRED',updated_at=? WHERE id=?", now(), d.id); bank.audit(user.id, 'risk.draft.expired', d.id); });
      d.status = 'EXPIRED';
    }
    return d;
  }
  function parseInput(user, body) {
    requireThat(body && Object.keys(body).every(k => fields.includes(k)), '草稿包含不支持的字段', 400, 'INVALID_DRAFT');
    requireThat(['sourceAccountRef', 'beneficiaryRef'].every(k => typeof body[k] === 'string' && /^[\w-]{1,100}$/.test(body[k])), '请选择付款账户和收款对象', 400, 'INVALID_DRAFT');
    requireThat(Number.isSafeInteger(body.amountMinor) && body.amountMinor > 0 && body.amountMinor <= 1000000000, '金额必须为正整数分', 400, 'INVALID_AMOUNT');
    requireThat(body.currency === 'CNY', '模拟支付仅支持人民币', 400, 'UNSUPPORTED_CURRENCY');
    requireThat(typeof body.memo === 'undefined' || typeof body.memo === 'string' && body.memo.length <= 100, '附言无效');
    const account = bank.get("SELECT * FROM accounts WHERE id=? AND user_id=? AND status='active' AND type='debit'", body.sourceAccountRef, user.id);
    requireThat(account, '无权使用付款账户', 403, 'ACCOUNT_FORBIDDEN');
    let p = bank.get('SELECT id,name,number,bank FROM payees WHERE id=? AND user_id=?', body.beneficiaryRef, user.id);
    if (!p) p = bank.get("SELECT a.id,u.name,a.number,'澄川银行' AS bank FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.type='debit' AND a.status='active'", body.beneficiaryRef);
    requireThat(p && p.number !== account.number, '收款对象不存在或无效', 400, 'INVALID_BENEFICIARY');
    const target = bank.get('SELECT a.id,a.user_id,a.status,u.name FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.number=?', p.number);
    requireThat(!target || target.status === 'active' && target.name === p.name, '收款对象当前不可用', 409, 'INVALID_BENEFICIARY');
    const payload = { sourceAccountRef: account.id, beneficiaryRef: p.id, beneficiaryToken: hash(p.number),
      beneficiaryName: p.name, beneficiaryMasked: `****${p.number.slice(-4)}`, institution: p.bank,
      targetId: target?.id || 'system', ownAccount: target?.user_id === user.id,
      amountMinor: body.amountMinor, currency: body.currency, memo: body.memo || '', feeMinor: 0,
      feeBearer: 'SENDER', paymentChannel: 'MOCK', paymentNetwork: 'SIMULATOR' };
    return payload;
  }
  const digest = (userId, draftId, version, payload) => paramsDigest({ userId, draftId, version, payload });
  function candidate(d, held = 0) { const p = JSON.parse(d.payload); return { ...p, beneficiaryRef: p.beneficiaryToken, category: 'transfer', heldByThisPayment: held }; }
  function evaluate(user, d, stage, held = 0) {
    return bank.atomic(() => {
      const current = owned(user, d.id);
      requireThat(current.version === d.version && current.payload_hash === d.payload_hash && current.status === d.status,
        '草稿状态已变化，请刷新', 409, 'DRAFT_STATE');
      const e = risk.evaluate(user, candidate(current, held), stage, d.id);
      bank.run('UPDATE risk_drafts SET evaluation_id=?,updated_at=? WHERE id=?', e.evaluationId, now(), d.id);
      if (['HOLD_REVIEW', 'BLOCK'].includes(e.finalAction)) bank.run('UPDATE risk_drafts SET status=? WHERE id=?', e.finalAction === 'BLOCK' ? 'BLOCKED' : 'HOLD_REVIEW', d.id);
      return e;
    });
  }
  function view(user, draftId, session) {
    const d = owned(user, draftId), p = JSON.parse(d.payload), row = bank.get('SELECT snapshot FROM risk_evaluations WHERE id=?', d.evaluation_id);
    const e = row ? JSON.parse(row.snapshot) : null;
    const plan = adaptive && e ? authPlan(user, d, e, session) : null;
    // Reminders to check the payee only help before paying; they read as an unresolved warning afterwards.
    const finished = ['SETTLED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(d.status), messages = [];
    if (!finished && e?.reasonCodes.includes('NEW_BENEFICIARY')) messages.push('这是首次向该收款账户付款，请独立核对收款信息。');
    if (!finished && e?.reasonCodes.some(c => ['MONTHLY_ANOMALY', 'LARGE_VS_HISTORY', 'MILD_OUTFLOW_ANOMALY', 'BALANCE_DRAIN'].includes(c))) messages.push('本次或近期转出金额偏离历史情况，请确认用途与剩余资金。');
    if (['HOLD_REVIEW', 'BLOCKED'].includes(d.status)) messages.push('该草稿尚未提交，可在帮助与客服申请复核；这不会冻结您的银行账户。');
    return { id: d.id, version: d.version, payloadHash: d.payload_hash, status: d.status, sourceAccountRef: d.source_account_ref,
      beneficiaryRef: d.beneficiary_ref, beneficiaryName: p.beneficiaryName, beneficiaryMasked: p.beneficiaryMasked,
      institution: p.institution, amountMinor: d.amount_minor, currency: d.currency, memo: p.memo, feeMinor: p.feeMinor,
      paymentId: bank.get('SELECT id FROM risk_payments WHERE draft_id=?', d.id)?.id || null, updatedAt: d.updated_at,
      expiresAt: d.expires_at, simulation: true, confirmationUrl: `/#risk-transfer?id=${encodeURIComponent(d.id)}`,
      delegateApprovals: services.puma?.delegates.status(d) || [],
      risk: e ? { action: e.finalAction, messages, offers: e.offers, evaluationId: e.evaluationId,
        ...(plan ? { tier: plan.tier, policyVersion: plan.version, reasonCodes: plan.reasons, expiresAt: e.expiresAt } : {}) } : null };
  }
  function create(user, body, session) {
    return bank.atomic(() => {
      const p = parseInput(user, body), draftId = id('RD'), at = now();
      bank.run('INSERT INTO risk_drafts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', draftId, user.id, p.sourceAccountRef, p.beneficiaryRef,
        JSON.stringify(p), p.amountMinor, p.currency, 1, digest(user.id, draftId, 1, p), 'RISK_CHECKED', null, at, at, new Date(Date.parse(at) + 900000).toISOString());
      const d = owned(user, draftId); services.puma?.delegates.sync(d); evaluate(user, d, 'DRAFT');
      bank.audit(user.id, 'risk.draft.created', draftId, { version: 1 }); return view(user, draftId, session);
    });
  }
  function invalidate(d) {
    bank.run('UPDATE risk_approvals SET revoked_at=? WHERE draft_id=? AND revoked_at IS NULL', now(), d.id);
    const intents = bank.all('SELECT auth_action_id FROM risk_approval_intents WHERE draft_id=?', d.id);
    bank.run('UPDATE risk_approval_intents SET used_at=COALESCE(used_at,?) WHERE draft_id=?', now(), d.id);
    for (const i of intents) { bank.run('UPDATE verifications SET used=1 WHERE action_id=?', i.auth_action_id); bank.run("UPDATE agent_actions SET status='cancelled' WHERE id=? AND status='proposed'", i.auth_action_id); }
  }
  function patch(user, draftId, body, session) {
    return bank.atomic(() => {
      const d = owned(user, draftId);
      requireThat(editable.includes(d.status), '该草稿不可修改', 409, 'DRAFT_STATE');
      requireThat(body.version === d.version, '草稿已更新，请重新核对', 409, 'DRAFT_VERSION');
      const { version, ...changes } = body;
      const old = JSON.parse(d.payload), p = parseInput(user, { ...Object.fromEntries(fields.map(k => [k, old[k]])), ...changes });
      invalidate(d); const next = version + 1;
      bank.run("UPDATE risk_drafts SET source_account_ref=?,beneficiary_ref=?,payload=?,amount_minor=?,version=?,payload_hash=?,status='RISK_CHECKED',updated_at=? WHERE id=? AND version=?",
        p.sourceAccountRef, p.beneficiaryRef, JSON.stringify(p), p.amountMinor, next, digest(user.id, d.id, next, p), now(), d.id, version);
      services.puma?.delegates.sync(owned(user, d.id));
      evaluate(user, owned(user, d.id), 'DRAFT'); bank.audit(user.id, 'risk.draft.updated', d.id, { version: next }); return view(user, d.id, session);
    });
  }
  function match(d, body) { requireThat(body.version === d.version && body.payloadHash === d.payload_hash, '草稿版本或内容已变化，请重新确认', 409, 'DRAFT_VERSION'); }
  function intent(user, draftId, body, session) {
    requireThat(Object.keys(body).every(k => ['version', 'payloadHash'].includes(k)), '确认参数包含无效字段', 400, 'INVALID_APPROVAL');
    const d = owned(user, draftId); match(d, body);
    services.puma?.delegates.sync(d);
    requireThat(editable.includes(d.status), '草稿状态不可批准', 409, 'DRAFT_STATE');
    const e = evaluate(user, d, 'PRE_APPROVAL'); risk.assertAllowed(e);
    return bank.atomic(() => {
      const current = owned(user, d.id); match(current, body);
      requireThat(editable.includes(current.status) && !bank.get('SELECT id FROM risk_payments WHERE draft_id=?', d.id), '草稿状态已变化，请刷新', 409, 'DRAFT_STATE');
      invalidate(d);
      const challengeId = id('RC'), actionId = id('RISK_AUTH');
      const plan = authPlan(user, d, e, session);
      requireThat(!adaptive || plan.tier !== 'L3', '本笔转账超过账户限额', 409, 'DAILY_LIMIT');
      const level = plan.strong ? 'red' : 'yellow';
      const p = JSON.parse(d.payload), args = { draftId: d.id, version: d.version, payloadHash: d.payload_hash, challengeId,
        ...(adaptive && plan.tier === 'L1' && provider.allowsSinglePin === true ? { smsOnly: true } : {}), ...(session ? { sessionRef: session.ref } : {}) };
      const expires = new Date(Math.min(Date.now() + 300000, Date.parse(d.expires_at))).toISOString();
      bank.run('INSERT INTO agent_actions(id,user_id,channel,tool,args,title,level,amount,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', actionId, user.id, 'app', 'risk_transfer_approval', JSON.stringify(args),
        `模拟转账 ${(d.amount_minor / 100).toFixed(2)} CNY → ${p.beneficiaryName} ${p.beneficiaryMasked}`, level, 0, now(), expires, now());
      bank.run('UPDATE agent_actions SET params_digest=? WHERE id=?', paramsDigest(actionParams(bank.get('SELECT * FROM agent_actions WHERE id=?', actionId))), actionId);
      bank.run('INSERT INTO risk_approval_intents VALUES(?,?,?,?,?,?,?,?,?,?,?)', challengeId, user.id, d.id, d.version, d.payload_hash, actionId, level, plan.version, expires, null, now());
      bank.run("UPDATE risk_drafts SET status='AWAITING_APPROVAL' WHERE id=?", d.id);
      bank.audit(user.id, 'risk.approval.intent', d.id, { challengeId, version: d.version, level,
        ...(policy && policy.flags.risk_adaptive_auth !== 'disabled' ? { tier: plan.tier, mode: policy.flags.risk_adaptive_auth, reasons: plan.reasons, policyVersion: plan.version } : {}) });
      return { challengeId, version: d.version, payloadHash: d.payload_hash, verificationActionId: level === 'red' ? actionId : null,
        smsOnly: Boolean(args.smsOnly && services.verification.faceVerification.mode(user) === 'simulated_face'), expiresAt: expires, simulation: true, draft: view(user, d.id, session) };
    });
  }
  function approve(user, draftId, body, session) {
    requireThat(Object.keys(body).every(k => ['challengeId', 'version', 'payloadHash', 'pin', 'verificationToken'].includes(k)), '批准只能使用绑定交易的认证凭证', 400, 'INVALID_APPROVAL');
    services.pin(user, body.pin); // Rate-limited existing authentication; no boolean/chat approval.
    return bank.atomic(() => {
      const d = owned(user, draftId); match(d, body);
      requireThat(d.status === 'AWAITING_APPROVAL', '草稿未等待批准', 409, 'DRAFT_STATE');
      requireThat(typeof body.challengeId === 'string' && /^[\w-]{1,100}$/.test(body.challengeId), '批准挑战无效', 403, 'INVALID_CHALLENGE');
      const i = bank.get('SELECT * FROM risk_approval_intents WHERE id=? AND user_id=? AND draft_id=?', body.challengeId, user.id, d.id);
      requireThat(i && !i.used_at && i.expires_at > now() && i.version === d.version && i.payload_hash === d.payload_hash, '批准挑战已过期、已使用或不匹配', 403, 'INVALID_CHALLENGE');
      const { sessionRef } = JSON.parse(bank.get('SELECT args FROM agent_actions WHERE id=?', i.auth_action_id).args);
      requireThat(!sessionRef || sessionRef === session?.ref, '请在发起验证的登录会话中批准', 403, 'INVALID_CHALLENGE');
      let assertion = 'sandbox:pin';
      if (i.required_level === 'red') {
        const factors = services.verification.consume(user, i.auth_action_id, body.verificationToken);
        assertion = (factors.length === 1 ? 'sandbox:sms:' : 'sandbox:strong:') + hash(body.verificationToken);
      }
      const approvalId = id('RP');
      bank.run('INSERT INTO risk_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', approvalId, user.id, d.id, d.version, d.payload_hash, i.id, assertion,
        Number(i.required_level === 'red'), i.policy_version, i.expires_at, null, null, now());
      bank.run('UPDATE risk_approval_intents SET used_at=? WHERE id=? AND used_at IS NULL', now(), i.id);
      bank.run("UPDATE agent_actions SET status='completed' WHERE id=?", i.auth_action_id);
      bank.run("UPDATE risk_drafts SET status='USER_APPROVED' WHERE id=?", d.id);
      bank.audit(user.id, 'risk.user.approved', d.id, { approvalId, challengeId: i.id, version: d.version, simulation: true });
      risk.metric(user.id, d.id, d.evaluation_id, 'APPROVED'); return view(user, d.id);
    });
  }
  function applyEvent(event) {
    const p = provider.verify(event);
    return bank.atomic(() => {
      const payment = bank.get('SELECT * FROM risk_payments WHERE id=?', p.paymentId);
      requireThat(payment, '支付不存在', 404, 'PAYMENT_NOT_FOUND');
      const d = owned({ id: payment.user_id }, payment.draft_id), payload = JSON.parse(d.payload);
      requireThat(p.draftId === d.id && p.userId === d.user_id && p.payloadHash === d.payload_hash && p.amountMinor === d.amount_minor && p.currency === d.currency
        && p.providerKey === payment.provider_key && p.providerReference === `mock:${payment.id}`, '支付回调与交易不匹配', 403, 'PROVIDER_BINDING');
      const old = bank.get('SELECT payload_hash FROM risk_provider_events WHERE event_id=?', p.eventId);
      if (old) { requireThat(old.payload_hash === hash(JSON.stringify(p)), '支付事件冲突', 409, 'PROVIDER_CONFLICT'); return; }
      bank.run('INSERT INTO risk_provider_events VALUES(?,?,?,?,1,?)', p.eventId, payment.id, p.status, hash(JSON.stringify(p)), now());
      if (p.sequence <= payment.last_event_sequence || ['SETTLED', 'FAILED'].includes(payment.status)) { bank.audit(d.user_id, 'risk.payment.stale_event', payment.id); return; }
      if (p.status !== 'PENDING' && payment.held) {
        bank.run('UPDATE accounts SET held=held-? WHERE id=?', d.amount_minor, d.source_account_ref);
        if (p.status === 'SETTLED') {
          // Store a normal simulator transaction so existing ledger/history/risk views see it.
          const account = bank.get('SELECT number FROM accounts WHERE id=?', payload.targetId);
          bank.run('INSERT INTO transactions(id,user_id,type,amount,title,status,payload,account_id,created_at,updated_at,expires_at,idempotency_key,fingerprint,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            payment.id, d.user_id, 'transfer', d.amount_minor, `模拟转账 · ${payload.beneficiaryName}`, 'completed', JSON.stringify({ recipientName: payload.beneficiaryName, recipientAccount: account?.number || payload.beneficiaryMasked, bank: payload.institution, targetId: payload.targetId, simulation: true }), d.source_account_ref, now(), now(), d.expires_at, payment.provider_key, d.payload_hash, now());
          bank.post(payment.id, d.source_account_ref, payload.targetId, d.amount_minor, `模拟转账 · ${payload.beneficiaryName}`, 'transfer');
          bank.notify(d.user_id, '模拟转账已完成', `已向${payload.beneficiaryName}（${payload.beneficiaryMasked}）转账 ¥${(d.amount_minor / 100).toFixed(2)}，流水号 ${payment.id}。`);
        } else if (p.status === 'FAILED') bank.notify(d.user_id, '模拟转账未成功', `向${payload.beneficiaryName}（${payload.beneficiaryMasked}）的转账 ¥${(d.amount_minor / 100).toFixed(2)} 未成功，预留资金已释放。`);
      }
      bank.run('UPDATE risk_payments SET status=?,provider_reference=?,last_event_sequence=?,held=?,updated_at=? WHERE id=?', p.status, p.providerReference, p.sequence, p.status === 'PENDING' ? payment.held : 0, now(), payment.id);
      bank.run('UPDATE risk_drafts SET status=?,updated_at=? WHERE id=?', p.status, now(), d.id);
      bank.audit(d.user_id, 'risk.payment.' + p.status.toLowerCase(), payment.id, { simulation: true, eventId: p.eventId });
      risk.metric(d.user_id, d.id, d.evaluation_id, p.status);
    });
  }
  function submit(user, draftId, session) {
    const d = owned(user, draftId);
    if (bank.get('SELECT id FROM risk_payments WHERE draft_id=?', d.id)) return view(user, d.id);
    requireThat(d.status === 'USER_APPROVED', '缺少用户交易批准', 403, 'APPROVAL_REQUIRED');
    if(services.puma && !services.puma.delegates.ready(d)) return view(user,d.id);
    const e = evaluate(user, d, 'PRE_EXECUTION'); risk.assertAllowed(e);
    const payment = bank.atomic(() => {
      const latest = owned(user, d.id);
      requireThat(latest.status === 'USER_APPROVED' && latest.payload_hash === d.payload_hash, '草稿状态变化', 409, 'DRAFT_STATE');
      requireThat(!services.puma || services.puma.delegates.ready(latest),'共同确认未完成',409,'DELEGATE_APPROVAL_REQUIRED');
      bank.run("UPDATE risk_drafts SET status='PRE_EXECUTION_CHECK' WHERE id=?", d.id);
      const a = bank.get('SELECT * FROM risk_approvals WHERE user_id=? AND draft_id=? AND version=? AND payload_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1', user.id, d.id, d.version, d.payload_hash, now());
      requireThat(a, '批准失效，请重新确认', 403, 'APPROVAL_REQUIRED');
      const plan = authPlan(user, d, e, session);
      requireThat(a.policy_version === plan.version && (!plan.strong || a.strong), '风险或策略已变化，请重新批准', 403, 'REAPPROVAL_REQUIRED');
      requireThat(!a.auth_assertion_ref.startsWith('sandbox:sms:') || plan.tier !== 'L2' && services.verification.faceVerification.mode(user) === 'simulated_face',
        '需要更强验证，请重新批准', 403, 'REAPPROVAL_REQUIRED');
      const stored = JSON.parse(d.payload), refreshed = parseInput(user, Object.fromEntries(fields.map(k => [k, stored[k]])));
      requireThat(digest(user.id, d.id, d.version, refreshed) === d.payload_hash, '收款信息已变化，请修改草稿后重新确认', 403, 'BENEFICIARY_CHANGED');
      // Reuse account permission, balance and configured daily limit checks.
      const account = bank.get('SELECT * FROM accounts WHERE id=?', d.source_account_ref);
      const decision = decide(bank, user, 'propose_transfer', { amount: (d.amount_minor / 100).toFixed(2) });
      const freshUser = bank.get('SELECT daily_limit FROM users WHERE id=?', user.id);
      requireThat(decision.amounts.total <= freshUser.daily_limit, '超出已设置的每日限额', 409, 'DAILY_LIMIT');
      requireThat(account.balance - account.held >= d.amount_minor, '可用余额不足', 409, 'INSUFFICIENT_FUNDS');
      bank.run('UPDATE accounts SET held=held+? WHERE id=?', d.amount_minor, d.source_account_ref);
      bank.run('UPDATE risk_approvals SET consumed_at=? WHERE id=? AND consumed_at IS NULL', now(), a.id);
      const paymentId = id('RMP'), providerKey = `risk:${d.id}`;
      bank.run('INSERT INTO risk_payments VALUES(?,?,?,?,?,?,1,-1,?,?)', paymentId, d.id, user.id, providerKey, null, 'SUBMITTING', now(), now());
      bank.run("UPDATE risk_drafts SET status='SUBMITTING' WHERE id=?", d.id);
      bank.audit(user.id, 'risk.payment.submitting', paymentId, { approvalId: a.id, draftId: d.id });
      return { paymentId, draftId: d.id, userId: user.id, providerKey, payloadHash: d.payload_hash, amountMinor: d.amount_minor, currency: d.currency };
    });
    try { applyEvent(provider.submit(payment)); }
    catch {
      // Once handed to a provider, an error is uncertain. Never blindly resubmit.
      bank.atomic(() => { bank.run("UPDATE risk_payments SET status='PENDING' WHERE id=? AND status='SUBMITTING'", payment.paymentId); bank.run("UPDATE risk_drafts SET status='PENDING' WHERE id=? AND status='SUBMITTING'", d.id); bank.audit(user.id, 'risk.payment.uncertain', payment.paymentId); });
    }
    return view(user, d.id);
  }
  function reconcile() {
    for (const p of bank.all("SELECT * FROM risk_payments WHERE status IN ('SUBMITTING','PENDING')")) {
      try { const event = provider.query(p.provider_key); if (event) applyEvent(event); } catch { bank.audit(p.user_id, 'risk.payment.reconcile_unavailable', p.id); }
    }
  }
  function cancel(user, draftId) {
    return bank.atomic(() => { const d = owned(user, draftId); requireThat(editable.includes(d.status), '已提交或结束的支付不可取消', 409, 'DRAFT_STATE'); invalidate(d); bank.run("UPDATE risk_drafts SET status='CANCELLED' WHERE id=?", d.id); bank.audit(user.id, 'risk.draft.cancelled', d.id); risk.metric(user.id, d.id, d.evaluation_id, 'CANCELLED'); return view(user, d.id); });
  }
  // Agent-visible facade has no approve/submit/provider credentials.
  return { drafts: { create, view, patch, cancel }, approvals: { intent, approve }, executor: { submit, applyEvent, reconcile }, provider };
}
