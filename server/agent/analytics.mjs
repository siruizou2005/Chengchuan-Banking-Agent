import { requireThat } from '../errors.mjs';
import { businessDate } from './policy.mjs';

// All periods are Beijing calendar dates; created_at stays UTC in the database.
const DAY = 86400000;
const bj = iso => new Date(Date.parse(iso) + 8 * 3600000).toISOString();
export const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const monthEnd = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
const shiftMonth = (ym, n) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().startsWith(d);
// Statements go back years, not centuries; resolveRange also keeps every date inside the four-digit years these helpers assume.
export const EARLIEST_DATE = '2000-01-01';
const MAX_RANGE_DAYS = 3660;
const utcStart = date => new Date(Date.parse(date + 'T00:00:00Z') - 8 * 3600000).toISOString();
export const utcBounds = range => [utcStart(range.from), utcStart(addDays(range.to, 1))];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const weekday = date => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;

export const PRESETS = { today: '今天', yesterday: '昨天', this_week: '本周', last_week: '上周', last_7_days: '近7天', last_30_days: '近30天', this_month: '本月', last_month: '上月', last_3_months: '近3个月', this_year: '今年' };
export const KIND_LABEL = { consumption: '消费', refund: '退款', income: '收入', transfer_out: '转账给他人', self: '本人账户互转', wallet: '充值提现', investment: '理财存款', debt: '信用卡/贷款', opening: '期初余额' };
// The eight CHFS consumption categories. 其他消费 holds whatever the rules cannot place with confidence.
export const OTHER_CATEGORY = '其他消费';
export const SPEND_CATEGORIES = ['食品', '衣着', '居住', '家庭设备及服务', '交通通信', '教育文娱', '医疗保健', OTHER_CATEGORY];
// Spending whose source bank only shows the payment platform, never the real merchant.
export const isUnknownTag = tag => /^(支付宝|微信支付|京东支付|抖音支付)支出$/.test(tag);
// Shopping platforms and vague company words (淘宝, 京东, 商贸, 供应链...) name no category, so they are left out on purpose:
// a merchant known only by them stays in 其他消费, while 京东便利店 still reaches 食品 through 便利.
const SPEND = [
  ['居住', /房租|房费|物业|水电|水费|电费|燃气|居住/],
  ['交通通信', /交通|地铁|公交|打车|加油|滴滴|出行|哈啰|高德|铁路|12306|航空|机场|中国石油|中石油|中国石化|中石化|石油有限|石化有限|石油分公司|石化分公司|停车|单车|通讯|话费|宽带|电信|联通|联合网络|移动通信|中国移动/],
  ['医疗保健', /医院|医药|医疗|药房|药店|快药|诊所|一心堂/],
  ['衣着', /服装|服饰|衣服|女装|男装|童装|内衣|鞋|帽|优衣库|UNIQLO|ZARA|H&M|安踏|李宁|耐克|NIKE|阿迪达斯|ADIDAS|特步|森马|海澜之家/],
  ['家庭设备及服务', /家电|家具|家居|家纺|日用|洗衣|保洁|家政|维修|照明|绿联|嘉立创|电子有限|数码/],
  ['食品', /餐饮|餐厅|饭|面馆|小面|米粉|烧烤|烤鱼|火锅|小吃|食品|乳业|零食|卤|鸡排|奶茶|咖啡|茶饮|清饮|蜜雪|蛋糕|甜品|面包|Tart|肯德基|麦当劳|汉堡|老乡鸡|三快|美团|点评|拉扎斯|饿了么|外卖|小馆|酒家|凉茶|涼茶|食堂|馒|鸭|椰|捞派|瑞幸|星巴克|冰室|牛约堡|小朵颐|丰收日|超市|便利|全家|罗森|LAWSON|SEVEN|7-11|生鲜|永辉|盒马|物美|鲜果|水果|果业|蔬|老邻居|智购/],
  ['教育文娱', /大学|学院|学校|教育|培训|考试|书店|学费|文具|办公用品|爱奇艺|腾讯视频|优酷|网易|游戏|电影|影城|影院|KTV|游泳|球馆|公园|华为软件|哔哩|娱乐|订阅|视频|音乐|云盘|健身|旅行|旅游|携程|程付通|华程|赫程|同程|飞猪|酒店|宾馆|民宿|景区|门票/],
];
// Small vendors take payments through personal QR codes, so a bare personal name is a merchant, not a transfer.
const PERSON = /^[王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤菅凌翁喻文欧俞柳鲍滕伍季屈童葛鲁佘傅齐康施牛洪祝左甘颜骆包邢申车关易苗常乔赖宁庄柯管聂岳殷温艾詹翟解饶舒应晏储符蒙冉臧郁毕祁靳栾邬宫阮尤][一-龥]{1,2}$/;
const PROCESSOR = /财付通|支付宝|Alipay/;

