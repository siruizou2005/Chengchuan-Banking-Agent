import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, llm } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { now } from '../server/db.mjs';
import { classify, decide, dailyTotal, businessDate } from '../server/agent/policy.mjs';
import { paramsDigest } from '../server/authorization.mjs';
import { toolDefinitions, executeTool } from '../server/agent/tools.mjs';

function clock(t,at='2026-09-20T02:00:00.000Z') {t.mock.timers.enable({apis:['Date'],now:Date.parse(at)});}
const at = seconds => new Date(Date.now()+seconds*1000).toISOString();
async function approve(f,a,token) {return (await f.call(`/agent/actions/${a.id}/confirm`,{pin:'123456',...(token?{verificationToken:token}:{})})).data;}
async function transfer(f,amount,extra={}) {return (await f.propose('propose_transfer',{recipient:f.recipient,amount,...extra})).data;}
function funds(f,balance,held,completed) {
  assert.equal(f.balance().balance,balance);assert.equal(f.balance().held,held);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND status='completed'",f.user.id).n,completed);
  assert.equal(f.bank.get('SELECT SUM(amount) AS n FROM ledger').n,0);
  assert.deepEqual(f.bank.all('SELECT id FROM accounts WHERE held<0 OR (user_id IS NOT NULL AND balance<held)'),[]);
}
function audited(f,kind,resource) {assert.ok(f.bank.get('SELECT id FROM audit WHERE action=? AND resource_id=?',kind,resource),kind);}

test('显式策略登记、低风险副作用范围、拒绝结果和稳定嵌套摘要',async t=>{
 const f=await fixture(t);
 for(const definition of toolDefinitions){const name=definition.function.name;assert.notEqual(name,'confirm');}
 assert.throws(()=>classify('unregistered_tool'),/未知/);
 assert.equal(classify('remember'),'green');assert.equal(classify('spending_stats'),'green');assert.equal(classify('list_subscriptions'),'yellow');
 assert.equal(classify('propose_split',{total:'50000',people:['someone']}),'yellow');
 const d=decide(f.bank,f.user,'get_overview',{}, {denial:{code:'NOT_OWNER',message:'无资源权限'}});
 assert.equal(d.outcome,'deny');assert.equal(d.reasons[0].code,'NOT_OWNER');assert.equal(d.policyVersion,'permissions-v2');
 assert.equal(paramsDigest({b:{z:1,a:2},a:3,pin:'123456'}),paramsDigest({a:3,b:{a:2,z:1},pin:'654321'}));
 const own=await executeTool(f.services,f.user,'get_overview',{accountId:f.services.accountFor({id:f.bob.user.id}).id});
 assert.ok(own.data.every(a=>a.user_id===f.user.id));
 assert.throws(()=>f.services.accountFor(f.user,f.services.accountFor({id:f.bob.user.id}).id),/不存在/);
 const initial=f.balance();await executeTool(f.services,f.user,'set_reminder',{at:at(60),text:'提醒',amount:'900',tool:'propose_transfer'});
 funds(f,initial.balance,0,0);
});

test('1000元边界、并发拆单及有效待确认提议计入一次',async t=>{
 const f=await fixture(t),b=f.balance().balance;
 const boundary=await transfer(f,'1000');assert.equal(boundary.level,'yellow');assert.equal(boundary.decision.amounts.total,100000);await f.call(`/agent/actions/${boundary.id}/cancel`,{});
 const over=await transfer(f,'1000.01');assert.equal(over.level,'red');await f.call(`/agent/actions/${over.id}/cancel`,{});
 const actions=await Promise.all(['600','500'].map(n=>transfer(f,n)));
 assert.deepEqual(actions.map(a=>a.level),['yellow','red']);
 const results=await Promise.all(actions.map(a=>approve(f,a)));
 assert.ok(results.every(r=>r.error?.code==='VERIFICATION_REQUIRED'));
 assert.ok(results.every(r=>r.error.decision.level==='red'&&r.error.decision.outcome==='require_verification'));
 funds(f,b,0,0);
 const token=await f.verify(actions[0].id);assert.equal((await approve(f,actions[0],token)).status,'completed');
 assert.equal(dailyTotal(f.bank,f.user.id),110000);
 funds(f,b-60000,0,1);audited(f,'agent.action.completed',actions[0].id);
});

