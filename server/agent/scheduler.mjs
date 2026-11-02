import { now } from '../db.mjs';
import { businessDate } from './policy.mjs';
// These clear on their own or by the customer, so due work waits instead of failing. A task's authorization window still bounds the wait.
const PAUSED=new Set(['AGENT_LOCKED','AGENT_STOPPED','AGENT_CONSENT_REQUIRED','AUTHORIZATION_PAUSED']);
const BEIJING=8*3600000;
// Monthly debits keep their Beijing calendar day: a shorter month bills on its last day, and the original day returns the month after.
function nextCharge(due,day,at) {
 const next=new Date(Date.parse(due)+BEIJING);
 do{const month=next.getUTCMonth()+1;next.setUTCMonth(month,Math.min(day,new Date(Date.UTC(next.getUTCFullYear(),month+1,0)).getUTCDate()));}while(new Date(next-BEIJING).toISOString()<=at);
 return new Date(next-BEIJING).toISOString();
}
export function createScheduler(services) {
 const {bank,guard}=services,{get,all,run,atomic,audit,notify}=bank;
 function runDue(at=now()) {
  services.expireActions(at);
  for(const r of all("SELECT * FROM reservations WHERE status='active' AND until_at<=?",at)) atomic(()=>{
   run('UPDATE accounts SET held=held-? WHERE id=?',r.amount,r.account_id);run("UPDATE reservations SET amount=0,status='released' WHERE id=?",r.id);audit(r.user_id,'reservation.expired',r.id,{amount:r.amount});
  });
  // Re-read dependency states each pass: a prerequisite completed in this tick can unblock a child.
  for(let pass=0;pass<13;pass++){
   let advanced=false;
   for(const task of all("SELECT * FROM scheduled_tasks WHERE status='pending' AND run_at<=? ORDER BY run_at,created_at,rowid",at)){
    let plan=task.plan_id?get('SELECT * FROM agent_plans WHERE id=?',task.plan_id):null;
    if(plan){const steps=JSON.parse(plan.steps),step=steps.find(s=>s.id===task.step_id);if(plan.status!=='active'||step.dependsOn.some(dep=>steps.find(s=>s.id===dep).status!=='completed'))continue;}
    const user=get('SELECT * FROM users WHERE id=?',task.user_id),args=JSON.parse(task.args);
    try{
     atomic(()=>{
      guard.assertOpen(user.id);
      if(plan){plan=get('SELECT * FROM agent_plans WHERE id=?',plan.id);if(plan.status!=='active')return;}
      const permit=task.action_id?services.recheckTask(user,task,at):null;
      run("UPDATE scheduled_tasks SET status='executing' WHERE id=?",task.id);
      if(plan)services.releaseReservations(plan.action_id,task.kind==='propose_lock_funds'?0:services.scheduledAmount(args,task.kind));
      else services.releaseReservations(task.action_id||task.id);
      let result;
      if(task.kind==='reminder'||task.kind==='set_reminder'){notify(user.id,'智能助手提醒',args.text);result={reminded:true};}
      else if(plan&&task.kind==='propose_lock_funds'){run("UPDATE reservations SET purpose=? WHERE action_id=? AND status='active'",args.purpose,plan.action_id);result={amount:Math.round(Number(args.amount)*100),until:args.until,purpose:args.purpose,sharedPlanBudget:true};}
      else result=services.executeOne(user,task.kind,args,plan?task.id:task.action_id,plan?.id,permit);
      if(permit)services.authorization.complete(permit,result);
      run("UPDATE scheduled_tasks SET status='completed',result=?,error=NULL WHERE id=?",JSON.stringify(result),task.id);audit(user.id,'scheduled.completed',task.id,{kind:task.kind});
      if(plan){const steps=JSON.parse(plan.steps),step=steps.find(s=>s.id===task.step_id);step.status='completed';step.result=result;const done=steps.every(s=>s.status==='completed');run('UPDATE agent_plans SET steps=?,status=? WHERE id=?',JSON.stringify(steps),done?'completed':'active',plan.id);if(done&&!steps.some(s=>s.tool==='propose_lock_funds'))services.releaseReservations(plan.action_id);if(done)services.completeAction(get('SELECT * FROM agent_actions WHERE id=?',plan.action_id),{planId:plan.id,steps:steps.map(s=>({id:s.id,status:s.status}))});}
      else if(task.action_id)services.completeAction(get('SELECT * FROM agent_actions WHERE id=?',task.action_id),result);
     });
    }catch(error){
     if(PAUSED.has(error.code)){
      atomic(()=>{if(run('UPDATE scheduled_tasks SET error=? WHERE id=? AND error IS NOT ?',error.message,task.id,error.message).changes){audit(user.id,'scheduled.deferred',task.id,{error:error.code});notify(user.id,'定时任务暂缓',`${error.message}。解除后自动继续${task.action_id?'，授权到期前未恢复则不再执行':''}。`);}});continue;
     }
     if(error.code==='SUPPLEMENTAL_VERIFICATION_REQUIRED'){
      atomic(()=>{
       const action=services.owned(user,task.action_id),args=JSON.parse(task.args);
       const decision=services.policyDecision(user,task.kind,args,{excludeId:plan?'':action.id,excludeStep:plan?task.id:'',at,phase:'execute',confirmed:true});
       run('UPDATE agent_actions SET decision=? WHERE id=?',JSON.stringify(decision),action.id);audit(user.id,'policy.evaluated',action.id,{phase:'execute',stepId:task.step_id,decision});
       services.pauseAction(user,action.id,error.message,at);
      });continue;
     }
     atomic(()=>{
      run("UPDATE scheduled_tasks SET status='failed',error=? WHERE id=?",error.message,task.id);services.releaseReservations(plan?task.id:task.action_id||task.id);audit(user.id,'scheduled.failed',task.id,{error:error.code||'EXECUTION_FAILED'});guard.record(user.id,'action_failure');
      if(plan){const steps=JSON.parse(plan.steps);steps.find(s=>s.id===task.step_id).status='failed';run('UPDATE agent_plans SET steps=? WHERE id=?',JSON.stringify(steps),plan.id);services.abortPlan(user,plan.id,`步骤失败：${error.message}`,'failed');}
      else if(task.action_id){services.authorization.revoke(task.action_id,error.code);run("UPDATE agent_actions SET status='failed',error=?,updated_at=? WHERE id=?",error.message,now(),task.action_id);services.pushResult(get('SELECT * FROM agent_actions WHERE id=?',task.action_id),`【定时操作失败】${error.message}`);}
      notify(user.id,'定时任务未完成',error.message);
     });
    }
    advanced=true;
   }
   if(!advanced)break;
  }
  for(const subscription of all("SELECT * FROM subscriptions WHERE status='active'")){
   const due=subscription.next_at,user=get('SELECT * FROM users WHERE id=?',subscription.user_id);
   if(due<=at){
    // Standing demo mandates are fixed amount; cancelling the subscription revokes future debits.
    try{atomic(()=>{
     guard.assertOpen(user.id);
     const body={type:'payment',billType:'merchant',merchant:`订阅 · ${subscription.merchant}`,amount:(subscription.amount/100).toFixed(2)};
     const permit=services.authorization.standing(user,subscription,body,at);
     const tx=services.createTransaction(user,body,`subscription:${subscription.id}:${due}`);
     if(tx.status!=='completed')services.settle(user,tx,permit);
     const day=subscription.billing_day||new Date(Date.parse(due)+BEIJING).getUTCDate();
     run('UPDATE subscriptions SET next_at=?,billing_day=?,reminded_at=NULL WHERE id=?',nextCharge(due,day,at),day,subscription.id);audit(user.id,'subscription.charged',subscription.id,{transactionId:tx.id});
    });}catch(error){
     // next_at stays, so the debit runs once the pause ends; reminded_at keeps this notice to one per due date.
     if(PAUSED.has(error.code)){const told=`deferred:${due}`;if(run('UPDATE subscriptions SET reminded_at=? WHERE id=? AND reminded_at IS NOT ?',told,subscription.id,told).changes){audit(user.id,'subscription.deferred',subscription.id,{error:error.code});notify(user.id,'订阅代扣暂缓',`${subscription.merchant}：${error.message}。解除后自动扣款。`);}continue;}
     run("UPDATE subscriptions SET status='payment_failed' WHERE id=?",subscription.id);audit(user.id,'subscription.failed',subscription.id,{error:error.code||'EXECUTION_FAILED'});notify(user.id,'订阅代扣失败',`${subscription.merchant}：${error.message}。代扣已暂停，请联系客服处理。`);}
   }else if(Date.parse(due)-Date.parse(at)<3*86400000&&subscription.reminded_at!==due){notify(user.id,'订阅续费提醒',`${subscription.merchant}将于${businessDate(due)}扣费¥${(subscription.amount/100).toFixed(2)}，可在智能助手中取消。`);run('UPDATE subscriptions SET reminded_at=? WHERE id=?',due,subscription.id);}
  }
 }
 return {runDue};
}
