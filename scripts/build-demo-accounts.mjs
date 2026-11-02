// Rebuilds server/seed/demo-accounts.json. Usage: node scripts/build-demo-accounts.mjs <建行明细.pdf> [真实姓名=化名 ...]
// `node scripts/build-demo-accounts.mjs --remask` re-applies the masking to the current seed, so a stricter rule needs neither the PDF nor the real names.
// Real names are never written here: the holder's comes from the PDF header and the rest from the command line.
// 邹瑞 comes from a CCB detail PDF. 万奇 comes from the fixture rows: its ICBC statement was once split into two users.
// Holders are renamed, card numbers stay simulated and counterparty accounts are masked, so no real account number enters the repo.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createBank } from '../server/db.mjs';
import { createProductCatalog, holdingSnapshot } from '../server/products.mjs';
import { classifyRow } from '../server/agent/analytics.mjs';
import { fileURLToPath } from 'node:url';

export const DEMO_ZOU = { phone: '18662995523', name: '邹瑞', card: '6218805061407941684' };
export const DEMO_WANQI = { phone: '15040147842', name: '万奇', card: '6218807752838722169' };
const TOPUP = 15000000, DAY = 86400000;
const TOPUP_DAY = '2026-10-01', PURCHASE_DAY = '2026-10-17', PURCHASE = 5000000, PURCHASE_PRODUCT = 'fund-003474';
const WANQI_SHIFT_DAYS = 31, FIXTURE_SHIFT_DAYS = 182;
const WANQI_PERIOD = `2025-11-02—2026-10-30（原 2025-10-02—2026-09-29，整体后移 ${WANQI_SHIFT_DAYS} 天）`;
const DEMO_FUNDS_NOTE = '演示资金，不在原对账单内';
// Rows are posted in order, so an added row must sit in time order for every later running balance to include it.
const insertByTime = (rows, row) => { const at = rows.findIndex(other => other[0] > row[0]); rows.splice(at < 0 ? rows.length : at, 0, row); return rows; };
// 邹瑞's monthly subscriptions, so the subscription scenario has something to show. They are not on the statement: four months of charges go in by time, marked in source_detail.
const DEMO_SUBSCRIPTIONS = [{ merchant: '视频会员', amount: 2500, day: 14 }, { merchant: '音乐', amount: 1500, day: 14 }, { merchant: '云盘', amount: 2100, day: 14 }];
const SUBSCRIPTION_MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10'];
export function addSubscriptions(user) {
  if (user.subscriptions) return user;
  for (const month of SUBSCRIPTION_MONTHS) for (const { merchant, amount, day } of DEMO_SUBSCRIPTIONS) {
    insertByTime(user.rows, [`${month}-${String(day).padStart(2, '0')}T02:00:00.000Z`, -amount, `消费 · 订阅 · ${merchant}`, 'payment', '消费', '订阅扣款', null, null, merchant, '澄川银行', null, null, 'second', { 说明: '演示订阅，不在原对账单内' }]);
  }
  user.closing -= SUBSCRIPTION_MONTHS.length * DEMO_SUBSCRIPTIONS.reduce((sum, s) => sum + s.amount, 0);
  user.subscriptions = DEMO_SUBSCRIPTIONS;
  return user;
}

