import { localDate } from './age.mjs';

const DAY = 86400000;
export const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (s[Math.floor((n - 1) / 2)] + s[Math.floor(n / 2)]) / 2 : null; };
export function robust(values, noise = 10000, fallbackRate = .1) {
  const middle = median(values);
  if (middle === null) return null;
  const mad = median(values.map(v => Math.abs(v - middle)));
  return { median: middle, mad, scale: Math.max(1.4826 * mad, fallbackRate * middle, noise),
    p95: values.length >= 20 ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null };
}
export function normalizeTransactions(rows) {
  const dedup = new Map();
  for (const r of rows) {
    if (!r.transaction_id || !r.user_id || !r.account_ref || !/^[A-Z]{3}$/.test(r.currency || '') || !Number.isSafeInteger(r.amount_minor) || r.amount_minor <= 0 || !Number.isFinite(Date.parse(r.occurred_at))) continue;
    const key = `${r.user_id}:${r.account_ref}:${r.transaction_id}`;
    const old = dedup.get(key);
    // A later reversal/status update wins even if it is no longer SETTLED.
    if (!old || (r.updated_at || r.occurred_at) >= (old.updated_at || old.occurred_at)) dedup.set(key, r);
  }
  return [...dedup.values()].filter(r => r.status === 'SETTLED' && r.direction === 'OUT' && !r.own_account && !r.reversal && !r.refund);
}
export function extractFeatures({ rows = [], userId, currency, at, timezone = 'Asia/Shanghai', coverageStart, balance, candidate, noise = 10000, fallbackRate = .1, windowMinutes = 60 }) {
  const time = Date.parse(at), today = localDate(at, timezone), month = today.slice(0, 7), day = Number(today.slice(8));
  const history = normalizeTransactions(rows).filter(r => r.user_id === userId && r.currency === currency && Date.parse(r.occurred_at) <= time)
    .map(r => ({ ...r, date: localDate(r.occurred_at, timezone) }));
  const eligible = history.filter(r => !r.recurring);
  const window = days => { const v = history.filter(r => Date.parse(r.occurred_at) > time - days * DAY); return { count: v.length, amount: v.reduce((s, r) => s + r.amount_minor, 0) }; };
  const first = coverageStart || history.map(r => r.date).sort()[0];
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2 - i, 1)).toISOString().slice(0, 7))
    .filter(m => first && `${m}-01` >= first && m < month && (coverageStart || history.some(r => r.date.startsWith(m))));
  const categories = [...new Set([...eligible.map(r => r.category), candidate?.category || 'transfer'])];
  const monthly = Object.fromEntries(categories.map(category => {
    const values = months.map(m => eligible.filter(r => r.category === category && r.date.startsWith(m) && Number(r.date.slice(8)) <= day).reduce((s, r) => s + r.amount_minor, 0));
    return [category, { ...robust(values, noise, fallbackRate), months: values.length,
      current: eligible.filter(r => r.category === category && r.date.startsWith(month)).reduce((s, r) => s + r.amount_minor, 0) }];
  }));
  const single = robust(eligible.map(r => r.amount_minor), noise, fallbackRate);
  const daily = Array.from({ length: 30 }, (_, i) => history.filter(r => Date.parse(r.occurred_at) > time - (i + 2) * DAY && Date.parse(r.occurred_at) <= time - (i + 1) * DAY));
  const weekly = Array.from({ length: 12 }, (_, i) => history.filter(r => Date.parse(r.occurred_at) > time - (i + 2) * 7 * DAY && Date.parse(r.occurred_at) <= time - (i + 1) * 7 * DAY));
  return { currency, windows: { short: window(windowMinutes/1440), m60: window(1/24), h24: window(1), d7: window(7), d30: window(30) }, monthly, single, sampleCount: eligible.length,
    dailyCount: robust(daily.map(v => v.length), 1), dailyAmount: robust(daily.map(v => v.reduce((s, r) => s + r.amount_minor, 0)), noise),
    weeklyCount: robust(weekly.map(v => v.length), 1), weeklyAmount: robust(weekly.map(v => v.reduce((s, r) => s + r.amount_minor, 0)), noise),
    historyDays: first ? Math.max(0, Math.floor((time - Date.parse(first)) / DAY)) : 0,
    lastOutAt: history.map(r => r.occurred_at).sort().at(-1) || null,
    newBeneficiary: candidate ? !history.some(r => r.payee_ref && r.payee_ref === candidate.beneficiaryRef) : null,
    newBeneficiaries7d: new Set(history.filter(r => Date.parse(r.occurred_at) > time - 7 * DAY && r.payee_ref && !history.some(old => old.payee_ref === r.payee_ref && Date.parse(old.occurred_at) <= time - 7 * DAY)).map(r => r.payee_ref)).size,
    balance: balance && balance.currency === currency && Number.isSafeInteger(balance.available) && balance.available >= 0
      && Number.isFinite(Date.parse(balance.asOf)) && time - Date.parse(balance.asOf) >= 0 && time - Date.parse(balance.asOf) <= 300000 ? balance.available : null,
    notices: [...(months.length < 6 ? ['INSUFFICIENT_HISTORY'] : []), ...(single?.mad === 0 || monthly[candidate?.category || 'transfer'].mad === 0 ? ['BASELINE_UNSTABLE'] : [])] };
}
