import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { migrateWeChat } from './channels/wechat-schema.mjs';
import { migrateFeishu } from './channels/feishu-schema.mjs';

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

// Optional, source-neutral ledger details; native rows leave them NULL.
export const LEDGER_DETAIL = ['txn_type','bank_summary','counterparty','counterparty_account','merchant','platform','channel','memo','time_precision','source_bank','source_detail'];

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
  // Additive migrations also run against existing local databases.
  if (!all('PRAGMA table_info(users)').some(c => c.name === 'agent_locked_until')) db.exec('ALTER TABLE users ADD COLUMN agent_locked_until TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL, session_id TEXT,
      tool TEXT NOT NULL, args TEXT NOT NULL, title TEXT NOT NULL, level TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'proposed', result TEXT, error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_actions_user ON agent_actions(user_id,status);
    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
      session_id TEXT, input TEXT NOT NULL, injection TEXT NOT NULL, trace TEXT NOT NULL, output TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, tokens INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_plans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), action_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, steps TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
      history TEXT NOT NULL DEFAULT '[]', handover INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_memory (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,key));
    CREATE TABLE IF NOT EXISTS agent_security (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), action_id TEXT,
      plan_id TEXT, step_id TEXT, kind TEXT NOT NULL, args TEXT NOT NULL, run_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      result TEXT, error TEXT, created_at TEXT NOT NULL, UNIQUE(plan_id,step_id));
    CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), merchant TEXT NOT NULL,
      amount INTEGER NOT NULL, next_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', reminded_at TEXT, UNIQUE(user_id,merchant));
    CREATE TABLE IF NOT EXISTS virtual_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), number TEXT NOT NULL,
      card_limit INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), account_id TEXT NOT NULL REFERENCES accounts(id),
      action_id TEXT, plan_id TEXT, amount INTEGER NOT NULL CHECK(amount>=0), purpose TEXT NOT NULL, until_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_bindings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
      external_id TEXT NOT NULL, token TEXT, base_url TEXT, context_token TEXT, cursor TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, UNIQUE(channel,external_id));
    CREATE TABLE IF NOT EXISTS channel_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS channel_messages (channel TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(channel,message_id));
    CREATE TABLE IF NOT EXISTS channel_outbox (id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_preferences (user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL CHECK(channel IN ('feishu','wechat')),
      mask_amounts INTEGER NOT NULL DEFAULT 0 CHECK(mask_amounts IN (0,1)), updated_at TEXT NOT NULL, PRIMARY KEY(user_id,channel));
    CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), action_id TEXT NOT NULL,
      code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, face_status TEXT NOT NULL DEFAULT 'pending', frame_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, token_hash TEXT, token_expires_at TEXT, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `);
  for (const [table, column, ddl] of [['agent_runs', 'events', "TEXT NOT NULL DEFAULT '[]'"], ['agent_runs', 'topic', 'TEXT'], ['agent_sessions', 'archived', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!all(`PRAGMA table_info(${table})`).some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  for (const [table, column, ddl] of [
    ['transactions','completed_at','TEXT'],
    ['agent_actions','revision','INTEGER NOT NULL DEFAULT 1'],
    ['agent_actions','params_digest','TEXT'],['agent_actions','decision','TEXT'],['agent_actions','run_id','TEXT'],
    ['agent_actions','authorization_until','TEXT'],['agent_actions','verification_until','TEXT'],['agent_actions','pause_reason','TEXT'],
    ['verifications','params_digest','TEXT'],['verifications','revision','INTEGER'],['verifications','face_reason','TEXT'],
    ['channel_bindings','transport','TEXT'],
    ...LEDGER_DETAIL.map(column=>['ledger',column,'TEXT']),
  ]) if (!all(`PRAGMA table_info(${table})`).some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operation_authorizations (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),action_id TEXT NOT NULL REFERENCES agent_actions(id),
      plan_id TEXT,revision INTEGER NOT NULL,params_digest TEXT NOT NULL,scope TEXT NOT NULL,
      approved_level TEXT NOT NULL,factors TEXT NOT NULL,policy_version TEXT NOT NULL,channel TEXT NOT NULL,binding_id TEXT,
      valid_from TEXT NOT NULL,expires_at TEXT NOT NULL,status TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,
      UNIQUE(action_id,revision)
    );
    CREATE TABLE IF NOT EXISTS authorization_executions (
      id TEXT PRIMARY KEY,action_id TEXT NOT NULL,authorization_id TEXT NOT NULL REFERENCES operation_authorizations(id),
      execution_key TEXT NOT NULL UNIQUE,step_id TEXT NOT NULL,amount INTEGER NOT NULL,result TEXT,created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS authorization_step_once ON authorization_executions(action_id,step_id);
    CREATE TABLE IF NOT EXISTS subscription_mandates (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),user_id TEXT NOT NULL,merchant TEXT NOT NULL,
      amount INTEGER NOT NULL,period TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL
    );
  `);
  migrateWeChat(db);
  migrateFeishu(db);
  let depth = 0;
  function atomic(fn) {
    const savepoint = `bank_${depth++}`;
    db.exec(depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    try { const result = fn(); if (result?.then) throw new TypeError('Database transactions must be synchronous'); db.exec(depth === 1 ? 'COMMIT' : `RELEASE ${savepoint}`); return result; }
    catch (error) { db.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
    finally { depth--; }
  }
  function audit(user, action, resource = '', detail = {}) { run('INSERT INTO audit(user_id,action,resource_id,detail,created_at) VALUES(?,?,?,?,?)', user, action, resource, JSON.stringify(detail), now()); }
  function notify(user, title, body) { run('INSERT INTO notifications(id,user_id,title,body,created_at) VALUES(?,?,?,?,?)', id('N'), user, title, body, now()); }
  function post(tx, from, to, amount, title, category, date = now(), detail = {}) {
    for (const [account, delta] of [[from, -amount], [to, amount]]) {
      run('UPDATE accounts SET balance=balance+? WHERE id=?', delta, account);
      const row = get('SELECT balance FROM accounts WHERE id=?', account);
      const extra = account === 'system' ? {} : detail;
      run(`INSERT INTO ledger(transaction_id,account_id,amount,balance_after,title,category,created_at,${LEDGER_DETAIL}) VALUES(?,?,?,?,?,?,?${',?'.repeat(LEDGER_DETAIL.length)})`, tx, account, delta, row.balance, title, category, date, ...LEDGER_DETAIL.map(c => extra[c] ?? null));
    }
  }
  function newUser(phone, name, password, pin, number, opening = 12865080) {
    const userId = id('U'), accountId = id('A');
    run('INSERT INTO users(id,phone,name,password_hash,pin_hash,created_at) VALUES(?,?,?,?,?,?)', userId, phone, name, hashPassword(password), hashPassword(pin), now());
    const cardNumber = number || `621880${String(BigInt('0x' + randomBytes(6).toString('hex'))).padStart(13, '0').slice(-13)}`;
    run('INSERT INTO accounts(id,user_id,number,name) VALUES(?,?,?,?)', accountId, userId, cardNumber, '澄川银行 · 借记卡');
    run('INSERT INTO credit_cards(id,user_id,number) VALUES(?,?,?)', id('C'), userId, '622880' + cardNumber.slice(6));
    if (opening) post(id('SEED'), 'system', accountId, opening, '模拟开户资金', 'income', number ? new Date(Date.now() - 30 * 86400000).toISOString() : now());
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
  // Balanced, once-only demo history, including upgrades of previously seeded databases.
  for (const user of all("SELECT * FROM users WHERE phone IN ('13800138000','13900139000')")) {
    if (get("SELECT id FROM audit WHERE user_id=? AND action='demo.history.v2'", user.id)) continue;
    atomic(() => {
      const account = get("SELECT id FROM accounts WHERE user_id=? AND type='debit'", user.id).id;
      for (let month = 2; month >= 0; month--) {
        for (const [day, title, amount] of [[1,'工资收入',1860000],[2,'房租',-320000],[5,'餐饮 · 小馆',-8600],[7,'交通 · 地铁',-2400],[9,'购物 · 超市',-26800],[10,'水电缴费',-18600],[12,'通讯 · 话费',-5900],[13,'订阅 · 视频会员',-2500],[14,'订阅 · 音乐',-1500],[15,'订阅 · 云盘',-2100],[16,'订阅 · 健身',-19900]]) {
          const d = new Date(); d.setUTCMonth(d.getUTCMonth()-month, day); d.setUTCHours(10,0,0,0);
          if (d > new Date()) continue;
          post(id('DEMO'), amount > 0 ? 'system' : account, amount > 0 ? account : 'system', Math.abs(amount), title, amount > 0 ? 'income' : 'payment', d.toISOString());
        }
      }
      const abnormal = new Date(Date.now()-86400000); abnormal.setUTCHours(19,17,0,0); // 03:17 China time
      post(id('DEMO'), account, 'system', 888800, '消费 · 陌生商户星际数码', 'payment', abnormal.toISOString());
      for (const [merchant, amount] of [['视频会员',2500],['音乐',1500],['云盘',2100],['健身',19900]]) {
        run('INSERT OR IGNORE INTO subscriptions(id,user_id,merchant,amount,next_at) VALUES(?,?,?,?,?)', id('SUB'), user.id, merchant, amount, new Date(Date.now()+25*86400000).toISOString());
        const sub=get('SELECT * FROM subscriptions WHERE user_id=? AND merchant=?',user.id,merchant);
        if(sub.amount===amount)run('INSERT OR IGNORE INTO subscription_mandates VALUES(?,?,?,?,?,?,?,?)',sub.id,user.id,merchant,amount,'monthly','explicit_demo_seed','active',now());
      }
      audit(user.id, 'demo.history.v2');
    });
  }
  // Statements imported from other banks: renamed holders, simulated card numbers, masked counterparty accounts.
  // Rows start with a back-computed opening balance, so balance_after reproduces the source statement.
  const imported = JSON.parse(readFileSync(new URL('./seed/imported-statements.json', import.meta.url), 'utf8'));
  for (const s of imported.users) {
    if (get('SELECT id FROM users WHERE phone=?', s.phone)) continue;
    atomic(() => {
      const userId = newUser(s.phone, s.name, 'Bank123456', '123456', s.card, 0);
      const account = get("SELECT id FROM accounts WHERE user_id=? AND type='debit'", userId).id;
      for (const values of s.rows) {
        const r = Object.fromEntries(imported.columns.map((c, i) => [c, values[i]]));
        const detail = { ...r, source_bank: s.source_bank, source_detail: r.source_detail && JSON.stringify(r.source_detail) };
        post(id('IMP'), r.amount > 0 ? 'system' : account, r.amount > 0 ? account : 'system', Math.abs(r.amount), r.title, r.category, r.created_at, detail);
      }
      if (get('SELECT balance FROM accounts WHERE id=?', account).balance !== s.closing) throw new Error(`导入流水余额不符：${s.name}`);
      audit(userId, 'statement.imported', account, { sourceBank: s.source_bank, period: s.period, rows: s.rows.length });
    });
  }
  if (!get("SELECT version FROM schema_migrations WHERE version='permissions-v2'")) atomic(()=>{
    for(const a of all("SELECT * FROM agent_actions WHERE status IN ('confirmed','executing')")) {
      const until=get("SELECT MAX(until_at) AS until_at FROM reservations WHERE action_id=? AND status='active'",a.id).until_at || new Date(Date.now()+900000).toISOString();
      run("UPDATE agent_actions SET status='awaiting_verification',authorization_until=?,verification_until=?,pause_reason='旧任务缺少有效授权证明，请重新授权' WHERE id=?",until,new Date(Math.min(Date.now()+900000,Date.parse(until))).toISOString(),a.id);
      run("UPDATE scheduled_tasks SET status='awaiting_verification' WHERE action_id=? AND status IN ('pending','executing')",a.id);
      run("UPDATE agent_plans SET status='awaiting_verification' WHERE action_id=?",a.id);
      audit(a.user_id,'authorization.migration_paused',a.id);
    }
    for(const sub of all('SELECT * FROM subscriptions')) {
      if(get('SELECT subscription_id FROM subscription_mandates WHERE subscription_id=?',sub.id))continue;
      const seed={视频会员:2500,音乐:1500,云盘:2100,健身:19900};
      const demo=get("SELECT id FROM audit WHERE user_id=? AND action='demo.history.v2'",sub.user_id);
      if(demo && seed[sub.merchant]===sub.amount)run('INSERT INTO subscription_mandates VALUES(?,?,?,?,?,?,?,?)',sub.id,sub.user_id,sub.merchant,sub.amount,'monthly','explicit_demo_seed','active',now());
      else {run("UPDATE subscriptions SET status='awaiting_authorization' WHERE id=? AND status='active'",sub.id);audit(sub.user_id,'subscription.migration_paused',sub.id);}
    }
    for(const t of all("SELECT * FROM transactions WHERE status='completed' AND completed_at IS NULL"))audit(t.user_id,'transaction.legacy_completion_proxy',t.id,{source:'updated_at',limitation:'历史记录无独立完成时间；累计以原updated_at兼容，不回填精确完成时间'});
    run('INSERT INTO schema_migrations VALUES(?,?)','permissions-v2',now());
  });
  return { db, get, all, run, atomic, audit, notify, post, newUser };
}