test('完成600元后500元升级，普通API和内部资金提交不能绕过授权',async t=>{
 const f=await fixture(t),b=f.balance().balance;
 const first=await transfer(f,'600');assert.equal((await approve(f,first)).status,'completed');
 const tx=(await f.call('/transactions',{type:'transfer',amount:'500',recipientName:'陈屿',recipientAccount:'6218808888000088096',bank:'澄川银行'},'POST')).data;
 // The endpoint requires its normal idempotency header.
 assert.equal(tx.error.code,'VALIDATION_ERROR');
 const created=await f.req('/transactions',{type:'transfer',amount:'500',recipientName:'陈屿',recipientAccount:'6218808888000088096',bank:'澄川银行'},f.alice.token,'POST',{'Idempotency-Key':randomUUID()});
 const row=f.bank.get('SELECT * FROM transactions WHERE id=?',created.data.id);
 assert.throws(()=>f.services.settle(f.user,row),/授权/);
 assert.throws(()=>f.services.executeOne(f.user,'propose_set_daily_limit',{amount:'900'},'bypass'),/可信/);
 assert.equal((await f.call(`/transactions/${row.id}/confirm`,{pin:'123456',skipConfirmation:true,level:'green'})).data.error.code,'VERIFICATION_REQUIRED');
 funds(f,b-60000,50000,1);
 const intent=(await f.call('/verify/intent',{path:`/transactions/${row.id}/confirm`,body:{pin:'123456'}})).data;
 const token=await f.verify(intent.actionId);
 assert.equal((await f.call(`/transactions/${row.id}/confirm`,{pin:'123456',verificationActionId:intent.actionId,verificationToken:token})).data.status,'completed');
 funds(f,b-110000,0,2);assert.equal(dailyTotal(f.bank,f.user.id),110000);audited(f,'authorization.executed',f.bank.get('SELECT id FROM operation_authorizations WHERE action_id=?',intent.actionId).id);
});

test('订阅查询确认前无专用明细、事件及模型上下文；确认后是查询结果',async t=>{
 const f=await fixture(t,{responses:[llm([['list_subscriptions',{}]]),llm()]});
 const r=await f.chat('查询订阅明细');const a=r.data.events[0].data;
 assert.equal(a.tool,'list_subscriptions');assert.equal(a.level,'yellow');assert.equal(a.result,null);assert.match(a.args.scope,/本人订阅/);
 const toolMessage=f.requests[1].messages.find(m=>m.role==='tool');const data=JSON.parse(toolMessage.content).data;assert.equal(data.result,null);assert.equal(data.subscriptions,undefined);assert.equal(data.detected,undefined);
 assert.ok(!r.data.events.some(e=>e.type==='subscriptions'));
 const confirmed=await approve(f,a);assert.equal(confirmed.result.query,true);assert.ok(confirmed.result.subscriptions.length>=4);
 assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM transactions').n,0);
 assert.equal((await f.req(`/agent/actions/${a.id}/confirm`,{pin:'123456'},f.bob.token)).status,404);
});

test('AA请求不占发起人累计，实际付款计入付款人',async t=>{
 const f=await fixture(t),b=f.balance().balance,bob=f.bank.get("SELECT balance FROM accounts WHERE user_id=?",f.bob.user.id).balance;
 const split=(await f.propose('propose_split',{total:'1500',people:[f.recipient]})).data;
 assert.equal(split.level,'yellow');const result=await approve(f,split);assert.equal(result.status,'completed');assert.equal(dailyTotal(f.bank,f.user.id),0);funds(f,b,0,0);
 const request=(await f.req(`/agent/splits/${split.id}/0`,undefined,f.bob.token)).data;
 const payment=(await f.req('/agent/actions',{tool:'propose_transfer',args:{recipient:request.recipient,amount:request.amount}},f.bob.token)).data;
 assert.equal(payment.level,'red');const token=await f.verify(payment.id,f.bob.token);
 assert.equal((await f.req(`/agent/actions/${payment.id}/confirm`,{pin:'123456',verificationToken:token},f.bob.token)).data.status,'completed');
 assert.equal(dailyTotal(f.bank,f.bob.user.id),150000);assert.equal(dailyTotal(f.bank,f.user.id),0);
 assert.equal(f.bank.get('SELECT balance FROM accounts WHERE user_id=?',f.bob.user.id).balance,bob-150000);funds(f,b+150000,0,0);audited(f,'split.created',split.id);
});