export const aliases = new Map();
const rename = text => text == null ? null : [...aliases].reduce((value, [real, alias]) => value.replaceAll(real, alias), text);
const maskNumber = n => n.length >= 10 ? `${n.slice(0, 4)}****${n.slice(-4)}` : `${n.slice(0, 2)}****${n.slice(-2)}`;
const maskDigits = text => text?.replace(/\d{7,}/g, maskNumber) ?? null;
const maskAccount = account => !account ? null : account.includes('*') || account.length <= 4 ? account : maskNumber(account);
const PAYMENT_PREFIX = /^(?:支付宝-(?:支付宝-消费-|支付宝外部商户-|淘宝-|天猫-)?|财付通-(?:微信支付-)?|京东支付-(?:京东商城-)?|抖音支付-(?:抖音生活服务\/所见所得-)?|程支付-(?:携程旅行网-)?|美团支付-)/;
const PLATFORMS = [[/^支付宝/, '支付宝'], [/^财付通/, '微信支付'], [/^京东支付/, '京东支付'], [/^抖音支付/, '抖音支付'], [/^程支付/, '携程支付'], [/^美团支付/, '美团支付']];
const platformOfMemo = memo => PLATFORMS.find(([re]) => re.test(memo || ''))?.[1] ?? null;
const platformOfName = name => /财付通|腾安/.test(name || '') ? '微信支付' : /支付宝/.test(name || '') ? '支付宝' : /抖音/.test(name || '') ? '抖音支付' : '银行';
const INVESTMENT = /基金|证券/;

// One statement row in the seed's column order. Dates are noon Beijing time because the statement only has days.
export function convertRow({ seq, summary, date, amount, memo: rawMemo, counterparty: rawCounterparty }) {
  const memo = maskDigits(rename(rawMemo)) || null;
  // The account is everything before the first slash, unless that text is a bare name such as a bank branch.
  const separator = rawCounterparty ? rawCounterparty.indexOf('/') : -1, left = separator >= 0 ? rawCounterparty.slice(0, separator) : '';
  const [account, name] = /^[\w*]+$/.test(left) || left.includes('*') ? [left, rawCounterparty.slice(separator + 1)] : [null, rawCounterparty || null];
  const counterparty = rename(name);
  const self = counterparty === DEMO_ZOU.name;
  let title, category, txnType, merchant, platform;
  if (['消费', '充值', '缴费'].includes(summary)) {
    [title, category, txnType] = [`${summary} · ${memo}`, 'payment', summary];
    merchant = memo?.replace(PAYMENT_PREFIX, '') || null; platform = platformOfMemo(memo);
  } else if (summary === '消费退货') {
    title = memo?.endsWith(counterparty) ? `${summary} · ${memo}` : `${summary} · ${memo} · ${counterparty}`;
    [category, txnType, merchant, platform] = ['income', '退款', counterparty, platformOfMemo(memo)];
  } else if (summary === '利息存入') {
    [title, category, txnType, merchant, platform] = [summary, 'income', '利息', null, '银行'];
  } else if (summary === '基金赎回' || summary === '证转银') {
    title = [summary, memo, counterparty].filter(Boolean).join(' · ');
    [category, txnType, merchant, platform] = ['income', '理财赎回', counterparty, platformOfName(counterparty)];
  } else if (summary === '支付机构提现') {
    title = `${summary} · ${counterparty}`;
    [category, txnType, merchant, platform] = ['income', '提现', null, platformOfName(counterparty)];
  } else if (amount < 0) {
    title = memo === summary || !memo ? `${summary} · ${counterparty}` : `${summary} · ${memo} · ${counterparty}`;
    [category, txnType, merchant, platform] = ['transfer', self ? '本人转出' : INVESTMENT.test(counterparty || '') ? '理财买入' : '转出', counterparty, platformOfName(counterparty)];
  } else {
    // 普通汇兑 only ever carries internal reference numbers, so its title is the payer alone.
    title = summary === '普通汇兑' || summary === '代收付' || !memo ? `${summary} · ${counterparty}` : `${summary} · ${memo} · ${counterparty}`;
    [category, txnType, merchant, platform] = ['income', self ? '本人转入' : summary === '薪金报酬' ? '工资' : '转入', counterparty, platformOfName(counterparty)];
  }
  return [`${date}T04:00:00.000Z`, amount, title, category, txnType, summary, counterparty, maskAccount(account), merchant, platform, null, memo, 'day', { 序号: seq, 币别: '人民币元', 钞汇: '钞' }];
}

