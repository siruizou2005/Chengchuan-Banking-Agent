import { readFileSync } from 'node:fs';
import { request } from 'node:https';

// Public fund data from Eastmoney's unofficial mobile endpoints: free and keyless but undocumented,
// so every value is display-only, cached in SQLite, and falls back to the bundled snapshot.
export const FUND_SOURCE = '东方财富天天基金';
export const FUND_CODES = Object.freeze([
  '000198', '000009', '004501', '003474', '003003', '000330', '000397', '000569', '000686', '050003', '202301', '270004', '482002',
  '006662', '007194', '217022', '000032', '070009', '000084', '003376', '000147', '519718', '519762', '040045', '006597',
  '110008', '110017', '000171', '001316', '090002', '485111', '002351', '110027', '001182', '002015', '004010', '000215', '000875',
  '519736', '005827', '163406', '001714', '000083', '260108', '161005', '001938', '166002', '000751', '003095', '110022', '005911',
  '163402', '519066', '161903', '040025', '519697', '000977', '001410', '001054', '000628', '519005', '003567', '000220', '001156',
  '002190', '320007', '519674', '110013', '006113', '004851', '001071', '002939',
  '110020', '008888', '000216', '161725', '000961', '001548', '000962', '001594', '160119', '110003', '004752', '161017',
  '050025', '270042', '000369', '162411', '096001', '160213', '000071', '110011', '164906', '000614', '012348',
  '501018', '160216', '160723', '161129',
]);
// Tencent symbols for 上证指数, 深证成指, 沪深300, 创业板指.
export const INDEX_SYMBOLS = Object.freeze(['sh000001', 'sz399001', 'sh000300', 'sz399006']);
export const INDEX_SOURCE = '腾讯财经';
const indexSymbol = code => INDEX_SYMBOLS.find(s => s.slice(2) === code);
export const RISK_LABEL = Object.freeze({ 1: 'R1 低风险', 2: 'R2 中低风险', 3: 'R3 中风险', 4: 'R4 中高风险', 5: 'R5 高风险' });
export const CATEGORY_LABEL = Object.freeze({ deposit: '定期存款', money: '货币基金', bond: '债券基金', mixed: '混合基金', equity: '股票基金', index: '指数基金', qdii: 'QDII/海外' });

const DEPOSIT_SOURCE = { source: '澄川银行挂牌利率（演示）', updatedAt: '2026-10-01T00:00:00.000Z' };
export const DEPOSITS = Object.freeze([
  { id: 'deposit-90', type: 'deposit', category: 'deposit', name: '安心存三个月', subtitle: '90天整存整取，支持提前支取', rate: 1.35, rateLabel: '年利率', days: 90, minimum: 5000, riskLevel: 0, risk: '存款', issuer: '澄川银行', purchasable: true, tags: ['50元起存', '到期可取'], description: '人民币整存整取定期存款，存期90天，支持提前支取。演示环境按本金结算，不计付利息。', ...DEPOSIT_SOURCE },
  { id: 'deposit-365', type: 'deposit', category: 'deposit', name: '安心存一年期', subtitle: '365天整存整取，支持提前支取', rate: 1.65, rateLabel: '年利率', days: 365, minimum: 5000, riskLevel: 0, risk: '存款', issuer: '澄川银行', purchasable: true, tags: ['50元起存', '整存整取'], description: '人民币整存整取定期存款，存期一年，支持提前支取。演示环境按本金结算，不计付利息。', ...DEPOSIT_SOURCE },
]);
// Retired demo products: no longer sold, kept so existing holdings still render and redeem.
export const LEGACY_PRODUCTS = Object.freeze([
  { id: 'wealth-flex', type: 'wealth', category: 'money', name: '澄享日日盈', subtitle: '现金管理类，每日可申赎', rate: 2.18, rateLabel: '成立以来年化', days: 0, minimum: 10000, riskLevel: 1, risk: 'R1 低风险', issuer: '澄川理财', purchasable: false, purchaseStatus: '已停售', tags: ['已停售'], description: '已停售的演示产品，持有份额按本金赎回。', source: '澄川银行演示数据', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'wealth-180', type: 'wealth', category: 'bond', name: '澄享稳进180天', subtitle: '固定持有期，到期后可赎回', rate: 3.20, rateLabel: '业绩比较基准', days: 180, minimum: 100000, riskLevel: 2, risk: 'R2 中低风险', issuer: '澄川理财', purchasable: false, purchaseStatus: '已停售', tags: ['已停售'], description: '已停售的演示产品，持有180天后按本金赎回。', source: '澄川银行演示数据', updatedAt: '2026-01-01T00:00:00.000Z' },
]);

