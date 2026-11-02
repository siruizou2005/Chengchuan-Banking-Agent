import { redactIdentity } from './privacy.mjs';
import { thirdPartyData } from './agent/guard.mjs';
export function loadChatConfig(env = process.env) {
  const model = env.CHAT_MODEL || 'deepseek-v4-flash';
  return {
    apiKey: env.CHAT_API_KEY || '',
    baseUrl: env.CHAT_BASE_URL || (model.startsWith('deepseek-') ? 'https://api.deepseek.com' : ''),
    model,
  };
}

const pick = (row, fields) => row && Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const mask = value => value ? `****${String(value).slice(-4)}` : undefined;
export function accountContext(snapshot) {
  return redactIdentity({
    asOf: new Date().toISOString(), source: '当前服务器的模拟银行数据库', currency: 'CNY', moneyUnit: '整数分',
    user: { ...pick(snapshot.user, ['name', 'dailyLimit', 'riskLevel', 'createdAt']), phone: mask(snapshot.user.phone) },
    accounts: snapshot.accounts.map(a => ({ ...pick(a, ['name', 'balance', 'held', 'available', 'status']), number: mask(a.number) })),
    // The fund catalog is ~100 rows; only deposits go into every prompt, funds are queried via tools.
    products: snapshot.products.filter(p => p.type === 'deposit').map(p => pick(p, ['id', 'name', 'rate', 'rateLabel', 'days', 'minimum'])),
    productCatalog: { funds: snapshot.products.filter(p => p.type !== 'deposit').length, ...pick(snapshot.productMeta || {}, ['source', 'updatedAt', 'stale', 'notice']), usage: '基金产品与业绩请调用get_products_and_holdings筛选，或compare_products对比' },
    holdings: snapshot.holdings.map(h => ({ ...pick(h, ['principal', 'earnings', 'value', 'created_at', 'unlock_at']), product: pick(h.product, ['id', 'name', 'type', 'risk', 'days']) })),
    loans: snapshot.loans.map(l => pick(l, ['principal', 'outstanding', 'months', 'status', 'created_at'])),
    creditCard: { ...pick(snapshot.creditCard, ['credit_limit', 'used', 'status']), number: mask(snapshot.creditCard?.number) },
    scope: '最近流水和交易见recent_activity数据块。未提供其他用户资料。',
  });
}
// Titles, merchants and errors can carry text other people wrote, so they stay out of the system message and reach the model filtered.
export function accountActivity(snapshot) {
  return thirdPartyData(redactIdentity({
    recentLedger: snapshot.ledger.slice(0, 30).map(l => pick(l, ['amount', 'balance_after', 'title', 'bj_time', 'kind', 'tag', 'merchant', 'platform'])),
    recentTransactions: snapshot.transactions.slice(0, 20).map(t => pick(t, ['type', 'amount', 'title', 'status', 'created_at', 'error'])),
    scope: '流水最多最近30条（bj_time为北京时间），交易最多最近20条；不代表完整历史，统计请调用bill_report或spending_stats。',
  }));
}

export function registerChat(route, _snapshotFor, options = {}) {
  const getConfig = options.config || loadChatConfig;
  route('get', '/chat/status', '聊天、语音与渠道配置状态', (_req, res) => {
    const config = getConfig();
    res.json({ configured: Boolean(config.apiKey && config.baseUrl), model: config.model,
      voice: Boolean(process.env.DASHSCOPE_API_KEY), agentDisabled: process.env.AGENT_DISABLED === 'true',
      channels: { feishu: Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET), feishuPersonal: process.env.FEISHU_PERSONAL_ENABLED === 'true' && /^https:\/\/[^/]+$/.test(process.env.PUBLIC_ORIGIN || ''), wechat: process.env.WECHAT_ENABLED === 'true' } });
  }, false);
}