// Assigns each word to the row whose date sits vertically nearest; cells are centred on their row.
export function parseCcbPdf(file) {
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { maxBuffer: 1 << 28 }).toString();
  const decode = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
  const rows = [];
  for (const page of xml.split('<page ').slice(1)) {
    const words = [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(m => ({ x: +m[1], y: (+m[2] + +m[3]) / 2, text: decode(m[4]) }));
    const anchors = words.filter(w => w.x > 105 && w.x < 115 && /^20\d{6}$/.test(w.text));
    if (!anchors.length) continue;
    const top = anchors[0].y - 12, bottom = anchors.at(-1).y + 12;
    const nearest = word => anchors.reduce((best, anchor) => Math.abs(anchor.y - word.y) < Math.abs(best.y - word.y) ? anchor : best);
    const cell = (anchor, from, to) => {
      const parts = words.filter(w => w.x >= from && w.x < to && w.y > top && w.y < bottom && nearest(w) === anchor).sort((a, b) => a.y - b.y || a.x - b.x);
      return parts.reduce((text, w, i) => text + (i && Math.abs(parts[i - 1].y - w.y) < 1 ? ' ' : '') + w.text, '');
    };
    for (const anchor of anchors) {
      const number = text => Math.round(Number(text.replaceAll(',', '')) * 100);
      const raw = anchor.text;
      rows.push({ seq: Number(cell(anchor, 0, 45)), summary: cell(anchor, 45, 105), date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`,
        amount: number(cell(anchor, 150, 225)), balance: number(cell(anchor, 225, 305)), memo: cell(anchor, 305, 440), counterparty: cell(anchor, 440, 1000) });
    }
  }
  return rows;
}

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴'], GIVEN = ['晓明', '雨桐', '子涵', '思远', '嘉怡', '浩然', '欣怡', '文博', '雅婷', '俊杰', '梓萱', '宇轩', '诗涵', '明远', '佳琪', '志强', '若曦', '天宇', '梦瑶', '立群'];
export const PSEUDONYMS = SURNAMES.flatMap(surname => GIVEN.map(given => surname + given));
const fingerprint = name => createHash('sha256').update(name).digest('hex');
const byFingerprint = (a, b) => fingerprint(a).localeCompare(fingerprint(b));
// Bare short names the bill rules do not recognise but that are plainly not people.
const SHORT_BRANDS = new Set(['小红书', '久久丫', '迪卡侬', '赞赏码']);
const ORGANIZATION = /大学|学院|学校|公司|银行|医院|集团|中心/;
const PSEUDONYM_SET = new Set(PSEUDONYMS);

// Anywhere in the row a name belongs to. Elsewhere a two-character name only counts when it stands alone, or 小龙 would rewrite 小龙虾店.
function substitute(row, at, pseudonym) {
  const own = new Set([row[at('counterparty')], row[at('merchant')]]);
  for (const field of ['title', 'counterparty', 'merchant', 'memo']) {
    if (typeof row[at(field)] !== 'string') continue;
    row[at(field)] = [...pseudonym].reduce((text, [name, alias]) => own.has(name) || name.length > 2 ? text.replaceAll(name, alias) : text.replace(new RegExp(`(?<![一-龥])${name}(?![一-龥])`, 'g'), alias), row[at(field)]);
  }
}

// Friends and family in person-to-person transfers get a stable pseudonym and a fully masked account. Companies keep their names.
export function maskPrivateTransfers(users, columns) {
  const at = name => columns.indexOf(name), holders = new Set(users.map(u => u.name));
  const isPrivate = row => ['转入', '转出'].includes(row[at('txn_type')]) && /^[一-龥]{2,4}$/.test(row[at('counterparty')] || '') && !holders.has(row[at('counterparty')]) && !ORGANIZATION.test(row[at('counterparty')]);
  const allRows = users.flatMap(u => u.rows);
  const names = [...new Set(allRows.filter(isPrivate).map(row => row[at('counterparty')]))].filter(name => !PSEUDONYM_SET.has(name)).sort(byFingerprint);
  const taken = new Set(allRows.map(row => row[at('counterparty')]));
  const pool = PSEUDONYMS.filter(name => !taken.has(name)).sort(byFingerprint);
  if (names.length > pool.length) throw new Error('化名不够用');
  const pseudonym = new Map(names.map((name, i) => [name, pool[i]]));
  for (const row of allRows) {
    const masked = isPrivate(row);
    substitute(row, at, pseudonym);
    if (masked) row[at('counterparty_account')] = '****';
  }
  return names.length;
}

// Small vendors take payment through personal QR codes, so the merchant on those rows is a real person's name. A short name the rules cannot place counts as one too.
const isPersonalMerchant = name => {
  if (!name || !/^[一-龥]{2,3}$/.test(name) || SHORT_BRANDS.has(name) || ORGANIZATION.test(name) || PSEUDONYM_SET.has(name)) return false;
  const { tag, tag_source } = classifyRow({ title: `消费 · ${name}`, amount: -1, category: 'payment', txn_type: '消费', merchant: name });
  return tag === '个人收款码' || tag_source === 'fallback';
};
export function maskPersonalMerchants(users, columns) {
  const at = name => columns.indexOf(name), holders = new Set(users.map(u => u.name)), allRows = users.flatMap(u => u.rows);
  const isPerson = name => isPersonalMerchant(name) && !holders.has(name);
  const names = [...new Set(allRows.map(row => row[at('merchant')]).filter(isPerson))].sort(byFingerprint);
  const taken = new Set(allRows.flatMap(row => [row[at('merchant')], row[at('counterparty')]]));
  const pool = PSEUDONYMS.filter(name => !taken.has(name)).sort(byFingerprint);
  if (names.length > pool.length) throw new Error('化名不够用');
  const pseudonym = new Map(names.map((name, i) => [name, pool[i]]));
  for (const row of allRows) {
    const direct = isPerson(row[at('counterparty')]);
    substitute(row, at, pseudonym);
    if (direct) row[at('counterparty_account')] = '****';
  }
  return names.length;
}

export function maskIdentifiers(users, columns) {
  const at = name => columns.indexOf(name);
  for (const row of users.flatMap(u => u.rows)) {
    for (const field of ['title', 'counterparty', 'merchant', 'memo']) row[at(field)] = maskDigits(row[at(field)]);
    row[at('counterparty_account')] = maskAccount(row[at('counterparty_account')]);
  }
}

function buildZou(file) {
  const holder = execFileSync('pdftotext', ['-l', '1', file, '-']).toString().match(/客户名称[:：]\s*(\S+)/)?.[1];
  if (!holder) throw new Error('对账单缺少客户名称');
  aliases.set(holder, DEMO_ZOU.name);
  const rows = parseCcbPdf(file);
  if (!rows.every((r, i) => r.seq === i + 1)) throw new Error('流水序号不连续');
  const opening = rows[0].balance - rows[0].amount;
  rows.reduce((balance, r) => { if (balance + r.amount !== r.balance) throw new Error(`第${r.seq}笔余额不符`); return r.balance; }, opening);
  const bank = createBank(':memory:'), product = createProductCatalog(bank, {}).get(PURCHASE_PRODUCT);
  bank.db.close();
  if (!product) throw new Error('产品不存在');
  const closing = rows.at(-1).balance + TOPUP - PURCHASE, created_at = `${PURCHASE_DAY}T04:00:00.000Z`;
  const seeded = [['2025-10-31T16:00:00.000Z', opening, '期初余额', 'opening', '期初余额', null, null, null, null, null, null, '按导入首笔交易倒推的期初余额', 'day', null], ...rows.map(convertRow)];
  insertByTime(seeded, [`${TOPUP_DAY}T04:00:00.000Z`, TOPUP, `汇兑 · 电子汇入 · ${DEMO_ZOU.name}`, 'income', '本人转入', '汇兑', DEMO_ZOU.name, '6235****8006', DEMO_ZOU.name, '银行', null, '电子汇入', 'day', { 币别: '人民币元', 钞汇: '钞', 说明: DEMO_FUNDS_NOTE }]);
  insertByTime(seeded, [created_at, -PURCHASE, `申购 · ${product.name}`, 'investment', '理财买入', '申购', null, null, null, '澄川银行', null, null, 'day', { 说明: DEMO_FUNDS_NOTE }]);
  // Only the position is seeded. Its earnings come from the fund's real NAV history when the holding is read.
  return { ...DEMO_ZOU, source_bank: '中国建设银行', period: `${rows[0].date}—2026-11-01`, closing, rows: seeded,
    holdings: [{ product_id: product.id, principal: PURCHASE, created_at, product_snapshot: holdingSnapshot(product) }] };
}

function buildWanqi(fixtures) {
  const [first, second] = ['万锦', '万奇'].map(name => fixtures.users.find(u => u.name === name));
  const moved = (row, days) => [new Date(Date.parse(row[0]) + days * DAY).toISOString(), ...row.slice(1)];
  const named = row => row.map(value => typeof value === 'string' ? value.replaceAll('万锦', DEMO_WANQI.name).replaceAll('WAN JIN', 'WAN QI') : value);
  const rows = [...first.rows.map(row => moved(row, -FIXTURE_SHIFT_DAYS)), ...second.rows.slice(1)].map(row => named(moved(row, WANQI_SHIFT_DAYS)));
  if (rows.reduce((sum, row) => sum + row[1], 0) !== second.closing) throw new Error('万奇合并后余额不符');
  return { ...DEMO_WANQI, source_bank: second.source_bank, period: WANQI_PERIOD, closing: second.closing + TOPUP,
    rows: insertByTime(rows, [`${TOPUP_DAY}T02:00:00.000Z`, TOPUP, '他行汇入 · WAN QI', 'income', '本人转入', '他行汇入', 'WAN QI', '4480****0214', 'WAN QI', '银行', '其他', null, 'second', { 说明: DEMO_FUNDS_NOTE }]) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = new URL('../server/seed/', import.meta.url);
  let output;
  if (process.argv[2] === '--remask') {
    output = JSON.parse(readFileSync(new URL('demo-accounts.json', seed), 'utf8'));
    output.users.find(u => u.phone === DEMO_WANQI.phone).period = WANQI_PERIOD;
  } else {
    const fixtures = JSON.parse(readFileSync(new URL('fixture-statements.json', seed), 'utf8'));
    for (const pair of process.argv.slice(3)) { const [real, alias] = pair.split('='); aliases.set(real, alias); }
    output = { columns: fixtures.columns, users: [buildZou(process.argv[2]), buildWanqi(fixtures)] };
  }
  addSubscriptions(output.users.find(u => u.phone === DEMO_ZOU.phone));
  maskIdentifiers(output.users, output.columns);
  console.log('私人转账对象', maskPrivateTransfers(output.users, output.columns), '人；个人收款码', maskPersonalMerchants(output.users, output.columns), '人');
  // One row per line keeps later regenerations reviewable as diffs.
  const users = output.users.map(({ rows, ...user }) => `  ${JSON.stringify(user).slice(0, -1)},"rows":[\n${rows.map(row => '   ' + JSON.stringify(row)).join(',\n')}\n  ]}`);
  writeFileSync(new URL('demo-accounts.json', seed), `{"columns":${JSON.stringify(output.columns)},"users":[\n${users.join(',\n')}\n]}\n`);
  for (const u of output.users) console.log(u.name, u.phone, u.period, 'rows', u.rows.length, 'closing', u.closing / 100);
}
