import test from 'node:test';
import assert from 'node:assert/strict';
import { backup } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { executeTool } from '../server/agent/tools.mjs';
import { latestSlot } from '../server/channels/reports.mjs';
import { wechatFixture,llm,until } from './wechat-helpers.mjs';

test('SQLite重启恢复：已生成结果只重投、执行中断不重跑、已提交效果只复用',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();await f.channels.wechat.delivery.stop();
  f.queue.push(llm([['remember',{key:'recovery',value:'safe',evidence:'safe'}]]),llm());await f.receive('记住偏好 safe','done');await f.channels.wechat.drain();
  await f.receive('处理中崩溃','crash');f.bank.run("UPDATE wechat_inbox SET status='running',lease_until=0 WHERE upstream_message_id='crash'");
  const effect=f.bank.get('SELECT * FROM agent_tool_effects');
  const dir=await mkdtemp(join(tmpdir(),'wechat-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'bank.sqlite');await backup(f.bank.db,path);
  let calls=0,sends=0;const restored=createApp(path,{chat:{config:()=>({apiKey:'test',baseUrl:'https://llm.test',model:'test'}),fetch:async()=>{calls++;return Response.json(llm());}},channels:{secret:'a'.repeat(64),wechat:{enabled:true,autoStart:false,fetch:async()=>{sends++;return Response.json({ret:0});}}}});
  try{
    await restored.channels.wechat.drain();assert.equal(calls,0);assert.equal(sends,2);assert.equal(restored.bank.get("SELECT status FROM wechat_inbox WHERE upstream_message_id='crash'").status,'interrupted');
    const result=await executeTool(restored.services,f.user,'remember',{key:'recovery',value:'safe',evidence:'safe'},{channel:'app',requestId:effect.request_id,toolCallId:effect.tool_call_id});assert.equal(result.data.candidate,true);
    assert.equal(restored.bank.get('SELECT count(*) n FROM agent_tool_effects').n,1);await restored.channels.wechat.drain();assert.equal(sends,2);
  }finally{await restored.channels.stop();restored.bank.db.close();}
});

test('模型等待期间解绑拒绝新副作用；旧代次轮询不写游标或收件',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=await wechatFixture(t,{chat:{fetch:async()=>{await wait;return Response.json(llm([['remember',{key:'old-binding',value:'forbidden'}]]));}}});const old=await f.bind();
  await f.receive('记住偏好','unbind');const work=f.channels.wechat.drain();await until(()=>f.state.typing.length>0);
  await f.call(`/channels/${old.id}/unbind`,{pin:'123456'});release();await work;
  assert.equal(f.bank.get("SELECT count(*) n FROM agent_memory WHERE key='old-binding'").n,0);const current=await f.bind();assert.ok(current.binding_generation>old.binding_generation);
  assert.throws(()=>f.channels.wechat.inbox.ingest(old,{msgs:[f.message('old','old')],get_updates_buf:'stale'}),e=>e.code==='BINDING_FENCED');assert.notEqual(f.binding().cursor,'stale');
});

test('微信关闭不再发送或处理；停止新收件仍可排空已接收任务',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();await f.receive('关闭前收到','drain');
  // Public option callbacks are immutable in a running instance; reopen the same DB through channel workers.
  const {createWeChat}=await import('../server/channels/wechat.mjs');
  const off=createWeChat(f.services,f.channels.router,{enabled:false,autoStart:false});await off.drain();await off.flush();assert.equal(f.requests.length,0);assert.equal(f.state.sent.length,0);await off.stop();
  const drainOnly=createWeChat(f.services,f.channels.router,{enabled:true,accepting:false,autoStart:false,fetch:async()=>Response.json({ret:0})});
  await assert.rejects(drainOnly.qr(f.user,'123456'),e=>e.code==='WECHAT_DISABLED');assert.deepEqual(await drainOnly.pollOnce(f.binding()),{msgs:[]});await drainOnly.drain();assert.equal(f.requests.length,1);assert.equal(f.bank.get('SELECT status FROM wechat_inbox').status,'completed');await drainOnly.stop();
});

test('微信：重扫后早于本次绑定的旧消息不处理也不更新上下文；时钟误差内和没有时间戳的消息照常处理',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();
  f.queue.push(llm([],'第一次'));await f.receive('查余额','before');await f.channels.wechat.drain();
  f.bank.run("UPDATE channel_bindings SET auth_state='reauth_required' WHERE channel='wechat'");const current=await f.bind();
  const calls=f.requests.length,hour=3600000,rows=id=>f.bank.get('SELECT count(*) n FROM wechat_inbox WHERE upstream_message_id=?',id).n;
  await f.receive('查余额','before',{create_time_ms:current.authorized_at-hour});await f.receive('转账给陈屿100元','backlog',{create_time_ms:current.authorized_at-hour});await f.channels.wechat.drain();
  assert.equal(rows('before'),1);assert.equal(rows('backlog'),0);assert.equal(f.requests.length,calls);
  assert.equal(f.binding().context_token,null);assert.equal(f.binding().cursor,String(f.state.cursor));
  assert.ok(f.bank.get("SELECT 1 FROM wechat_quarantine WHERE reason='BEFORE_AUTHORIZATION' AND binding_generation=?",current.binding_generation));
  for(const [id,extra] of [['skew',{create_time_ms:current.authorized_at-5000}],['fresh',{create_time_ms:current.authorized_at+1000}],['no-time',{}]]){
    f.queue.push(llm([],'好的'));await f.receive('查余额',id,extra);await f.channels.wechat.drain();
    assert.equal(f.bank.get('SELECT status FROM wechat_inbox WHERE upstream_message_id=?',id).status,'completed');
  }
  assert.equal(f.requests.length,calls+3);
});

