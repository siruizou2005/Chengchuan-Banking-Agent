import { cents, requireThat } from '../errors.mjs';

export const POLICY_VERSION = 'permissions-v2';
export const BUSINESS_TIMEZONE = 'Asia/Shanghai';
export const THRESHOLD = 100000;
export const READ_TOOLS = new Set(['get_overview','get_ledger','get_transactions','get_products_and_holdings','get_credit_card','get_loans','get_payees','resolve_recipient','bill_report','spending_stats','detect_anomalies','compare_products','get_risk_profile','get_scheduled_tasks','get_cards','run_analysis','recall','decline_off_topic']);
export const LOW_RISK_EFFECTS = new Set(['remember','set_reminder','handover_to_human']);
export const cumulativeTools = new Set(['propose_transfer','propose_payment']);
export const rank = { green: 0, yellow: 1, red: 2 };
export const businessDate = (at = new Date().toISOString()) => new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(0,10);
export function expectedAt(step, steps = [], base = new Date().toISOString()) {
  const dates = [step.runAt || step.args.scheduleAt || step.args.at || base];
  for (const dep of step.dependsOn || []) dates.push(expectedAt(steps.find(s => s.id === dep), steps, base));
  return dates.sort().at(-1);
}
export function actionAmount(tool, args) {
  if (tool === 'create_plan') return args.steps.reduce((n,s) => n + actionAmount(s.tool,s.args),0);
  if (tool === 'propose_split') return cents(args.total);
  return args.amount === undefined ? 0 : cents(args.amount);
}
export function classify(tool, args = {}, ctx = {}) {
  if (READ_TOOLS.has(tool) || LOW_RISK_EFFECTS.has(tool)) return 'green';
  if (tool === 'create_plan') {
    const totals = new Map(); let level = 'yellow';
    for (const s of args.steps) {
      const date = businessDate(expectedAt(s,args.steps,ctx.at));
      const total = totals.get(date) ?? (ctx.totalForDate ? ctx.totalForDate(date) : ctx.dailyTotal || 0);
      const next = classify(s.tool,s.args,{...ctx,dailyTotal:total});
      if (rank[next] > rank[level]) level = next;
      if (cumulativeTools.has(s.tool)) totals.set(date,total + actionAmount(s.tool,s.args));
    }
    return level;
  }
  if (cumulativeTools.has(tool)) return (ctx.dailyTotal || 0) + actionAmount(tool,args) > THRESHOLD ? 'red' : 'yellow';
  if (['propose_subscribe_product','propose_loan_draw','change_credentials'].includes(tool)) return 'red';
  if (tool === 'propose_card_action') return args.action === 'freeze' ? 'yellow' : 'red';
  if (tool === 'propose_set_daily_limit') return cents(args.amount) > (ctx.dailyLimit ?? 0) ? 'red' : 'yellow';
  if (tool === 'propose_lock_funds') return cents(args.amount) > THRESHOLD ? 'red' : 'yellow';
  requireThat(['list_subscriptions','propose_split','propose_cancel_subscription','propose_virtual_card','propose_redeem','propose_loan_repay','propose_credit_repay'].includes(tool),'未知操作',400,'UNKNOWN_TOOL');
  return 'yellow';
}

