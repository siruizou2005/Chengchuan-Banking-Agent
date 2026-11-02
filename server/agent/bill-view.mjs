import { billReport, enrich, ledgerFor, merchantKey, resolveRange, selectLedger, spendingStats } from './analytics.mjs';
import { resolvePrincipal } from './principal.mjs';
import { businessDate } from './policy.mjs';
import { requireThat } from '../errors.mjs';

export function billLedger(bank, services, user, period) {
  requireThat(services.puma.consents.allowed(user, 'data_read'), '未获授权读取账单数据', 403, 'DATA_READ_DENIED');
  const today = businessDate();
  requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period <= today.slice(0, 7), '请选择有效的账单月份');
  const range = resolveRange({ period }, today);
  const rows = ledgerFor(bank, user.id);
  // The Agent ledger window is capped. Never present an incomplete period as a total.
  const history = rows.map(enrich);
  const cutoff = rows.length === 10000 ? history.at(-1).bj_time.slice(0, 10) : null;
  requireThat(!cutoff || cutoff < range.from, '当前可读取的历史流水不足以覆盖该月份', 422, 'INCOMPLETE_HISTORY');
  return { today, range, rows, history, cutoff };
}

// View projection of the same read-only Agent statistics that feed BillReport.
export function billView(bank, services, user, period) {
  const { today, range, rows, history, cutoff } = billLedger(bank, services, user, period);
  const report = billReport(rows, range);
  const previousRange = report.previous && (!cutoff || cutoff < report.previous.from)
    ? resolveRange({ from: report.previous.from, to: report.previous.to }, today) : null;
  const previous = previousRange && billReport(rows, previousRange);
  const start = new Date(Date.UTC(+period.slice(0, 4), +period.slice(5) - 6, 1)).toISOString().slice(0, 10);
  const months = spendingStats(rows, resolveRange({ from: start, to: range.to }, today), { by: 'month' });
  const monthly = Array.from({ length: 6 }, (_, i) => {
    const key = new Date(Date.UTC(+period.slice(0, 4), +period.slice(5) - 6 + i, 1)).toISOString().slice(0, 7);
    const bucket = months.buckets.find(b => b.key === key);
    return { key, consumption: bucket?.amount || 0 };
  }).filter(p => !cutoff || p.key > cutoff.slice(0, 7));
  const entries = selectLedger(history, range).filter(r => r.kind !== 'opening').map(
    r => { const { id, transaction_id, title, merchant, tag, tag_source, kind, amount, bj_time } = r;
      return { id, transaction_id, title, merchant, tag, tag_source, kind, amount, bj_time, has_merchant: Boolean(merchantKey(r)) }; });
  const principal = resolvePrincipal(bank, user, { channel: 'app' });
  const personalized = services.memory.enabled(principal);
  const profile = services.memory.profile(principal);
  const labels = profile.preferred_name ? {
    hidden_consumption: `${profile.preferred_name}，看看你的隐形消费？`,
    personalized_bill: `${profile.preferred_name}，看看你的个性化账单？`,
  } : {};
  // Rows arrive newest first; the opening balance is not a bill.
  const firstEntry = history.findLast(r => r.kind !== 'opening');
  return { from: range.from, to: range.to, first_month: firstEntry ? firstEntry.bj_time.slice(0, 7) : null, totals: report.totals, categories: report.categories, daily: report.trend, monthly, entries,
    previous: previous && { totals: previous.totals, categories: previous.categories },
    labels, personalized, weekdays: spendingStats(rows, range, { by: 'weekday' }).buckets,
    hours: spendingStats(rows, range, { by: 'hour' }).buckets,
  };
}
