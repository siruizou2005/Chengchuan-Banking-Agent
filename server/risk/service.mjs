import { readFileSync } from 'node:fs';
import { id, now } from '../db.mjs';
import { hash, requireThat, BusinessError } from '../errors.mjs';
import { classifyRow } from '../agent/analytics.mjs';
import { redact } from '../agent/guard.mjs';
import { DEFAULT_AGE_POLICY, validateAgePolicy } from './age.mjs';
import { extractFeatures } from './features.mjs';
import { evaluatePolicy, eventSignals, flagTypeOf } from './policy.mjs';

const cleanText = text => redact(String(text)).replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[date]').slice(0, 1000);
export function createRiskService(bank, options = {}) {
  const rules = { noise: 10000, fallbackRate: .1, drainRatio: .5, dormantDays: 90, ...options.pumaRules, ...options.rules };
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
        refund: kind === 'refund', recurring: /^(?:消费 · )?订阅 · /.test(r.title),
        payee_ref: p.payeeToken || (p.recipientAccount || r.counterparty_account ? hash(p.recipientAccount || r.counterparty_account) : null) };
    });
  }
  function evaluate(user, candidate, stage = 'ANALYSIS', draftId = null) {
    const started = performance.now(), at = now(), candidateDigest = hash(JSON.stringify(candidate ?? null));
    let evaluation, features;
    try {
      requireThat(sync(options.available) !== false, '风控服务暂不可用', 503, 'RISK_UNAVAILABLE');
      const identity = sync(options.identity, user.id) || null;
      expire();
      const trusted = { at, events: [...(sync(options.signals, user.id, candidate) || [])] };
      // A false positive only clears what the reviewer examined: that flag type, that event and source, on these transfer facts.
      // Confirmed provider fraud is corrected at its source, never by a review (ADR-001). reasonCodes starts with the signal codes, aligned with evidenceRefs.
      const reviewed=bank.all(`SELECT e.snapshot,f.flag_type,f.updated_at FROM risk_flags f JOIN risk_evaluations e ON e.id=f.evaluation_id
        WHERE f.user_id=? AND f.scope_ref=? AND f.status='FALSE_POSITIVE' AND f.expires_at>?`,user.id,draftId||'analysis',at).map(r=>({...r,snapshot:JSON.parse(r.snapshot)}));
      const released=event=>event.type!=='CONFIRMED_FRAUD'&&event.occurredAt&&eventSignals(event,at).some(s=>reviewed.some(r=>r.flag_type===flagTypeOf(s)&&event.occurredAt<=r.updated_at&&r.snapshot.candidateDigest===candidateDigest
        &&r.snapshot.evidenceRefs.some((ref,i)=>ref===hash(s.evidenceRef)&&r.snapshot.reasonCodes[i]===s.code)));
      trusted.events=trusted.events.filter(event=>!released(event));
      // A confirmed flag binds until a reviewer closes it: its next-review date schedules work, it does not end the risk.
      if(candidate?.beneficiaryRef)for(const flag of bank.all(`SELECT f.*,l.subject_ref FROM risk_flags f JOIN puma_risk_links l ON l.flag_id=f.id
        WHERE f.user_id=? AND l.scope='payee' AND l.subject_ref=? AND l.severity='HIGH' AND (f.status='CONFIRMED' OR (f.status IN ('OPEN','UNDER_REVIEW') AND f.expires_at>?))`,user.id,candidate.beneficiaryRef,at)){
        const fraud=bank.get("SELECT id FROM puma_feedback WHERE flag_id=? AND outcome='CONFIRMED_FRAUD'",flag.id);
        trusted.events.push({type:fraud?'CONFIRMED_FRAUD':'REPEAT_SUSPICIOUS_PAYEE',verified:true,sourceRef:flag.id,occurredAt:flag.created_at,expiresAt:flag.status==='CONFIRMED'?new Date(Date.parse(at)+86400000).toISOString():flag.expires_at});
      }
      const account = candidate?.sourceAccountRef ? bank.get('SELECT * FROM accounts WHERE id=? AND user_id=?', candidate.sourceAccountRef, user.id) : null;
      features = extractFeatures({ rows: sync(options.transactions, user.id) || rows(user.id), userId: user.id, currency: candidate?.currency || 'CNY', at,
        timezone: policy.businessTimezone, candidate, coverageStart: sync(options.coverageStart, user.id),
        noise: rules.noise, fallbackRate: rules.fallbackRate, windowMinutes:rules.windowMinutes,
        balance: account ? { available: account.balance - account.held + (candidate.heldByThisPayment || 0), currency: 'CNY', asOf: at } : null });
      evaluation = evaluatePolicy(features, candidate, trusted, identity, policy, rules);
      // Legacy payment and scheduled-plan callers cannot prove a trusted browser session.
      if (options.adaptiveAuth && candidate?.legacy && ['ALLOW', 'WARN'].includes(evaluation.finalAction)) {
        evaluation.finalAction = 'STEP_UP';
        evaluation.reasonCodes.push('SESSION_ASSURANCE_REQUIRED');
      }
      evaluation.policyVersion += '/' + hash(JSON.stringify({ policy, rules })).slice(0, 12);
    } catch { throw new BusinessError('暂时无法完成风险检查，请稍后重试', 503, 'RISK_UNAVAILABLE'); }
    const evaluationId = id('RE'), policyFactsHash = hash(JSON.stringify({ features, signals: evaluation.signals, candidate }));
    // A failed/uncalibrated research adapter never changes deterministic payment decisions.
    let modelStatus='RESEARCH_ONLY';
    if(options.scamPredictor)try{sync(options.scamPredictor,user.id,candidate);}catch{modelStatus='UNAVAILABLE';bank.run('INSERT INTO puma_metrics(user_id,kind,value,created_at) VALUES(?,?,1,?)',user.id,'MODEL_UNAVAILABLE',at);}
    // Persist allowlisted, hashed evidence only. Neither DOB nor upstream text reaches logs/LLM.
    const safe = { ...evaluation, evidenceRefs: evaluation.evidenceRefs.map(hash), signals: undefined,
      familiarPayee: features.newBeneficiary === false, adequateSample: features.sampleCount >= rules.minimumSamples,
      evaluationId, policyFactsHash, candidateDigest, stage, evaluatedAt: at, latencyMs: Math.round(performance.now() - started), modelStatus,
      risk_decision_id:evaluationId, expiresAt:new Date(Date.parse(at)+300000).toISOString(),recheck_required:true,
      actions:[({ALLOW:'ALLOW',WARN:'NOTICE',STEP_UP:'STEP_UP',HOLD_REVIEW:'MANUAL_REVIEW',BLOCK:'REJECT'})[evaluation.finalAction]] };
    const severe = ['HOLD_REVIEW', 'BLOCK'].includes(safe.coreAction), subject = candidate?.beneficiaryRef || draftId || 'analysis';
    const record = () => bank.atomic(() => {
      if (bank.get('SELECT id FROM risk_evaluations WHERE id=?', evaluationId)) return;
      bank.run('INSERT INTO risk_evaluations VALUES(?,?,?,?,?,?,?,?,?,?,?)', evaluationId, user.id, draftId, stage, safe.coreAction, safe.finalAction,
        safe.protectionProfile, safe.policyVersion, policyFactsHash, JSON.stringify(safe), at);
      bank.audit(user.id, 'risk.evaluated', evaluationId, { stage, coreAction: safe.coreAction, finalAction: safe.finalAction, ageEffect: safe.ageEffect,
        policyVersion: safe.policyVersion, objectiveEvidenceGroups: safe.objectiveEvidenceGroups, factsHash: policyFactsHash });
      const types = new Set(evaluation.signals.map(flagTypeOf));
      if (safe.ageEffect !== 'NONE') types.add('AGE_PROTECTION_APPLIED');
      for (const type of types) {
        const scope = draftId || 'analysis';
        const existing = bank.get("SELECT f.id FROM risk_flags f JOIN risk_evaluations e ON e.id=f.evaluation_id JOIN puma_risk_links l ON l.flag_id=f.id WHERE f.user_id=? AND f.scope_ref=? AND f.flag_type=? AND l.subject_ref=? AND f.expires_at>? AND (f.status IN ('OPEN','UNDER_REVIEW') OR (f.status='FALSE_POSITIVE' AND e.facts_hash=?))", user.id, scope, type, subject, at, policyFactsHash);
        if (!existing) bank.run('INSERT INTO risk_flags VALUES(?,?,?,?,?,?,?,?,?)', id('RF'), user.id, scope, type, 'OPEN', evaluationId, at, new Date(Date.parse(at) + (rules.riskFlagDays ?? 7) * 86400000).toISOString(), at);
        // Severity follows the gravest decision on this concern, not the first one, so payee-level checks see the escalation.
        else if (severe) bank.run("UPDATE puma_risk_links SET severity='HIGH' WHERE flag_id=?", existing.id);
      }
      for(const f of bank.all('SELECT * FROM risk_flags WHERE evaluation_id=?',evaluationId)){
        bank.audit(user.id,'risk.flag.created',f.id,{evaluationId});
        const event=bank.get("SELECT event_id FROM puma_events WHERE user_id=? AND type='RISK_FLAG_UPDATED' AND resource_ref=? ORDER BY ingested_at DESC LIMIT 1",user.id,'ref:'+hash(f.id));
        bank.run('INSERT OR IGNORE INTO puma_risk_links VALUES(?,?,?,?,?,?,?,?,?)',f.id,user.id,candidate?.beneficiaryRef?'payee':'transaction',subject,severe?'HIGH':'LOW',JSON.stringify(event?[event.event_id]:[]),safe.policyVersion,null,new Date(Date.parse(at)+86400000).toISOString());
      }
      bank.run('INSERT INTO puma_metrics(user_id,kind,value,created_at) VALUES(?,?,?,?)',user.id,'RISK_LATENCY_MS',safe.latencyMs,at);
    });
    record();
    // A denial usually aborts the caller's transaction; the decision and its flags must survive that rollback.
    if (['HOLD_REVIEW', 'BLOCK'].includes(safe.finalAction)) bank.afterTransaction(record);
    return safe;
  }
  function assertAllowed(evaluation) { requireThat(!['HOLD_REVIEW', 'BLOCK'].includes(evaluation.finalAction), '该草稿尚未提交，请通过帮助与客服申请复核', 409, evaluation.finalAction === 'BLOCK' ? 'RISK_BLOCKED' : 'RISK_HOLD_REVIEW'); }
  function expire() {
    for (const f of bank.all("SELECT id,user_id FROM risk_flags WHERE status IN ('OPEN','UNDER_REVIEW') AND expires_at<=?", now())) bank.atomic(() => {
      bank.run("UPDATE risk_flags SET status='EXPIRED',updated_at=? WHERE id=?", now(), f.id); bank.audit(f.user_id, 'risk.flag.expired', f.id);
    });
  }
  function flags(user) { expire(); return bank.all('SELECT id,scope_ref,flag_type,status,expires_at,updated_at FROM risk_flags WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id); }
  function reviewer(user) { requireThat(reviewers.has(user.id), '无风控审核权限', 403, 'REVIEW_FORBIDDEN'); }
  function queue(user) { reviewer(user); expire(); return bank.all("SELECT f.*,e.snapshot FROM risk_flags f JOIN risk_evaluations e ON e.id=f.evaluation_id WHERE f.status IN ('OPEN','UNDER_REVIEW') OR (f.status='CONFIRMED' AND f.expires_at<=?) ORDER BY f.created_at LIMIT 100", now()).map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) })); }
  function review(user, body) {
    reviewer(user); expire();
    requireThat(typeof body.flagId === 'string', '风险事件无效', 400, 'INVALID_FLAG');
    requireThat(typeof body.rationale === 'string' && body.rationale.trim().length >= 5 && body.rationale.length <= 1000, '请填写复核理由');
    return bank.atomic(() => {
      const f = bank.get('SELECT * FROM risk_flags WHERE id=?', body.flagId), at = now(), nextReview = typeof body.nextReviewAt === 'string' ? body.nextReviewAt : null;
      requireThat(f && ({ OPEN: ['UNDER_REVIEW'], UNDER_REVIEW: ['CONFIRMED', 'FALSE_POSITIVE', 'RESOLVED'], CONFIRMED: ['UNDER_REVIEW'] }[f.status] || []).includes(body.disposition), '复核状态转换无效', 409, 'REVIEW_STATE');
      requireThat(body.disposition !== 'CONFIRMED' || Date.parse(nextReview) > Date.now(), '确认风险需要下次复核时间');
      const reviewId = id('RR');
      bank.run('INSERT INTO risk_reviews VALUES(?,?,?,?,?,?,?)', reviewId, f.id, user.id, body.disposition, cleanText(body.rationale), nextReview, at);
      // A confirmation carries its review date as expiry and returns to the queue when due. Reopening starts a normal window, or the sweep would retire it at once.
      const expires = body.disposition === 'CONFIRMED' ? new Date(nextReview).toISOString() : f.status === 'CONFIRMED' ? new Date(Date.parse(at) + (rules.riskFlagDays ?? 7) * 86400000).toISOString() : f.expires_at;
      bank.run('UPDATE risk_flags SET status=?,updated_at=?,expires_at=? WHERE id=?', body.disposition, at, expires, f.id);
      bank.run("UPDATE puma_risk_links SET review_owner=?,review_due=COALESCE(?,review_due),severity=CASE WHEN ?='CONFIRMED' THEN 'HIGH' ELSE severity END WHERE flag_id=?",user.id,nextReview,body.disposition,f.id);
      bank.audit(f.user_id, 'risk.reviewed', f.id, { reviewerId: user.id, reviewId, disposition: body.disposition });
      return { id: reviewId, status: body.disposition };
    });
  }
  function appeal(user, body) {
    requireThat(typeof body.flagId === 'string', '风险事件无效', 400, 'INVALID_FLAG');
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
      legacy: true, heldByThisPayment: body.heldByThisPayment || 0 }, stage, resource);
  }
  return { evaluate, assertAllowed, flags, queue, review, appeal, fairness, metric, legacy, changePolicy, expire, rows };
}