const PLATFORMS = ['支付宝', '微信支付', '京东支付', '抖音支付'];
// Native titles are fixed by the bank unless they carry a name the customer typed at checkout.
const MERCHANT_TITLE = /^(?:信用卡)?消费 · (?!订阅 · )/;
const normalizeKey = text => text?.normalize('NFKC').replace(/\s+/g, ' ').trim() || null;
// Bank memo phrases and payment processors name no one in particular.
const GENERIC_MERCHANT = /平台商户$|商城业务$|^扫二维码付款$|^赞赏码$|财付通|支付宝|Alipay/i;
const specificKey = text => { const key = normalizeKey(text); return key && !GENERIC_MERCHANT.test(key) ? key : null; };
// The merchant a row belongs to. Null when only the payment platform or a generic phrase is known, because grouping on it would lump unrelated spending together.
export function merchantKey(r) {
  if (!r.txn_type) return normalizeKey(r.title.replace(/^(?:信用卡)?消费 · /, ''));
  if (r.merchant) return specificKey(r.merchant);
  if (PLATFORMS.includes(r.platform) || PROCESSOR.test(r.counterparty || '')) return null;
  return specificKey(r.counterparty || r.memo);
}
// Only merchant-like text may leave the bank: never personal names, masked values or anything that could be a phone or card number.
// PERSON cannot list every surname, so any bare two or three Chinese characters count as a possible name, at the cost of some short brand names.
// The same trade-off covers the other shapes a name takes: compound surnames, dotted names, pinyin and text addressed to someone.
const NAME_LIKE = /^(?:欧阳|司马|上官|诸葛|东方|皇甫|尉迟|公孙|慕容|司徒|令狐|夏侯|南宫|独孤|端木|百里|呼延|长孙|宇文|轩辕)[一-龥]{1,2}$|^[一-龥]{1,8}[·•・][一-龥]{1,8}$|(?:给|付给|转给|还给|借给|替|帮)[一-龥]{2,4}/;
const LATIN_NAME = /^[a-z]+(?: [a-z]+){1,3}$/i, LATIN_BUSINESS = /\b(?:store|shop|cafe|coffee|market|mart|hotel|restaurant|bar|club|mall|inc|ltd|llc|co|company|games?|studio|online|pay)\b/i;
export const sendableKey = key => Boolean(key) && key.length <= 60 && !/^[一-龥]{2,3}$/.test(key) && !NAME_LIKE.test(key) && !(LATIN_NAME.test(key) && !LATIN_BUSINESS.test(key)) && !/[*@]/.test(key) && !/\d{6}/.test(key.replace(/[\s()（）._—–-]/g, ''));

