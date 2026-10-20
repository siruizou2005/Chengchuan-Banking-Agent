import { ledgerFor, billReport, resolveRange } from './agent/analytics.mjs';
import { businessDate } from './agent/policy.mjs';
import { RISK_LABEL, CATEGORY_LABEL } from './products.mjs';

// Deterministic wealth advice: the same user state, product cache and parameters always give the
// same plan and reasons. The model only explains the result; it never picks products itself.
export const HORIZONS = Object.freeze({ short: '随时可能用', mid: '3–12个月', long: '1年以上' });
export const BUCKETS = Object.freeze({ liquid: '流动', stable: '稳健', growth: '进取' });
// Allocation shares (liquid, stable, growth) by horizon and risk level R1–R5.
const TEMPLATE = {
  short: () => [100, 0, 0],
  mid: r => r >= 3 ? [30, 60, 10] : r === 2 ? [30, 70, 0] : [40, 60, 0],
  long: r => [[20, 80, 0], [20, 70, 10], [15, 55, 30], [10, 40, 50], [10, 30, 60]][r - 1],
};
const EMERGENCY_MONTHS = 6, EMERGENCY_MIN_MONTHS = 3;
const DISCLAIMER = '基于本人账户数据与公开产品数据的规则测算，过往业绩不代表未来表现，不构成投资建议；申购前请阅读产品说明并确认风险。';
const yuan = c => Math.round(c / 100);
const fmt = c => `¥${(c / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const shiftMonth = (ym, n) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
const monthEnd = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
const roundDown = (c, step = 10000) => Math.floor(c / step) * step;

const bucketOf = p => p.type === 'deposit' ? 'stable' : p.category === 'money' ? 'liquid' : p.category === 'bond' && p.riskLevel <= 3 ? 'stable' : 'growth';

// Spending is consumption plus transfers to others, averaged over the last three full calendar
// months that the ledger covers; with less than a month of history, the last 30 days stand in.
function monthlyFlows(bank, userId, today) {
  const rows = ledgerFor(bank, userId), month = today.slice(0, 7);
  const span = resolveRange({ from: `${shiftMonth(month, -3)}-01`, to: monthEnd(shiftMonth(month, -1)) }, today);
  const report = billReport(rows, span), first = report.coverage.first;
  const fullMonths = first ? [1, 2, 3].filter(n => `${shiftMonth(month, -n)}-01` >= first).length : 0;
  if (fullMonths) {
    const from = `${shiftMonth(month, -fullMonths)}-01`, covered = fullMonths === 3 ? report : billReport(rows, resolveRange({ from, to: span.to }, today));
    const spend = covered.totals.consumption + covered.totals.transferOut;
    return { spend: Math.round(spend / fullMonths), income: Math.round(covered.totals.income / fullMonths), months: fullMonths, basis: `近${fullMonths}个整月（${from.slice(0, 7)}至${span.to.slice(0, 7)}）` };
  }
  const recent = billReport(rows, resolveRange({ preset: 'last_30_days' }, today));
  return { spend: recent.totals.consumption + recent.totals.transferOut, income: recent.totals.income, months: 0, basis: '流水不足一个整月，按近30天估算' };
}

export function financeProfile(services, user, today = businessDate()) {
  const state = services.state(user);
  const available = state.accounts.filter(a => a.status === 'active' && a.type !== 'system').reduce((n, a) => n + a.available, 0);
  const flows = monthlyFlows(services.bank, user.id, today);
  const holdings = { liquid: 0, stable: 0, growth: 0 };
  for (const h of state.holdings) holdings[bucketOf(h.product)] += h.principal;
  const next = state.holdings.filter(h => h.product.type === 'deposit' && h.unlock_at.slice(0, 10) >= today).sort((a, b) => a.unlock_at.localeCompare(b.unlock_at))[0];
  // Money-fund holdings are as liquid as the current account, so both count toward the emergency fund.
  const target = flows.spend * EMERGENCY_MONTHS, covered = available + holdings.liquid;
  const creditCard = state.creditCard?.used || 0;
  const investable = roundDown(Math.max(0, available - Math.max(0, target - holdings.liquid) - creditCard));
  return {
    available, monthlySpend: flows.spend, monthlyIncome: flows.income, monthlySurplus: flows.income - flows.spend, months: flows.months, basis: flows.basis,
    emergency: { target, min: flows.spend * EMERGENCY_MIN_MONTHS, covered, gap: Math.max(0, target - covered), months: flows.spend ? Math.floor(covered / flows.spend * 10) / 10 : null },
    commitments: { creditCard }, investable,
    holdings: { ...holdings, total: holdings.liquid + holdings.stable + holdings.growth, nextMaturity: next ? { name: next.product.name, date: next.unlock_at.slice(0, 10), principal: next.principal } : null },
  };
}

// The horizon question in the risk questionnaire (third answer) seeds the default horizon.
function assessedHorizon(bank, userId) {
  const row = bank.get("SELECT detail FROM audit WHERE user_id=? AND action='risk.assessed' ORDER BY id DESC LIMIT 1", userId);
  const answer = row ? JSON.parse(row.detail).answers?.[2] : null;
  return answer === 1 ? 'short' : answer === 2 ? 'mid' : answer >= 3 ? 'long' : null;
}

function allowedByHorizon(p, horizon, bucket) {
  if (horizon === 'short') return p.category === 'money';
  // 3–12 months: 90-day deposits, R1–R2 bond funds, and at most R3 for the small growth part.
  if (horizon === 'mid') return p.type === 'deposit' ? p.days <= 90 : bucket === 'stable' ? p.riskLevel <= 2 : bucket === 'growth' ? p.riskLevel <= 3 : true;
  return true;
}
const feeOf = p => Number.parseFloat(p.fee) || 0;
const headline = p => p.type === 'deposit' || p.category === 'money' ? p.rate : p.returns?.y1 ?? p.rate;

// Max drawdown, annualised volatility and Sharpe ratio from a 1-year cumulative-return series.
export function seriesMetrics(points, riskFree = 1.5) {
  if (!points || points.length < 20) return null;
  const levels = points.map(p => 1 + p.value / 100);
  let peak = levels[0], drawdown = 0;
  const daily = [];
  for (let i = 1; i < levels.length; i++) { peak = Math.max(peak, levels[i]); drawdown = Math.max(drawdown, 1 - levels[i] / peak); daily.push(levels[i] / levels[i - 1] - 1); }
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  const volatility = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length - 1)) * Math.sqrt(250) * 100;
  const total = (levels.at(-1) / levels[0] - 1) * 100;
  const round = v => Math.round(v * 100) / 100;
  return { maxDrawdown: round(drawdown * 100), volatility: round(volatility), sharpe: volatility > 0 ? round((total - riskFree) / volatility) : null };
}

// Percentile in [0,1] among the candidates; higher is better unless `lower` is set. Ties share a rank.
function percentile(values, v, lower = false) {
  const list = values.filter(x => x !== null && x !== undefined);
  if (v === null || v === undefined || list.length < 2) return null;
  const better = list.filter(x => lower ? x < v : x > v).length;
  return 1 - better / (list.length - 1);
}

function rankBucket(candidates, metrics) {
  const factor = {
    ret: { weight: 0.45, values: candidates.map(headline) },
    ret6: { weight: 0.15, values: candidates.map(p => p.returns?.m6 ?? null) },
    sharpe: { weight: 0.2, values: candidates.map(p => metrics.get(p.id)?.sharpe ?? null) },
    drawdown: { weight: 0.1, values: candidates.map(p => metrics.get(p.id)?.maxDrawdown ?? null), lower: true },
    fee: { weight: 0.1, values: candidates.map(feeOf), lower: true },
  };
  return candidates.map((p, i) => {
    const parts = Object.entries(factor).map(([key, f]) => [key, f.weight, percentile(f.values, f.values[i], f.lower)]).filter(([, , s]) => s !== null);
    const weight = parts.reduce((n, [, w]) => n + w, 0);
    const score = weight ? parts.reduce((n, [, w, s]) => n + w * s, 0) / weight : 0;
    return { p, score: Math.round(score * 1e6) / 1e6, parts };
  }).sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
}

function reasonFor({ p, parts }, rank, size, metrics) {
  const m = metrics.get(p.id), bits = [];
  if (p.type === 'deposit') bits.push(`年利率${p.rate.toFixed(2)}%，存款类，${p.days}天整存整取，可提前支取`);
  else {
    const top = [...parts].sort((a, b) => b[1] * b[2] - a[1] * a[2]).map(([k]) => k);
    // The card shows the headline return beside the reason, so the reason starts from the ranking.
    if (size > 1) bits.push(`${size}款${p.category === 'money' ? '货币基金' : '候选'}中综合第${rank}`);
    for (const k of top.slice(0, 2)) {
      if (k === 'drawdown' && m) bits.push(`近一年最大回撤${m.maxDrawdown}%`);
      else if (k === 'sharpe' && m?.sharpe !== null && m) bits.push(`夏普比率${m.sharpe}`);
      else if (k === 'fee' && feeOf(p) <= 0.1) bits.push(feeOf(p) ? `申购费率${p.fee}` : '免申购费');
      else if (k === 'ret6' && p.returns?.m6 !== null) bits.push(`近6月${p.returns.m6 > 0 ? '+' : ''}${p.returns.m6.toFixed(2)}%`);
    }
    bits.push(p.category === 'money' ? '随时可取' : '开放申赎');
  }
  return bits.slice(0, 3).join('，');
}

// Split a bucket between its top one or two products, rounded to 100 yuan, never below minimums.
function fill(ranked, amount, metrics) {
  const picks = [];
  for (const r of ranked) {
    if (picks.length === 2) break;
    picks.push(r);
  }
  if (!picks.length) return [];
  const split = picks.length === 2 && amount >= 2 * Math.max(picks[0].p.minimum, picks[1].p.minimum, 100000) ? [0.6, 0.4] : [1];
  const amounts = split.map(s => roundDown(amount * s));
  amounts[0] += amount - amounts.reduce((a, b) => a + b, 0);
  return split.map((_, i) => {
    const r = picks[i], m = metrics.get(r.p.id) || null;
    return {
      id: r.p.id, name: r.p.name, category: CATEGORY_LABEL[r.p.category], risk: r.p.risk, riskLevel: r.p.riskLevel,
      metric: { label: r.p.type === 'deposit' ? '年利率' : r.p.category === 'money' ? '7日年化' : '近一年收益', value: headline(r.p) },
      metrics: m, reason: reasonFor(r, ranked.indexOf(r) + 1, ranked.length, metrics), amount: amounts[i], minimum: r.p.minimum,
    };
  });
}

// Follow-ups are phrased as the user would ask them and centre on the largest part of the plan.
function suggestionsFor(stage, plan) {
  const main = plan?.buckets.length ? [...plan.buckets].sort((a, b) => b.amount - a.amount)[0].products : [];
  if (stage === 'risk_assessment') return ['风险测评的5道题分别看什么', '我的资金够不够应急'];
  if (stage === 'emergency') return ['应急资金为什么建议留6个月支出', ...(main[0] ? [`为什么推荐${main[0].name}`] : [])];
  if (stage !== 'plan' || !main.length) return [];
  return [`为什么推荐${main[0].name}`, main[1] && `对比${main[0].name}和${main[1].name}`, '我现在的持仓表现如何'].filter(Boolean);
}

export async function wealthAdvice(services, user, params = {}, today = businessDate()) {
  const catalog = services.catalog, fresh = services.bank.get('SELECT risk_level FROM users WHERE id=?', user.id);
  const level = fresh.risk_level, profile = financeProfile(services, user, today);
  const horizon = HORIZONS[params.horizon] ? params.horizon : assessedHorizon(services.bank, user.id);
  const horizonSource = HORIZONS[params.horizon] ? 'selected' : horizon ? 'assessment' : null;
  const meta = catalog.meta();
  const base = {
    asOf: new Date().toISOString(), user: { riskLevel: level, risk: level ? RISK_LABEL[level] : '未测评' }, profile,
    source: { products: meta.source, updatedAt: meta.updatedAt, stale: meta.stale, cashflow: profile.basis }, disclaimer: DISCLAIMER, warnings: [],
  };
  const emergencyMode = profile.emergency.gap > 0;
  // The emergency fund stays in money funds; keep one month of spending in the current account for payments.
  const ceiling = roundDown(emergencyMode ? Math.max(0, profile.available - profile.monthlySpend - profile.commitments.creditCard) : profile.investable);
  const requested = params.amount ? Math.min(params.amount, profile.available) : ceiling;
  if (params.amount > profile.available) base.warnings.push(`金额超过活期可用${fmt(profile.available)}，已按可用余额测算`);
  else if (params.amount && params.amount > ceiling) base.warnings.push(emergencyMode ? '金额超过建议转入货币基金的部分，可能影响日常支付' : `金额超过建议可投资金额${fmt(ceiling)}，会占用应急资金或待还款`);
  const params_ = { amount: requested, horizon: emergencyMode ? 'short' : horizon, horizonSource: emergencyMode ? 'emergency' : horizonSource, suggestedAmount: ceiling };
  const done = (stage, gate, plan = null) => ({ ...base, params: params_, stage, gate, plan, suggestions: suggestionsFor(stage, plan) });

  if (!level) return done('risk_assessment', { title: '先完成风险测评', text: '理财产品须与风险承受能力匹配。完成5道测评题（约1分钟）后，会按测评结果和资金期限给出配置方案。', action: { label: '去测评', route: 'risk' } });
  if (!emergencyMode && profile.investable <= 0) return done('no_funds', { title: '暂无可投资金额', text: `活期可用${fmt(profile.available)}需留作${EMERGENCY_MONTHS}个月应急资金${profile.commitments.creditCard ? `和信用卡待还${fmt(profile.commitments.creditCard)}` : ''}，建议先保持活期或增加结余后再配置。`, action: null });
  if (!emergencyMode && !horizon) return done('horizon', { title: '这笔钱多久会用到？', text: '选择资金期限后生成方案：期限越短，越侧重随时可取的产品。', action: null });
  const emergencyGate = { title: `应急资金还差${fmt(profile.emergency.gap)}`, text: `建议留足${EMERGENCY_MONTHS}个月支出（${fmt(profile.emergency.target)}）作为应急资金，先放在随时可取的货币基金，暂不配置定期或波动较大的产品。`, action: null };
  if (requested <= 0) return done(emergencyMode ? 'emergency' : 'no_funds', emergencyMode
    ? { ...emergencyGate, text: `${emergencyGate.text}目前活期需保留一个月支出用于日常支付，暂无可转入的金额${profile.monthlySurplus > 0 ? `；按近期月均结余${fmt(profile.monthlySurplus)}，每月存入货币基金约${Math.ceil(profile.emergency.gap / profile.monthlySurplus)}个月可补足` : ''}。` }
    : { title: '暂无可转入的金额', text: '活期余额需保留一个月日常支出用于支付，暂不建议转入。', action: null });

  const h = params_.horizon, shares = emergencyMode ? [100, 0, 0] : TEMPLATE[h](level);
  const wealth = catalog.list();
  const reasons = new Map(), add = r => reasons.set(r, (reasons.get(r) || 0) + 1);
  const eligible = { liquid: [], stable: [], growth: [] };
  for (const p of wealth) {
    const bucket = bucketOf(p);
    if (p.riskLevel > level) add(`风险高于${RISK_LABEL[level].split(' ')[0]}`);
    else if (!p.purchasable) add('暂停申购');
    else if (emergencyMode && (p.category !== 'money' || p.riskLevel > 1)) add('应急资金只放随时可取的货币基金');
    else if (!allowedByHorizon(p, h, bucket)) add('与资金期限不匹配');
    else eligible[bucket].push(p);
  }
  // Volatility and drawdown need NAV history, so fetch it only for each bucket's top five by return.
  const metrics = new Map();
  const shortlist = [...eligible.stable, ...eligible.growth].filter(p => p.code).sort((a, b) => (headline(b) ?? -Infinity) - (headline(a) ?? -Infinity) || a.id.localeCompare(b.id));
  const wanted = ['stable', 'growth'].flatMap(b => shortlist.filter(p => bucketOf(p) === b).slice(0, 5));
  let missing = 0;
  await Promise.all(wanted.map(async p => { const series = await catalog.history(p.id, '1y').catch(() => null); const m = seriesMetrics(series?.points); if (m) metrics.set(p.id, m); else missing++; }));
  const notes = [];
  if (missing) notes.push(`${missing}款产品暂缺净值走势，波动与回撤未参与排序`);

  const keys = Object.keys(BUCKETS);
  let amounts = shares.map(s => roundDown(requested * s / 100)); amounts[shares.findIndex(s => s > 0)] += requested - amounts.reduce((a, b) => a + b, 0);
  const buckets = [];
  let carry = 0;
  for (const [i, key] of keys.entries()) {
    const amount = amounts[i];
    if (!amount) continue;
    // Rank only products whose minimum and daily limit suit this part's amount, so ranks shown match the picks.
    const usable = eligible[key].filter(p => p.minimum <= amount && (!p.purchaseLimit || p.purchaseLimit >= amount));
    for (const p of eligible[key]) if (!usable.includes(p)) add(p.minimum > amount ? '起购额高于分配金额' : '单日申购上限低于分配金额');
    const products = fill(rankBucket(usable, metrics), amount, metrics);
    if (!products.length) { if (key !== 'liquid') notes.push(`${BUCKETS[key]}部分没有符合条件且起购额合适的产品，金额并入${BUCKETS.liquid}部分`); carry += amount; continue; }
    buckets.push({ id: key, label: BUCKETS[key], share: Math.round(amount / requested * 100), amount, products });
  }
  if (carry) {
    const liquid = buckets.find(b => b.id === 'liquid');
    if (liquid) { liquid.amount += carry; liquid.share = Math.round(liquid.amount / requested * 100); liquid.products[0].amount += carry; }
    else { const products = fill(rankBucket(eligible.liquid.filter(p => p.minimum <= carry && (!p.purchaseLimit || p.purchaseLimit >= carry)), metrics), carry, metrics); if (products.length) buckets.unshift({ id: 'liquid', label: BUCKETS.liquid, share: Math.round(carry / requested * 100), amount: carry, products }); }
  }
  const excluded = { total: [...reasons.values()].reduce((a, b) => a + b, 0), reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)) };
  const plan = { mode: emergencyMode ? 'emergency' : 'normal', template: Object.fromEntries(keys.map((k, i) => [k, shares[i]])), buckets, excluded, notes };
  return done(emergencyMode ? 'emergency' : 'plan', emergencyMode ? emergencyGate : null, plan);
}

// What the model sees: yuan amounts and one line per product. The card shows everything else.
export function compactAdvice(a) {
  const p = a.profile, main = a.plan?.buckets.length ? [...a.plan.buckets].sort((x, y) => y.amount - x.amount)[0] : null;
  return {
    stage: a.stage, ...(a.gate ? { gate: `${a.gate.title}：${a.gate.text}` } : {}), riskLevel: a.user.risk,
    profile: { 活期可用: yuan(p.available), 月均支出: yuan(p.monthlySpend), 月均结余: yuan(p.monthlySurplus), 应急资金目标: yuan(p.emergency.target), 应急资金缺口: yuan(p.emergency.gap), 可投资: yuan(p.investable), 口径: p.basis },
    params: { 金额: yuan(a.params.amount), 期限: HORIZONS[a.params.horizon] || '未选择' },
    ...(main ? { 首选: { 产品: main.products[0].name, 部分: main.label, 金额: yuan(main.products[0].amount), 理由: main.products[0].reason } } : {}),
    ...(a.plan ? { plan: a.plan.buckets.map(b => ({ 部分: b.label, 金额: yuan(b.amount), 产品: b.products.map(x => `${x.name}（${x.id}，${x.risk}，${x.metric.label}${x.metric.value ?? '--'}%）${yuan(x.amount)}元：${x.reason}`) })), excluded: a.plan.excluded.total, notes: a.plan.notes } : {}),
    ...(a.warnings.length ? { warnings: a.warnings } : {}),
    unit: '金额为元', note: '完整方案、排除原因与申购入口见服务端配置建议卡片；用户可在卡片中直接调整期限与金额，无需追问',
  };
}