test('令牌跨用户/动作/参数版本拒绝，过期令牌不消费，重复确认无副作用',async t=>{
 const f=await fixture(t),b=f.balance().balance,a=await transfer(f,'1100'),other=await transfer(f,'1200'),token=await f.verify(a.id);
 assert.equal((await approve(f,other,token)).error.code,'INVALID_VERIFICATION');
 assert.equal((await f.req(`/agent/actions/${a.id}/confirm`,{pin:'123456',verificationToken:token},f.bob.token)).status,404);
 f.bank.run('UPDATE agent_actions SET revision=revision+1 WHERE id=?',a.id);
 assert.equal((await approve(f,a,token)).error.code,'INVALID_VERIFICATION');
 f.bank.run('UPDATE agent_actions SET revision=revision-1 WHERE id=?',a.id);
 f.bank.run("UPDATE verifications SET token_expires_at='2000-01-01' WHERE action_id=?",a.id);
 assert.equal((await approve(f,a,token)).error.code,'INVALID_VERIFICATION');
 assert.equal(f.bank.get('SELECT used FROM verifications WHERE action_id=?',a.id).used,0);funds(f,b,0,0);
 f.bank.run('UPDATE verifications SET token_expires_at=? WHERE action_id=?',at(600),a.id);
 assert.equal((await approve(f,a,token)).status,'completed');assert.equal((await approve(f,a,token)).status,'completed');
 funds(f,b-110000,0,1);assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM authorization_executions WHERE action_id=?',a.id).n,1);
});

test('红色执行失败回滚资金和签发，令牌作废，账户冻结不被强验证绕过',async t=>{
 const f=await fixture(t),b=f.balance().balance,a=await transfer(f,'1100'),token=await f.verify(a.id);
 f.bank.run("UPDATE accounts SET status='frozen' WHERE user_id=?",f.user.id);
 const result=await approve(f,a,token);assert.equal(result.status,'failed');funds(f,b,0,0);
 assert.equal(f.bank.get('SELECT used FROM verifications WHERE action_id=?',a.id).used,1);
 assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM operation_authorizations WHERE action_id=? AND status='active'",a.id).n,0);
 audited(f,'agent.action.failed',a.id);assert.equal((await approve(f,a,token)).error.code,'INVALID_STATE');
});

test('修改已保存操作的金额或收款对象不能复用旧验证',async t=>{
 const f=await fixture(t),a=await transfer(f,'1100'),token=await f.verify(a.id),b=f.balance().balance;
 const row=f.services.owned(f.user,a.id),args=JSON.parse(row.args);args.amount='1';args._transaction.amount='1';
 f.bank.run('UPDATE agent_actions SET args=? WHERE id=?',JSON.stringify(args),a.id);
 assert.equal((await approve(f,a,token)).error.code,'AUTHORIZATION_MISMATCH');funds(f,b,0,0);
 assert.equal(f.bank.get('SELECT used FROM verifications WHERE action_id=?',a.id).used,0);
});

test('定时黄色授权到期升级：暂停、一次通知、补充验证、幂等恢复且不重复预留',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance,a=await transfer(f,'500',{scheduleAt:at(60)});
 assert.equal((await approve(f,a)).status,'confirmed');funds(f,b,50000,0);
 const spend=await transfer(f,'600');assert.equal(spend.level,'red');assert.equal((await approve(f,spend,await f.verify(spend.id))).status,'completed');
 t.mock.timers.tick(61000);f.scheduler.runDue();f.scheduler.runDue();
 const paused=f.services.owned(f.user,a.id);assert.equal(paused.status,'awaiting_verification');assert.equal(Date.parse(paused.verification_until)-Date.now(),900000);
 funds(f,b-60000,50000,1);assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM audit WHERE action='agent.action.awaiting_verification' AND resource_id=?",a.id).n,1);
 assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM agent_security WHERE kind='action_failure'").n,0);
 const token=await f.verify(a.id);assert.equal((await approve(f,a,token)).status,'confirmed');funds(f,b-60000,50000,1);
 f.scheduler.runDue();f.scheduler.runDue();funds(f,b-110000,0,2);assert.equal(f.services.owned(f.user,a.id).status,'completed');
 assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM reservations WHERE action_id=?',a.id).n,1);
 assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM operation_authorizations WHERE action_id=?',a.id).n,2);audited(f,'agent.action.resumed',a.id);
});