// A place in a shop's name says where the shop is, not what it sells, and 交通银行 is a bank rather than transport.
const NOT_EVIDENCE = /交通银行|(?:大学|学院|学校|机场|医院|公园)(?=\S{0,8}(?:店|小卖部|便利部|食堂)(?:\s|$))/g;
function ruleCategory(r, imported) {
  if (!imported && !MERCHANT_TITLE.test(r.title)) return SPEND.find(([, re]) => re.test(r.title))?.[0];
  const text = imported ? [r.merchant, r.counterparty, r.memo].filter(Boolean).join(' ') : r.title;
  // Hits in several categories mean the rules cannot tell, which is the same as no hit.
  const hits = SPEND.filter(([, re]) => re.test(text));
  return hits.length === 1 && hits[0][1].test(text.replace(NOT_EVIDENCE, '')) ? hits[0][0] : null;
}
function spendCategory(r, imported) {
  const tag = ruleCategory(r, imported);
  if (tag) return { tag, tag_source: 'rule' };
  if (imported && PERSON.test(r.merchant || '')) return { tag: '个人收款码', tag_source: 'rule' };
  if (imported && !r.merchant && PLATFORMS.includes(r.platform)) return { tag: `${r.platform}支出`, tag_source: 'rule' };
  return r.model_tag ? { tag: r.model_tag, tag_source: 'model' } : { tag: OTHER_CATEGORY, tag_source: 'fallback' };
}
// Imported rows carry txn_type; native rows only have title and the transaction category.
function classifyAutomatically(r) {
  const imported = Boolean(r.txn_type), t = r.txn_type || '';
  if (r.category === 'opening' || r.title === '模拟开户资金') return { kind: 'opening', tag: '期初余额' };
  if (t.startsWith('本人')) return { kind: 'self', tag: KIND_LABEL.self };
  if (/理财/.test(t) || ['deposit', 'investment', 'redeem'].includes(r.category)) return { kind: 'investment', tag: KIND_LABEL.investment };
  if (['loan_draw', 'loan_repay', 'credit_repay'].includes(r.category)) return { kind: 'debt', tag: KIND_LABEL.debt };
  if (t === '退款') return { kind: 'refund', ...spendCategory(r, imported) };
  if (t === '提现' || t === '存现' || (t === '充值' && (!r.merchant || r.merchant === '微信转账')) || (t === '转入' && !r.merchant && PROCESSOR.test(r.counterparty || ''))) return { kind: 'wallet', tag: KIND_LABEL.wallet };
  if (r.amount > 0) return { kind: 'income', tag: t === '利息' ? '利息' : t === '工资' || /工资/.test(r.title) ? '工资收入' : t === '转入' || /转账/.test(r.title) ? '转账收入' : '其他收入' };
  if (/房租|房费|物业/.test(`${r.memo || ''} ${r.title}`)) return { kind: 'consumption', tag: '居住', tag_source: 'rule' };
  if (t === '转出' || (!imported && r.category === 'transfer') || /微信转账|红包/.test(r.merchant || '')) return { kind: 'transfer_out', tag: KIND_LABEL.transfer_out };
  return { kind: 'consumption', ...spendCategory(r, imported) };
}
// Only tag ever changes here. kind drives totals and risk features, so neither the model nor the customer can move it.
export function classifyRow(r) {
  const result = classifyAutomatically(r);
  return r.user_tag && (result.kind === 'consumption' || result.kind === 'refund') ? { ...result, tag: r.user_tag, tag_source: 'user' } : result;
}
// Attaches the customer's own corrections and the shared merchant cache, so classification itself stays a pure function of the row.
export function withCategoryTags(bank, userId, rows) {
  const pairs = (sql, ...args) => new Map(bank.all(sql, ...args).map(row => Object.values(row)));
  const entries = pairs('SELECT ledger_id,tag FROM ledger_category_overrides WHERE user_id=?', userId);
  const merchants = pairs('SELECT merchant_key,tag FROM merchant_category_overrides WHERE user_id=?', userId);
  const model = pairs("SELECT merchant_key,tag FROM merchant_categories WHERE status='classified'");
  if (!entries.size && !merchants.size && !model.size) return rows;
  return rows.map(r => {
    const key = merchantKey(r), user_tag = entries.get(r.id) ?? merchants.get(key), model_tag = model.get(key);
    return user_tag || model_tag ? { ...r, user_tag, model_tag } : r;
  });
}
export function enrich(r) {
  const at = bj(r.created_at);
  return { ...r, ...classifyRow(r), bj_time: r.time_precision === 'day' ? at.slice(0, 10) : `${at.slice(0, 10)} ${at.slice(11, 16)}` };
}
export function ledgerFor(bank, userId) { return withCategoryTags(bank, userId, bank.all('SELECT l.* FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT 10000', userId)); }
const dateOf = r => r.bj_time.slice(0, 10);
const merchantOf = r => r.merchant || (r.txn_type ? null : r.title);
// The name a row is counted under when spending is grouped by merchant, so drilling into a group returns exactly its rows.
const merchantLabel = r => merchantOf(r) || r.tag;
export const platformOf = r => r.platform || (r.txn_type ? '银行卡快捷支付' : '澄川银行');
const isSpend = r => r.kind === 'consumption' || r.kind === 'refund';
// kind=spend selects consumption plus refunds, matching how consumption is totalled.
export function selectLedger(rows, { from, to, direction, kind, category, keyword, platform, merchant } = {}) {
  return rows.filter(r => (!from || dateOf(r) >= from) && (!to || dateOf(r) <= to) && (!direction || (direction === 'income' ? r.amount > 0 : r.amount < 0))
    && (!kind || (kind === 'spend' ? isSpend(r) : r.kind === kind)) && (!platform || platformOf(r) === platform) && (!merchant || merchantLabel(r) === merchant) && (!category || r.tag === category) && (!keyword || [r.title, r.counterparty, r.merchant, r.memo, r.transaction_id].some(v => v?.includes(keyword))));
}

