import { billReport, enrich, ledgerFor, recognizeSubscriptions, resolveRange, selectLedger, spendingStats } from './analytics.mjs';
import { resolvePrincipal } from './principal.mjs';
import { businessDate } from './policy.mjs';
import { requireThat } from '../errors.mjs';

function hiddenCharges(history, range) {
  const spend = history.filter(r => r.kind === 'consumption' && r.amount < 0 && r.bj_time.slice(0, 10) <= range.to);
  const knownMerchant = r => r.merchant || (!r.txn_type ? r.title : null);
  const recurring = new Set(recognizeSubscriptions(spend.filter(knownMerchant).map(r => ({ ...r, title: knownMerchant(r) })))
    .map(r => JSON.stringify([r.merchant, r.amount])));
  const month = selectLedger(spend, range);
  const smallCounts = new Map();
  for (const r of month) {
    const name = knownMerchant(r);
    if (name && -r.amount <= 2000) smallCounts.set(name, (smallCounts.get(name) || 0) + 1);
  }
  const groups = [
    { name: '自动续费与周期扣款', rule: '订阅扣款标记，或同商户同金额间隔 26–33 天重复出现。', ids: [], amount: 0 },
    { name: '小额高频', rule: '当期同一商户至少 3 笔单笔不超过 20 元的消费，已归入周期扣款的流水只计一次。', ids: [], amount: 0 },
  ];
  for (const r of month) {
    const merchant = knownMerchant(r);
    const key = JSON.stringify([merchant?.replace(/^订阅 · /, ''), -r.amount]);
    const periodic = /^(?:消费 · )?订阅 · /.test(r.title) || recurring.has(key);
    const small = -r.amount <= 2000 && smallCounts.get(merchant) >= 3;
    if (!periodic && !small) continue;
    const group = groups[periodic ? 0 : 1];
    group.amount -= r.amount;
    group.ids.push(r.id);
  }
  return { groups, total: groups.reduce((sum, g) => sum + g.amount, 0) };
}

// View projection of the same read-only Agent statistics that feed BillReport.
export function billView(bank, services, user, period) {
  requireThat(services.puma.consents.allowed(user, 'data_read'), '未获授权读取账单数据', 403, 'DATA_READ_DENIED');
  const today = businessDate();
  requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period <= today.slice(0, 7), '请选择有效的账单月份');
  const range = resolveRange({ period }, today);
  const rows = ledgerFor(bank, user.id);
  // The Agent ledger window is capped. Never present an incomplete period as a total.
  const history = rows.map(enrich);
  const cutoff = rows.length === 10000 ? history.at(-1).bj_time.slice(0, 10) : null;
  requireThat(!cutoff || cutoff < range.from, '当前可读取的历史流水不足以覆盖该月份', 422, 'INCOMPLETE_HISTORY');
  const report = billReport(rows, range);
  const previousRange = report.previous && (!cutoff || cutoff < report.previous.from)
    ? resolveRange({ from: report.previous.from, to: report.previous.to }, today) : null;
  const previous = previousRange && billReport(rows, previousRange);
  const hidden = hiddenCharges(history, range);
  const start = new Date(Date.UTC(+period.slice(0, 4), +period.slice(5) - 6, 1)).toISOString().slice(0, 10);
  const months = spendingStats(rows, resolveRange({ from: start, to: range.to }, today), { by: 'month' });
  const monthly = Array.from({ length: 6 }, (_, i) => {
    const key = new Date(Date.UTC(+period.slice(0, 4), +period.slice(5) - 6 + i, 1)).toISOString().slice(0, 7);
    const bucket = months.buckets.find(b => b.key === key);
    return { key, consumption: bucket?.amount || 0 };
  }).filter(p => !cutoff || p.key > cutoff.slice(0, 7));
  const entries = selectLedger(history, range).filter(r => r.kind !== 'opening').map(
    ({ id, transaction_id, title, merchant, tag, kind, amount, bj_time }) => ({ id, transaction_id, title, merchant, tag, kind, amount, bj_time }));
  const principal = resolvePrincipal(bank, user, { channel: 'app' });
  const personalized = services.memory.enabled(principal);
  const profile = services.memory.profile(principal);
  const labels = profile.preferred_name ? {
    hidden_consumption: `${profile.preferred_name}，看看你的隐形消费？`,
    personalized_bill: `${profile.preferred_name}，看看你的个性化账单？`,
  } : {};
  return { from: range.from, to: range.to, totals: report.totals, categories: report.categories, daily: report.trend, monthly, entries,
    previous: previous && { totals: previous.totals, categories: previous.categories, hidden: hiddenCharges(history, previousRange).total },
    hidden, labels, personalized, weekdays: spendingStats(rows, range, { by: 'weekday' }).buckets,
    hours: spendingStats(rows, range, { by: 'hour' }).buckets,
  };
}
