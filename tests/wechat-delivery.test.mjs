import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatFixture,llm,until } from './wechat-helpers.mjs';
import { createWeChatProtocol } from '../server/channels/wechat-protocol.mjs';

test('微信明确限流复用client_id和正文重试；取消后的待发操作不再提示确认',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();
  f.state.sendOverride=()=>Response.json({ret:429},{status:429,headers:{'retry-after':'1'}});
  await f.receive('你好','retry');await f.channels.wechat.drain();
  const row=f.bank.get('SELECT * FROM wechat_deliveries');assert.equal(row.status,'retry_wait');
  f.state.sendOverride=null;f.bank.run('UPDATE wechat_deliveries SET next_at=0 WHERE id=?',row.id);await f.channels.wechat.delivery.drain();
  assert.deepEqual(f.state.sent[0],f.state.sent[1]);assert.equal(f.bank.get('SELECT status FROM wechat_deliveries').status,'api_accepted');assert.equal(f.requests.length,1);
  await f.channels.wechat.delivery.stop();f.queue.push(llm([['propose_transfer',{recipient:f.recipient,amount:'10'}]]),llm());
  await f.receive('转10元','cancel-before-send');await f.channels.wechat.drain();
  const action=f.bank.get('SELECT * FROM agent_actions');f.services.cancel(f.user,action.id);
  f.channels.wechat.delivery.start();await f.channels.wechat.delivery.drain();
  const final=f.bank.get("SELECT d.client_id FROM wechat_deliveries d JOIN wechat_inbox i ON i.id=d.request_id WHERE i.upstream_message_id='cancel-before-send' AND d.kind='final'");
  const text=f.state.sent.find(s=>s.msg.client_id===final.client_id).msg.item_list[0].text_item.text;
  assert.match(text,/已取消/);assert.doesNotMatch(text,/待确认/);
});

test('发送租约过期后旧响应不能确认送达；缺少本轮context不借用其他轮次',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();f.state.sendOverride=async()=>{await wait;return Response.json({ret:0});};
  await f.receive('你好','late-send');const work=f.channels.wechat.drain();await until(()=>f.state.sent.length===1);
  f.bank.run("UPDATE wechat_deliveries SET lease_until=0 WHERE status='sending'");release();await work;
  assert.equal(f.bank.get('SELECT status FROM wechat_deliveries').status,'unknown');assert.equal(f.bank.get('SELECT api_accepted_at FROM wechat_deliveries').api_accepted_at,null);
  await f.receive('另一个请求','no-context',{context_token:null});await f.channels.wechat.drain();assert.equal(f.state.sent.length,1);
  f.bank.run("UPDATE wechat_deliveries SET expires_at=0 WHERE status='pending'");f.channels.wechat.delivery.maintain();assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE status='expired'").n,1);
});

test('微信协议区分显式成功、旧响应、响应未知与失效，不透传上游秘密',async()=>{
  let response;const p=createWeChatProtocol({fetch:async()=>response});
  const request=()=>p.request('https://ilinkai.weixin.qq.com','/ilink/bot/sendmessage',{token:'secret',body:{},send:true});
  response=Response.json({ret:0});assert.equal((await request()).responseQuality,'explicit_code');
  response=Response.json({});assert.equal((await request()).responseQuality,'legacy_missing_code');
  response=new Response('{"ret":0,"message_id":9223372036854775807,"msgs":[{"message_id":9223372036854775806}]}');
  const preserved=(await request()).data;assert.equal(preserved.message_id,'9223372036854775807');assert.equal(preserved.msgs[0].message_id,'9223372036854775806');
  for(const [res,code,state] of [[new Response('private upstream secret',{status:502}),'WECHAT_RESPONSE_UNKNOWN','unknown'],[Response.json({ret:-14}),'WECHAT_REAUTH_REQUIRED','failed'],[Response.json({ret:500},{status:500}),'WECHAT_ERROR','unknown']]){
    response=res;await assert.rejects(request(),e=>e.code===code&&e.deliveryState===state&&!e.message.includes('private'));
  }
});

test('受控上游20轮首次反馈与最终发送p95均在1秒内，不代表手机送达',async t=>{
  const f=await wechatFixture(t);await f.bind();const first=[],final=[];
  for(let i=0;i<20;i++){
    await f.receive('测试'+i,'perf-'+i);await f.channels.wechat.drain();
    const row=f.bank.get('SELECT * FROM wechat_inbox WHERE upstream_message_id=?','perf-'+i);
    const deliveries=f.bank.all("SELECT * FROM wechat_deliveries WHERE request_id=? AND started_at IS NOT NULL ORDER BY started_at",row.id);
    first.push(f.state.typing.find(x=>x.status===1&&x.at>=row.received_at).at-row.received_at);const last=deliveries.find(d=>d.kind==='final');assert.equal(last.status,'api_accepted');final.push(last.started_at-row.finished_at);
  }
  const p95=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  t.diagnostic(`controlled transport n=20: first p95=${p95(first)}ms; final p95=${p95(final)}ms`);assert.ok(p95(first)<=1000);assert.ok(p95(final)<=1000);
});

test('启动后空闲不设唤醒定时器；限流重试按到期时间自动发送，发完只留一天后的清理',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();
  // A real getupdates is held open by WeChat until a message arrives.
  f.state.updatesOverride=init=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  const w=f.channels.wechat;w.start();t.after(()=>w.stop());
  await new Promise(r=>setTimeout(r,30));assert.equal(w.nextWake(),null);
  let limited=true;f.state.sendOverride=()=>{if(limited){limited=false;return new Response(JSON.stringify({ret:0}),{status:429,headers:{'Content-Type':'application/json','Retry-After':'1'}});}return Response.json({ret:0,message_id:'ok'});};
  f.queue.push(llm([],'余额充足'));w.inbox.ingest(f.binding(),{msgs:[f.message('查余额','scheduled')],get_updates_buf:'next'});w.inbox.kick();
  await until(()=>f.bank.get("SELECT 1 FROM wechat_deliveries WHERE kind='final' AND status='retry_wait'"));
  await until(()=>w.nextWake()!==null);assert.ok(w.nextWake()>Date.now()+500);
  await until(async()=>{await new Promise(r=>setTimeout(r,20));return f.bank.get("SELECT 1 FROM wechat_deliveries WHERE kind='final' AND status='api_accepted'");});
  // Only the day-later purge of the request text remains scheduled.
  await until(()=>w.nextWake()>Date.now()+23*3600000);assert.equal(f.state.sent.length,2);
});