export function resolveRange({ preset, period, from, to } = {}, today = businessDate()) {
  let label, named;
  if (from || to) {
    requireThat(validDate(from) && validDate(to), '起止日期须为有效的YYYY-MM-DD');
    label = `${from}至${to}`;
  } else if (period) {
    requireThat(typeof period === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(period), '期间须为YYYY、YYYY-MM或YYYY-MM-DD');
    [from, to] = period.length === 4 ? [`${period}-01-01`, `${period}-12-31`] : period.length === 7 ? [`${period}-01`, monthEnd(period)] : [period, period];
    requireThat(validDate(from) && validDate(to), '期间无效');
    label = named = period;
  } else {
    preset ||= 'this_month';
    requireThat(Object.hasOwn(PRESETS, preset), '未知时段');
    const w = weekday(today), month = today.slice(0, 7);
    [from, to] = { today: [today, today], yesterday: [addDays(today, -1), addDays(today, -1)], this_week: [addDays(today, -w), today], last_week: [addDays(today, -w - 7), addDays(today, -w - 1)],
      last_7_days: [addDays(today, -6), today], last_30_days: [addDays(today, -29), today], this_month: [`${month}-01`, today],
      last_month: [`${shiftMonth(month, -1)}-01`, monthEnd(shiftMonth(month, -1))], last_3_months: [`${shiftMonth(month, -2)}-01`, today], this_year: [`${today.slice(0, 4)}-01-01`, today] }[preset];
    label = PRESETS[preset];
    named = { this_month: month, last_month: from.slice(0, 7), this_year: today.slice(0, 4), today, yesterday: from }[preset];
  }
  requireThat(from <= to, '开始日期不能晚于结束日期');
  requireThat(from >= EARLIEST_DATE && to <= `${+today.slice(0, 4) + 1}-12-31`, '只能查询2000年至明年的账单');
  if (from <= today && to > today) to = today; // a period still in progress ends today, so averages and comparisons stay month-to-date
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  requireThat(days <= MAX_RANGE_DAYS, '查询跨度不能超过10年');
  const sameMonth = from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7) && (to === monthEnd(to.slice(0, 7)) || to === today);
  const sameYear = from.endsWith('-01-01') && from.slice(0, 4) === to.slice(0, 4) && (to.endsWith('-12-31') || to === today);
  return { from, to, label, days, granularity: days <= 62 ? 'day' : 'month', period: named || (from === to ? from : sameMonth ? from.slice(0, 7) : sameYear ? from.slice(0, 4) : `${from}~${to}`) };
}

