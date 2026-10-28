import { applyAgePolicy } from './age.mjs';

export const RISK_VERSION = 'risk-mvp-v1';
export function detectSignals(f, candidate, trusted = {}, config = {}) {
  const noise = config.noise ?? 10000, amount = candidate?.amountMinor || 0, result = [];
  const add = (code, group, severity = 'moderate', evidenceRef = code) => result.push({ code, group, severity, evidenceRef, objective: true });
  if (!candidate?.ownAccount) {
    if (f.newBeneficiary) add('NEW_BENEFICIARY', 'beneficiary_change');
    const m = f.monthly[candidate?.category || 'transfer'];
    if (m?.months >= 6 && m.current + amount > m.median + 3 * m.scale && m.current + amount > noise) add('MONTHLY_ANOMALY', 'unusual_outflow');
    if (f.sampleCount >= 20 && amount > Math.max(3 * f.single.median, f.single.p95, noise)) add('LARGE_VS_HISTORY', 'unusual_outflow');
    else if (f.sampleCount >= 20 && amount > Math.max(1.5 * f.single.median, noise)) add('MILD_OUTFLOW_ANOMALY', 'unusual_outflow', 'mild');
    if (f.historyDays >= 90 && ((f.windows.h24.count + 1 > f.dailyCount.median + 3 * f.dailyCount.scale && f.windows.h24.amount + amount > f.dailyAmount.median + 3 * f.dailyAmount.scale)
      || (f.windows.d7.count + 1 > f.weeklyCount.median + 3 * f.weeklyCount.scale && f.windows.d7.amount + amount > f.weeklyAmount.median + 3 * f.weeklyAmount.scale))) add('VELOCITY_SPIKE', 'transaction_velocity');
    if (f.balance !== null && amount + f.windows.h24.amount >= f.balance * (config.drainRatio ?? .5) && amount > noise) add('BALANCE_DRAIN', 'balance_drain');
    if (f.newBeneficiary && f.lastOutAt && Date.parse(trusted.at) - Date.parse(f.lastOutAt) > (config.dormantDays ?? 90) * 86400000 && amount > noise) add('DORMANT_REACTIVATION', 'transaction_velocity');
  }
  // Only trusted backend adapters may produce these facts. Expired facts are ignored.
  for (const e of trusted.events || []) {
    if (!e.verified || !e.sourceRef || !e.expiresAt || e.expiresAt <= trusted.at || e.occurredAt > trusted.at) continue;
    if (e.type === 'BENEFICIARY_CHANGED') add(e.type, 'beneficiary_change', 'moderate', e.sourceRef);
    if (e.type === 'ATO_SEQUENCE') add(e.type, 'account_security_change', e.confirmed ? 'severe' : 'moderate', e.sourceRef);
    if (e.type === 'CONFIRMED_FRAUD') add(e.type, 'confirmed_external_fraud_intelligence', 'block', e.sourceRef);
    if (e.type === 'NAME_MISMATCH') add(e.type, 'beneficiary_verification_mismatch', 'moderate', e.sourceRef);
  }
  return result;
}
export function coreDecision(signals) {
  if (signals.some(s => s.severity === 'block')) return 'BLOCK';
  if (signals.some(s => s.severity === 'severe')) return 'HOLD_REVIEW';
  // Multiple aliases of one event never count as independent evidence.
  const sources = new Set(), groups = new Set();
  for (const s of signals.filter(s => s.severity === 'moderate')) if (!sources.has(s.evidenceRef)) { sources.add(s.evidenceRef); groups.add(s.group); }
  return groups.size >= 2 ? 'STEP_UP' : signals.length ? 'WARN' : 'ALLOW';
}
export function evaluatePolicy(features, candidate, trusted, identity, agePolicy, rules) {
  const raw = detectSignals(features, candidate, trusted, rules), seen = new Set();
  const signals = raw.filter(s => { if (seen.has(s.evidenceRef)) return false; seen.add(s.evidenceRef); return true; });
  const coreAction = coreDecision(signals), age = applyAgePolicy(coreAction, signals, identity, trusted.at, agePolicy);
  return { coreAction, ...age, policyVersion: `${RISK_VERSION}/${age.agePolicyVersion}/${age.ageMode}`,
    reasonCodes: [...signals.map(s => s.code), ...features.notices, ...(features.balance === null ? ['UNKNOWN_FEATURE'] : []), ...(age.ageEffect === 'STEP_UP' ? ['AGE_STEP_UP_APPLIED'] : [])],
    evidenceRefs: signals.map(s => s.evidenceRef), signals };
}
