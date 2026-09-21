import { now } from '../db.mjs';
export function createScheduler(services) {
 const {bank,guard}=services,{get,all,run,atomic,audit,notify}=bank;
 function runDue(at=now()) {
  services.expireActions();
  for(const r of all("SELECT * FROM reservations WHERE status='active' AND until_at<=?",at)) atomic(()=>{
   run('UPDATE accounts SET held=held-? WHERE id=?',r.amount,r.account_id);run("UPDATE reservations SET amount=0,status='released' WHERE id=?",r.id);audit(r.user_id,'reservation.expired',r.id,{amount:r.amount});
  });
  // Re-read dependency states each pass: a prerequisite completed in this tick can unblock a child.
  for(let pass=0;pass<13;pass++){
   let advanced=false;
   for(const task of all("SELECT * FROM scheduled_tasks WHERE status='pending' AND run_at<=? ORDER BY run_at,created_at",at)){
    let plan=task.plan_id?get('SELECT * FROM agent_plans WHERE id=?',task.plan_id):null;
    if(plan){const steps=JSON.parse(plan.steps),step=steps.find(s=>s.id===task.step_id);if(plan.status!=='active'||step.dependsOn.some(dep=>steps.find(s=>s.id===dep).status!=='completed'))continue;}
    const user=get('SELECT * FROM users WHERE id=?',task.user_id),args=JSON.parse(task.args);
    try{
     atomic(()=>{
      guard.assertOpen(user.id);
      run("UPDATE scheduled_tasks SET status='executing' WHERE id=?",task.id);
      if(plan)services.releaseReservations(plan.action_id,task.kind==='propose_lock_funds'?0:services.scheduledAmount(args,task.kind));
      else services.releaseReservations(task.action_id||task.id);
      let result;
      if(task.kind==='reminder'||task.kind==='set_reminder'){notify(user.id,'智能助手提醒',args.text);result={reminded:true};}
      else if(plan&&task.kind==='propose_lock_funds'){run("UPDATE reservations SET purpose=? WHERE action_id=? AND status='active'",args.purpose,plan.action_id);result={amount:Math.round(Number(args.amount)*100),until:args.until,purpose:args.purpose,sharedPlanBudget:true};}
      else result=services.executeOne(user,task.kind,args,plan?task.id:task.action_id,plan?.id);
      run("UPDATE scheduled_tasks SET status='completed',result=? WHERE id=?",JSON.stringify(result),task.id);audit(user.id,'scheduled.completed',task.id,{kind:task.kind});
      if(plan){const steps=JSON.parse(plan.steps),step=steps.find(s=>s.id===task.step_id);step.status='completed';step.result=result;const done=steps.every(s=>s.status==='completed');run('UPDATE agent_plans SET steps=?,status=? WHERE id=?',JSON.stringify(steps),done?'completed':'active',plan.id);if(done&&!steps.some(s=>s.tool==='propose_lock_funds'))services.releaseReservations(plan.action_id);if(done)services.completeAction(get('SELECT * FROM agent_actions WHERE id=?',plan.action_id),{planId:plan.id,steps:steps.map(s=>({id:s.id,status:s.status}))});}
      else if(task.action_id)services.completeAction(get('SELECT * FROM agent_actions WHERE id=?',task.action_id),result);
     });
    }catch(error){
     atomic(()=>{
      run("UPDATE scheduled_tasks SET status='failed',error=? WHERE id=?",error.message,task.id);services.releaseReservations(plan?task.id:task.action_id||task.id);audit(user.id,'scheduled.failed',task.id,{error:error.code||'EXECUTION_FAILED'});guard.record(user.id,'action_failure');
      if(plan){const steps=JSON.parse(plan.steps);steps.find(s=>s.id===task.step_id).status='failed';run('UPDATE agent_plans SET steps=? WHERE id=?',JSON.stringify(steps),plan.id);services.abortPlan(user,plan.id,`步骤失败：${error.message}`,'failed');}
      else if(task.action_id){run("UPDATE agent_actions SET status='failed',error=?,updated_at=? WHERE id=?",error.message,now(),task.action_id);services.pushResult(get('SELECT * FROM agent_actions WHERE id=?',task.action_id),`【定时操作失败】${error.message}`);}
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
     const tx=services.createTransaction(user,{type:'payment',billType:'merchant',merchant:`订阅 · ${subscription.merchant}`,amount:(subscription.amount/100).toFixed(2)},`subscription:${subscription.id}:${due}`);
     if(tx.status!=='completed')services.settle(user,tx);
     const next=new Date(due);next.setUTCMonth(next.getUTCMonth()+1);if(next.toISOString()<=at)next.setTime(Date.parse(at)+30*86400000);
     run('UPDATE subscriptions SET next_at=?,reminded_at=NULL WHERE id=?',next.toISOString(),subscription.id);audit(user.id,'subscription.charged',subscription.id,{transactionId:tx.id});
    });}catch(error){run("UPDATE subscriptions SET status='payment_failed' WHERE id=?",subscription.id);audit(user.id,'subscription.failed',subscription.id,{error:error.code||'EXECUTION_FAILED'});notify(user.id,'订阅代扣失败',`${subscription.merchant}：${error.message}。代扣已暂停，请联系客服处理。`);}
   }else if(Date.parse(due)-Date.parse(at)<3*86400000&&subscription.reminded_at!==due){notify(user.id,'订阅续费提醒',`${subscription.merchant}将于${due.slice(0,10)}扣费¥${(subscription.amount/100).toFixed(2)}，可在智能助手中取消。`);run('UPDATE subscriptions SET reminded_at=? WHERE id=?',due,subscription.id);}
  }
 }
 return {runDue};
}