export function migrateProducts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_cache (id TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS product_sync (source TEXT PRIMARY KEY, success_at TEXT, attempt_at TEXT, error TEXT, partial TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS product_history (id TEXT NOT NULL, range TEXT NOT NULL, data TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(id,range));
  `);
  if (!db.prepare('PRAGMA table_info(holdings)').all().some(c => c.name === 'product_snapshot')) db.exec('ALTER TABLE holdings ADD COLUMN product_snapshot TEXT');
  const backfill = db.prepare('UPDATE holdings SET product_snapshot=? WHERE product_id=? AND product_snapshot IS NULL');
  for (const p of [...DEPOSITS, ...LEGACY_PRODUCTS]) backfill.run(JSON.stringify(holdingSnapshot(p)), p.id);
}

const num = v => { const n = Number(v); return v === '' || v === null || v === undefined || v === '--' || !Number.isFinite(n) ? null : n; };
function category(type = '') {
  if (type.startsWith('货币')) return 'money';
  if (type.startsWith('QDII') || type.includes('海外')) return 'qdii';
  if (type.startsWith('债券') || type === '指数型-固收') return 'bond';
  if (type.startsWith('指数')) return 'index';
  if (type.startsWith('股票')) return 'equity';
  return 'mixed';
}
// "限大额(单日投资上限500万元)" -> 500,000,000 cents.
function purchaseLimit(status = '') {
  const m = status.match(/上限([\d.]+)(万|亿)?元/);
  return m ? Math.round(Number(m[1]) * ({ 万: 1e4, 亿: 1e8 }[m[2]] || 1) * 100) : null;
}
const yuanText = c => { const y = c / 100; return y >= 1e4 ? `${y / 1e4}万元` : `${y}元`; };

export function normalizeFund(d, fetchedAt) {
  const code = String(d.FCODE), cat = category(d.FTYPE), money = cat === 'money';
  const riskLevel = Math.min(5, Math.max(1, Number(d.RISKLEVEL) || 3));
  const minimum = Math.max(1, Math.round((num(d.MINSG) ?? 10) * 100));
  const status = d.SGZT || '未知', limit = purchaseLimit(status), purchasable = !status.includes('暂停申购');
  const rate = money ? num(d.SYI) : num(d.SYL_1N);
  return {
    id: `fund-${code}`, code, type: 'wealth', category: cat, fundType: d.FTYPE, name: d.SHORTNAME, issuer: d.JJGS,
    riskLevel, risk: RISK_LABEL[riskLevel], rate, rateLabel: money ? '7日年化' : '近一年收益',
    returns: { m1: num(d.SYL_Y), m3: num(d.SYL_3Y), m6: num(d.SYL_6Y), y1: num(d.SYL_1N) },
    ...(money ? { perTenThousand: num(d.DWJZ) } : { nav: num(d.DWJZ), accNav: num(d.LJJZ) }), navDate: d.FSRQ || null,
    minimum, fee: d.RATE || '0.00%', purchaseStatus: status, redeemStatus: d.SHZT || '未知', purchaseLimit: limit, purchasable, days: 0,
    subtitle: `${CATEGORY_LABEL[cat]} · ${d.JJGS}`,
    tags: [`${yuanText(minimum)}起购`, purchasable ? (limit ? `单日上限${yuanText(limit)}` : '开放申购') : '暂停申购'],
    description: `${d.FTYPE}，基金管理人${d.JJGS}。业绩与净值来自${FUND_SOURCE}公开数据，仅供展示参考，过往业绩不代表未来表现。演示环境为模拟申购，按本金结算，不计算净值变动。`,
    source: FUND_SOURCE, sourceUrl: `https://fund.eastmoney.com/${code}.html`, updatedAt: fetchedAt,
  };
}
export const holdingSnapshot = p => ({ id: p.id, type: p.type, category: p.category, name: p.name, risk: p.risk, riskLevel: p.riskLevel, days: p.days, issuer: p.issuer, source: p.source });