// Transactions replace their proposal/step using a stable idempotency key.
// Historical completion timestamps use updated_at explicitly as a compatibility proxy.
export function dailyAmounts(bank,userId,{excludeId='',excludeStep='',date=businessDate(),at=new Date().toISOString()}={}) {
  const result = {completed:0,committed:0,proposed:0};
  const keys = new Set();
  for (const t of bank.all("SELECT * FROM transactions WHERE user_id=? AND type IN ('transfer','payment','credit_spend') AND status IN ('pending','completed')",userId)) {
    keys.add(t.idempotency_key);
    if (t.id === excludeId || t.idempotency_key === excludeId || t.idempotency_key === excludeStep) continue;
    if (t.status === 'pending' && t.expires_at <= at) continue;
    const when = t.status === 'completed' ? t.completed_at || t.updated_at : at;
    if (businessDate(when) === date) result[t.status === 'completed' ? 'completed' : 'proposed'] += t.amount;
  }
  for (const a of bank.all("SELECT * FROM agent_actions WHERE user_id=? AND status IN ('proposed','confirmed','executing','awaiting_verification')",userId)) {
    if (a.id === excludeId || (a.status === 'proposed' && a.expires_at <= at)) continue;
    const args = JSON.parse(a.args), bucket = a.status === 'proposed' ? 'proposed' : 'committed';
    if (a.tool === 'create_plan') {
      const p = bank.get('SELECT steps FROM agent_plans WHERE action_id=?',a.id);
      const steps = p ? JSON.parse(p.steps) : args.steps;
      for (const s of steps) {
        if (!cumulativeTools.has(s.tool) || ['completed','failed','cancelled','expired'].includes(s.status) || s.actionId === excludeStep || (s.actionId && s.actionId === excludeId) || keys.has(s.actionId)) continue;
        if (businessDate(expectedAt(s,steps,a.created_at)) === date) result[bucket] += actionAmount(s.tool,s.args);
      }
    } else if (cumulativeTools.has(a.tool) && !keys.has(a.id) && businessDate(args.scheduleAt || at) === date) result[bucket] += a.amount;
  }
  return result;
}
export function dailyTotal(bank,userId,excludeId='',date=businessDate(),at=new Date().toISOString()) {
  return Object.values(dailyAmounts(bank,userId,{excludeId,date,at})).reduce((n,x)=>n+x,0);
}
export function decide(bank,user,tool,args={},options={}) {
  const at = options.at || new Date().toISOString();
  const date = businessDate(options.phase === 'execute' ? at : args.scheduleAt || at);
  const snapshot = dailyAmounts(bank,user.id,{...options,date,at});
  const total = Object.values(snapshot).reduce((n,x)=>n+x,0);
  const level = classify(tool,args,{dailyLimit:user.daily_limit,dailyTotal:total,at,totalForDate:d=>dailyTotal(bank,user.id,options.excludeId,d,at)});
  const current = cumulativeTools.has(tool) ? actionAmount(tool,args) : 0;
  const reasons = [{code: level === 'green' ? LOW_RISK_EFFECTS.has(tool) ? 'LOW_RISK_EFFECT' : 'REGISTERED_QUERY' : current ? total+current>THRESHOLD ? 'DAILY_THRESHOLD_EXCEEDED' : 'DAILY_THRESHOLD_WITHIN' : 'MINIMUM_LEVEL',message:level==='green'?'本人资源范围内已登记的低风险操作':current?`北京时间 ${date} 累计 ¥${((total+current)/100).toFixed(2)}，阈值 ¥1000.00`:'此操作适用固定最低权限等级'}];
  const authorization = options.authorization;
  const covered = authorization && rank[authorization.approved_level] >= rank[level] && (level !== 'red' || JSON.parse(authorization.factors).includes('simulated_sms'));
  const groups=new Map();
  if(tool==='create_plan')for(const step of args.steps){
    if(!cumulativeTools.has(step.tool))continue;
    const day=businessDate(expectedAt(step,args.steps,at));
    if(!groups.has(day))groups.set(day,{businessDate:day,...dailyAmounts(bank,user.id,{...options,date:day,at}),current:0,threshold:THRESHOLD});
    groups.get(day).current+=actionAmount(step.tool,step.args);
  }
  const amountsByDate=[...groups.values()].map(g=>({...g,total:g.completed+g.committed+g.proposed+g.current}));
  if(amountsByDate.length)reasons.push({code:'PLAN_EXECUTION_DAYS',message:'计划按各步骤预计执行的北京时间业务日分别累计，到期按实际执行日复核。'});
  return {level,outcome:options.denial?'deny':covered||level==='green'?'allow':level==='red'&&options.confirmed?'require_verification':'require_confirmation',reasons:options.denial?[{code:options.denial.code,message:options.denial.message}]:reasons,requiredFactors:level==='green'?[]:level==='red'?['explicit_confirmation','pin','simulated_sms','simulated_face_or_registered_fallback']:['explicit_confirmation'],policyVersion:POLICY_VERSION,evaluatedAt:at,businessDate:date,...(current?{amounts:{...snapshot,current,total:total+current,threshold:THRESHOLD}}:{}),...(tool==='create_plan'?{dates:[...new Set(args.steps.map(s=>businessDate(expectedAt(s,args.steps,at))))],amountsByDate}:{})};
}
