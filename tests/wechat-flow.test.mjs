import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatFixture,llm,until } from './wechat-helpers.mjs';

test('微信慢模型等待6秒提示一次，输入状态回复后取消；重复去重、并行收件、本轮context和最终App结果',async t=>{
  let resolveModel;const model=new Promise(r=>resolveModel=r);
  const f=await wechatFixture(t,{wechat:{typingKeepaliveMs:20},chat:{fetch:async()=>{await model;return Response.json(llm([],'余额123.45元，账号6218808888000012068'));}}});await f.bind();
  await f.call('/channels/preferences/wechat',{maskAmounts:true},'PATCH');
  await f.receive('查余额','one');const work=f.channels.wechat.drain();
  await until(()=>f.state.typing.filter(x=>x.status===1).length>=2);assert.equal(f.state.sent.length,0);
  assert.deepEqual(f.state.configs.map(c=>[c.ilink_user_id,c.context_token]),[['wx-owner','ctx-one']]);
  assert.ok(f.state.typing.every(x=>x.ilink_user_id==='wx-owner'&&x.typing_ticket==='typing-ticket'));
  const first=f.bank.get("SELECT * FROM wechat_inbox WHERE upstream_message_id='one'");
  await f.receive('查余额','one');await f.receive('第二条','two');assert.equal(f.bank.get('SELECT count(*) n FROM wechat_inbox').n,2);
  // Simulate elapsed processing without tying the test to wall-clock model latency.
  f.bank.run('UPDATE wechat_inbox SET received_at=? WHERE id=?',Date.now()-6000,first.id);
  f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();
  assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE kind IN ('ack','progress')").n,1);
  assert.equal(f.state.sent[0].msg.item_list[0].text_item.text,'正在处理');
  assert.equal(f.state.sent[0].msg.context_token,'ctx-one');
  f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();assert.equal(f.state.sent.length,1);
  resolveModel();await work;await f.channels.wechat.drain();
  assert.equal(f.bank.get("SELECT count(*) n FROM wechat_inbox WHERE status='completed'").n,2);
  await until(()=>f.state.typing.at(-1).status===2);assert.equal(f.state.configs.length,1);
  assert.equal(f.state.sent.length,3);assert.ok(f.state.sent.every(s=>!/已收到|还在处理/.test(s.msg.item_list[0].text_item.text)));
  assert.equal(new Set(f.state.sent.map(s=>s.msg.client_id)).size,f.state.sent.length);
  const firstFinal=f.bank.get("SELECT * FROM wechat_deliveries WHERE request_id=? AND kind='final'",first.id);
  const sent=f.state.sent.find(s=>s.msg.client_id===firstFinal.client_id);assert.equal(sent.msg.context_token,'ctx-one');assert.doesNotMatch(sent.msg.item_list[0].text_item.text,/123\.45|621880/);
  assert.equal(firstFinal.status,'api_accepted');assert.equal(firstFinal.platform_delivered_at,null);
  const view=await f.call(`/channels/wechat/requests/${first.id}`);assert.equal(view.status,200);assert.match(view.data.result.text,/123\.45/);
  assert.equal((await f.req(`/channels/wechat/requests/${first.id}`,undefined,f.bob.token)).status,404);
  const stops=f.state.typing.length;await new Promise(r=>setTimeout(r,60));assert.equal(f.state.typing.length,stops);
});

test('取不到输入提示凭据也不立即发文字：5999毫秒不提示，6000毫秒只提示一次',async t=>{
  let resolveModel;const model=new Promise(r=>resolveModel=r);
  const f=await wechatFixture(t,{chat:{fetch:async()=>{await model;return Response.json(llm([],'好的'));}}});await f.bind();
  f.state.configOverride=()=>Response.json({ret:0});
  await f.receive('查余额','no-ticket');const work=f.channels.wechat.drain();
  await until(()=>f.bank.get("SELECT 1 FROM wechat_inbox WHERE status='running'"));
  assert.equal(f.state.sent.length,0);assert.equal(f.state.typing.length,0);
  const row=f.bank.get("SELECT * FROM wechat_inbox WHERE upstream_message_id='no-ticket'");
  t.mock.timers.enable({apis:['Date'],now:row.received_at+5999});
  assert.equal(f.channels.wechat.inbox.nextDue(),row.received_at+6000);
  f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();assert.equal(f.state.sent.length,0);
  t.mock.timers.tick(1);
  f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE request_id=? AND kind='progress'",row.id).n,1);
  assert.equal(f.state.sent[0].msg.item_list[0].text_item.text,'正在处理');
  t.mock.timers.tick(8000);f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();assert.equal(f.state.sent.length,1);
  resolveModel();await work;await f.channels.wechat.drain();
  assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE kind IN ('ack','progress') AND status IN ('pending','retry_wait')").n,0);
});