test('渠道任务表清理：已结束且超过30天的行被删除，保留期内和未结束的保留，保留期内重复消息仍去重',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();const wechat=f.binding();
  const feishu=f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code),pipe=f.channels.feishuPipeline;
  const aged=Date.now()-31*86400000,agedIso=new Date(aged).toISOString(),count=(table,where='1=1',...args)=>f.bank.get(`SELECT count(*) n FROM ${table} WHERE ${where}`,...args).n;
  const request=id=>f.bank.get('SELECT id FROM wechat_inbox WHERE upstream_message_id=?',id).id;
  // Finished work: one aged request on each channel, one recent.
  f.queue.push(llm([],'旧结果'),llm([],'新结果'),llm([],'飞书旧结果'));
  await f.receive('查余额','aged');await f.channels.wechat.drain();await f.receive('查余额','recent');await f.channels.wechat.drain();
  pipe.ingest({externalId:'fs-owner',messageId:'fs-aged',text:'查余额'});await pipe.drain();
  const fsAged=f.bank.get("SELECT id FROM feishu_inbox WHERE message_id='fs-aged'").id;
  f.bank.run('UPDATE wechat_inbox SET received_at=?,finished_at=? WHERE id=?',aged,aged,request('aged'));f.bank.run('UPDATE wechat_deliveries SET created_at=? WHERE request_id=?',aged,request('aged'));
  f.bank.run('UPDATE feishu_inbox SET received_at=?,finished_at=? WHERE id=?',aged,aged,fsAged);f.bank.run("UPDATE feishu_deliveries SET status='api_accepted',created_at=? WHERE request_id=?",aged,fsAged);
  f.bank.run('UPDATE agent_execution_queue SET created_at=? WHERE request_id IN (?,?)',aged,request('aged'),fsAged);
  // Unfinished work stays however old it is.
  f.channels.wechat.inbox.ingest(f.binding(),{msgs:[f.message('查余额','aged-queued')]});f.bank.run('UPDATE wechat_inbox SET received_at=? WHERE id=?',aged,request('aged-queued'));
  f.bank.run('UPDATE agent_execution_queue SET created_at=? WHERE request_id=?',aged,request('aged-queued'));
  for(const [id,binding,status] of [['out-sent',feishu.id,'sent'],['out-pending',feishu.id,'pending'],['out-forwarded-done',wechat.id,'forwarded'],['out-forwarded-active',wechat.id,'forwarded']])f.bank.run('INSERT INTO channel_outbox(id,binding_id,body,status,next_at) VALUES(?,?,?,?,?)',id,binding,'通知',status,agedIso);
  for(const [id,status] of [['done','committed'],['open','prepared']])f.bank.run("INSERT INTO agent_tool_effects(request_id,tool_call_id,effect_type,args_digest,status,created_at) VALUES(?,'tool','remember','x',?,?)",id,status,aged);
  f.bank.run('INSERT INTO channel_codes VALUES(?,?,?,?,?,1)','old-code',f.user.id,'old-hash','feishu',agedIso);
  // A delivered report keeps its outcome after the delivery rows are gone.
  await f.call('/channels/reports/wechat',{monthly:true},'PATCH');const slot=latestSlot('monthly',new Date().toISOString());
  f.bank.run("UPDATE report_subscriptions SET next_at=? WHERE kind='monthly'",slot);f.channels.reports.runDue(new Date(Date.parse(slot)+60000).toISOString(),{budgetMs:Infinity});await f.channels.wechat.delivery.drain();
  assert.equal((await f.call('/channels/reports')).data.wechat.monthly.last.state,'sent');
  f.bank.run("UPDATE report_pushes SET created_at=? WHERE kind='monthly'",agedIso);f.bank.run("UPDATE channel_outbox SET next_at=? WHERE kind='report'",agedIso);f.bank.run("UPDATE wechat_deliveries SET created_at=? WHERE kind='report'",aged);
  const unsent=f.channels.wechat.delivery.enqueue(f.binding(),{kind:'action_result',body:'未发出'});f.bank.run("UPDATE wechat_deliveries SET created_at=?,source_outbox_id='out-forwarded-active' WHERE id=?",aged,unsent);
  f.channels.prune();
  assert.equal(count('wechat_inbox','upstream_message_id=?','aged'),0);assert.equal(count('feishu_inbox','id=?',fsAged),0);assert.equal(count('feishu_deliveries','request_id=?',fsAged),0);
  assert.equal(count('wechat_inbox','upstream_message_id=?','recent'),1);assert.equal(count('wechat_inbox','upstream_message_id=?','aged-queued'),1);
  assert.equal(count('wechat_deliveries','id=?',unsent),1);assert.equal(count('wechat_deliveries',"kind='report'"),0);
  assert.deepEqual(f.bank.all("SELECT id FROM channel_outbox WHERE id LIKE 'out-%' ORDER BY id").map(r=>r.id),['out-forwarded-active','out-pending']);assert.equal(count('channel_outbox',"kind='report'"),0);
  assert.equal(count('agent_execution_queue','request_id=?',fsAged),0);assert.equal(count('agent_execution_queue','request_id=?',request('aged-queued')),1);
  assert.equal(count('puma_queue_epochs','request_id=?',fsAged),0);assert.equal(count('puma_queue_epochs','request_id=?',request('aged-queued')),1);
  assert.deepEqual(f.bank.all('SELECT request_id FROM agent_tool_effects').map(r=>r.request_id),['open']);assert.equal(count('channel_codes',"id='old-code'"),0);
  assert.equal((await f.call('/channels/reports')).data.wechat.monthly.last.state,'sent');
  const calls=f.requests.length;await f.receive('查余额','recent');assert.equal(count('wechat_inbox','upstream_message_id=?','recent'),1);assert.equal(f.requests.length,calls);
});