test('验证等待超时结束未执行部分、释放资金并撤销授权',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance,a=await transfer(f,'500',{scheduleAt:at(60)});await approve(f,a);
 const spend=await transfer(f,'600');await approve(f,spend,await f.verify(spend.id));t.mock.timers.tick(61000);f.scheduler.runDue();
 t.mock.timers.tick(900001);f.scheduler.runDue();assert.equal(f.services.owned(f.user,a.id).status,'expired');funds(f,b-60000,0,1);
 assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM operation_authorizations WHERE action_id=? AND status='active'",a.id).n,0);
 assert.equal(f.bank.get('SELECT status FROM scheduled_tasks WHERE action_id=?',a.id).status,'expired');audited(f,'agent.action.expired',a.id);
});

test('DAG部分完成后暂停整个计划，恢复保留回单及预算，取消不反向转账',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance;
 const plan=(await f.propose('create_plan',{title:'分步支付',steps:[{id:'a',title:'首步',tool:'propose_payment',args:{billType:'merchant',merchant:'鲜花',amount:'100'},runAt:at(60)},{id:'b',title:'后步',tool:'propose_transfer',args:{recipient:f.recipient,amount:'500'},dependsOn:['a'],runAt:at(120)}]})).data;
 await approve(f,plan);t.mock.timers.tick(61000);f.scheduler.runDue();funds(f,b-10000,50000,1);
 const spend=await transfer(f,'500');await approve(f,spend,await f.verify(spend.id));t.mock.timers.tick(60000);f.scheduler.runDue();
 assert.equal(f.services.plans(f.user)[0].status,'awaiting_verification');const first=f.services.plans(f.user)[0].steps[0].result.id;
 await approve(f,plan,await f.verify(plan.id));f.scheduler.runDue();f.scheduler.runDue();funds(f,b-110000,0,3);
 assert.equal(f.services.plans(f.user)[0].steps[0].result.id,first);assert.equal(f.bank.get('SELECT status FROM transactions WHERE id=?',first).status,'completed');
 await f.call(`/agent/plans/${plan.plan.id}/abort`,{});assert.equal(f.services.owned(f.user,plan.id).status,'completed');funds(f,b-110000,0,3);
});

test('未来跨日DAG按各执行日分组，短期验证过期不影响持久计划授权',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance;
 const plan=(await f.propose('create_plan',{title:'两日计划',steps:[{id:'a',title:'明天',tool:'propose_transfer',args:{recipient:f.recipient,amount:'600'},runAt:at(86400)},{id:'b',title:'后天',tool:'propose_transfer',args:{recipient:f.recipient,amount:'600'},dependsOn:['a'],runAt:at(172800)}]})).data;
 assert.equal(plan.level,'yellow');assert.equal(plan.decision.dates.length,2);assert.equal(dailyTotal(f.bank,f.user.id),0);
 await approve(f,plan);funds(f,b,120000,0);t.mock.timers.tick(86401000);f.scheduler.runDue();funds(f,b-60000,60000,1);
 t.mock.timers.tick(86400000);f.scheduler.runDue();funds(f,b-120000,0,2);assert.equal(f.services.owned(f.user,plan.id).status,'completed');
 assert.equal(dailyTotal(f.bank,f.user.id),60000);
 f.bank.run('UPDATE sessions SET expires_at=? WHERE user_id=?',at(7*86400),f.user.id);
 const red=await transfer(f,'1100',{scheduleAt:at(86400)});await approve(f,red,await f.verify(red.id));
 t.mock.timers.tick(86401000);f.scheduler.runDue();funds(f,b-230000,0,3);assert.equal(f.services.owned(f.user,red.id).status,'completed');
});

