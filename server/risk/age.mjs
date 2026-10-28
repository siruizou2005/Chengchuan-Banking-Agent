import { readFileSync } from 'node:fs';

export const DEFAULT_AGE_POLICY = JSON.parse(readFileSync(new URL('./age-policy.json', import.meta.url), 'utf8'));
export function validateAgePolicy(input) {
  const p = structuredClone(input);
  if (!p || !/^[\w.-]{1,80}$/.test(p.policyVersion) || !['shadow', 'enforce'].includes(p.mode)
      || typeof p.jurisdiction !== 'string' || !Array.isArray(p.bands) || p.bands.length !== 5
      || p.bands.some((b, i) => b.name !== DEFAULT_AGE_POLICY.bands[i].name || !Number.isInteger(b.min) || b.min < 18 || b.min > 120 || (i && b.min <= p.bands[i - 1].min))
      || p.bands[0].min !== 18 || !Number.isInteger(p.stepUpGroups) || p.stepUpGroups < 2
      || ['warningAge', 'stepUpAge', 'verificationOfferAge', 'assistanceAge'].some(k => !Number.isInteger(p[k]) || p[k] < 60 || p[k] > 120)) throw new Error('Invalid age policy');
  new Intl.DateTimeFormat('en', { timeZone: p.businessTimezone }).format(new Date());
  return p;
}
export function localDate(at, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function ageInYears(identity, at, timezone = 'Asia/Shanghai') {
  if (!identity?.verified || !identity.sourceRef || !validDate(identity.dob)) return null;
  const today = localDate(at, timezone), dob = identity.dob;
  if (dob > today) return null;
  const year = Number(today.slice(0, 4));
  let anniversary = dob.slice(5);
  if (anniversary === '02-29' && !validDate(`${year}-02-29`)) anniversary = '03-01';
  return year - Number(dob.slice(0, 4)) - (today.slice(5) < anniversary ? 1 : 0);
}
export function applyAgePolicy(coreAction, signals, identity, at, config = DEFAULT_AGE_POLICY) {
  const p = validateAgePolicy(config), age = ageInYears(identity, at, p.businessTimezone);
  const protectionProfile = age === null || age < 18 ? 'UNKNOWN' : p.bands.findLast(b => age >= b.min).name;
  // Evidence is supplied by the deterministic detector, never a user/LLM request.
  const sources = new Set();
  const groups = [...new Set(signals.filter(s => {
    if (!s.objective || !s.group || !s.evidenceRef || sources.has(s.evidenceRef)) return false;
    sources.add(s.evidenceRef); return true;
  }).map(s => s.group))];
  const offers = [];
  let proposedAction = coreAction, ageEffect = 'NONE';
  if (age !== null && age >= p.warningAge && groups.length) { offers.push('CONTEXTUAL_WARNING'); ageEffect = 'WARN_ONLY'; }
  if (age !== null && age >= p.stepUpAge && coreAction === 'WARN' && groups.length >= p.stepUpGroups) { proposedAction = 'STEP_UP'; ageEffect = 'STEP_UP'; }
  if (age !== null && age >= p.verificationOfferAge && groups.length) offers.push('INDEPENDENT_VERIFICATION_OFFER');
  if (age !== null && age >= p.assistanceAge) { offers.push('ACCESSIBLE_ASSISTANCE_OFFER'); if (ageEffect === 'NONE') ageEffect = 'ASSISTANCE_OFFERED'; }
  return { protectionProfile, finalAction: p.mode === 'enforce' ? proposedAction : coreAction,
    proposedAction, ageEffect: p.mode === 'enforce' ? ageEffect : 'NONE', proposedAgeEffect: ageEffect,
    objectiveEvidenceGroups: groups, offers: p.mode === 'enforce' ? offers : [], proposedOffers: offers, agePolicyVersion: p.policyVersion, ageMode: p.mode,
    boundaryCohort: [59, 60, 64, 65, 69, 70, 79, 80].includes(age) ? String(age) : null };
}