test('快速完成不发等待文字，结果生成后取消尚未发出的等待提示',async t=>{
  const f=await wechatFixture(t,{wechat:{typing:false}});await f.bind();
  f.queue.push(llm([],'好的'));await f.receive('你好','fast');await f.channels.wechat.drain();
  assert.deepEqual(f.state.sent.map(s=>s.msg.item_list[0].text_item.text),['好的']);
  assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE kind IN ('ack','progress')").n,0);
  await f.channels.wechat.delivery.stop();
  await f.receive('查余额','pending');
  const row=f.bank.get("SELECT * FROM wechat_inbox WHERE upstream_message_id='pending'");
  f.bank.run('UPDATE wechat_inbox SET received_at=? WHERE id=?',Date.now()-6000,row.id);
  f.channels.wechat.inbox.maintain();
  assert.equal(f.bank.get("SELECT status FROM wechat_deliveries WHERE kind='progress'").status,'pending');
  await f.channels.wechat.drain();
  assert.equal(f.bank.get("SELECT status FROM wechat_deliveries WHERE kind='progress'").status,'cancelled');
  f.channels.wechat.delivery.start();await f.channels.wechat.delivery.drain();
  assert.equal(f.state.sent.length,2);assert.ok(f.state.sent.every(s=>s.msg.item_list[0].text_item.text!=='正在处理'));
});

test('排队时间计入6秒，开始执行不重新计时；关闭反馈时不发送等待提示',async t=>{
  for(const feedback of [true,false]){
    const f=await wechatFixture(t,{wechat:{typing:false,feedback}});await f.bind();
    await f.receive('查余额','queued');
    const row=f.bank.get('SELECT * FROM wechat_inbox');
    f.bank.run('UPDATE wechat_inbox SET received_at=? WHERE id=?',Date.now()-6000,row.id);
    f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();
    assert.equal(f.state.sent.length,feedback?1:0);
    if(feedback)assert.equal(f.state.sent[0].msg.item_list[0].text_item.text,'正在处理');
    await f.channels.wechat.drain();
    assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE kind='progress'").n,feedback?1:0);
  }
});

test('启动后自动按收到消息的6秒截止时间发送提示，无需再次收件触发',async t=>{
  let release;const model=new Promise(r=>release=r);
  const f=await wechatFixture(t,{wechat:{typing:false},chat:{fetch:async()=>{await model;return Response.json(llm([],'好的'));}}});await f.bind();
  // Hold the long poll open so only the deadline timer can trigger feedback.
  f.state.updatesOverride=init=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  const w=f.channels.wechat;
  try{
    w.start();w.inbox.ingest(f.binding(),{msgs:[f.message('你好','timer')]});w.inbox.kick();
    const row=f.bank.get('SELECT * FROM wechat_inbox');
    await until(()=>w.nextWake()!==null);
    assert.ok(Math.abs(w.nextWake()-(row.received_at+6000))<50);assert.equal(f.state.sent.length,0);
    await until(async()=>{await new Promise(r=>setTimeout(r,20));return f.state.sent.length===1;});
    assert.equal(f.state.sent[0].msg.item_list[0].text_item.text,'正在处理');
    const progress=f.bank.get("SELECT * FROM wechat_deliveries WHERE kind='progress'");
    assert.ok(progress.started_at-row.received_at>=6000);
    release();await w.drain();assert.equal(f.state.sent.length,2);
  }finally{release();await w.stop();}
});