// Eastmoney closes idle keep-alive sockets without notice, and fetch's pooled sockets then fail
// with "other side closed". A fresh connection per request (agent: false) avoids that; the
// volume is a few requests per refresh, so the handshake cost is irrelevant.
export function freshFetch(url, { signal, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, headers, signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const body = Buffer.concat(chunks); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(body.toString('utf8')), text: async (encoding = 'utf-8') => new TextDecoder(encoding).decode(body) }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
// Quote hosts sometimes drop the connection or answer 5xx; one quick retry covers that.
// 4xx and timeouts are not retried.
async function fetchBody(fetchImpl, url, timeoutMs, read, retries = 1) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { final: response.status < 500 });
    return await read(response);
  } catch (error) {
    if (retries <= 0 || error.final || error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
    await new Promise(resolve => setTimeout(resolve, 300));
    return fetchBody(fetchImpl, url, timeoutMs, read, retries - 1);
  }
}
const getJson = (fetchImpl, url, timeoutMs) => fetchBody(fetchImpl, url, timeoutMs, r => r.json());
export async function fetchFund(fetchImpl, code, timeoutMs, fetchedAt = new Date().toISOString()) {
  const body = await getJson(fetchImpl, `https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx?FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0`, timeoutMs);
  if (!body?.Datas?.FCODE) throw new Error(`no data for ${code}`);
  return normalizeFund(body.Datas, fetchedAt);
}
// Index quotes come from Tencent: Eastmoney's quote host answers 302/502 intermittently from the
// Hong Kong server. The reply is GBK text, one line per symbol:
// v_sh000300="1~沪深300~000300~price~prevClose~open~...~30:time~31:change~32:changePct~33:high~34:low~35:price/volume/amount~...";
export async function fetchIndices(fetchImpl, timeoutMs, fetchedAt = new Date().toISOString()) {
  const text = await fetchBody(fetchImpl, `https://qt.gtimg.cn/q=${INDEX_SYMBOLS.join(',')}`, timeoutMs, r => r.text('gbk'));
  const rows = [...text.matchAll(/v_(\w+)="([^"]*)"/g)].map(([, symbol, body]) => [symbol, body.split('~')]).filter(([symbol, f]) => INDEX_SYMBOLS.includes(symbol) && f.length > 35);
  if (!rows.length) throw new Error('no index data');
  return rows.map(([symbol, f]) => ({ code: symbol.slice(2), name: f[1], price: num(f[3]), change: num(f[31]), changePct: num(f[32]), open: num(f[5]), high: num(f[33]), low: num(f[34]), prevClose: num(f[4]), amount: num(f[35].split('/')[2]), source: INDEX_SOURCE, updatedAt: fetchedAt }));
}
// Eastmoney RANGE codes: y = one month, 3y/6y = three/six months, n = one year.
export const HISTORY_RANGES = Object.freeze({ '1m': 'y', '3m': '3y', '6m': '6y', '1y': 'n' });
// Money funds chart their 7-day annualised yield (LJJZ); others chart cumulative return from
// accumulated NAV, so dividends do not show up as drops.
export async function fetchHistory(fetchImpl, product, range, timeoutMs) {
  const body = await getJson(fetchImpl, `https://fundmobapi.eastmoney.com/FundMApi/FundNetDiagram.ashx?FCODE=${product.code}&RANGE=${HISTORY_RANGES[range]}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0`, timeoutMs);
  const rows = (body?.Datas || []).map(r => ({ date: r.FSRQ, nav: num(r.DWJZ), acc: num(r.LJJZ) })).filter(r => r.date && r.acc !== null);
  if (rows.length < 2) throw new Error(`no history for ${product.code}`);
  const money = product.category === 'money', base = rows[0].acc;
  return rows.map(r => ({ date: r.date, value: money ? r.acc : Math.round((r.acc / base - 1) * 10000) / 100, ...(money ? { perTenThousand: r.nav } : { nav: r.nav }) }));
}
// Index daily closes also come from Tencent: Eastmoney's kline host (push2his) resets about half
// of all connections. Trading days per range:
const KLINE_DAYS = Object.freeze({ '1m': 22, '3m': 66, '6m': 130, '1y': 250 });
export async function fetchIndexHistory(fetchImpl, code, range, timeoutMs) {
  const symbol = indexSymbol(code);
  const body = await getJson(fetchImpl, `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${KLINE_DAYS[range]},qfq`, timeoutMs);
  // Each row is [date, open, close, high, low, volume].
  const rows = (body?.data?.[symbol]?.day || []).map(([date, open, close, high, low]) => ({ date, value: num(close), open: num(open), high: num(high), low: num(low) })).filter(r => r.date && r.value !== null);
  if (rows.length < 2) throw new Error(`no kline for ${code}`);
  return rows;
}
// Runs fetches with bounded concurrency; failures resolve to undefined.
async function pooled(items, limit, task) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await task(items[i]); } catch { out[i] = undefined; } }
  }));
  return out;
}
export async function fetchCatalog(fetchImpl = freshFetch, { codes = FUND_CODES, timeoutMs = 4000, concurrency = 6 } = {}) {
  const fetchedAt = new Date().toISOString();
  const [funds, market] = await Promise.all([
    pooled(codes, concurrency, code => fetchFund(fetchImpl, code, timeoutMs, fetchedAt)),
    fetchIndices(fetchImpl, timeoutMs, fetchedAt).catch(() => null),
  ]);
  return { fetchedAt, funds: funds.filter(Boolean), failed: codes.filter((_, i) => !funds[i]), market };
}