const sum = list => list.reduce((n, r) => n + r.amount, 0);
const neg = list => -sum(list) || 0;
const byAmount = (a, b) => b.amount - a.amount;
function group(list, key, sign) {
  const map = new Map();
  for (const r of list) { const k = key(r); if (k == null) continue; const g = map.get(k) || { name: k, amount: 0, count: 0 }; g.amount += sign * r.amount; g.count++; map.set(k, g); }
  return [...map.values()];
}
// Counted up front rather than compared as strings: past 9999-12-31 a date becomes "+010000-01", which sorts below any end date.
function buckets(range, granularity) {
  if (granularity === 'day') return Array.from({ length: Math.max(0, Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY) + 1) }, (_, i) => addDays(range.from, i));
  const monthNumber = date => +date.slice(0, 4) * 12 + +date.slice(5, 7);
  return Array.from({ length: Math.max(0, monthNumber(range.to) - monthNumber(range.from) + 1) }, (_, i) => shiftMonth(range.from.slice(0, 7), i));
}
function coverageOf(all, range, selected) {
  const dates = all.map(dateOf).sort(), active = all.filter(r => r.kind !== 'opening').map(dateOf).sort();
  return { first: dates[0] || null, last: active.at(-1) || null, partial: Boolean(dates.length) && (range.from < dates[0] || range.to > active.at(-1)), dayPrecisionRows: selected.filter(r => r.time_precision === 'day').length };
}
const brief = r => ({ bj_time: r.bj_time, title: r.title, amount: r.amount, tag: r.tag });

