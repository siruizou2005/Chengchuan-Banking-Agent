import { id, now, products } from './db.mjs';
import { cents, requireThat, BusinessError } from './errors.mjs';
import { classify, dailyTotal, actionAmount, rank } from './agent/policy.mjs';
import { validateArgs } from './agent/tools.mjs';
import { redact } from './agent/guard.mjs';
const parse = value => value ? JSON.parse(value) : null;
const yuan = n => (n/100).toFixed(2);
const labels={propose_transfer:'转账',propose_payment:'缴费/消费',propose_split:'AA收款',propose_subscribe_product:'产品申购',propose_redeem:'赎回',propose_loan_draw:'贷款提款',propose_loan_repay:'贷款还款',propose_credit_repay:'信用卡还款',propose_card_action:'卡片管理',propose_virtual_card:'虚拟卡申请',propose_set_daily_limit:'调整每日限额',propose_cancel_subscription:'取消订阅',propose_lock_funds:'资金锁定',create_plan:'联动计划'};
export function future(value) {
 const d=new Date(value);requireThat(typeof value==='string'&&Number.isFinite(d.valueOf())&&d.valueOf()>Date.now()&&d.valueOf()<Date.now()+366*86400000,'请选择未来一年内的有效时间');return d.toISOString();
}
export function createServices(bank,core,guard) {
 const {get,all,run,atomic,audit,notify}=bank;
 const services={...core,bank,guard};
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
 function normalize(user,tool,args) {
  args=validateArgs(tool,args);
  if(tool==='create_plan'){
   const ids=new Set(args.steps.map(s=>s.id));requireThat(ids.size===args.steps.length,'计划步骤ID不能重复');
   const visited=new Set(),visiting=new Set(),ordered=[];
   const visit=step=>{if(visited.has(step.id))return;requireThat(!visiting.has(step.id),'计划存在循环依赖');visiting.add(step.id);for(const dep of step.dependsOn){requireThat(ids.has(dep),'计划依赖不存在');visit(args.steps.find(s=>s.id===dep));}visiting.delete(step.id);visited.add(step.id);ordered.push(step);};
   args.steps.forEach(visit);
   args.steps=ordered.map(s=>({...s,args:normalize(user,s.tool,s.args),runAt:s.runAt?future(s.runAt):undefined,status:'pending'}));
   for(const step of args.steps)for(const dep of step.dependsOn){const parent=args.steps.find(s=>s.id===dep);requireThat(!step.runAt||!parent.runAt||step.runAt>=parent.runAt,'步骤时间不能早于依赖步骤');}
   return args;
  }
  let body;
  if(tool==='propose_transfer'){const r=recipient(user,args.recipient);body={type:'transfer',amount:args.amount,recipientName:r.name,recipientAccount:r.number,bank:r.bank,note:args.note||''};args.recipientLabel=`${r.name}（尾号${r.number.slice(-4)}）`;if(args.scheduleAt)args.scheduleAt=future(args.scheduleAt);}
  if(tool==='propose_payment')body={type:'payment',...args};
  if(tool==='propose_subscribe_product'){const p=products.find(p=>p.id===args.productId);requireThat(p,'产品不存在');body={type:p.type==='deposit'?'deposit':'investment',...args};args.productName=p.name;}
  for(const [t,type] of Object.entries({propose_redeem:'redeem',propose_loan_draw:'loan_draw',propose_loan_repay:'loan_repay',propose_credit_repay:'credit_repay'}))if(tool===t)body={type,...args};
  if(body){core.prepare(fresh(user),body);args._transaction=body;}
  if(tool==='propose_split'){requireThat(new Set(args.people).size===args.people.length,'AA成员不能重复');requireThat(cents(args.total)>=args.people.length,'AA金额不足');args.recipients=args.people.map(p=>{const r=recipient(user,p);const a=get('SELECT user_id FROM accounts WHERE number=?',r.number);requireThat(a?.user_id&&a.user_id!==user.id,'AA仅支持其他行内用户');return {...r,userId:a.user_id};});}
  if(tool==='propose_card_action'){const c=get('SELECT id,status FROM accounts WHERE id=? AND user_id=?',args.card,user.id)||get('SELECT id,status FROM credit_cards WHERE id=? AND user_id=?',args.card,user.id)||get('SELECT id,status FROM virtual_cards WHERE id=? AND user_id=?',args.card,user.id);requireThat(c,'卡片不存在',404,'NOT_FOUND');args.cardLabel=args.card;}
  if(tool==='propose_virtual_card')requireThat(cents(args.limit)<=50000000,'虚拟卡限额最高50万元');
  if(tool==='propose_set_daily_limit')requireThat(cents(args.amount)<=50000000,'每日限额最高50万元');
  if(tool==='propose_cancel_subscription')requireThat(get("SELECT id FROM subscriptions WHERE id=? AND user_id=? AND status='active'",args.id,user.id),'订阅不存在或已取消',404,'NOT_FOUND');
  if(tool==='propose_lock_funds'){cents(args.amount);args.until=future(args.until);}
  if(tool==='set_reminder')args.at=future(args.at);
  return args;
 }
 function policy(user,tool,args,exclude=''){return classify(tool,args,{dailyLimit:fresh(user).daily_limit,dailyTotal:dailyTotal(bank,user.id,exclude)});}
 function actionView(row) {
  if(!row)return null;
  const args=parse(row.args);const clean=redact(args);delete clean._transaction;
  if(clean.steps)clean.steps=clean.steps.map(s=>{const a={...s.args};delete a._transaction;return {...s,args:a};});
  return {...row,args:clean,result:redact(parse(row.result)),...(row.tool==='create_plan'?{plan:planView(get('SELECT * FROM agent_plans WHERE action_id=?',row.id))}:{})};
 }
 function planView(row){return row?{...row,steps:parse(row.steps).map(s=>{const args=redact(s.args);delete args._transaction;return {...s,args,result:redact(s.result)};})}:null;}
 function propose(user,tool,raw,context={}) {
  guard.assertOpen(user.id);
  return atomic(()=>{
   expireActions();
   const args=normalize(user,tool,raw),level=policy(user,tool,args),actionId=id('ACT');
   requireThat(level!=='green','该工具无需确认');
   const amount=actionAmount(tool,args),title=tool==='create_plan'?args.title:`${labels[tool]}${amount?' ¥'+yuan(amount):''}${args.recipientLabel?' → '+args.recipientLabel:''}`;
   run('INSERT INTO agent_actions(id,user_id,channel,session_id,tool,args,title,level,amount,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',actionId,user.id,context.channel||'app',context.sessionId||null,tool,JSON.stringify(args),title,level,amount,now(),new Date(Date.now()+900000).toISOString(),now());
   if(tool==='create_plan')run('INSERT INTO agent_plans VALUES(?,?,?,?,?,?,?)',id('PLAN'),user.id,actionId,args.title,JSON.stringify(args.steps),'proposed',now());
   audit(user.id,'agent.action.proposed',actionId,{tool,args:redact(args),level,channel:context.channel||'app'});
   if(level==='red'&&context.channel&&context.channel!=='app')notify(user.id,'待App强验证操作',`${title}，请打开智能助手完成验证。操作编号：${actionId}`);
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
 function executeOne(user,tool,args,key,planId=null) {
  user=fresh(user);guard.assertOpen(user.id);
  if(args._transaction){
   const tx=core.createTransaction(user,args._transaction,key);
   if(tx.status==='completed')return {...tx,payload:parse(tx.payload)};
   return {...core.settle(user,tx),payload:parse(tx.payload)};
  }
  switch(tool){
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
   case 'propose_cancel_subscription':requireThat(run("UPDATE subscriptions SET status='cancelled' WHERE id=? AND user_id=? AND status='active'",args.id,user.id).changes,'订阅已取消或不存在',409);audit(user.id,'subscription.cancelled',args.id);return {id:args.id,status:'cancelled'};
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
  const dates=args.steps.map(s=>s.args.until||new Date(Date.parse(s.runAt||s.args.scheduleAt||s.args.at||now())+86400000).toISOString());
  const until=dates.sort().at(-1);
  reserve(user,action.id,plan.id,Math.max(spending,locked),until,`计划预授权 · ${args.title}`);
  for(const step of args.steps){
   const taskId=id('TASK');step.actionId=taskId;
   const runAt=step.runAt||step.args.scheduleAt||(step.tool==='set_reminder'?step.args.at:now());
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
  audit(action.user_id,'agent.action.completed',action.id,{result:redact(result)});guard.record(action.user_id,'action_success');
  notify(action.user_id,'智能助手操作完成',`${action.title}，操作编号：${action.id}`);pushResult(action,`【操作完成】${action.title}\n回单/操作编号：${result?.id||action.id}`);
 }
 function confirm(user,actionId,{pin,verificationToken}={},context={channel:'app'}) {
  guard.assertOpen(user.id);expireActions();let action=owned(user,actionId);
  if(context.channel==='app')core.pin(fresh(user),pin);
  else requireThat(context.bindingId===action.session_id&&context.channel===action.channel&&get("SELECT id FROM channel_bindings WHERE id=? AND user_id=? AND status='active'",context.bindingId,user.id),'渠道确认无效',403,'CHANNEL_NOT_BOUND');
  if(['completed','confirmed'].includes(action.status))return actionView(action);
  requireThat(action.status==='proposed','该操作无法确认',409,'INVALID_STATE');
  const args=parse(action.args),level=policy(user,action.tool,args,action.id);
  if(rank[level]>rank[action.level]){run('UPDATE agent_actions SET level=? WHERE id=?',level,action.id);audit(user.id,'agent.action.escalated',action.id,{level});action={...action,level};}
  if(action.level==='red')requireThat(context.channel==='app','红色操作必须返回App完成强验证',403,'APP_VERIFICATION_REQUIRED');
  let authorized=false;
  try{
   atomic(()=>{
    if(action.level==='red')services.verification.consume(user,action.id,verificationToken);
    authorized=true;
    run("UPDATE agent_actions SET status='confirmed',updated_at=? WHERE id=?",now(),action.id);audit(user.id,'agent.action.confirmed',action.id,{level:action.level,channel:context.channel});
    if(action.tool==='create_plan')authorizePlan(user,action,args);
    else if(args.scheduleAt){reserve(user,action.id,null,scheduledAmount(args,action.tool),new Date(Date.parse(args.scheduleAt)+86400000).toISOString(),'定时操作预授权');run('INSERT INTO scheduled_tasks(id,user_id,action_id,kind,args,run_at,created_at) VALUES(?,?,?,?,?,?,?)',id('TASK'),user.id,action.id,action.tool,JSON.stringify(args),args.scheduleAt,now());}
    else {run("UPDATE agent_actions SET status='executing' WHERE id=?",action.id);audit(user.id,'agent.action.executing',action.id);completeAction(action,executeOne(user,action.tool,args,action.id));}
   });
  }catch(error){
   if(!authorized)throw error;
   atomic(()=>{run("UPDATE agent_actions SET status='failed',error=?,updated_at=? WHERE id=?",error instanceof BusinessError?error.message:'执行失败',now(),action.id);audit(user.id,'agent.action.failed',action.id,{error:error.code||'EXECUTION_FAILED'});guard.record(user.id,'action_failure');notify(user.id,'智能助手操作失败',`${action.title}：${error.message}`);pushResult(action,`【操作失败】${action.title}：${error.message}`);if(action.tool==='create_plan')run("UPDATE agent_plans SET status='failed' WHERE action_id=?",action.id);});
  }
  return actionView(owned(user,actionId));
 }
 function cancel(user,actionId) {
  const a=owned(user,actionId);if(a.status==='cancelled')return actionView(a);
  requireThat(['proposed','confirmed'].includes(a.status),'操作已执行或结束，不能取消',409,'INVALID_STATE');
  atomic(()=>{
   const plan=get('SELECT id FROM agent_plans WHERE action_id=?',a.id);if(plan)abortPlan(user,plan.id);else {for(const task of all("SELECT id FROM scheduled_tasks WHERE action_id=? AND status='pending'",a.id))run("UPDATE scheduled_tasks SET status='cancelled' WHERE id=?",task.id);releaseReservations(a.id);}
   run("UPDATE agent_actions SET status='cancelled',updated_at=? WHERE id=?",now(),a.id);audit(user.id,'agent.action.cancelled',a.id);pushResult(a,`【已取消】${a.title}`);
  });return actionView(owned(user,actionId));
 }
 function abortPlan(user,planId,reason='用户中断',status='cancelled') {
  const plan=get('SELECT * FROM agent_plans WHERE id=? AND user_id=?',planId,user.id);requireThat(plan,'计划不存在',404);
  atomic(()=>{
   releaseReservations(plan.action_id);
   const steps=parse(plan.steps);for(const s of steps){if(s.status==='pending')s.status='cancelled';if(s.actionId)releaseReservations(s.actionId);}
   run('UPDATE agent_plans SET status=?,steps=? WHERE id=?',status,JSON.stringify(steps),plan.id);
   run("UPDATE scheduled_tasks SET status='cancelled',error=? WHERE plan_id=? AND status='pending'",reason,plan.id);
   run('UPDATE agent_actions SET status=?,error=?,updated_at=? WHERE id=?',status,reason,now(),plan.action_id);
   audit(user.id,'agent.plan.aborted',plan.id,{reason});notify(user.id,'联动计划已中断',`${plan.title}：${reason}。未执行步骤已取消，锁定资金已释放；已完成交易可查回单。`);
  });return planView(get('SELECT * FROM agent_plans WHERE id=?',planId));
 }
 function handover(user,reason,sessionId) {
  const ticket=id('S');atomic(()=>{run('INSERT INTO tickets(id,user_id,subject,content,created_at) VALUES(?,?,?,?,?)',ticket,user.id,'智能助手转人工',reason,now());if(sessionId)run('UPDATE agent_sessions SET handover=1 WHERE id=? AND user_id=?',sessionId,user.id);audit(user.id,'agent.handover',ticket);notify(user.id,'已转模拟人工客服',`工单号：${ticket}`);});return {id:ticket,status:'submitted',simulation:true};
 }
 function expireActions(){for(const a of all("SELECT * FROM agent_actions WHERE status='proposed' AND expires_at<=?",now())){run("UPDATE agent_actions SET status='expired',updated_at=? WHERE id=?",now(),a.id);run("UPDATE agent_plans SET status='expired' WHERE action_id=?",a.id);audit(a.user_id,'agent.action.expired',a.id);}}
 function plans(user){return all('SELECT * FROM agent_plans WHERE user_id=? ORDER BY created_at DESC',user.id).map(planView);}
 function snapshot(user){return {agentActions:all('SELECT * FROM agent_actions WHERE user_id=? ORDER BY created_at DESC LIMIT 100',user.id).map(actionView),agentPlans:plans(user),subscriptions:all('SELECT * FROM subscriptions WHERE user_id=?',user.id),virtualCards:all('SELECT * FROM virtual_cards WHERE user_id=?',user.id),reservations:all("SELECT * FROM reservations WHERE user_id=? AND status='active'",user.id),scheduledTasks:all('SELECT * FROM scheduled_tasks WHERE user_id=? ORDER BY run_at DESC LIMIT 100',user.id).map(t=>({...t,args:redact(parse(t.args)),result:redact(parse(t.result))})),bindings:all('SELECT id,channel,status,created_at FROM channel_bindings WHERE user_id=?',user.id),agentLockedUntil:fresh(user).agent_locked_until};}
 return Object.assign(services,{resolveRecipients,normalize,policy,actionView,planView,propose,owned,confirm,cancel,plans,snapshot,executeOne,releaseReservations,reserve,abortPlan,handover,reminder,completeAction,expireActions,pushResult,scheduledAmount});
}