test('北京零点跨日创建后完成按实际日统计，当前交易和步骤不重复计入',async t=>{
 clock(t,'2026-09-20T15:59:50.000Z');const f=await fixture(t),b=f.balance().balance;
 assert.equal(businessDate(now()),'2026-09-20');const a=await transfer(f,'600');await approve(f,a);
 const tx=f.services.createTransaction(f.user,{type:'transfer',amount:'500',recipientName:'陈屿',recipientAccount:'6218808888000088096',bank:'澄川银行'},'cross-midnight');
 t.mock.timers.tick(20000);assert.equal(businessDate(now()),'2026-09-21');
 assert.equal((await f.call(`/transactions/${tx.id}/confirm`,{pin:'123456'})).data.status,'completed');
 funds(f,b-110000,0,2);assert.equal(dailyTotal(f.bank,f.user.id),50000);assert.equal(dailyTotal(f.bank,f.user.id,'','2026-09-20'),60000);
 const next=await transfer(f,'500');assert.equal(next.level,'yellow');assert.equal(next.decision.amounts.total,100000);
 audited(f,'transaction.completed',tx.id);
});

test('延迟到下一业务日执行重新累计，不沿用计划日的低风险额度',async t=>{
 clock(t,'2026-09-20T14:00:00.000Z');const f=await fixture(t),b=f.balance().balance,a=await transfer(f,'500',{scheduleAt:at(60)});await approve(f,a);
 t.mock.timers.tick(3*3600000);const spend=await transfer(f,'600');assert.equal(spend.level,'yellow');await approve(f,spend);
 f.scheduler.runDue();assert.equal(f.services.owned(f.user,a.id).status,'awaiting_verification');funds(f,b-60000,50000,1);
 assert.equal(JSON.parse(f.services.owned(f.user,a.id).decision).amounts.total,110000);
});

test('修改计划步骤或任务参数使旧授权失效，失败释放所有未用预留',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance;
 const a=(await f.propose('create_plan',{title:'不可修改',steps:[{id:'a',title:'付款',tool:'propose_transfer',args:{recipient:f.recipient,amount:'100'},runAt:at(60)}]})).data;await approve(f,a);
 const steps=JSON.parse(f.bank.get('SELECT steps FROM agent_plans WHERE id=?',a.plan.id).steps);steps[0].args.amount='200';f.bank.run('UPDATE agent_plans SET steps=? WHERE id=?',JSON.stringify(steps),a.plan.id);
 t.mock.timers.tick(61000);f.scheduler.runDue();assert.equal(f.services.owned(f.user,a.id).status,'failed');funds(f,b,0,0);audited(f,'scheduled.failed',steps[0].actionId);
});

test('IM确认只给出App链接，多笔须指定编号，跨绑定拒绝，App确认后解绑撤销计划并释放预留',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance,{code}=f.channels.router.createCode(f.user,'123456'),binding=f.channels.router.bind('feishu','alice',code);
 const context={channel:'feishu',sessionId:binding.id};
 const a=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'200'},context),other=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'100',scheduleAt:at(60)},context);
 let i=0;const receive=text=>f.channels.router.receive({channel:'feishu',externalId:'alice',messageId:'m'+i++,text});
 assert.match(await receive('确认'),/多笔/);funds(f,b,0,0);
 assert.match(await receive('确认 '+a.id),/App内完成支付密码验证/);funds(f,b,0,0);
 const confirmInApp=async id=>(await f.call(`/agent/actions/${id}/confirm`,{pin:'123456'})).data.status;
 assert.equal(await confirmInApp(a.id),'completed');assert.equal(await confirmInApp(a.id),'completed');funds(f,b-20000,0,1);assert.match(await receive('确认 '+a.id),/操作完成/);
 const app=await transfer(f,'10');assert.match(await receive('确认 '+app.id),/没有该/);
 assert.equal(await confirmInApp(other.id),'confirmed');assert.match(await receive('确认 '+other.id),/等待执行/);funds(f,b-20000,10000,1);
 await f.call(`/channels/${binding.id}/unbind`,{pin:'123456'});funds(f,b-20000,0,1);assert.equal(f.services.owned(f.user,other.id).status,'cancelled');
 t.mock.timers.tick(61000);f.scheduler.runDue();funds(f,b-20000,0,1);audited(f,'authorization.revoked',f.bank.get('SELECT id FROM operation_authorizations WHERE action_id=?',other.id).id);
});