export function billReport(rows, range) {
  const all = rows.map(enrich), sel = selectLedger(all, range).filter(r => r.kind !== 'opening');
  const of = (...kinds) => sel.filter(r => kinds.includes(r.kind));
  const spend = of('consumption', 'refund'), consumption = neg(spend), transferOut = neg(of('transfer_out')), income = sum(of('income'));
  const categories = group(spend, r => r.tag, -1).filter(c => c.amount).sort(byAmount).map(c => ({ ...c, share: consumption > 0 ? c.amount / consumption : 0 }));
  const excluded = ['self', 'wallet', 'investment', 'debt'].map(kind => { const list = of(kind); return list.length ? { name: KIND_LABEL[kind], kind, in: sum(list.filter(r => r.amount > 0)), out: neg(list.filter(r => r.amount < 0)), count: list.length } : null; }).filter(Boolean);
  const trend = buckets(range, range.granularity).map(key => { const list = sel.filter(r => dateOf(r).startsWith(key)); return { key, consumption: neg(list.filter(r => r.kind === 'consumption' || r.kind === 'refund')), income: sum(list.filter(r => r.kind === 'income')) }; });
  const coverage = coverageOf(all, range, sel);
  // Compare with the same span one period earlier (calendar months compare month-to-date), only when the data reaches back that far.
  // A single day is compared with the day before, even on the first of a month; the month view of that same date stays month-to-date.
  const monthly = range.from.endsWith('-01') && range.from.slice(0, 7) === range.to.slice(0, 7) && range.period !== range.from;
  const prevFrom = monthly ? `${shiftMonth(range.from.slice(0, 7), -1)}-01` : addDays(range.from, -range.days);
  const prevTo = monthly ? (range.to === monthEnd(range.to.slice(0, 7)) ? monthEnd(prevFrom.slice(0, 7)) : [`${prevFrom.slice(0, 7)}${range.to.slice(7)}`, monthEnd(prevFrom.slice(0, 7))].sort()[0]) : addDays(range.from, -1);
  const prevConsumption = neg(selectLedger(all, { from: prevFrom, to: prevTo }).filter(r => r.kind === 'consumption' || r.kind === 'refund'));
  const previous = coverage.first && coverage.first <= prevFrom ? { from: prevFrom, to: prevTo, consumption: prevConsumption, change: prevConsumption ? (consumption - prevConsumption) / prevConsumption : null } : null;
  const topMerchants = group(spend, merchantOf, -1).filter(m => m.amount > 0).sort(byAmount).slice(0, 5);
  const unknown = categories.filter(c => isUnknownTag(c.name)).reduce((n, c) => n + c.amount, 0);
  const items = (range.days === 1 ? sel : [...of('consumption')].sort((a, b) => a.amount - b.amount).slice(0, 5)).slice(0, 30).map(brief);
  return {
    period: range.period, label: range.label, from: range.from, to: range.to, granularity: range.granularity,
    totals: { consumption, consumptionGross: neg(of('consumption')), refunds: sum(of('refund')), transferOut, income, inflow: sum(sel.filter(r => r.amount > 0)), outflow: neg(sel.filter(r => r.amount < 0)), count: sel.length, consumptionCount: of('consumption').length, days: range.days, dailyAverage: Math.round(consumption / range.days) },
    categories, excluded, topMerchants, incomeSources: group(of('income'), r => r.counterparty || r.tag, 1).sort(byAmount).slice(0, 5), trend, items, previous, coverage, unknownShare: consumption > 0 ? unknown / consumption : 0, suggestions: reportSuggestions(range, categories, unknown / (consumption || 1)),
    // Legacy fields read by older report cards and IM text.
    income, expense: consumption + transferOut, net: income - consumption - transferOut, count: sel.length, change: previous?.change ?? null,
    previousPeriod: previous && `${previous.from}~${previous.to}`, previousExpense: previous?.consumption ?? null,
    scope: '本人已入账流水，按北京时间日期归属；消费=消费−退款，转账给他人单列，本人账户互转、充值提现、理财存款、信用卡/贷款不计入消费',
  };
}
// The model only sees this; the full report goes to the card. Amounts are converted to yuan so the model never
// rescales cents itself, and packed tool messages must stay under 4096 bytes.
const round = n => Math.round(n * 1000) / 1000;
const yuan = cents => Math.round(cents) / 100;
const yuanOf = (row, keys) => ({ ...row, ...Object.fromEntries(keys.map(k => [k, yuan(row[k])])) });
export function compactReport(report) {
  const t = report.totals, peak = report.granularity === 'day' ? report.trend.filter(p => p.consumption > 0).sort((a, b) => b.consumption - a.consumption).slice(0, 3) : report.trend;
  return { unit: '元', period: report.period, label: report.label, from: report.from, to: report.to,
    totals: { ...yuanOf(t, ['consumption', 'consumptionGross', 'refunds', 'transferOut', 'income', 'inflow', 'outflow', 'dailyAverage']) },
    categories: report.categories.slice(0, 8).map(c => ({ ...yuanOf(c, ['amount']), share: round(c.share) })), topMerchants: report.topMerchants.map(m => yuanOf(m, ['amount'])), incomeSources: report.incomeSources.slice(0, 3).map(m => yuanOf(m, ['amount'])),
    excluded: report.excluded.map(({ kind, ...rest }) => yuanOf(rest, ['in', 'out'])), previous: report.previous && { ...yuanOf(report.previous, ['consumption']), change: report.previous.change === null ? null : round(report.previous.change) },
    coverage: report.coverage, unknownShare: round(report.unknownShare), [report.granularity === 'day' ? 'peakDays' : 'months']: peak.map(p => yuanOf(p, ['consumption', 'income'])),
    items: report.items.slice(0, 12).map(r => yuanOf(r, ['amount'])), itemCount: report.items.length, note: '本结果金额单位为元（不是分）；完整明细见服务端账单卡片' };
}

