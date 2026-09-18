import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const id = (prefix = '') => prefix + randomUUID().replaceAll('-', '');
export const now = () => new Date().toISOString();
export function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
export function verifyPassword(value, stored) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(value, salt, 64));
}

export const products = [
  { id: 'deposit-90', type: 'deposit', name: '安心存三个月', subtitle: '90天整存整取，支持提前支取', rate: 1.35, days: 90, minimum: 5000, risk: '存款', tags: ['50元起存', '到期可取'], description: '人民币整存整取定期存款，存期90天，支持提前支取。演示环境按本金结算，不计付利息。' },
  { id: 'deposit-365', type: 'deposit', name: '安心存一年期', subtitle: '365天整存整取，支持提前支取', rate: 1.65, days: 365, minimum: 5000, risk: '存款', tags: ['50元起存', '整存整取'], description: '人民币整存整取定期存款，存期一年，支持提前支取。演示环境按本金结算，不计付利息。' },
  { id: 'wealth-flex', type: 'wealth', name: '澄享日日盈', subtitle: '现金管理类，每日可申赎', rate: 2.18, days: 0, minimum: 10000, risk: 'R1 低风险', tags: ['100元起购', '灵活申赎'], description: '现金管理类理财，主投高流动性固收资产，每个交易日可申赎。展示收益率为演示数据，不构成收益承诺；演示环境按本金结算，不计算净值变动。' },
  { id: 'wealth-180', type: 'wealth', name: '澄享稳进180天', subtitle: '固定持有期，到期后可赎回', rate: 3.20, days: 180, minimum: 100000, risk: 'R2 中低风险', tags: ['1,000元起购', '180天持有期'], description: '固定持有期理财，持有180天后方可赎回。展示收益率为演示用业绩比较基准，不构成收益承诺；到期按本金结算。' },
];

export function createBank(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, pin_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      daily_limit INTEGER NOT NULL DEFAULT 5000000, risk_level INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0),
      status TEXT NOT NULL DEFAULT 'active', type TEXT NOT NULL DEFAULT 'debit',
      CHECK(user_id IS NULL OR (balance>=0 AND held<=balance))
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), type TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
      title TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, account_id TEXT REFERENCES accounts(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, error TEXT,
      idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(user_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY, transaction_id TEXT NOT NULL, account_id TEXT REFERENCES accounts(id),
      amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id,created_at);
    CREATE TABLE IF NOT EXISTS holdings (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), product_id TEXT NOT NULL,
      principal INTEGER NOT NULL CHECK(principal>=0), created_at TEXT NOT NULL, unlock_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), principal INTEGER NOT NULL, outstanding INTEGER NOT NULL CHECK(outstanding>=0),
      months INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_cards (
      id TEXT PRIMARY KEY, user_id TEXT UNIQUE REFERENCES users(id), number TEXT NOT NULL,
      credit_limit INTEGER NOT NULL DEFAULT 5000000, used INTEGER NOT NULL DEFAULT 238650,
      status TEXT NOT NULL DEFAULT 'active', CHECK(used>=0 AND used<=credit_limit)
    );
    CREATE TABLE IF NOT EXISTS payees (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), name TEXT NOT NULL, number TEXT NOT NULL, bank TEXT NOT NULL, UNIQUE(user_id,number));
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), title TEXT NOT NULL, body TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), subject TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), branch TEXT NOT NULL, service TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id), action TEXT NOT NULL, resource_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function atomic(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function audit(user, action, resource = '', detail = {}) { run('INSERT INTO audit(user_id,action,resource_id,detail,created_at) VALUES(?,?,?,?,?)', user, action, resource, JSON.stringify(detail), now()); }
  function notify(user, title, body) { run('INSERT INTO notifications(id,user_id,title,body,created_at) VALUES(?,?,?,?,?)', id('N'), user, title, body, now()); }
  function post(tx, from, to, amount, title, category, date = now()) {
    for (const [account, delta] of [[from, -amount], [to, amount]]) {
      run('UPDATE accounts SET balance=balance+? WHERE id=?', delta, account);
      const row = get('SELECT balance FROM accounts WHERE id=?', account);
      run('INSERT INTO ledger(transaction_id,account_id,amount,balance_after,title,category,created_at) VALUES(?,?,?,?,?,?,?)', tx, account, delta, row.balance, title, category, date);
    }
  }
  function newUser(phone, name, password, pin, number) {
    const userId = id('U'), accountId = id('A');
    run('INSERT INTO users(id,phone,name,password_hash,pin_hash,created_at) VALUES(?,?,?,?,?,?)', userId, phone, name, hashPassword(password), hashPassword(pin), now());
    const cardNumber = number || `621880${String(BigInt('0x' + randomBytes(6).toString('hex'))).padStart(13, '0').slice(-13)}`;
    run('INSERT INTO accounts(id,user_id,number,name) VALUES(?,?,?,?)', accountId, userId, cardNumber, '澄川银行 · 借记卡');
    run('INSERT INTO credit_cards(id,user_id,number) VALUES(?,?,?)', id('C'), userId, '622880' + cardNumber.slice(6));
    post(id('SEED'), 'system', accountId, 12865080, '模拟开户资金', 'income', number ? new Date(Date.now() - 30 * 86400000).toISOString() : now());
    notify(userId, '欢迎来到澄川银行', '模拟账户已开通。开户资金、信用卡账单和产品均为虚拟数据，可用于体验与测试。');
    audit(userId, 'user.created', userId);
    return userId;
  }
  if (!get("SELECT id FROM accounts WHERE id='system'")) {
    atomic(() => {
      run("INSERT INTO accounts(id,number,name,type) VALUES('system','SYSTEM','模拟清算账户','system')");
      const first = newUser('13800138000', '林知夏', 'Bank123456', '123456', '6218808888000012068');
      const second = newUser('13900139000', '陈屿', 'Bank123456', '123456', '6218808888000088096');
      run('INSERT INTO payees(id,user_id,name,number,bank) VALUES(?,?,?,?,?)', id('P'), first, '陈屿', '6218808888000088096', '澄川银行');
      run('INSERT INTO payees(id,user_id,name,number,bank) VALUES(?,?,?,?,?)', id('P'), second, '林知夏', '6218808888000012068', '澄川银行');
      const acct = get('SELECT id FROM accounts WHERE user_id=?', first).id;
      const past = new Date(Date.now()-86400000*2).toISOString();
      post(id('SEED'), 'system', acct, 1860000, '工资收入 · 九月', 'income', past);
      post(id('SEED'), acct, 'system', 8600, '生活缴费 · 电费', 'payment', past);
      post(id('SEED'), acct, 'system', 2000000, '安心存 · 一年期', 'deposit', past);
      run('INSERT INTO holdings VALUES(?,?,?,?,?,?)', id('H'), first, 'deposit-365', 2000000, past, new Date(Date.now()+363*86400000).toISOString());
      post(id('SEED'), acct, 'system', 320000, '转账 · 房租', 'transfer', new Date(Date.now()-86400000).toISOString());
    });
  }
  return { db, get, all, run, atomic, audit, notify, post, newUser };
}