test('持续订阅固定商户/金额授权，篡改后拒绝代扣且无余额变更',async t=>{
 const f=await fixture(t),b=f.balance().balance,sub=f.bank.get('SELECT * FROM subscriptions WHERE user_id=?',f.user.id);
 f.bank.run('UPDATE subscriptions SET next_at=?,amount=amount+1 WHERE id=?',now(),sub.id);f.scheduler.runDue();funds(f,b,0,0);
 assert.equal(f.bank.get('SELECT status FROM subscriptions WHERE id=?',sub.id).status,'payment_failed');audited(f,'subscription.failed',sub.id);
 const changed=f.bank.get("SELECT * FROM subscriptions WHERE user_id=? AND status='active'",f.user.id);f.bank.run('UPDATE subscriptions SET merchant=?,next_at=? WHERE id=?',changed.merchant+'变更',now(),changed.id);f.scheduler.runDue();funds(f,b,0,0);assert.equal(f.bank.get('SELECT status FROM subscriptions WHERE id=?',changed.id).status,'payment_failed');
 const valid=f.bank.get("SELECT * FROM subscriptions WHERE user_id=? AND status='active'",f.user.id);f.bank.run('UPDATE subscriptions SET next_at=? WHERE id=?',now(),valid.id);
 const due=f.bank.get('SELECT * FROM subscriptions WHERE id=?',valid.id);assert.throws(()=>f.services.authorization.standing(f.user,due,{type:'payment',billType:'merchant',merchant:'任意付款',amount:'999'},now()),/授权范围/);
 f.scheduler.runDue();f.scheduler.runDue();funds(f,b-valid.amount,0,1);
 audited(f,'subscription.charged',valid.id);
});

test('旧库非破坏迁移重复运行：历史保留，未证明授权任务暂停，未知订阅暂停',async t=>{
 clock(t);const dir=join('test-results','migration-'+randomUUID());mkdirSync(dir,{recursive:true});const path=join(dir,'bank.sqlite');
 let app=createApp(path),user=app.bank.get("SELECT * FROM users WHERE phone='13800138000'"),recipient=app.services.resolveRecipients(user,{name:'陈屿'})[0].recipient;
 const completed=app.services.propose(user,'propose_transfer',{recipient,amount:'600'});app.services.confirm(user,completed.id,{pin:'123456'});
 const a=app.services.propose(user,'propose_transfer',{recipient,amount:'100',scheduleAt:at(60)});app.services.confirm(user,a.id,{pin:'123456'});
 const balance=app.bank.get('SELECT balance,held FROM accounts WHERE user_id=?',user.id);
 app.bank.run('DELETE FROM operation_authorizations WHERE action_id=?',a.id);app.bank.run("DELETE FROM schema_migrations WHERE version='permissions-v2'");
 app.bank.run("INSERT INTO subscriptions(id,user_id,merchant,amount,next_at) VALUES('legacy-sub',?,'不明商户',100,?)",user.id,now());
 app.bank.db.exec('DROP TABLE authorization_executions; DROP TABLE operation_authorizations; DROP TABLE subscription_mandates; DROP TABLE schema_migrations');
 for(const column of ['revision','params_digest','decision','run_id','authorization_until','verification_until','pause_reason'])app.bank.db.exec(`ALTER TABLE agent_actions DROP COLUMN ${column}`);
 for(const column of ['params_digest','revision','face_reason'])app.bank.db.exec(`ALTER TABLE verifications DROP COLUMN ${column}`);
 app.bank.db.exec('ALTER TABLE transactions DROP COLUMN completed_at');app.bank.db.close();
 for(let i=0;i<2;i++) {
  app=createApp(path);assert.equal(app.bank.get('SELECT status FROM agent_actions WHERE id=?',a.id).status,'awaiting_verification');
  assert.equal(app.bank.get("SELECT status FROM subscriptions WHERE id='legacy-sub'").status,'awaiting_authorization');
  app.scheduler.runDue(at(61));assert.deepEqual(app.bank.get('SELECT balance,held FROM accounts WHERE user_id=?',user.id),balance);
  assert.equal(app.bank.get('SELECT COUNT(*) AS n FROM operation_authorizations WHERE action_id=?',a.id).n,0);
  assert.equal(app.bank.get('SELECT COUNT(*) AS n FROM reservations WHERE action_id=?',a.id).n,1);
  assert.equal(app.bank.get('SELECT status FROM agent_actions WHERE id=?',completed.id).status,'completed');
  assert.equal(app.bank.get("SELECT COUNT(*) AS n FROM audit WHERE action='transaction.legacy_completion_proxy'").n,1);
  assert.equal(app.bank.get("SELECT COUNT(*) AS n FROM audit WHERE action='authorization.migration_paused' AND resource_id=?",a.id).n,1);app.bank.db.close();
 }
});