const SNAPSHOT_URL = new URL('./fund-snapshot.json', import.meta.url);
const STALE_NOTICE = '外部数据暂不可用，当前展示的是缓存数据，可能不是最新';

export function createProductCatalog(bank, options = {}) {
  const { db } = bank;
  const remote = options.remote ?? false;
  const fetchImpl = options.fetch || freshFetch;
  const ttlMs = options.ttlMs ?? 6 * 3600000, staleAfterMs = options.staleAfterMs ?? 3 * 86400000;
  const codes = options.codes || FUND_CODES, timeoutMs = options.timeoutMs ?? 4000, concurrency = options.concurrency ?? 6;
  const snapshot = options.snapshot || JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8'));
  const sync = () => db.prepare("SELECT * FROM product_sync WHERE source='eastmoney'").get();
  let funds, market, inflight = null;

  function load() {
    const rows = db.prepare('SELECT data FROM product_cache').all().map(r => JSON.parse(r.data));
    const byId = new Map(snapshot.funds.filter(f => codes.includes(f.code)).map(f => [f.id, f]));
    for (const row of rows) if (codes.includes(row.code)) byId.set(row.id, row);
    funds = codes.map(code => byId.get(`fund-${code}`)).filter(Boolean);
    const s = sync();
    market = s?.data ? JSON.parse(s.data) : snapshot.market || [];
  }
  load();

  function meta() {
    const s = sync(), successAt = s?.success_at || null;
    const updatedAt = successAt || snapshot.capturedAt;
    const age = Date.now() - Date.parse(updatedAt);
    // error is cleared by every successful refresh, so it means the latest attempt failed.
    const stale = !successAt || age > staleAfterMs || Boolean(s?.error);
    return {
      source: FUND_SOURCE, updatedAt, stale, fallback: !successAt ? 'snapshot' : null, remote,
      notice: stale ? (successAt ? STALE_NOTICE : `${remote ? '外部数据暂未获取成功，' : ''}当前展示的是${snapshot.capturedAt.slice(0, 10)}抓取的内置数据，可能不是最新`) : null,
    };
  }
  async function refresh() {
    const attemptAt = new Date().toISOString();
    try {
      const result = await fetchCatalog(fetchImpl, { codes, timeoutMs, concurrency });
      if (!result.funds.length) throw new Error('all fund requests failed');
      const put = db.prepare('INSERT INTO product_cache(id,data,fetched_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const f of result.funds) put.run(f.id, JSON.stringify(f), result.fetchedAt);
        const partial = result.failed.length ? `${result.failed.length} funds failed: ${result.failed.slice(0, 10).join(',')}` : null;
        db.prepare(`INSERT INTO product_sync(source,success_at,attempt_at,error,partial,data) VALUES('eastmoney',?,?,NULL,?,?)
          ON CONFLICT(source) DO UPDATE SET success_at=excluded.success_at,attempt_at=excluded.attempt_at,error=NULL,partial=excluded.partial,data=COALESCE(excluded.data,product_sync.data)`)
          .run(result.fetchedAt, attemptAt, partial, result.market ? JSON.stringify(result.market) : null);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      load();
      return { ok: true, funds: result.funds.length, failed: result.failed };
    } catch (error) {
      db.prepare(`INSERT INTO product_sync(source,attempt_at,error) VALUES('eastmoney',?,?) ON CONFLICT(source) DO UPDATE SET attempt_at=excluded.attempt_at,error=excluded.error`).run(attemptAt, String(error.message || error).slice(0, 300));
      return { ok: false, error: error.message };
    }
  }
  // Called from request paths only: no background polling. Concurrent callers share one refresh.
  function ensureFresh() {
    if (!remote) return Promise.resolve();
    const s = sync();
    // After a failed refresh, retry sooner (10 minutes at most) instead of waiting a full TTL.
    const failing = Boolean(s?.error);
    const last = Date.parse((failing ? s.attempt_at : s?.success_at) || 0);
    if (Date.now() - last < (failing ? Math.min(ttlMs, 600000) : ttlMs)) return inflight || Promise.resolve();
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }
  // Index quotes move intraday, so they refresh on their own short interval (one request).
  const marketTtlMs = options.marketTtlMs ?? 300000;
  let marketAt = Date.parse(sync()?.success_at || 0), marketFlight = null;
  function ensureMarket() {
    if (!remote || Date.now() - marketAt < marketTtlMs) return marketFlight || Promise.resolve();
    marketAt = Date.now();
    marketFlight ||= fetchIndices(fetchImpl, timeoutMs).then(rows => {
      market = rows;
      db.prepare("UPDATE product_sync SET data=? WHERE source='eastmoney'").run(JSON.stringify(rows));
    }).catch(() => {}).finally(() => { marketFlight = null; });
    return marketFlight;
  }
  // Waits for a refresh at most waitMs; slower refreshes finish in the background and land in the cache.
  async function ready(waitMs = options.waitMs ?? 1500) {
    const pending = Promise.all([ensureFresh(), ensureMarket()]);
    await Promise.race([pending, new Promise(resolve => setTimeout(resolve, waitMs).unref?.())]);
  }
  const historyFlight = new Map();
  // Charts are fetched only when someone opens a detail page, then cached per item and range.
  async function cachedSeries(key, range, meta, load, maxAgeMs = ttlMs) {
    const cached = db.prepare('SELECT data,fetched_at FROM product_history WHERE id=? AND range=?').get(key, range);
    const view = (row, stale) => ({ id: key, range, source: FUND_SOURCE, ...meta, points: row ? JSON.parse(row.data) : [], updatedAt: row?.fetched_at || null, stale, notice: stale ? (row ? STALE_NOTICE : '暂时无法获取走势数据，请稍后再试') : null });
    if (cached && Date.now() - Date.parse(cached.fetched_at) < maxAgeMs) return view(cached, false);
    if (!remote) return view(cached, true);
    const flight = `${key}:${range}`;
    if (!historyFlight.has(flight)) historyFlight.set(flight, load().then(points => {
      const fetchedAt = new Date().toISOString();
      db.prepare('INSERT INTO product_history(id,range,data,fetched_at) VALUES(?,?,?,?) ON CONFLICT(id,range) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').run(key, range, JSON.stringify(points), fetchedAt);
      return { data: JSON.stringify(points), fetched_at: fetchedAt };
    }).finally(() => historyFlight.delete(flight)));
    try { return view(await historyFlight.get(flight), false); } catch { return view(cached, true); }
  }
  function history(productId, range) {
    const product = get(productId);
    if (!product?.code || !HISTORY_RANGES[range]) return null;
    return cachedSeries(productId, range, { metric: product.category === 'money' ? '7日年化' : '累计收益率', unit: '%' }, () => fetchHistory(fetchImpl, product, range, timeoutMs));
  }
  function indexHistory(code, range) {
    if (!indexSymbol(code) || !KLINE_DAYS[range]) return null;
    return cachedSeries(`index-${code}`, range, { metric: '收盘点位', unit: '点', source: INDEX_SOURCE }, () => fetchIndexHistory(fetchImpl, code, range, timeoutMs), Math.min(ttlMs, 1800000));
  }
  const list = () => [...DEPOSITS, ...funds];
  const get = productId => list().find(p => p.id === productId);
  // Holdings keep a snapshot so a delisted or renamed fund still renders and redeems.
  function forHolding(h) {
    const live = get(h.product_id) || LEGACY_PRODUCTS.find(p => p.id === h.product_id);
    const saved = h.product_snapshot ? JSON.parse(h.product_snapshot) : { id: h.product_id, type: 'wealth', name: h.product_id, risk: '', riskLevel: 0, days: 0 };
    return live || { ...saved, rate: null, rateLabel: '', minimum: 0, purchasable: false, purchaseStatus: '已下架', tags: [], subtitle: '产品数据已下架，仅保留持仓', description: '' };
  }
  return { list, get, forHolding, meta, market: () => market, history, indexHistory, refresh, ensureFresh, ready, codes };
}
