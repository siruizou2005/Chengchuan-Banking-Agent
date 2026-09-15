import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { createBank, id, now, products, verifyPassword, hashPassword } from './db.mjs';
import { registerChat } from './chat.mjs';

class BusinessError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new BusinessError(message, status, code); };
const requireThat = (test, message, status, code) => { if (!test) fail(message, status, code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const textField = (v, label, min = 1, max = 80) => { requireThat(typeof v === 'string' && v.trim().length >= min && v.trim().length <= max, `请正确填写${label}`); return v.trim(); };
export function cents(v) {
  const s = String(v ?? '');
  requireThat(/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(s), '金额须为正数，最多保留两位小数');
  const [whole, fraction = ''] = s.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireThat(result > 0 && result <= 1000000000, '金额须大于0且不超过1,000万元');
  return result;
}
const publicUser = u => ({ id: u.id, name: u.name, phone: u.phone, dailyLimit: u.daily_limit, riskLevel: u.risk_level, createdAt: u.created_at });
const canonical = o => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
const transactionView = t => ({ ...t, payload: JSON.parse(t.payload), fingerprint: undefined, idempotency_key: undefined });
const money = n => (n / 100).toFixed(2);

export function createApp(dbPath = ':memory:', options = {}) {
  const bank = createBank(dbPath);
  const { get, all, run, atomic, audit, notify, post } = bank;
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && origin !== (options.publicOrigin || `${req.protocol}://${req.get('host')}`)) return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: '请求来源不匹配' } });
      if (!req.is('application/json')) return res.status(415).json({ error: { code: 'JSON_REQUIRED', message: '请使用 application/json 请求' } });
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') return res.status(400).json({ error: { code: 'INVALID_BODY', message: '请求内容必须是 JSON 对象' } });
    }
    next();
  });
  const routes = [];
  const route = (method, path, summary, handler, auth = true, schema) => {
    routes.push({ method, path, summary, auth, schema });
    app[method](`/api${path}`, (req, res, next) => {
      try {
        if (auth) {
          const bearer = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
          const cookie = req.headers.cookie?.split('; ').find(c => c.startsWith('bank_session='))?.slice(13);
          const token = bearer || cookie;
          requireThat(token && token.length <= 128, '请先登录', 401, 'UNAUTHENTICATED');
          const session = get('SELECT * FROM sessions WHERE token=? AND expires_at>?', hash(token), now());
          requireThat(session, '登录已过期，请重新登录', 401, 'UNAUTHENTICATED');
          req.user = get('SELECT * FROM users WHERE id=?', session.user_id);
          req.tokenHash = hash(token);
          expire();
        }
        Promise.resolve(handler(req, res)).catch(next);
      } catch (error) { next(error); }
    });
  };
  const attempts = new Map();
  function checkRate(key) {
    const entry = attempts.get(key);
    if (entry && entry.until < Date.now()) attempts.delete(key);
    requireThat(!attempts.get(key) || attempts.get(key).count < 8, '尝试次数过多，请15分钟后再试', 429, 'RATE_LIMITED');
  }
  function badAttempt(key) {
    if (attempts.size > 10000) attempts.clear();
    const old = attempts.get(key);
    attempts.set(key, { count: (old?.count || 0) + 1, until: old?.until || Date.now() + 900000 });
  }
  function pin(user, value) {
    const key = `pin:${user.id}`; checkRate(key);
    if (!verifyPassword(value, user.pin_hash)) { badAttempt(key); audit(user.id, 'pin.rejected'); fail('支付密码不正确', 403, 'INVALID_PIN'); }
    attempts.delete(key);
  }
  function startSession(userId, res) {
    const token = randomBytes(32).toString('hex');
    const created = now(), expires = new Date(Date.now() + 86400000).toISOString();
    run('DELETE FROM sessions WHERE expires_at<=?', created);
    run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), userId, expires, created);
    res.cookie('bank_session', token, { httpOnly: true, sameSite: 'strict', secure: Boolean(options.secureCookies), maxAge: 86400000, path: '/' });
    return { user: publicUser(get('SELECT * FROM users WHERE id=?', userId)), token, expiresAt: expires };
  }
  const accountFor = (user, accountId) => {
    const a = accountId ? get('SELECT * FROM accounts WHERE id=? AND user_id=?', accountId, user.id) : get("SELECT * FROM accounts WHERE user_id=? AND type='debit' ORDER BY rowid LIMIT 1", user.id);
    requireThat(a, '账户不存在', 404, 'NOT_FOUND');
    return a;
  };
  function expire() {
    const rows = all("SELECT * FROM transactions WHERE status='pending' AND expires_at<=?", now());
    if (rows.length) atomic(() => rows.forEach(t => finishFailed(t, 'expired', '超过15分钟未确认，交易已过期')));
  }
  function finishFailed(t, status, error) {
    const p = JSON.parse(t.payload);
    if (p.debit) run('UPDATE accounts SET held=held-? WHERE id=?', t.amount, t.account_id);
    run('UPDATE transactions SET status=?,error=?,updated_at=? WHERE id=?', status, error, now(), t.id);
    audit(t.user_id, `transaction.${status}`, t.id, { error });
    notify(t.user_id, `交易${{ cancelled: '已取消', failed: '未成功', expired: '已过期' }[status]}`, `${t.title} ¥${money(t.amount)}；${error}`);
  }
  function prepare(user, b, existing = false) {
    const amount = existing ? b.amount : cents(b.amount);
    const account = accountFor(user, b.accountId);
    requireThat(account.status === 'active', '银行卡已冻结，请先解冻', 409, 'ACCOUNT_FROZEN');
    let title, debit = true;
    const p = { accountId: account.id, type: b.type };
    switch (b.type) {
      case 'transfer': {
        p.recipientName = textField(b.recipientName, '收款人姓名', 2, 40);
        p.recipientAccount = textField(b.recipientAccount, '收款账号', 16, 19);
        requireThat(/^\d{16,19}$/.test(p.recipientAccount), '收款账号须为16至19位数字');
        p.bank = textField(b.bank, '收款银行', 2, 30);
        p.note = typeof b.note === 'string' ? b.note.trim().slice(0, 100) : '';
        p.scenario = b.scenario === 'bank_rejected' ? 'bank_rejected' : 'success';
        const target = get('SELECT * FROM accounts WHERE number=?', p.recipientAccount);
        requireThat(p.recipientAccount !== account.number, '不能向同一账户转账');
        if (p.bank === '澄川银行' || target) {
          requireThat(target?.user_id, '未找到该行内账户，请核对卡号', 404, 'RECIPIENT_NOT_FOUND');
          const owner = get('SELECT name FROM users WHERE id=?', target.user_id);
          requireThat(owner.name === p.recipientName, '收款人姓名与账户不匹配');
          requireThat(target.status === 'active', '收款账户当前不可入账', 409, 'RECIPIENT_UNAVAILABLE');
          p.targetId = target.id; p.bank = '澄川银行';
        } else { p.targetId = 'system'; }
        if (!existing) {
          const spent = get("SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE user_id=? AND type='transfer' AND status IN ('pending','completed') AND substr(created_at,1,10)=?", user.id, now().slice(0, 10)).total;
          requireThat(spent + amount <= user.daily_limit, '已超出每日转账限额，可前往安全中心调整', 409, 'DAILY_LIMIT');
        }
        title = `转账 · ${p.recipientName}`; break;
      }
      case 'deposit': case 'investment': {
        const product = products.find(x => x.id === b.productId);
        requireThat(product && product.type === (b.type === 'deposit' ? 'deposit' : 'wealth'), '产品不存在');
        requireThat(amount >= product.minimum, `起购金额为${money(product.minimum)}元`);
        if (product.type === 'wealth') requireThat(user.risk_level >= (product.risk.startsWith('R2') ? 2 : 1), '请先完成匹配的风险测评', 409, 'RISK_ASSESSMENT_REQUIRED');
        p.productId = product.id; title = product.name; break;
      }
      case 'redeem': {
        const h = get('SELECT * FROM holdings WHERE id=? AND user_id=?', b.holdingId, user.id);
        requireThat(h && h.principal >= amount, '可赎回本金不足', 409, 'HOLDING_UNAVAILABLE');
        const product = products.find(x => x.id === h.product_id);
        requireThat(product.type === 'deposit' || h.unlock_at <= now(), '产品尚未到期，暂不可赎回', 409, 'HOLDING_LOCKED');
        p.holdingId = h.id; debit = false; title = `赎回 · ${product.name}`; break;
      }
      case 'loan_draw': {
        const outstanding = get("SELECT COALESCE(SUM(outstanding),0) AS total FROM loans WHERE user_id=?", user.id).total;
        requireThat(amount >= 100000 && amount + outstanding <= 20000000, '借款金额须满1,000元且不超过剩余额度', 409, 'LOAN_LIMIT');
        p.months = Number(b.months || 12);
        requireThat([3, 6, 12, 24].includes(p.months), '请选择有效借款期限');
        debit = false; title = '澄心贷 · 借款到账'; break;
      }
      case 'loan_repay': {
        const loan = get('SELECT * FROM loans WHERE id=? AND user_id=?', b.loanId, user.id);
        requireThat(loan && loan.outstanding >= amount, '还款金额超过待还本金');
        p.loanId = loan.id; title = '澄心贷 · 归还本金'; break;
      }
      case 'credit_repay': case 'credit_spend': {
        const c = get('SELECT * FROM credit_cards WHERE user_id=?', user.id);
        if (b.type === 'credit_repay') requireThat(c.used >= amount, '还款金额超过当前待还金额');
        else {
          requireThat(c.status === 'active', '信用卡已冻结', 409, 'CARD_FROZEN');
          requireThat(c.credit_limit - c.used >= amount, '信用卡可用额度不足', 409, 'CREDIT_LIMIT');
          p.merchant = textField(b.merchant, '商户名称', 2, 50); debit = false;
        }
        title = b.type === 'credit_repay' ? '信用卡还款' : `信用卡消费 · ${p.merchant}`; break;
      }
      case 'payment': {
        const labels = { water: '水费', electricity: '电费', gas: '燃气费', mobile: '话费', broadband: '宽带费', property: '物业费', scan: '扫码付款' };
        requireThat(labels[b.billType], '请选择缴费类型');
        p.billType = b.billType;
        p.billNumber = textField(b.billNumber, '缴费户号', 6, 30);
        requireThat(/^[\dA-Za-z-]{6,30}$/.test(p.billNumber), '缴费户号格式不正确');
        if (p.billType === 'mobile') requireThat(/^1\d{10}$/.test(p.billNumber), '请填写11位手机号');
        title = `生活缴费 · ${labels[p.billType]}`; break;
      }
      default: fail('不支持的交易类型');
    }
    if (debit && !existing) requireThat(account.balance - account.held >= amount, '可用余额不足', 409, 'INSUFFICIENT_FUNDS');
    return { p: { ...p, debit }, title, amount, account };
  }
  function state(user) {
    const accounts = all('SELECT *,balance-held AS available FROM accounts WHERE user_id=?', user.id);
    const holdings = all('SELECT * FROM holdings WHERE user_id=? AND principal>0 ORDER BY created_at DESC', user.id).map(h => ({ ...h, product: products.find(p => p.id === h.product_id) }));
    const ledger = all('SELECT l.*,a.number FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT 500', user.id);
    return {
      user: publicUser(get('SELECT * FROM users WHERE id=?', user.id)), accounts, holdings, ledger, products,
      loans: all('SELECT * FROM loans WHERE user_id=? ORDER BY created_at DESC', user.id),
      creditCard: get('SELECT * FROM credit_cards WHERE user_id=?', user.id),
      transactions: all('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id).map(transactionView),
      payees: all('SELECT * FROM payees WHERE user_id=? ORDER BY name', user.id),
      notifications: all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id),
      tickets: all('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC', user.id),
      appointments: all('SELECT * FROM appointments WHERE user_id=? ORDER BY created_at DESC', user.id),
    };
  }
  registerChat(route, state, options.chat);
  route('get', '/health', '服务健康状态', (_req, res) => res.json({ status: 'ok', simulation: true }), false);
  route('post', '/auth/login', '登录，返回会话 Cookie 与 Bearer Token', (req, res) => {
    const key = `login:${req.ip}`; checkRate(key);
    const u = get('SELECT * FROM users WHERE phone=?', String(req.body.phone || ''));
    if (!u || !verifyPassword(req.body.password, u.password_hash)) { badAttempt(key); fail('手机号或登录密码不正确', 401, 'INVALID_CREDENTIALS'); }
    attempts.delete(key); audit(u.id, 'session.login'); res.json(startSession(u.id, res));
  }, false, { required: ['phone', 'password'], properties: { phone: { type: 'string' }, password: { type: 'string' } } });
  route('post', '/auth/register', '注册模拟用户并创建虚拟账户', (req, res) => {
    const key = `register:${req.ip}`; checkRate(key); badAttempt(key);
    const phone = textField(req.body.phone, '手机号');
    requireThat(/^1\d{10}$/.test(phone), '请输入11位手机号');
    requireThat(!get('SELECT id FROM users WHERE phone=?', phone), '该手机号已注册', 409, 'PHONE_EXISTS');
    const name = textField(req.body.name, '姓名', 2, 20);
    const password = textField(req.body.password, '登录密码', 8, 72);
    requireThat(/[A-Za-z]/.test(password) && /\d/.test(password), '登录密码须包含字母和数字');
    requireThat(/^\d{6}$/.test(req.body.pin || ''), '支付密码须为6位数字');
    const u = atomic(() => bank.newUser(phone, name, password, req.body.pin));
    res.status(201).json(startSession(u, res));
  }, false);
  route('post', '/auth/logout', '退出当前会话', (req, res) => { run('DELETE FROM sessions WHERE token=?', req.tokenHash); res.clearCookie('bank_session', { path: '/' }); res.json({ ok: true }); });
  route('get', '/me', '当前用户信息', (req, res) => res.json(publicUser(req.user)));
  route('get', '/dashboard', '完整账户视图与业务数据', (req, res) => res.json(state(req.user)));
  route('get', '/accounts', '账户与可用余额（单位：分）', (req, res) => res.json(all('SELECT *,balance-held AS available FROM accounts WHERE user_id=?', req.user.id)));
  route('patch', '/accounts/:id', '冻结或解冻借记卡', (req, res) => {
    pin(req.user, req.body.pin); const a = accountFor(req.user, req.params.id);
    requireThat(['active', 'frozen'].includes(req.body.status), '状态无效');
    atomic(() => { run('UPDATE accounts SET status=? WHERE id=?', req.body.status, a.id); audit(req.user.id, 'account.status_changed', a.id, { status: req.body.status }); });
    res.json({ ok: true });
  });
  route('post', '/transactions', '创建待确认交易并预留余额；请求金额单位：元', (req, res) => {
    const key = textField(req.get('Idempotency-Key') || req.body.idempotencyKey, '幂等键', 8, 100);
    const body = { ...req.body }; delete body.idempotencyKey;
    const fingerprint = hash(canonical(body));
    const previous = get('SELECT * FROM transactions WHERE user_id=? AND idempotency_key=?', req.user.id, key);
    if (previous) { requireThat(previous.fingerprint === fingerprint, '该幂等键已用于其他请求', 409, 'IDEMPOTENCY_CONFLICT'); return res.json(transactionView(previous)); }
    const transaction = atomic(() => {
      const { p, title, amount, account } = prepare(req.user, body);
      const tx = id('TX'), created = now(), expires = new Date(Date.now() + 900000).toISOString();
      if (p.debit) run('UPDATE accounts SET held=held+? WHERE id=?', amount, account.id);
      run('INSERT INTO transactions(id,user_id,type,amount,title,status,payload,account_id,created_at,updated_at,expires_at,idempotency_key,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', tx, req.user.id, body.type, amount, title, 'pending', JSON.stringify(p), account.id, created, created, expires, key, fingerprint);
      audit(req.user.id, 'transaction.created', tx, { type: body.type, amount });
      return get('SELECT * FROM transactions WHERE id=?', tx);
    });
    res.status(201).json(transactionView(transaction));
  }, true, { required: ['type', 'amount'], properties: { type: { type: 'string', enum: ['transfer', 'deposit', 'investment', 'redeem', 'loan_draw', 'loan_repay', 'credit_repay', 'credit_spend', 'payment'] }, amount: { type: 'string', pattern: '^[0-9]+(\\.[0-9]{1,2})?$', description: '人民币元，例如 100.50' }, accountId: { type: 'string' }, recipientName: { type: 'string' }, recipientAccount: { type: 'string' }, bank: { type: 'string' }, note: { type: 'string' }, scenario: { type: 'string', enum: ['success', 'bank_rejected'] }, productId: { type: 'string' }, holdingId: { type: 'string' }, loanId: { type: 'string' }, months: { type: 'integer', enum: [3, 6, 12, 24] }, merchant: { type: 'string' }, billType: { type: 'string', enum: ['water', 'electricity', 'gas', 'mobile', 'broadband', 'property', 'scan'] }, billNumber: { type: 'string' } } });
  route('get', '/transactions', '交易列表，可按状态过滤', (req, res) => {
    const rows = req.query.status ? all('SELECT * FROM transactions WHERE user_id=? AND status=? ORDER BY created_at DESC LIMIT 500', req.user.id, String(req.query.status)) : all('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 500', req.user.id);
    res.json(rows.map(transactionView));
  });
  const ownedTransaction = req => { const t = get('SELECT * FROM transactions WHERE id=? AND user_id=?', req.params.id, req.user.id); requireThat(t, '交易不存在', 404, 'NOT_FOUND'); return t; };
  route('get', '/transactions/:id', '按编号查询交易与电子回单', (req, res) => res.json(transactionView(ownedTransaction(req))));
  route('post', '/transactions/:id/cancel', '取消待确认交易并释放余额', (req, res) => {
    const t = ownedTransaction(req);
    if (t.status === 'cancelled') return res.json(transactionView(t));
    requireThat(t.status === 'pending', '该交易已结束，无法取消', 409, 'INVALID_STATE');
    atomic(() => finishFailed(t, 'cancelled', '用户取消了本次交易'));
    res.json(transactionView(get('SELECT * FROM transactions WHERE id=?', t.id)));
  });
  route('post', '/transactions/:id/confirm', '校验支付密码并执行交易；重复确认不会重复扣款', (req, res) => {
    const t = ownedTransaction(req); pin(req.user, req.body.pin);
    if (t.status === 'completed') return res.json(transactionView(t));
    requireThat(t.status === 'pending', '该交易已结束，无法确认', 409, 'INVALID_STATE');
    try {
      atomic(() => {
        const payload = JSON.parse(t.payload);
        const { p, account } = prepare(req.user, { ...payload, amount: t.amount }, true);
        if (p.scenario === 'bank_rejected') fail('模拟收款行拒绝入账，预留资金已释放', 409, 'BANK_REJECTED');
        if (p.debit) {
          requireThat(account.held >= t.amount && account.balance >= t.amount, '预留资金不足', 409, 'INSUFFICIENT_FUNDS');
          run('UPDATE accounts SET held=held-? WHERE id=?', t.amount, account.id);
        }
        if (t.type === 'transfer') {
          post(t.id, account.id, p.targetId, t.amount, t.title + (p.note ? ` · ${p.note}` : ''), t.type);
          const recipient = get('SELECT user_id FROM accounts WHERE id=?', p.targetId);
          if (recipient?.user_id) {
            run('UPDATE ledger SET title=? WHERE transaction_id=? AND account_id=?', `转账收入 · ${req.user.name}${p.note ? ` · ${p.note}` : ''}`, t.id, p.targetId);
            notify(recipient.user_id, '转账到账通知', `${req.user.name}向您转入¥${money(t.amount)}，资金已到账。`);
          }
        } else if (['deposit', 'investment'].includes(t.type)) {
          post(t.id, account.id, 'system', t.amount, t.title, t.type);
          const product = products.find(x => x.id === p.productId);
          run('INSERT INTO holdings VALUES(?,?,?,?,?,?)', id('H'), req.user.id, p.productId, t.amount, now(), new Date(Date.now() + product.days * 86400000).toISOString());
        } else if (t.type === 'redeem') {
          run('UPDATE holdings SET principal=principal-? WHERE id=?', t.amount, p.holdingId);
          post(t.id, 'system', account.id, t.amount, t.title, t.type);
        } else if (t.type === 'loan_draw') {
          run('INSERT INTO loans VALUES(?,?,?,?,?,?,?)', id('L'), req.user.id, t.amount, t.amount, p.months, 'active', now());
          post(t.id, 'system', account.id, t.amount, t.title, t.type);
        } else if (t.type === 'loan_repay') {
          run("UPDATE loans SET outstanding=outstanding-?,status=CASE WHEN outstanding=? THEN 'paid' ELSE 'active' END WHERE id=?", t.amount, t.amount, p.loanId);
          post(t.id, account.id, 'system', t.amount, t.title, t.type);
        } else if (t.type === 'credit_repay') {
          run('UPDATE credit_cards SET used=used-? WHERE user_id=?', t.amount, req.user.id);
          post(t.id, account.id, 'system', t.amount, t.title, t.type);
        } else if (t.type === 'credit_spend') {
          run('UPDATE credit_cards SET used=used+? WHERE user_id=?', t.amount, req.user.id);
        } else if (t.type === 'payment') post(t.id, account.id, 'system', t.amount, t.title, t.type);
        run("UPDATE transactions SET status='completed',updated_at=? WHERE id=?", now(), t.id);
        audit(req.user.id, 'transaction.completed', t.id, { amount: t.amount, type: t.type });
        notify(req.user.id, '交易完成', `${t.title} ¥${money(t.amount)}，已完成。`);
      });
    } catch (error) {
      if (!(error instanceof BusinessError)) throw error;
      atomic(() => finishFailed(t, 'failed', error.message));
    }
    res.json(transactionView(get('SELECT * FROM transactions WHERE id=?', t.id)));
  }, true, { required: ['pin'], properties: { pin: { type: 'string', pattern: '^\\d{6}$' } } });
  route('get', '/ledger', '收支流水，支持方向与关键字过滤', (req, res) => {
    let rows = all('SELECT l.*,a.number FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT 2000', req.user.id);
    if (req.query.direction === 'income') rows = rows.filter(x => x.amount > 0);
    if (req.query.direction === 'expense') rows = rows.filter(x => x.amount < 0);
    if (req.query.q) rows = rows.filter(x => x.title.includes(String(req.query.q)) || x.transaction_id.includes(String(req.query.q)));
    res.json(rows);
  });
  route('get', '/ledger/export', '导出当前用户流水 CSV', (req, res) => {
    const rows = all('SELECT l.* FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=? ORDER BY l.created_at DESC,l.id DESC', req.user.id);
    const escape = v => { let s = String(v); if (/^[=+@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
    const csv = [['交易编号', '时间', '摘要', '金额（元）', '余额（元）'], ...rows.map(r => [r.transaction_id, r.created_at, r.title, money(r.amount), money(r.balance_after)])].map(r => r.map(escape).join(',')).join('\r\n');
    res.type('text/csv; charset=utf-8').attachment('chengchuan-statement.csv').send('\uFEFF' + csv);
  });
  route('get', '/products', '模拟存款与理财产品', (_req, res) => res.json(products));
  route('get', '/holdings', '当前持仓', (req, res) => res.json(state(req.user).holdings));
  route('get', '/loans', '贷款与剩余本金', (req, res) => res.json(all('SELECT * FROM loans WHERE user_id=?', req.user.id)));
  route('get', '/credit-card', '信用卡额度与账单', (req, res) => res.json(get('SELECT * FROM credit_cards WHERE user_id=?', req.user.id)));
  route('patch', '/credit-card', '冻结或解冻信用卡', (req, res) => {
    pin(req.user, req.body.pin); requireThat(['active', 'frozen'].includes(req.body.status), '状态无效');
    atomic(() => { run('UPDATE credit_cards SET status=? WHERE user_id=?', req.body.status, req.user.id); audit(req.user.id, 'credit.status_changed', '', { status: req.body.status }); }); res.json({ ok: true });
  });
  route('get', '/payees', '常用收款人', (req, res) => res.json(all('SELECT * FROM payees WHERE user_id=?', req.user.id)));
  route('post', '/payees', '保存常用收款人', (req, res) => {
    const name = textField(req.body.name, '姓名', 2, 40), number = textField(req.body.number, '卡号', 16, 19), bankName = textField(req.body.bank, '银行', 2, 30);
    requireThat(/^\d{16,19}$/.test(number), '卡号格式不正确');
    const payeeId = id('P');
    run('INSERT INTO payees VALUES(?,?,?,?,?) ON CONFLICT(user_id,number) DO UPDATE SET name=excluded.name,bank=excluded.bank', payeeId, req.user.id, name, number, bankName);
    res.status(201).json(get('SELECT * FROM payees WHERE user_id=? AND number=?', req.user.id, number));
  });
  route('delete', '/payees/:id', '移除常用收款人', (req, res) => { requireThat(run('DELETE FROM payees WHERE id=? AND user_id=?', req.params.id, req.user.id).changes, '收款人不存在', 404); res.json({ ok: true }); });
  route('post', '/risk-assessment', '根据三项问卷答案记录模拟风险等级', (req, res) => {
    const answers = req.body.answers;
    requireThat(Array.isArray(answers) && answers.length === 3 && answers.every(x => [1, 2, 3].includes(x)), '请完成全部风险测评问题');
    const level = answers.reduce((a, b) => a + b, 0) >= 7 ? 2 : 1;
    atomic(() => { run('UPDATE users SET risk_level=? WHERE id=?', level, req.user.id); audit(req.user.id, 'risk.assessed', '', { level, answers }); }); res.json({ level });
  });
  route('patch', '/settings', '修改每日限额、登录密码或支付密码', (req, res) => {
    pin(req.user, req.body.pin);
    const changes = {};
    if (req.body.dailyLimit !== undefined) { const limit = cents(req.body.dailyLimit); requireThat(limit <= 50000000, '每日限额最高为500,000元'); changes.daily_limit = limit; }
    if (req.body.newPassword !== undefined) {
      requireThat(verifyPassword(req.body.oldPassword, req.user.password_hash), '原登录密码不正确', 403);
      const password = textField(req.body.newPassword, '新登录密码', 8, 72);
      requireThat(/[A-Za-z]/.test(password) && /\d/.test(password), '新密码须包含字母和数字'); changes.password_hash = hashPassword(password);
    }
    if (req.body.newPin !== undefined) { requireThat(/^\d{6}$/.test(req.body.newPin), '新支付密码须为6位数字'); changes.pin_hash = hashPassword(req.body.newPin); }
    requireThat(Object.keys(changes).length, '未提供需要修改的设置');
    atomic(() => {
      for (const [key, value] of Object.entries(changes)) run(`UPDATE users SET ${key}=? WHERE id=?`, value, req.user.id);
      if (changes.password_hash || changes.pin_hash) run('DELETE FROM sessions WHERE user_id=? AND token<>?', req.user.id, req.tokenHash);
      audit(req.user.id, 'settings.updated', '', { fields: Object.keys(changes) });
    }); res.json({ ok: true });
  });
  route('get', '/notifications', '站内消息', (req, res) => res.json(all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC', req.user.id)));
  route('post', '/notifications/read', '将全部消息标为已读', (req, res) => { run('UPDATE notifications SET is_read=1 WHERE user_id=?', req.user.id); res.json({ ok: true }); });
  route('post', '/support', '创建模拟客服工单', (req, res) => {
    const subject = textField(req.body.subject, '问题类型', 2, 40), content = textField(req.body.content, '问题描述', 5, 2000), ticketId = id('S');
    atomic(() => { run('INSERT INTO tickets(id,user_id,subject,content,created_at) VALUES(?,?,?,?,?)', ticketId, req.user.id, subject, content, now()); audit(req.user.id, 'ticket.created', ticketId); });
    res.status(201).json({ id: ticketId, status: 'submitted' });
  });
  route('get', '/support', '查询本人的模拟客服工单', (req, res) => res.json(all('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC', req.user.id)));
  route('post', '/appointments', '预约模拟网点服务', (req, res) => {
    const branch = textField(req.body.branch, '网点', 2, 40), service = textField(req.body.service, '业务', 2, 40), date = textField(req.body.date, '日期');
    const parsed = new Date(date + 'T12:00:00Z');
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === date && date >= now().slice(0, 10) && parsed.valueOf() < Date.now() + 31 * 86400000, '请选择未来30天内的有效预约日期');
    requireThat(!get("SELECT id FROM appointments WHERE user_id=? AND date=? AND status='reserved'", req.user.id, date), '当天已有预约，请先取消原预约', 409);
    const appointmentId = id('B'); run('INSERT INTO appointments(id,user_id,branch,service,date,created_at) VALUES(?,?,?,?,?,?)', appointmentId, req.user.id, branch, service, date, now());
    res.status(201).json({ id: appointmentId });
  });
  route('post', '/appointments/:id/cancel', '取消本人的网点预约', (req, res) => { requireThat(run("UPDATE appointments SET status='cancelled' WHERE id=? AND user_id=? AND status='reserved'", req.params.id, req.user.id).changes, '预约不存在或已取消', 404); res.json({ ok: true }); });
  route('get', '/audit', '当前用户的操作审计日志', (req, res) => res.json(all('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT 500', req.user.id).map(x => ({ ...x, detail: JSON.parse(x.detail) }))));
  route('get', '/agent/manifest', 'Agent 能力与调用约定', (_req, res) => res.json({ name: '澄川银行模拟器', version: '1.0.0', simulation: true, openapi: '/api/openapi.json', authentication: 'HttpOnly Cookie or Bearer token from /api/auth/login', money: { request: 'decimal yuan string', response: 'integer cents', currency: 'CNY' }, transactionFlow: ['POST /api/transactions with Idempotency-Key', 'Review returned transaction', 'POST /api/transactions/{id}/confirm with pin', 'GET /api/transactions/{id}'], states: ['pending', 'completed', 'failed', 'cancelled', 'expired'], expiresInSeconds: 900, ui: 'All form fields have names and labels; primary actions expose data-testid. Hash routes are stable.', capabilities: ['accounts', 'transfers', 'ledger', 'deposits', 'investments', 'loans', 'credit_cards', 'payments', 'payees', 'notifications', 'support', 'appointments', 'audit'] }), false);
  route('get', '/openapi.json', 'OpenAPI 3.1 接口定义', (_req, res) => {
    const paths = {};
    for (const r of routes) {
      const path = '/api' + r.path.replace(/:([a-z]+)/g, '{$1}');
      const params = [...r.path.matchAll(/:([a-z]+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      if (r.path === '/transactions' && r.method === 'post') params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 } });
      (paths[path] ||= {})[r.method] = { summary: r.summary, operationId: r.method + r.path.replace(/[^a-zA-Z]/g, '_'), security: r.auth ? [{ bearerAuth: [] }, { cookieAuth: [] }] : [], parameters: params, ...(['post', 'patch', 'delete'].includes(r.method) ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', ...(r.schema || { additionalProperties: true }) } } } } } : {}), responses: { '200': { description: '成功；所有响应金额为整数分' }, '400': { description: '参数错误' }, '401': { description: '未认证' }, '403': { description: '密码或来源校验失败' }, '404': { description: '资源不存在或无权访问' }, '409': { description: '余额、状态或幂等冲突' }, '429': { description: '请求频率限制' } } };
    }
    res.json({ openapi: '3.1.0', info: { title: '澄川银行模拟 API', version: '1.0.0', description: '全部为虚拟业务。详见项目 docs/API.md，金额输入为元字符串，输出为整数分。' }, servers: [{ url: '/' }], paths, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: 'bank_session' } } } });
  }, false);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
  app.use((error, _req, res, _next) => {
    const status = error instanceof BusinessError ? error.status : error.type === 'entity.parse.failed' ? 400 : 500;
    if (status === 500) console.error('Bank API error:', error.message);
    res.status(status).json({ error: { code: error.code || (status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR'), message: status === 500 ? '服务暂时不可用，请稍后重试' : error.message } });
  });
  return { app, bank, maintenance: expire };
}