async function strong(instance,user,actionId) {
 const v=await instance.services.verification.start(user,actionId);
 instance.services.verification.face(user,{id:v.id,skipped:true,reason:'unavailable'});
 const body=instance.bank.get("SELECT body FROM notifications WHERE user_id=? AND title='模拟短信验证码' ORDER BY rowid DESC LIMIT 1",user.id).body;
 return instance.services.verification.complete(user,{id:v.id,code:body.match(/验证码 (\d{6})/)[1]}).verificationToken;
}

test('补充验证后重启恢复持久授权，任务和预留只消费一次',async t=>{
 clock(t);const dir=join('test-results','resume-'+randomUUID());mkdirSync(dir,{recursive:true});const path=join(dir,'bank.sqlite');
 let f=createApp(path),user=f.bank.get("SELECT * FROM users WHERE phone='13800138000'"),recipient=f.services.resolveRecipients(user,{name:'陈屿'})[0].recipient;
 const b=f.services.accountFor(user).balance,a=f.services.propose(user,'propose_transfer',{recipient,amount:'500',scheduleAt:at(60)});f.services.confirm(user,a.id,{pin:'123456'});
 const spend=f.services.propose(user,'propose_transfer',{recipient,amount:'600'});f.services.confirm(user,spend.id,{pin:'123456',verificationToken:await strong(f,user,spend.id)});
 t.mock.timers.tick(61000);f.scheduler.runDue();assert.equal(f.services.owned(user,a.id).status,'awaiting_verification');
 f.services.confirm(user,a.id,{pin:'123456',verificationToken:await strong(f,user,a.id)});f.bank.db.close();
 for(let i=0;i<2;i++){
  f=createApp(path);f.scheduler.runDue();assert.equal(f.services.owned(user,a.id).status,'completed');
  assert.equal(f.services.accountFor(user).balance,b-110000);assert.equal(f.services.accountFor(user).held,0);
  assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM authorization_executions WHERE action_id=?',a.id).n,1);
  assert.equal(f.bank.get('SELECT COUNT(*) AS n FROM reservations WHERE action_id=?',a.id).n,1);f.bank.db.close();
 }
});

test('渠道解绑暂停中的整个计划，验证期限受原授权窗口约束',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance,{code}=f.channels.router.createCode(f.user,'123456'),binding=f.channels.router.bind('feishu','pause-binding',code);
 const plan=f.services.propose(f.user,'create_plan',{title:'待解绑',steps:[{id:'a',title:'支付',tool:'propose_transfer',args:{recipient:f.recipient,amount:'500'},runAt:at(60)}]},{channel:'feishu',sessionId:binding.id});
 f.services.confirm(f.user,plan.id,{pin:'123456'});
 const spend=await transfer(f,'600');await approve(f,spend,await f.verify(spend.id));t.mock.timers.tick(61000);
 const until=at(120);f.bank.run('UPDATE agent_actions SET authorization_until=? WHERE id=?',until,plan.id);f.bank.run('UPDATE operation_authorizations SET expires_at=? WHERE action_id=?',until,plan.id);
 f.scheduler.runDue();assert.equal(f.services.owned(f.user,plan.id).verification_until,until);funds(f,b-60000,50000,1);
 await f.call(`/channels/${binding.id}/unbind`,{pin:'123456'});funds(f,b-60000,0,1);
 assert.equal(f.services.plans(f.user)[0].status,'cancelled');assert.equal(f.bank.get('SELECT status FROM scheduled_tasks WHERE action_id=?',plan.id).status,'cancelled');
 t.mock.timers.tick(60000);f.scheduler.runDue();funds(f,b-60000,0,1);
});