export const STATS_LABEL = { category: '分类', merchant: '商户', platform: '支付平台', month: '按月', week: '按周', day: '按日', weekday: '按星期', hour: '按小时' };
const STATS_TIME = new Set(['month', 'week', 'day', 'weekday', 'hour']);
export function spendingStats(rows, range, { by = 'category', kind = 'consumption', category, keyword, limit = 10 } = {}) {
  const sel = selectLedger(rows.map(enrich), { ...range, category, keyword }).filter(r => kind === 'consumption' ? r.kind === 'consumption' || r.kind === 'refund' : r.kind === kind);
  const sign = kind === 'income' || kind === 'refund' ? 1 : -1;
  let skipped = 0;
  const key = {
    category: r => r.tag, merchant: merchantLabel, platform: platformOf,
    month: r => dateOf(r).slice(0, 7), week: r => addDays(dateOf(r), -weekday(dateOf(r))), day: dateOf, weekday: r => WEEKDAYS[weekday(dateOf(r))],
    hour: r => { if (r.time_precision === 'day') { skipped++; return null; } return `${r.bj_time.slice(11, 13)}时`; },
  }[by];
  requireThat(key, '不支持的统计维度');
  const groups = group(sel, key, sign), total = groups.reduce((n, g) => n + g.amount, 0), map = new Map(groups.map(g => [g.name, g]));
  if (by === 'day' && range.days <= 62) for (const d of buckets(range, 'day')) if (!map.has(d)) map.set(d, { name: d, amount: 0, count: 0 });
  if (by === 'weekday') for (const d of WEEKDAYS) if (!map.has(d)) map.set(d, { name: d, amount: 0, count: 0 });
  const list = [...map.values()].map(g => ({ key: g.name, amount: g.amount, count: g.count, share: total > 0 ? g.amount / total : 0 }));
  list.sort(STATS_TIME.has(by) ? (a, b) => (by === 'weekday' ? WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key) : a.key < b.key ? -1 : 1) : byAmount);
  return { label: range.label, period: range.period, from: range.from, to: range.to, by, kind, category: category || null, keyword: keyword || null, total, count: sel.length - skipped, skipped, buckets: list, limit, suggestions: statsSuggestions(range, by, list, category) };
}
// Follow-up questions shown under a card, phrased the way a user would ask them.
export function rangeText(range) {
  const p = range.period;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return Object.values(PRESETS).includes(range.label) ? range.label : `${+p.slice(5, 7)}月${+p.slice(8)}日`;
  if (/^\d{4}-\d{2}$/.test(p)) return range.label === p ? `${+p.slice(5)}月` : range.label;
  if (/^\d{4}$/.test(p)) return range.label === p ? `${p}年` : range.label;
  return range.label;
}
const known = (list, key) => list.find(c => c.amount > 0 && !isUnknownTag(c[key]))?.[key];
function reportSuggestions(range, categories, unknownShare) {
  const t = rangeText(range), top = known(categories, 'name'), unknown = categories.find(c => isUnknownTag(c.name));
  return [top && `${t}${top}花在哪些商户`, range.days > 1 && (range.granularity === 'day' ? `${t}每天花多少` : `${t}每月花多少`), unknown && unknownShare >= 0.3 ? `${t}${unknown.name}明细` : `${t}有没有异常支出`].filter(Boolean).slice(0, 3);
}
function statsSuggestions(range, by, buckets, category) {
  const t = rangeText(range), active = buckets.filter(b => b.count), top = known(active, 'key');
  const peak = [...active].sort((a, b) => b.amount - a.amount)[0];
  const day = d => `${+d.slice(5, 7)}月${+d.slice(8)}日`;
  const options = {
    category: [top && `${t}${top}花在哪些商户`, `${t}每天花多少`, `${t}的账单报告`],
    merchant: [category ? `${t}的账单报告` : `${t}按分类看消费`, `${t}每天花多少`, `${t}按支付平台看消费`],
    platform: [`${t}按分类看消费`, `${t}按商户看消费`],
    day: [peak && `${day(peak.key)}的日账单`, `${t}按星期看消费规律`, `${t}按分类看消费`],
    week: [`${t}每天花多少`, `${t}按分类看消费`],
    month: [peak && `${+peak.key.slice(5)}月的账单报告`, `${t}按分类看消费`],
    weekday: [`${t}每天花多少`, `${t}按分类看消费`],
    hour: [`${t}按星期看消费规律`, `${t}按分类看消费`],
  }[by];
  return options.filter(Boolean).slice(0, 3);
}
export function compactStats(stats) {
  const top = [...stats.buckets].filter(b => b.count).sort(byAmount).slice(0, stats.limit).map(b => ({ ...yuanOf(b, ['amount']), share: round(b.share) }));
  return { unit: '元', label: stats.label, from: stats.from, to: stats.to, by: stats.by, kind: stats.kind, category: stats.category, keyword: stats.keyword, total: yuan(stats.total), count: stats.count, skipped: stats.skipped,
    bucketCount: stats.buckets.filter(b => b.count).length, buckets: top, note: `本结果金额单位为元（不是分），按金额从高到低${stats.skipped ? `；${stats.skipped}笔原对账单只有日期，未计入按小时统计` : ''}` };
}

