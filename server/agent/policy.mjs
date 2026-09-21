import { cents, requireThat } from '../errors.mjs';

export const READ_TOOLS = new Set(['get_overview','get_ledger','get_transactions','get_products_and_holdings','get_credit_card','get_loans','get_payees','resolve_recipient','bill_report','detect_anomalies','list_subscriptions','compare_products','get_risk_profile','get_scheduled_tasks','get_cards','run_analysis','remember','recall','set_reminder','handover_to_human']);
export const cumulativeTools = new Set(['propose_transfer','propose_payment','propose_split']);
export const rank = { green: 0, yellow: 1, red: 2 };
export function actionAmount(tool, args) {
  if (tool === 'create_plan') return args.steps.reduce((sum, s) => sum + (cumulativeTools.has(s.tool) ? actionAmount(s.tool, s.args) : 0), 0);
  if (tool === 'propose_split') return cents(args.total);
  return args.amount === undefined ? 0 : cents(args.amount);
}
export function classify(tool, args = {}, ctx = {}) {
  if (READ_TOOLS.has(tool)) return 'green';
  if (tool === 'create_plan') {
    let total = ctx.dailyTotal || 0, level = 'green';
    for (const s of args.steps) {
      const next = classify(s.tool, s.args, { ...ctx, dailyTotal: total });
      if (rank[next] > rank[level]) level = next;
      if (cumulativeTools.has(s.tool)) total += actionAmount(s.tool, s.args);
    }
    return level === 'green' ? 'yellow' : level;
  }
  if (cumulativeTools.has(tool)) return (ctx.dailyTotal || 0) + actionAmount(tool, args) > 100000 ? 'red' : 'yellow';
  if (['propose_subscribe_product','propose_loan_draw','change_credentials'].includes(tool)) return 'red';
  if (tool === 'propose_card_action') return args.action === 'freeze' ? 'yellow' : 'red';
  if (tool === 'propose_set_daily_limit') return cents(args.amount) > (ctx.dailyLimit ?? 0) ? 'red' : 'yellow';
  if (tool === 'propose_lock_funds') return cents(args.amount) > 100000 ? 'red' : 'yellow';
  requireThat(['propose_cancel_subscription','propose_virtual_card','propose_redeem','propose_loan_repay','propose_credit_repay'].includes(tool), '未知操作', 400, 'UNKNOWN_TOOL');
  return 'yellow';
}
// Count direct bank transactions and outstanding proposals, without counting settled actions twice.
export function dailyTotal(bank, userId, excludeId = '') {
  const date = new Date().toISOString().slice(0,10);
  const tx = bank.get("SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE user_id=? AND type IN ('transfer','payment') AND status IN ('pending','completed') AND substr(created_at,1,10)=?", userId, date).n;
  const actions = bank.all("SELECT * FROM agent_actions WHERE user_id=? AND id<>? AND status IN ('proposed','confirmed','executing','completed') AND (status IN ('proposed','confirmed','executing') OR substr(created_at,1,10)=?) AND (status<>'proposed' OR expires_at>?)", userId, excludeId, date, new Date().toISOString());
  return tx + actions.reduce((n,a) => {
    const args = JSON.parse(a.args);
    if (a.tool === 'create_plan') {
      const plan = bank.get('SELECT steps FROM agent_plans WHERE action_id=?', a.id);
      return n + (plan ? JSON.parse(plan.steps) : args.steps).reduce((sum,s) => sum + (cumulativeTools.has(s.tool) && !['completed','failed','cancelled'].includes(s.status) ? actionAmount(s.tool,s.args) : 0),0);
    }
    if (!cumulativeTools.has(a.tool)) return n;
    if (bank.get("SELECT id FROM transactions WHERE user_id=? AND idempotency_key=? AND status IN ('pending','completed')", userId, a.id)) return n;
    return n + a.amount;
  },0);
}