test('单笔定时任务修改精确金额被拒绝，授权撤销且预留释放',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance,a=await transfer(f,'100',{scheduleAt:at(60)});await approve(f,a);
 const task=f.bank.get('SELECT * FROM scheduled_tasks WHERE action_id=?',a.id),args=JSON.parse(task.args);args.amount='50';args._transaction.amount='50';f.bank.run('UPDATE scheduled_tasks SET args=? WHERE id=?',JSON.stringify(args),task.id);
 t.mock.timers.tick(61000);f.scheduler.runDue();funds(f,b,0,0);assert.equal(f.services.owned(f.user,a.id).status,'failed');
 assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM operation_authorizations WHERE action_id=? AND status='active'",a.id).n,0);audited(f,'scheduled.failed',task.id);
});

test('DAG中途业务失败保留首步回单，后续停止并释放资金',async t=>{
 clock(t);const f=await fixture(t),b=f.balance().balance;
 const plan=(await f.propose('create_plan',{title:'失败计划',steps:[{id:'a',title:'首笔',tool:'propose_payment',args:{billType:'merchant',merchant:'鲜花',amount:'100'},runAt:at(60)},{id:'b',title:'次笔',tool:'propose_transfer',args:{recipient:f.recipient,amount:'200'},dependsOn:['a'],runAt:at(120)},{id:'c',title:'后续',tool:'propose_payment',args:{billType:'merchant',merchant:'蛋糕',amount:'100'},dependsOn:['b'],runAt:at(180)}]})).data;
 await approve(f,plan);t.mock.timers.tick(61000);f.scheduler.runDue();funds(f,b-10000,30000,1);
 const receipt=f.services.plans(f.user)[0].steps[0].result.id;f.bank.run("UPDATE accounts SET status='frozen' WHERE user_id=?",f.bob.user.id);
 t.mock.timers.tick(61000);f.scheduler.runDue();f.scheduler.runDue(at(200));funds(f,b-10000,0,1);
 assert.equal(f.services.owned(f.user,plan.id).status,'failed');assert.equal(f.bank.get('SELECT status FROM transactions WHERE id=?',receipt).status,'completed');
 assert.deepEqual(f.services.plans(f.user)[0].steps.map(s=>s.status),['completed','failed','cancelled']);
});

test('每日业务限额与北京业务日一致，未来计划不占今天，验证不绕过限额',async t=>{
 clock(t,'2026-09-20T15:59:40.000Z');const f=await fixture(t),b=f.balance().balance;
 f.bank.run('UPDATE users SET daily_limit=100000 WHERE id=?',f.user.id);
 const a=await transfer(f,'1000');await approve(f,a);funds(f,b-100000,0,1);
 assert.equal((await f.propose('propose_transfer',{recipient:f.recipient,amount:'1'})).data.error.code,'DAILY_LIMIT');
 const tomorrow=(await f.propose('create_plan',{title:'明天额度',steps:[{id:'a',title:'明日转账',tool:'propose_transfer',args:{recipient:f.recipient,amount:'1000'},runAt:at(60)}]})).data;
 assert.equal(tomorrow.level,'yellow');assert.equal((await approve(f,tomorrow)).status,'confirmed');funds(f,b-100000,100000,1);
 t.mock.timers.tick(61000);f.scheduler.runDue();funds(f,b-200000,0,2);assert.equal(dailyTotal(f.bank,f.user.id),100000);
 audited(f,'agent.action.completed',tomorrow.id);
});