// history widens the baseline (median, first-time merchants, repeats) beyond the range being checked.
export function detectAnomalies(rows, range, history = range) {
  const all = rows.map(enrich), outgoing = r => r.amount < 0 && (r.kind === 'consumption' || r.kind === 'transfer_out');
  const expenses = selectLedger(all, range).filter(outgoing), baseline = history === range ? expenses : selectLedger(all, history).filter(outgoing);
  const amounts = baseline.map(r => -r.amount).sort((a, b) => a - b), median = amounts[Math.floor(amounts.length / 2)] || 0;
  const counts = new Map(); for (const r of baseline) counts.set(merchantOf(r) || r.title, (counts.get(merchantOf(r) || r.title) || 0) + 1);
  return expenses.flatMap(r => {
    const reasons = [], name = merchantOf(r), hour = +r.bj_time.slice(11, 13);
    if (-r.amount > Math.max(500000, median * 5)) reasons.push('金额明显高于常见支出');
    if (r.time_precision !== 'day' && hour < 6) reasons.push('深夜交易（北京时间）');
    if (counts.get(name || r.title) === 1 && -r.amount >= 100000) reasons.push('陌生商户或首次大额支出');
    if (name && -r.amount >= 5000 && baseline.some(x => x.id !== r.id && merchantOf(x) === name && x.amount === r.amount && Math.abs(Date.parse(x.created_at) - Date.parse(r.created_at)) < DAY)) reasons.push('24小时内同额重复扣费');
    return reasons.length ? [{ id: r.id, ...brief(r), reasons }] : [];
  }).sort((a, b) => b.reasons.length - a.reasons.length || a.amount - b.amount).slice(0, 10);
}
export function recognizeSubscriptions(rows) {
  const groups=new Map();for(const r of rows.filter(x=>x.amount<0)){const key=r.title+':'+r.amount;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  return [...groups.values()].filter(g=>g.length>=2&&g.some((r,i)=>g.slice(i+1).some(s=>{const days=Math.abs(Date.parse(r.created_at)-Date.parse(s.created_at))/86400000;return days>=26&&days<=33;}))).map(g=>({merchant:g[0].title.replace(/^订阅 · /,''),amount:-g[0].amount,occurrences:g.length,detected:true}));
}