test('输入提示续期失败不影响延迟文字提示',async t=>{
  let resolveModel;const model=new Promise(r=>resolveModel=r);
  const f=await wechatFixture(t,{wechat:{typingKeepaliveMs:20},chat:{fetch:async()=>{await model;return Response.json(llm([],'好的'));}}});await f.bind();
  await f.receive('查余额','drop');const work=f.channels.wechat.drain();await until(()=>f.channels.wechat.typing.showing(f.binding().id));
  f.state.typingOverride=()=>Response.json({ret:-1});await until(()=>!f.channels.wechat.typing.showing(f.binding().id));
  const row=f.bank.get("SELECT * FROM wechat_inbox WHERE upstream_message_id='drop'");
  f.bank.run('UPDATE wechat_inbox SET received_at=?,started_at=? WHERE id=?',Date.now()-9000,Date.now()-9000,row.id);
  f.channels.wechat.inbox.maintain();await f.channels.wechat.delivery.drain();assert.equal(f.state.sent.at(-1).msg.item_list[0].text_item.text,'正在处理');
  resolveModel();await work;await f.channels.wechat.drain();assert.equal(f.bank.get("SELECT status FROM wechat_inbox WHERE id=?",row.id).status,'completed');
});

test('微信发送结果未知只保留结果并通知App，不重跑模型或自动重发',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();f.state.sendOverride=()=>{throw Error('socket reset after write');};
  f.queue.push(llm([],'查询已生成'));await f.receive('查余额','unknown');await f.channels.wechat.drain();
  const d=f.bank.get("SELECT * FROM wechat_deliveries WHERE kind='final'");assert.equal(d.status,'unknown');assert.equal(d.needs_review,0);assert.equal(f.requests.length,1);
  f.bank.run('UPDATE wechat_deliveries SET started_at=? WHERE id=?',Date.now()-300001,d.id);f.channels.wechat.delivery.maintain();assert.equal(f.bank.get('SELECT needs_review FROM wechat_deliveries WHERE id=?',d.id).needs_review,1);
  await f.channels.wechat.drain();assert.equal(f.state.sent.length,1);assert.equal(f.requests.length,1);
  assert.ok(f.bank.get("SELECT id FROM notifications WHERE title='微信回复送达未确认'"));assert.equal(f.bank.get('SELECT status FROM wechat_inbox').status,'completed');
});

test('微信业务闭环：提议、IM不能确认、App确认回推、取消和解绑',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();const before=f.balance().balance;
  f.queue.push(llm([['propose_transfer',{recipient:f.recipient,amount:'200'}]]),llm([],'请确认'));
  await f.receive('转200元','transfer');await f.channels.wechat.drain();
  const action=f.bank.get("SELECT * FROM agent_actions WHERE channel='wechat'");assert.ok(action);assert.equal(action.session_id,f.binding().binding_session_id);
  await f.receive('确认 '+action.id,'confirm');await f.channels.wechat.drain();assert.equal(f.balance().balance,before);assert.match(f.state.sent.at(-1).msg.item_list[0].text_item.text,/App/);
  const result=await f.call(`/agent/actions/${action.id}/confirm`,{pin:'123456'});assert.equal(result.data.status,'completed');assert.equal(f.balance().balance,before-20000);
  await f.channels.flush();assert.equal(f.bank.get("SELECT status FROM wechat_deliveries WHERE kind='action_result'").status,'api_accepted');assert.equal(f.bank.get('SELECT status FROM channel_outbox').status,'forwarded');
  const next=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'50'},{channel:'wechat',sessionId:f.binding().binding_session_id});
  await f.receive('取消 '+next.id,'cancel');await f.channels.wechat.drain();assert.equal(f.services.owned(f.user,next.id).status,'cancelled');
  assert.equal((await f.call(`/channels/${f.binding().id}/unbind`,{pin:'123456'})).status,200);assert.equal(f.binding().status,'revoked');
});

test('微信隔离异常消息、绑定失效期间拒绝新工具及泄漏',async t=>{
  const f=await wechatFixture(t);await f.bind();
  f.state.messages.push(f.message('secret','intruder',{from_user_id:'other'}),f.message('group','group',{group_id:'g'}),f.message('no id','x',{message_id:null}));
  await f.channels.wechat.pollOnce(f.binding());await f.channels.wechat.drain();assert.equal(f.requests.length,0);assert.equal(f.bank.get('SELECT count(*) n FROM wechat_quarantine').n,1);
  f.bank.run("UPDATE users SET pin_hash='replaced' WHERE id=?",f.user.id);assert.equal(f.binding().auth_state,'reauth_required');
  await assert.rejects(f.channels.wechat.pollOnce(f.binding()),e=>e.code==='CHANNEL_REAUTH_REQUIRED');assert.equal(f.requests.length,0);
});
