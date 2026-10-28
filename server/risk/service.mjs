import { readFileSync } from 'node:fs';
import { id, now } from '../db.mjs';
import { hash, requireThat, BusinessError } from '../errors.mjs';
import { classifyRow } from '../agent/analytics.mjs';
import { redact } from '../agent/guard.mjs';
import { DEFAULT_AGE_POLICY, validateAgePolicy } from './age.mjs';
import { extractFeatures } from './features.mjs';
import { evaluatePolicy } from './policy.mjs';

const cleanText = text => redact(String(text)).replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[date]').slice(0, 1000);
export function createRiskService(bank, options = {}) {
  const rules = { noise: 10000, fallbackRate: .1, drainRatio: .5, dormantDays: 90, ...options.rules };
  requireThat(Number.isSafeInteger(rules.noise) && rules.noise > 0 && Number.isFinite(rules.fallbackRate) && rules.fallbackRate > 0 && rules.fallbackRate <= 1
    && Number.isFinite(rules.drainRatio) && rules.drainRatio > 0 && rules.drainRatio <= 1 && Number.isInteger(rules.dormantDays) && rules.dormantDays > 0, '风控规则配置无效', 503, 'INVALID_RISK_POLICY');
  const file = options.policyFile || process.env.RISK_POLICY_FILE;
  let policy = validateAgePolicy({ ...(file ? JSON.parse(readFileSync(file, 'utf8')) : DEFAULT_AGE_POLICY), ...(process.env.RISK_AGE_MODE ? { mode: process.env.RISK_AGE_MODE } : {}), ...options.agePolicy });
  const reviewers = new Set(options.reviewerIds || (process.env.RISK_REVIEWER_IDS || '').split(',').filter(Boolean));
  const sync = (adapter, ...args) => { const v = adapter?.(...args); if (v?.then) { v.catch?.(() => {}); throw new Error('Risk adapters must return bounded, synchronous trusted snapshots'); } return v; };
  function changePolicy(next, actor = 'backend') {
    const updated = validateAgePolicy(next);
    requireThat(updated.policyVersion !== policy.policyVersion || JSON.stringify(updated) === JSON.stringify(policy), '策略修改必须升级版本', 409, 'POLICY_VERSION_REQUIRED');
    bank.audit(null, 'risk.policy.changed', '', { previous: policy.policyVersion, next: updated.policyVersion, actor: hash(actor) }); policy = updated;
  }
  function rows(userId) {
    const ownNumbers = new Set(bank.all('SELECT number FROM accounts WHERE user_id=?', userId).map(a => a.number));
    return bank.all(`SELECT l.*,a.user_id,t.status AS tx_status,t.payload AS tx_payload FROM ledger l JOIN accounts a ON a.id=l.account_id
      LEFT JOIN transactions t ON t.id=l.transaction_id WHERE a.user_id=?`, userId).map(r => {
      const kind = classifyRow(r).kind, p = r.tx_payload ? JSON.parse(r.tx_payload) : {};
      const target = p.targetId ? bank.get('SELECT user_id FROM accounts WHERE id=?', p.targetId) : null;
      return { transaction_id: r.transaction_id, user_id: r.user_id, account_ref: r.account_id, occurred_at: r.created_at,
        currency: 'CNY', amount_minor: Math.abs(r.amount), direction: r.amount < 0 ? 'OUT' : 'IN',
        status: r.tx_status && r.tx_status !== 'completed' ? 'PENDING' : 'SETTLED',
        category: kind === 'transfer_out' || kind === 'self' ? 'transfer' : kind, own_account: target?.user_id === userId || ownNumbers.has(r.counterparty_account),
        refund: kind === 'refund', recurring: /^(订阅 · )/.test(r.title),
        payee_ref: p.recipientAccount || r.counterparty_account ? hash(p.recipientAccount || r.counterparty_account) : null };
    });
  }
  function evaluate(user, candidate, stage = 'ANALYSIS', draftId = null) {
    const started = performance.now(), at = now();
    let evaluation, features;
    try {
      requireThat(sync(options.available) !== false, '风控服务暂不可用', 503, 'RISK_UNAVAILABLE');
      const identity = sync(options.identity, user.id) || null;
      const trusted = { at, events: sync(options.signals, user.id, candidate) || [] };
      const account = candidate?.sourceAccountRef ? bank.get('SELECT * FROM accounts WHERE id=? AND user_id=?', candidate.sourceAccountRef, user.id) : null;
      features = extractFeatures({ rows: sync(options.transactions, user.id) || rows(user.id), userId: user.id, currency: candidate?.currency || 'CNY', at,
        timezone: policy.businessTimezone, candidate, coverageStart: sync(options.coverageStart, user.id),
        noise: rules.noise, fallbackRate: rules.fallbackRate,
        balance: account ? { available: account.balance - account.held + (candidate.heldByThisPayment || 0), currency: 'CNY', asOf: at } : null });
      evaluation = evaluatePolicy(features, candidate, trusted, identity, policy, rules);
      evaluation.policyVersion += '/' + hash(JSON.stringify({ policy, rules })).slice(0, 12);
    } catch { throw new BusinessError('暂时无法完成风险检查，请稍后重试', 503, 'RISK_UNAVAILABLE'); }
    const evaluationId = id('RE'), policyFactsHash = hash(JSON.stringify({ features, signals: evaluation.signals, candidate }));
    // Persist allowlisted, hashed evidence only. Neither DOB nor upstream text reaches logs/LLM.
    const safe = { ...evaluation, evidenceRefs: evaluation.evidenceRefs.map(hash), signals: undefined,
      evaluationId, policyFactsHash, stage, evaluatedAt: at, latencyMs: Math.round(performance.now() - started) };
    bank.atomic(() => {
      bank.run('INSERT INTO risk_evaluations VALUES(?,?,?,?,?,?,?,?,?,?,?)', evaluationId, user.id, draftId, stage, safe.coreAction, safe.finalAction,
        safe.protectionProfile, safe.policyVersion, policyFactsHash, JSON.stringify(safe), at);
      bank.audit(user.id, 'risk.evaluated', evaluationId, { stage, coreAction: safe.coreAction, finalAction: safe.finalAction, ageEffect: safe.ageEffect,
        policyVersion: safe.policyVersion, objectiveEvidenceGroups: safe.objectiveEvidenceGroups, factsHash: policyFactsHash });
      const types = new Set(evaluation.signals.map(s => s.group === 'beneficiary_change' ? 'NEW_OR_CHANGED_PAYEE' : s.group === 'account_security_change' ? 'ACCOUNT_SECURITY_ALERT' : s.severity === 'block' ? 'POTENTIAL_SCAM_SIGNAL' : 'UNUSUAL_TRANSACTION'));
      if (safe.ageEffect !== 'NONE') types.add('AGE_PROTECTION_APPLIED');
      for (const type of types) {
        const scope = draftId || 'analysis';
        if (!bank.get("SELECT f.id FROM risk_flags f JOIN risk_evaluations e ON e.id=f.evaluation_id WHERE f.user_id=? AND f.scope_ref=? AND f.flag_type=? AND f.expires_at>? AND (f.status IN ('OPEN','UNDER_REVIEW') OR (f.status='FALSE_POSITIVE' AND e.facts_hash=?))", user.id, scope, type, at, policyFactsHash))
          bank.run('INSERT INTO risk_flags VALUES(?,?,?,?,?,?,?,?,?)', id('RF'), user.id, scope, type, 'OPEN', evaluationId, at, new Date(Date.parse(at) + 7 * 86400000).toISOString(), at);
      }
    });
    return safe;
  }
  function assertAllowed(evaluation) { requireThat(!['HOLD_REVIEW', 'BLOCK'].includes(evaluation.finalAction), '该草稿尚未提交，请通过帮助与客服申请复核', 409, evaluation.finalAction === 'BLOCK' ? 'RISK_BLOCKED' : 'RISK_HOLD_REVIEW'); }
  function expire() {
    for (const f of bank.all("SELECT id,user_id FROM risk_flags WHERE status IN ('OPEN','UNDER_REVIEW','CONFIRMED') AND expires_at<=?", now())) bank.atomic(() => {
      bank.run("UPDATE risk_flags SET status='EXPIRED',updated_at=? WHERE id=?", now(), f.id); bank.audit(f.user_id, 'risk.flag.expired', f.id);
    });
  }
  function flags(user) { expire(); return bank.all('SELECT id,scope_ref,flag_type,status,expires_at,updated_at FROM risk_flags WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id); }
  function reviewer(user) { requireThat(reviewers.has(user.id), '无风控审核权限', 403, 'REVIEW_FORBIDDEN'); }
  function queue(user) { reviewer(user); expire(); return bank.all("SELECT f.*,e.snapshot FROM risk_flags f JOIN risk_evaluations e ON e.id=f.evaluation_id WHERE f.status IN ('OPEN','UNDER_REVIEW') ORDER BY f.created_at LIMIT 100").map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) })); }
  function review(user, body) {
    reviewer(user); expire();
    requireThat(typeof body.rationale === 'string' && body.rationale.trim().length >= 5 && body.rationale.length <= 1000, '请填写复核理由');
    return bank.atomic(() => {
      const f = bank.get('SELECT * FROM risk_flags WHERE id=?', body.flagId);
      requireThat(f && (f.status === 'OPEN' ? ['UNDER_REVIEW'] : f.status === 'UNDER_REVIEW' ? ['CONFIRMED', 'FALSE_POSITIVE', 'RESOLVED'] : []).includes(body.disposition), '复核状态转换无效', 409, 'REVIEW_STATE');
      requireThat(body.disposition !== 'CONFIRMED' || (typeof body.nextReviewAt === 'string' && body.nextReviewAt > now() && Number.isFinite(Date.parse(body.nextReviewAt))), '确认风险需要下次复核时间');
      const reviewId = id('RR');
      bank.run('INSERT INTO risk_reviews VALUES(?,?,?,?,?,?,?)', reviewId, f.id, user.id, body.disposition, cleanText(body.rationale), body.nextReviewAt || null, now());
      bank.run('UPDATE risk_flags SET status=?,updated_at=? WHERE id=?', body.disposition, now(), f.id);
      bank.audit(f.user_id, 'risk.reviewed', f.id, { reviewerId: user.id, reviewId, disposition: body.disposition });
      return { id: reviewId, status: body.disposition };
    });
  }
  function appeal(user, body) {
    const f = bank.get('SELECT * FROM risk_flags WHERE id=? AND user_id=?', body.flagId, user.id);
    requireThat(f, '无权访问此风险事件', 403, 'RISK_FORBIDDEN');
    requireThat(typeof body.rationale === 'string' && body.rationale.trim().length >= 5 && body.rationale.length <= 1000, '请填写申诉原因');
    const appealId = id('RA');
    bank.atomic(() => { bank.run('INSERT INTO risk_appeals VALUES(?,?,?,?,?)', appealId, user.id, f.id, cleanText(body.rationale), now()); bank.audit(user.id, 'risk.appealed', f.id, { appealId }); });
    return { id: appealId, status: 'SUBMITTED', message: '草稿尚未提交；可在帮助与客服查询处理进度。' };
  }
  function metric(userId, draftId, evaluationId, kind) { bank.run('INSERT INTO risk_metrics VALUES(?,?,?,?,?,?)', id('RM'), userId, draftId, evaluationId, kind, now()); }
  function fairness(user) {
    reviewer(user);
    const result = bank.all(`SELECT strftime('%Y-%W',e.created_at) AS week,e.policy_version,e.age_band,e.core_action,
      json_extract(e.snapshot,'$.boundaryCohort') AS boundary_cohort,COUNT(*) AS n,SUM(e.final_action='STEP_UP') AS stepups,
      SUM(EXISTS(SELECT 1 FROM risk_metrics m WHERE m.draft_id=e.draft_id AND m.kind='APPROVED')) AS approved,
      SUM(EXISTS(SELECT 1 FROM risk_metrics m WHERE m.draft_id=e.draft_id AND m.kind='SETTLED')) AS completed,
      SUM(EXISTS(SELECT 1 FROM risk_metrics m WHERE m.draft_id=e.draft_id AND m.kind='CANCELLED')) AS cancelled,
      SUM(EXISTS(SELECT 1 FROM risk_metrics m WHERE m.draft_id=e.draft_id AND m.kind='AUTH_FAILURE')) AS auth_failed,
      SUM(EXISTS(SELECT 1 FROM risk_flags f JOIN risk_appeals a ON a.flag_id=f.id WHERE f.scope_ref=e.draft_id)) AS appealed,
      SUM(EXISTS(SELECT 1 FROM risk_flags f WHERE f.scope_ref=e.draft_id AND f.status='FALSE_POSITIVE')) AS false_positive,
      AVG(json_extract(e.snapshot,'$.latencyMs')) AS mean_latency_ms
      FROM risk_evaluations e WHERE e.stage='PRE_APPROVAL'
      AND e.rowid=(SELECT MAX(e2.rowid) FROM risk_evaluations e2 WHERE e2.draft_id=e.draft_id AND e2.stage='PRE_APPROVAL')
      GROUP BY week,e.policy_version,e.age_band,e.core_action,boundary_cohort
    `);
    return result.map(r => ({ ...r, sampleStatus: r.n >= 20 ? 'DESCRIPTIVE_ONLY' : 'INSUFFICIENT_DATA',
      rates: Object.fromEntries(['stepups', 'approved', 'completed', 'cancelled', 'auth_failed', 'appealed', 'false_positive'].map(k => [k, r.n >= 20 ? r[k] / r.n : null])),
      confirmedFraudLossRate: null, accessibilityErrorRate: null, unavailableReason: 'NO_VERIFIED_OUTCOME_FEED' }));
  }
  function legacy(user, body, stage, resource) {
    if (body.type !== 'transfer') return null;
    const target = bank.get('SELECT user_id FROM accounts WHERE number=?', body.recipientAccount);
    return evaluate(user, { sourceAccountRef: body.accountId || bank.get("SELECT id FROM accounts WHERE user_id=? AND type='debit' ORDER BY rowid LIMIT 1", user.id)?.id,
      beneficiaryRef: hash(body.recipientAccount), amountMinor: body.amountMinor, currency: 'CNY', category: 'transfer', ownAccount: target?.user_id === user.id,
      heldByThisPayment: body.heldByThisPayment || 0 }, stage, resource);
  }
  return { evaluate, assertAllowed, flags, queue, review, appeal, fairness, metric, legacy, changePolicy, expire };
}
