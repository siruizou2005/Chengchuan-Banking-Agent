import { id, now, products } from './db.mjs';
import { cents, requireThat, BusinessError } from './errors.mjs';
import { decide, expectedAt, actionAmount, rank, businessDate, dailyTotal } from './agent/policy.mjs';
import { validateArgs } from './agent/tools.mjs';
import { redact } from './agent/guard.mjs';
import { createAuthorization, paramsDigest, actionParams } from './authorization.mjs';
import { recognizeSubscriptions, ledgerFor } from './agent/analytics.mjs';
const parse = value => value ? JSON.parse(value) : null;
const yuan = n => (n/100).toFixed(2);
const labels={propose_transfer:'转账',propose_payment:'缴费/消费',propose_split:'AA收款',propose_subscribe_product:'产品申购',propose_redeem:'赎回',propose_loan_draw:'贷款提款',propose_loan_repay:'贷款还款',propose_credit_repay:'信用卡还款',propose_card_action:'卡片管理',propose_virtual_card:'虚拟卡申请',propose_set_daily_limit:'调整每日限额',propose_cancel_subscription:'取消订阅',propose_lock_funds:'资金锁定',list_subscriptions:'订阅明细查询',create_plan:'联动计划'};
export function future(value) {
 const d=new Date(value);requireThat(typeof value==='string'&&Number.isFinite(d.valueOf())&&d.valueOf()>Date.now()&&d.valueOf()<Date.now()+366*86400000,'请选择未来一年内的有效时间');return d.toISOString();
}
export function createServices(bank,core,guard) {
 const {get,all,run,atomic,audit,notify}=bank;
 const authorization=createAuthorization(bank);
 const services={...core,bank,guard,authorization};
 const fresh=user=>get('SELECT * FROM users WHERE id=?',user.id);
 function resolveRecipients(user,query) {
  const rows=all('SELECT id,name,number,bank FROM payees WHERE user_id=?',user.id).filter(p=>(query.name&&p.name===query.name)||(query.account&&p.number===query.account));
  const found=all("SELECT a.id,u.name,a.number,'澄川银行' AS bank FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.type='debit' AND u.id<>? AND (u.name=? OR u.phone=? OR a.number=?)",user.id,query.name||'',query.phone||'',query.account||'');
  const unique=new Map();for(const r of [...rows,...found])if(!unique.has(r.number))unique.set(r.number,r);
  return [...unique.values()].map(r=>({recipient:r.id,name:r.name,account:'****'+r.number.slice(-4),bank:r.bank}));
 }
 function recipient(user,ref) {
  let r=get('SELECT name,number,bank FROM payees WHERE id=? AND user_id=?',ref,user.id);
  if(!r)r=get("SELECT u.name,a.number,'澄川银行' AS bank FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.type='debit' AND u.id<>?",ref,user.id);
  requireThat(r,'请先解析并选择收款人',404,'RECIPIENT_NOT_FOUND');return r;
 }
 function normalize(user,tool,args,businessAt) {
  args=validateArgs(tool,args);
  if(tool==='create_plan'){
   const ids=new Set(args.steps.map(s=>s.id));requireThat(ids.size===args.steps.length,'计划步骤ID不能重复');
   const visited=new Set(),visiting=new Set(),ordered=[];
   const visit=step=>{if(visited.has(step.id))return;requireThat(!visiting.has(step.id),'计划存在循环依赖');visiting.add(step.id);for(const dep of step.dependsOn){requireThat(ids.has(dep),'计划依赖不存在');visit(args.steps.find(s=>s.id===dep));}visiting.delete(step.id);visited.add(step.id);ordered.push(step);};
   args.steps.forEach(visit);
   args.steps=ordered.map(s=>({...s,args:normalize(user,s.tool,s.args,expectedAt(s,ordered)),runAt:s.runAt?future(s.runAt):undefined,status:'pending'}));
   for(const step of args.steps){if(step.tool==='propose_lock_funds')requireThat(step.args.until>expectedAt(step,args.steps),'锁定截止时间必须晚于执行时间');for(const dep of step.dependsOn){const parent=args.steps.find(s=>s.id===dep);requireThat(!step.runAt||!parent.runAt||step.runAt>=parent.runAt,'步骤时间不能早于依赖步骤');}}
   return args;
  }
  let body;
  if(tool==='propose_transfer'){const r=recipient(user,args.recipient);body={type:'transfer',amount:args.amount,recipientName:r.name,recipientAccount:r.number,bank:r.bank,note:args.note||''};args.recipientLabel=`${r.name}（尾号${r.number.slice(-4)}）`;if(args.scheduleAt)args.scheduleAt=future(args.scheduleAt);}
  if(tool==='propose_payment')body={type:'payment',...args};
  if(tool==='propose_subscribe_product'){const p=products.find(p=>p.id===args.productId);requireThat(p,'产品不存在');body={type:p.type==='deposit'?'deposit':'investment',...args};args.productName=p.name;}
  for(const [t,type] of Object.entries({propose_redeem:'redeem',propose_loan_draw:'loan_draw',propose_loan_repay:'loan_repay',propose_credit_repay:'credit_repay'}))if(tool===t)body={type,...args};
  if(body){core.prepare(fresh(user),{...body,_businessAt:businessAt||args.scheduleAt});args._transaction=body;}
  if(tool==='propose_split'){requireThat(new Set(args.people).size===args.people.length,'AA成员不能重复');requireThat(cents(args.total)>=args.people.length,'AA金额不足');args.recipients=args.people.map(p=>{const r=recipient(user,p);const a=get('SELECT user_id FROM accounts WHERE number=?',r.number);requireThat(a?.user_id&&a.user_id!==user.id,'AA仅支持其他行内用户');return {...r,userId:a.user_id};});}
  if(tool==='propose_card_action'){const c=get('SELECT id,number,status FROM accounts WHERE id=? AND user_id=?',args.card,user.id)||get('SELECT id,number,status FROM credit_cards WHERE id=? AND user_id=?',args.card,user.id)||get('SELECT id,number,status FROM virtual_cards WHERE id=? AND user_id=?',args.card,user.id);requireThat(c,'卡片不存在',404,'NOT_FOUND');args.cardLabel=`尾号${c.number.slice(-4)}（${args.card}）`;}
  if(tool==='propose_virtual_card')requireThat(cents(args.limit)<=50000000,'虚拟卡限额最高50万元');
  if(tool==='propose_set_daily_limit')requireThat(cents(args.amount)<=50000000,'每日限额最高50万元');
  if(tool==='propose_cancel_subscription'){const sub=get("SELECT * FROM subscriptions WHERE id=? AND user_id=? AND status='active'",args.id,user.id);requireThat(sub,'订阅不存在或已取消',404,'NOT_FOUND');args.subscriptionLabel=`${sub.merchant} · ¥${yuan(sub.amount)}/月`;}
  if(tool==='propose_lock_funds'){cents(args.amount);args.until=future(args.until);}
  if(tool==='list_subscriptions')args.scope='本人订阅商户、金额、续费日期及周期识别结果（模拟）';
  if(tool==='set_reminder')args.at=future(args.at);
  return args;
 }
 function policyDecision(user,tool,args,options={}){return decide(bank,fresh(user),tool,args,options);}
 function policy(user,tool,args,exclude=''){return policyDecision(user,tool,args,{excludeId:exclude}).level;}
 function recordDecision(user,action,decision,phase){run('UPDATE agent_actions SET decision=?,level=? WHERE id=?',JSON.stringify(decision),rank[decision.level]>rank[action.level]?decision.level:action.level,action.id);audit(user.id,'policy.evaluated',action.id,{phase,decision,paramsDigest:action.params_digest});}

 function actionView(row) {
  if(!row)return null;
  const args=parse(row.args);const clean=redact(args);delete clean._transaction;
  if(clean.steps)clean.steps=clean.steps.map(s=>{const a={...s.args};delete a._transaction;return {...s,args:a};});
  const target=args.card?['accounts','credit_cards','virtual_cards'].map(t=>get(`SELECT number FROM ${t} WHERE id=? AND user_id=?`,args.card,row.user_id)).find(Boolean):null;
  return {...row,decision:parse(row.decision),accountTail:(target||core.accountFor({id:row.user_id})).number.slice(-4),args:clean,result:redact(parse(row.result)),...(row.tool==='create_plan'?{plan:planView(get('SELECT * FROM agent_plans WHERE action_id=?',row.id))}:{})};
 }
 function planView(row){const a=row?get('SELECT authorization_until,verification_until,pause_reason FROM agent_actions WHERE id=?',row.action_id):{};return row?{...row,...a,budget:parse(row.steps).reduce((n,s)=>n+scheduledAmount(s.args,s.tool),0),steps:parse(row.steps).map(s=>{const args=redact(s.args);delete args._transaction;return {...s,args,result:redact(s.result)};})}:null;}
 function propose(user,tool,raw,context={}) {
  guard.assertOpen(user.id);
  return atomic(()=>{
   expireActions();
   const args=normalize(user,tool,raw),decision=policyDecision(user,tool,args),level=decision.level,actionId=id('ACT');
   requireThat(level!=='green','该工具无需确认');
   const amount=actionAmount(tool,args),title=tool==='create_plan'?args.title:`${labels[tool]}${amount?' ¥'+yuan(amount):''}${args.recipientLabel?' → '+args.recipientLabel:''}`;
   run('INSERT INTO agent_actions(id,user_id,channel,session_id,tool,args,title,level,amount,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',actionId,user.id,context.channel||'app',context.sessionId||null,tool,JSON.stringify(args),title,level,amount,now(),new Date(Date.now()+900000).toISOString(),now());
   const saved=get('SELECT * FROM agent_actions WHERE id=?',actionId);run('UPDATE agent_actions SET params_digest=?,decision=?,run_id=? WHERE id=?',paramsDigest(actionParams(saved)),JSON.stringify(decision),context.runId||null,actionId);audit(user.id,'policy.evaluated',actionId,{phase:'propose',decision,runId:context.runId});
   if(tool==='create_plan')run('INSERT INTO agent_plans(id,user_id,action_id,title,steps,status,created_at) VALUES(?,?,?,?,?,?,?)',id('PLAN'),user.id,actionId,args.title,JSON.stringify(args.steps),'proposed',now());
   audit(user.id,'agent.action.proposed',actionId,{tool,args:redact(args),level,channel:context.channel||'app',runId:context.runId});
   if(level==='red'&&context.channel&&context.channel!=='app')notify(user.id,'操作待加强验证',`${title}，请打开智能助手完成验证。操作编号：${actionId}`);
   return actionView(get('SELECT * FROM agent_actions WHERE id=?',actionId));
  });
 }
 function owned(user,actionId){const a=get('SELECT * FROM agent_actions WHERE id=? AND user_id=?',actionId,user.id);requireThat(a,'操作不存在',404,'NOT_FOUND');return a;}
 function releaseReservations(actionId,amount=Infinity) {
  let remaining=amount;
  for(const r of all("SELECT * FROM reservations WHERE action_id=? AND status='active' ORDER BY created_at",actionId)){
   const released=Math.min(r.amount,remaining);run('UPDATE accounts SET held=held-? WHERE id=?',released,r.account_id);
   run("UPDATE reservations SET amount=amount-?,status=CASE WHEN amount=? THEN 'released' ELSE status END WHERE id=?",released,released,r.id);
   audit(r.user_id,'reservation.released',r.id,{amount:released});remaining-=released;if(remaining<=0)break;
  }
 }
 function reserve(user,actionId,planId,amount,until,purpose) {
  if(!amount)return;
  const account=core.accountFor(user);requireThat(account.status==='active','银行卡当前不可用',409,'ACCOUNT_UNAVAILABLE');requireThat(account.balance-account.held>=amount,'预授权可用余额不足',409,'INSUFFICIENT_FUNDS');
  run('UPDATE accounts SET held=held+? WHERE id=?',amount,account.id);
  const reservationId=id('R');run('INSERT INTO reservations(id,user_id,account_id,action_id,plan_id,amount,purpose,until_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',reservationId,user.id,account.id,actionId,planId||null,amount,purpose,until,now());audit(user.id,'reservation.created',reservationId,{amount,purpose});
 }
 function executeOne(user,tool,args,key,planId=null,permit) {
  authorization.assertPermit(permit,user,tool,args);
  user=fresh(user);guard.assertOpen(user.id);
  if(args._transaction){
   const tx=core.createTransaction(user,args._transaction,key,{excludeId:key,at:permit.at});
   if(tx.status==='completed')return {...tx,payload:parse(tx.payload)};
   return {...core.settle(user,tx,permit),payload:parse(tx.payload)};
  }
  switch(tool){
   case 'list_subscriptions':return {subscriptions:all('SELECT * FROM subscriptions WHERE user_id=?',user.id),detected:recognizeSubscriptions(ledgerFor(bank,user.id)),query:true};
   case 'propose_card_action': {
    let table=['accounts','credit_cards','virtual_cards'].find(t=>get(`SELECT id FROM ${t} WHERE id=? AND user_id=?`,args.card,user.id));requireThat(table,'卡片不存在',404);
    const card=get(`SELECT status FROM ${table} WHERE id=?`,args.card);
    requireThat(args.action==='report_lost'||(args.action==='unlost'?card.status==='lost':card.status!=='lost'),'挂失卡片需先解挂',409,'CARD_LOST');
    const status={freeze:'frozen',unfreeze:'active',report_lost:'lost',unlost:'active'}[args.action];
    run(`UPDATE ${table} SET status=? WHERE id=?`,status,args.card);
    if(table==='accounts'&&status==='lost')for(const tx of all("SELECT * FROM transactions WHERE account_id=? AND status='pending'",args.card))core.finishFailed(tx,'failed','银行卡已挂失，预留资金已释放');
    audit(user.id,'card.status_changed',args.card,{status});notify(user.id,'卡片状态变更',`${status==='lost'?'已挂失':status==='active'?'已恢复':'已冻结'}，卡片编号：${args.card}`);return {card:args.card,status};
   }
   case 'propose_virtual_card':{const card=id('VC');run('INSERT INTO virtual_cards(id,user_id,number,card_limit,created_at) VALUES(?,?,?,?,?)',card,user.id,'9999'+id().replace(/\D/g,'').padEnd(12,'0').slice(0,12),cents(args.limit),now());audit(user.id,'virtual_card.created',card);return {id:card,limit:cents(args.limit),simulation:true};}
   case 'propose_set_daily_limit':run('UPDATE users SET daily_limit=? WHERE id=?',cents(args.amount),user.id);audit(user.id,'settings.updated','',{dailyLimit:cents(args.amount)});return {dailyLimit:cents(args.amount)};
   case 'propose_cancel_subscription':run("UPDATE subscription_mandates SET status='revoked' WHERE subscription_id=? AND user_id=?",args.id,user.id);requireThat(run("UPDATE subscriptions SET status='cancelled' WHERE id=? AND user_id=? AND status='active'",args.id,user.id).changes,'订阅已取消或不存在',409);audit(user.id,'subscription.cancelled',args.id);return {id:args.id,status:'cancelled'};
   case 'propose_lock_funds':requireThat(args.until>now(),'资金锁定日期已过期');reserve(user,key,planId,cents(args.amount),args.until,args.purpose);return {amount:cents(args.amount),until:args.until,purpose:args.purpose};
   case 'propose_split': {
    const total=cents(args.total),each=Math.floor(total/args.recipients.length);
    const requests=args.recipients.map((r,i)=>({to:r.name,toUserId:r.userId,amount:each+(i<total%args.recipients.length?1:0),url:`/#pay-request/${key}/${i}`}));
    requests.forEach(r=>notify(r.toUserId,'AA收款请求',`${user.name}发起AA收款 ¥${yuan(r.amount)}：${args.note||'AA分摊'}。打开 ${r.url} 审核并付款。`));audit(user.id,'split.created',key,{count:requests.length,total});return {requests};
   }
   case 'set_reminder':return reminder(user,args,key);
   default:throw new BusinessError('不支持的操作');
  }
 }
 function reminder(user,args,key=id('REM')) {
  const at=future(args.at);run('INSERT OR IGNORE INTO scheduled_tasks(id,user_id,kind,args,run_at,created_at) VALUES(?,?,?,?,?,?)',key,user.id,'reminder',JSON.stringify({text:args.text}),at,now());audit(user.id,'reminder.created',key,{at});return {id:key,at,text:args.text};
 }
 function scheduledAmount(args,tool){return args._transaction&& !['redeem','loan_draw','credit_spend'].includes(args._transaction.type)?cents(args.amount):tool==='propose_lock_funds'?cents(args.amount):0;}
 function authorizePlan(user,action,args) {
  const plan=get('SELECT * FROM agent_plans WHERE action_id=?',action.id);
  const spending=args.steps.reduce((n,s)=>n+(s.tool==='propose_lock_funds'?0:scheduledAmount(s.args,s.tool)),0);
  const locked=args.steps.filter(s=>s.tool==='propose_lock_funds').reduce((n,s)=>n+cents(s.args.amount),0);
  const transfers=new Map();
  for(const s of args.steps)if(s.tool==='propose_transfer'){const date=businessDate(expectedAt(s,args.steps,action.created_at));transfers.set(date,(transfers.get(date)||0)+cents(s.args.amount));}
  for(const [date,amount] of transfers)requireThat(dailyTotal(bank,user.id,action.id,date)+amount<=fresh(user).daily_limit,'计划超出该业务日的每日限额',409,'DAILY_LIMIT');
  const until=authorizationWindow(action,args);
  reserve(user,action.id,plan.id,Math.max(spending,locked),until,`计划预授权 · ${args.title}`);
  for(const step of args.steps){
   const taskId=id('TASK');step.actionId=taskId;
   const runAt=expectedAt(step,args.steps,action.created_at);
   run('INSERT INTO scheduled_tasks(id,user_id,action_id,plan_id,step_id,kind,args,run_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',taskId,user.id,action.id,plan.id,step.id,step.tool,JSON.stringify(step.args),runAt,now());
  }
  run("UPDATE agent_plans SET steps=?,status='active' WHERE id=?",JSON.stringify(args.steps),plan.id);
 }
 function pushResult(action,text){
  if(action.channel==='app'||!action.session_id)return;
  const binding=get("SELECT * FROM channel_bindings WHERE id=? AND user_id=? AND status='active'",action.session_id,action.user_id);
  if(binding)run('INSERT INTO channel_outbox(id,binding_id,body,next_at) VALUES(?,?,?,?)',id('OUT'),binding.id,text,now());
 }
 function completeAction(action,result) {
  run("UPDATE agent_actions SET status='completed',result=?,updated_at=? WHERE id=?",JSON.stringify(result),now(),action.id);
  run("UPDATE operation_authorizations SET status='completed' WHERE action_id=? AND status='active'",action.id);
  audit(action.user_id,'agent.action.completed',action.id,{result:redact(result)});guard.record(action.user_id,'action_success');
  notify(action.user_id,'智能助手操作完成',`${action.title}，操作编号：${action.id}`);pushResult(action,`【操作完成】${action.title}\n回单/操作编号：${result?.id||action.id}`);
 }
 function authorizationWindow(action,args) {
  if(action.authorization_until)return action.authorization_until;
  const dates=(args.steps||[{args}]).map(s=>s.args.until||new Date(Date.parse(args.steps?expectedAt(s,args.steps):s.args.scheduleAt||now())+86400000).toISOString());
  return args.steps||args.scheduleAt?dates.sort().at(-1):action.expires_at;
 }
 function currentPlanArgs(action,args,at=now()) {
  if(action.tool!=='create_plan')return args;
  const steps=parse(get('SELECT steps FROM agent_plans WHERE action_id=?',action.id).steps);
  return {...args,steps:steps.filter(s=>!['completed','cancelled','failed','expired'].includes(s.status)).map(s=>({...s,dependsOn:[],runAt:[expectedAt(s,steps,action.created_at),at].sort().at(-1)}))};
 }
 function confirm(user,actionId,{pin,verificationToken}={},context={channel:'app'}) {
  guard.assertOpen(user.id);expireActions();let action=owned(user,actionId);
  if(context.channel==='app')core.pin(fresh(user),pin);
  else requireThat(context.bindingId===action.session_id&&context.channel===action.channel&&get("SELECT id FROM channel_bindings WHERE id=? AND user_id=? AND status='active'",context.bindingId,user.id),'渠道确认无效',403,'CHANNEL_NOT_BOUND');
  if(['completed','confirmed'].includes(action.status))return actionView(action);
  requireThat(['proposed','awaiting_verification'].includes(action.status),'该操作无法确认',409,'INVALID_STATE');
  requireThat(action.tool!=='direct_operation','请从原业务页面完成验证',409,'INVALID_STATE');
  requireThat(!action.params_digest||action.params_digest===paramsDigest(actionParams(action)),'操作参数已变化，请重新提议',403,'AUTHORIZATION_MISMATCH');
  const args=parse(action.args),resuming=action.status==='awaiting_verification';
  let authorized=false;
  // Persist the latest requirement even when verification is missing.
  const initialDecision=policyDecision(user,action.tool,currentPlanArgs(action,args),{excludeId:action.id,confirmed:true});
  if(rank[action.level]>rank[initialDecision.level])initialDecision.level=action.level;
  recordDecision(user,action,initialDecision,'confirm');action=owned(user,actionId);
  if(action.level==='red')requireThat(context.channel==='app','此操作需返回App完成加强验证',403,'APP_VERIFICATION_REQUIRED');
  try{
   atomic(()=>{
    action=owned(user,actionId);
    const decision=policyDecision(user,action.tool,currentPlanArgs(action,args),{excludeId:action.id,confirmed:true});
    if(rank[action.level]>rank[decision.level])decision.level=action.level;
    recordDecision(user,action,decision,'confirm');
    const factors=['explicit_confirmation',context.channel==='app'?'pin':'bound_channel_confirmation'];
    if(decision.level==='red')factors.push(...services.verification.consume(user,action.id,verificationToken));
    authorized=true;
    const until=authorizationWindow(action,args);
    requireThat(until>now(),'原授权窗口已结束',403,'AUTHORIZATION_INVALID');
    authorization.issue(user,action,decision,factors,context,until);
    decision.outcome='allow';recordDecision(user,action,decision,'authorized');
    run("UPDATE agent_actions SET status='confirmed',authorization_until=?,verification_until=NULL,pause_reason=NULL,updated_at=? WHERE id=?",until,now(),action.id);
    audit(user.id,'agent.action.confirmed',action.id,{level:decision.level,channel:context.channel});
    if(resuming){
     run("UPDATE scheduled_tasks SET status='pending',error=NULL WHERE action_id=? AND status='awaiting_verification'",action.id);
     run("UPDATE agent_plans SET status='active' WHERE action_id=? AND status='awaiting_verification'",action.id);
     const plan=get('SELECT * FROM agent_plans WHERE action_id=?',action.id);if(plan){const steps=parse(plan.steps);for(const s of steps)if(s.status==='awaiting_verification')s.status='pending';run('UPDATE agent_plans SET steps=? WHERE id=?',JSON.stringify(steps),plan.id);}
     audit(user.id,'agent.action.resumed',action.id);notify(user.id,'操作已重新授权',action.title+'，等待调度执行。');pushResult(action,'【已重新授权，等待执行】'+action.title);
    }else if(action.tool==='create_plan')authorizePlan(user,action,args);
    else if(args.scheduleAt){reserve(user,action.id,null,scheduledAmount(args,action.tool),until,'定时操作预授权');run('INSERT INTO scheduled_tasks(id,user_id,action_id,kind,args,run_at,created_at) VALUES(?,?,?,?,?,?,?)',id('TASK'),user.id,action.id,action.tool,JSON.stringify(args),args.scheduleAt,now());}
    else {
     const executionDecision=policyDecision(user,action.tool,args,{excludeId:action.id,phase:'execute'});
     const permit=authorization.permit(user,action,action.tool,args,executionDecision);
     run("UPDATE agent_actions SET status='executing' WHERE id=?",action.id);
     const result=executeOne(user,action.tool,args,action.id,null,permit);authorization.complete(permit,result);completeAction(action,result);
    }
   });
  }catch(error){
   if(!authorized){error.decision=initialDecision;audit(user.id,'authorization.rejected',action.id,{code:error.code,decision:initialDecision});throw error;}
   atomic(()=>{
    authorization.revoke(action.id,error.code||'EXECUTION_FAILED');run('UPDATE verifications SET used=1 WHERE action_id=?',action.id);releaseReservations(action.id);
    run("UPDATE agent_actions SET status='failed',error=?,updated_at=? WHERE id=?",error instanceof BusinessError?error.message:'执行失败',now(),action.id);
    audit(user.id,'agent.action.failed',action.id,{error:error.code||'EXECUTION_FAILED',decision:policyDecision(user,action.tool,args,{excludeId:action.id,denial:{code:error.code||'EXECUTION_FAILED',message:error.message}})});guard.record(user.id,'action_failure');notify(user.id,'智能助手操作失败',action.title+'：'+error.message);pushResult(action,'【操作失败】'+action.title+'：'+error.message);
    if(action.tool==='create_plan')run("UPDATE agent_plans SET status='failed' WHERE action_id=?",action.id);
   });
  }
  return actionView(owned(user,actionId));
 }
 function recheckTask(user,task,at=now()) {
  const action=owned(user,task.action_id),args=parse(task.args);
  requireThat(action.status==='confirmed','操作未授权或已暂停',403,'AUTHORIZATION_INVALID');
  const a=authorization.active(user,action,at);
  if(task.kind==='propose_lock_funds'){
   requireThat(core.accountFor(user).status==='active','锁定账户当前不可用',409,'ACCOUNT_UNAVAILABLE');
   requireThat(args.until>at,'锁定截止时间已过期',409,'INVALID_STATE');
   if(task.plan_id)requireThat(get("SELECT COALESCE(SUM(amount),0) AS n FROM reservations WHERE action_id=? AND status='active'",action.id).n>=cents(args.amount),'计划剩余资金不足以覆盖锁定金额',409,'INSUFFICIENT_FUNDS');
  }
  if(task.plan_id){
   const plan=get('SELECT * FROM agent_plans WHERE id=? AND user_id=?',task.plan_id,user.id);
   const steps=parse(plan.steps),original=parse(action.args).steps;
   const strip=ss=>ss.map(({status,result,actionId,...s})=>s);
   requireThat(paramsDigest(strip(steps))===paramsDigest(strip(original)),'计划步骤已变化，请重新提议',403,'AUTHORIZATION_MISMATCH');
   const step=steps.find(s=>s.id===task.step_id);
   requireThat(step?.actionId===task.id&&step.status==='pending','任务不是当前未完成的授权步骤',403,'AUTHORIZATION_MISMATCH');
   requireThat(task.run_at===expectedAt(step,steps,action.created_at)&&at>=task.run_at,'步骤执行时间不在授权范围内',403,'AUTHORIZATION_MISMATCH');
  }else requireThat(task.run_at===parse(action.args).scheduleAt&&at>=task.run_at,'执行时间不在授权范围内',403,'AUTHORIZATION_MISMATCH');
  const decision=policyDecision(user,task.kind,args,{excludeId:task.plan_id?'':action.id,excludeStep:task.plan_id?task.id:'',phase:'execute',at,authorization:a,confirmed:true});
  recordDecision(user,action,decision,'execute');
  return authorization.permit(user,action,task.kind,args,decision,{stepId:task.step_id||'single',key:task.plan_id?task.id:action.id,at});
 }
 function pauseAction(user,actionId,reason,at=now()) {
  const action=owned(user,actionId);if(action.status==='awaiting_verification')return;
  const until=new Date(Math.min(Date.parse(at)+900000,Date.parse(action.authorization_until||at))).toISOString();
  run("UPDATE agent_actions SET status='awaiting_verification',level='red',verification_until=?,pause_reason=?,updated_at=? WHERE id=?",until,reason,now(),action.id);
  run("UPDATE agent_plans SET status='awaiting_verification' WHERE action_id=?",action.id);
  const plan=get('SELECT * FROM agent_plans WHERE action_id=?',action.id);if(plan){const steps=parse(plan.steps);for(const s of steps)if(s.status==='pending')s.status='awaiting_verification';run('UPDATE agent_plans SET steps=? WHERE id=?',JSON.stringify(steps),plan.id);}
  run("UPDATE scheduled_tasks SET status='awaiting_verification',error=? WHERE action_id=? AND status='pending'",reason,action.id);
  audit(user.id,'agent.action.awaiting_verification',action.id,{reason,until});notify(user.id,'定时操作需补充模拟加强验证',action.title+'：'+reason+'。请在 '+until+' 前验证。');pushResult(action,'【需回App补充模拟加强验证】'+action.title+'，编号：'+action.id);
 }
 function cancel(user,actionId) {
  const a=owned(user,actionId);if(a.status==='cancelled')return actionView(a);
  requireThat(['proposed','confirmed','awaiting_verification'].includes(a.status),'操作已执行或结束，不能取消',409,'INVALID_STATE');
  atomic(()=>{
   authorization.revoke(a.id,'user_cancelled');run('UPDATE verifications SET used=1 WHERE action_id=?',a.id);
   const plan=get('SELECT id FROM agent_plans WHERE action_id=?',a.id);if(plan)abortPlan(user,plan.id);else {for(const task of all("SELECT id FROM scheduled_tasks WHERE action_id=? AND status IN ('pending','awaiting_verification')",a.id))run("UPDATE scheduled_tasks SET status='cancelled' WHERE id=?",task.id);releaseReservations(a.id);}
   run("UPDATE agent_actions SET status='cancelled',updated_at=? WHERE id=?",now(),a.id);audit(user.id,'agent.action.cancelled',a.id);pushResult(a,`【已取消】${a.title}`);
  });return actionView(owned(user,actionId));
 }
 function abortPlan(user,planId,reason='用户中断',status='cancelled') {
  const plan=get('SELECT * FROM agent_plans WHERE id=? AND user_id=?',planId,user.id);requireThat(plan,'计划不存在',404);
  atomic(()=>{
   authorization.revoke(plan.action_id,reason);run('UPDATE verifications SET used=1 WHERE action_id=?',plan.action_id);
   releaseReservations(plan.action_id);
   const steps=parse(plan.steps);for(const s of steps){if(['pending','awaiting_verification'].includes(s.status))s.status='cancelled';if(s.actionId)releaseReservations(s.actionId);}
   run('UPDATE agent_plans SET status=?,steps=? WHERE id=?',plan.status==='completed'?'completed':status,JSON.stringify(steps),plan.id);
   run("UPDATE scheduled_tasks SET status='cancelled',error=? WHERE plan_id=? AND status IN ('pending','awaiting_verification')",reason,plan.id);
   if(plan.status!=='completed')run('UPDATE agent_actions SET status=?,error=?,updated_at=? WHERE id=?',status,reason,now(),plan.action_id);
   audit(user.id,'agent.plan.aborted',plan.id,{reason});notify(user.id,'联动计划已中断',`${plan.title}：${reason}。未执行步骤已取消，锁定资金已释放；已完成交易可查回单。`);
  });return planView(get('SELECT * FROM agent_plans WHERE id=?',planId));
 }
 function handover(user,reason,sessionId) {
  const ticket=id('S');atomic(()=>{run('INSERT INTO tickets(id,user_id,subject,content,created_at) VALUES(?,?,?,?,?)',ticket,user.id,'智能助手转人工',reason,now());if(sessionId)run('UPDATE agent_sessions SET handover=1 WHERE id=? AND user_id=?',sessionId,user.id);audit(user.id,'agent.handover',ticket);notify(user.id,'已转模拟人工客服',`工单号：${ticket}`);});return {id:ticket,status:'submitted',simulation:true};
 }
 function expireActions(at=now()) {
  for(const a of all("SELECT * FROM agent_actions WHERE (status='proposed' AND expires_at<=?) OR (status='awaiting_verification' AND (verification_until<=? OR authorization_until<=?)) OR (status='confirmed' AND authorization_until<=?)",at,at,at,at)) atomic(()=>{
   authorization.revoke(a.id,'window_expired','expired');releaseReservations(a.id);
   const plan=get('SELECT id FROM agent_plans WHERE action_id=?',a.id);
   if(plan)abortPlan({id:a.user_id},plan.id,'授权或补充验证窗口已过期','expired');
   run("UPDATE scheduled_tasks SET status='expired' WHERE action_id=? AND status IN ('pending','awaiting_verification')",a.id);
   run("UPDATE agent_actions SET status='expired',updated_at=? WHERE id=?",now(),a.id);run("UPDATE agent_plans SET status='expired' WHERE action_id=?",a.id);audit(a.user_id,'agent.action.expired',a.id);
  });
 }
 function plans(user){return all('SELECT * FROM agent_plans WHERE user_id=? ORDER BY created_at DESC',user.id).map(planView);}
 function snapshot(user){return {agentActions:all('SELECT * FROM agent_actions WHERE user_id=? ORDER BY created_at DESC LIMIT 100',user.id).map(actionView),agentPlans:plans(user),subscriptions:all('SELECT * FROM subscriptions WHERE user_id=?',user.id),virtualCards:all('SELECT * FROM virtual_cards WHERE user_id=?',user.id),reservations:all("SELECT * FROM reservations WHERE user_id=? AND status='active'",user.id),scheduledTasks:all('SELECT * FROM scheduled_tasks WHERE user_id=? ORDER BY run_at DESC LIMIT 100',user.id).map(t=>({...t,args:redact(parse(t.args)),result:redact(parse(t.result))})),bindings:all('SELECT id,channel,status,created_at FROM channel_bindings WHERE user_id=?',user.id),agentLockedUntil:fresh(user).agent_locked_until};}
 return Object.assign(services,{resolveRecipients,normalize,policy,policyDecision,recheckTask,pauseAction,actionView,planView,propose,owned,confirm,cancel,plans,snapshot,executeOne,releaseReservations,reserve,abortPlan,handover,reminder,completeAction,expireActions,pushResult,scheduledAmount});
}
