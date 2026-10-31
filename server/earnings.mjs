import { CATEGORY_LABEL } from './products.mjs';
import { requireThat } from './errors.mjs';

// Daily earnings on holdings. Settled on demand (reading holdings or redeeming), never by a timer, and each
// holding and date is booked once. Rate products accrue on principal; funds compound on their current value.
const DAY = 86400000;
export const beijingDate = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

export function migrateEarnings(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS holding_earnings (
      holding_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), product_id TEXT NOT NULL,
      date TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(holding_id,date));
    CREATE INDEX IF NOT EXISTS holding_earnings_user ON holding_earnings(user_id,date);`);
  const columns = new Set(db.prepare('PRAGMA table_info(holdings)').all().map(c => c.name));
  for (const [column, ddl] of [['earnings', 'INTEGER NOT NULL DEFAULT 0'], ['settled_through', 'TEXT'], ['accrual_carry', 'REAL NOT NULL DEFAULT 0']])
    if (!columns.has(column)) db.exec(`ALTER TABLE holdings ADD COLUMN ${column} ${ddl}`);
}

const pointRatio = (previous, current) => previous.acc != null && current.acc != null && previous.acc > 0
  ? current.acc / previous.acc
  : (1 + current.value / 100) / (1 + previous.value / 100);

// Pure: what one holding earns after its settled date, up to and including `through`.
export function accrue(holding, product, points, through) {
  let earnings = holding.earnings || 0, carry = holding.accrual_carry || 0, cursor = holding.settled_through || beijingDate(Date.parse(holding.created_at));
  const start = cursor, rows = [];
  // Fractions of a cent carry over, so a small holding still earns instead of rounding to zero every day.
  const book = (date, exact) => {
    // Rounded first so floating-point noise (9999.9999999) cannot drop a whole cent.
    const total = Math.round((exact + carry) * 1e6) / 1e6, cents = Math.trunc(total);
    carry = total - cents;
    if (cents) { rows.push({ date, amount: cents }); earnings += cents; }
    cursor = date;
  };
  if (product.code && product.category !== 'money') {
    for (let i = 1; i < points.length; i++) {
      const current = points[i];
      if (current.date <= cursor || current.date > through) continue;
      const base = holding.principal + earnings;
      book(current.date, Math.max(-base, base * (pointRatio(points[i - 1], current) - 1)));
    }
  } else if (product.code) {
    let index = -1;
    for (let date = nextDay(cursor); date <= through; date = nextDay(date)) {
      while (index + 1 < points.length && points[index + 1].date <= date) index++;
      const rate = index >= 0 ? points[index].value : product.rate;
      if (rate == null) break;
      book(date, (holding.principal + earnings) * rate / 100 / 365);
    }
  } else if (product.rate > 0) {
    const maturity = product.type === 'deposit' ? beijingDate(Date.parse(holding.unlock_at)) : through, last = maturity < through ? maturity : through;
    for (let date = nextDay(cursor); date <= last; date = nextDay(date)) book(date, holding.principal * product.rate / 100 / 365);
    if (maturity < through && cursor < through) cursor = through; // Interest stops at maturity; nothing left to revisit.
  }
  return { rows, earnings, carry, settledThrough: cursor, changed: cursor !== start };
}

export function createEarnings(bank, catalog) {
  const { all, get, run, atomic } = bank;
  const yesterday = () => beijingDate(Date.now() - DAY);
  function settle(userId) {
    const through = yesterday();
    const pending = all('SELECT * FROM holdings WHERE user_id=? AND principal+earnings>0 AND (settled_through IS NULL OR settled_through<?)', userId, through);
    if (!pending.length) return;
    const results = [];
    for (const holding of pending) {
      const product = catalog.forHolding(holding);
      // Fund NAVs come from the cache only; a refresh runs in the background and the next read books the new days.
      if (product.code) Promise.resolve(catalog.history(product.id, '1y')).catch(() => {});
      const result = accrue(holding, product, product.code ? catalog.cachedPoints(product.id) : [], through);
      if (result.changed) results.push({ holding, result });
    }
    if (!results.length) return;
    atomic(() => {
      for (const { holding, result } of results) {
        for (const row of result.rows) run('INSERT OR IGNORE INTO holding_earnings(holding_id,user_id,product_id,date,amount) VALUES(?,?,?,?,?)', holding.id, userId, holding.product_id, row.date, row.amount);
        run('UPDATE holdings SET earnings=?,accrual_carry=?,settled_through=? WHERE id=?', result.earnings, result.carry, result.settledThrough, holding.id);
      }
    });
  }
  function summary(userId) {
    const through = yesterday();
    return {
      asOf: through,
      yesterday: get('SELECT COALESCE(SUM(amount),0) AS n FROM holding_earnings WHERE user_id=? AND date=?', userId, through).n,
      total: get('SELECT COALESCE(SUM(amount),0) AS n FROM holding_earnings WHERE user_id=?', userId).n,
    };
  }
  const byHolding = (userId, date = yesterday()) => new Map(all('SELECT holding_id,amount FROM holding_earnings WHERE user_id=? AND date=?', userId, date).map(r => [r.holding_id, r.amount]));
  function breakdown(userId, key) {
    const rows = all('SELECT e.holding_id,e.product_id,SUM(e.amount) AS amount,h.created_at,h.unlock_at,h.product_snapshot FROM holding_earnings e LEFT JOIN holdings h ON h.id=e.holding_id WHERE e.user_id=? AND e.date LIKE ? GROUP BY e.holding_id ORDER BY ABS(SUM(e.amount)) DESC', userId, `${key}%`);
    const groups = new Map();
    const items = rows.map(row => {
      const product = catalog.forHolding(row), label = CATEGORY_LABEL[product.category] || '理财';
      groups.set(label, (groups.get(label) || 0) + row.amount);
      return { holdingId: row.holding_id, productId: row.product_id, name: product.name, label, amount: row.amount };
    });
    return { total: rows.reduce((sum, row) => sum + row.amount, 0), composition: [...groups].map(([label, amount]) => ({ label, amount })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)), items };
  }
  // view: day (period = YYYY-MM), month (period = YYYY), year, all. `key` picks the date, month or year to break down.
  function report(userId, { view = 'day', period, key } = {}) {
    requireThat(['day', 'month', 'year', 'all'].includes(view), '收益视图无效', 400, 'INVALID_EARNINGS_QUERY');
    settle(userId);
    const through = yesterday();
    const scope = view === 'day' ? period || through.slice(0, 7) : view === 'month' ? period || through.slice(0, 4) : '';
    requireThat(view === 'day' ? /^\d{4}-\d{2}$/.test(scope) : view === 'month' ? /^\d{4}$/.test(scope) : !period, '收益区间无效', 400, 'INVALID_EARNINGS_QUERY');
    const width = { day: 10, month: 7, year: 4 }[view];
    const series = view === 'all' ? [] : all(`SELECT substr(date,1,${width}) AS key,SUM(amount) AS amount FROM holding_earnings WHERE user_id=? AND date LIKE ? GROUP BY substr(date,1,${width}) ORDER BY key`, userId, `${scope}%`);
    const validKey = key && key.length === width && key.startsWith(scope) && /^\d{4}(-\d{2}){0,2}$/.test(key);
    const chosen = view === 'all' ? '' : validKey ? key : view === 'day' && through.startsWith(scope) ? through : series.at(-1)?.key || scope;
    return { view, period: scope, asOf: through, summary: summary(userId), series, selected: { key: chosen, ...breakdown(userId, chosen) } };
  }
  return { settle, summary, byHolding, report };
}
