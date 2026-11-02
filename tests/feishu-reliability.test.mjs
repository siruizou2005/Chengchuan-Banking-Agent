import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture,llm } from './helpers.mjs';
import { createFeishuHandler,feishuRequest } from '../server/channels/feishu.mjs';
import { createApp } from '../server/app.mjs';
import { feishuContentText as contentText } from './helpers.mjs';
import { executeTool } from '../server/agent/tools.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const until=async predicate=>{for(let i=0;i<400;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition timed out');};
const event=(id,text,owner='fs-owner')=>({sender:{sender_id:{open_id:owner},sender_type:'user'},message:{message_id:id,chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}});
async function setup(t,options={}) {
 const sdk={LoggerLevel:{warn:2},Client:class{im={v1:{message:{create:async()=>({code:0}),reply:async()=>({code:0})}}};},WSClient:class{start(){}close(){}},EventDispatcher:class{register(){return this;}}};
 const f=await fixture(t,{chat:options.chat,channels:{publicOrigin:'https://bank.test',feishu:{appId:'test',appSecret:'test',sdk},feishuPipeline:{feedback:false,...options.pipeline}}});await f.channels.start();
 const binding=f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code),sent=[];
 const handler=createFeishuHandler(f.channels.router,{im:{v1:{message:{reply:async arg=>{sent.push(arg);return options.reply?options.reply(arg):{code:0,data:{message_id:'out-'+sent.length}};}}}}});
 return {...f,binding,sent,handler,pipe:f.channels.feishuPipeline};
}

test('飞书：解绑期间的模型不得写工具效果或发送金额，重绑隔离会话和旧回调',async t=>{
 const gate=deferred(),entered=deferred();let calls=0;
 const f=await setup(t,{chat:{fetch:async()=>{if(++calls===1){entered.resolve();await gate.promise;return Response.json(llm([['remember',{key:'fs_test',value:'must not persist'}]]));}return Response.json(llm([],'余额 ¥123.45'));}}});
 await f.call('/channels/preferences/feishu',{maskAmounts:true},'PATCH');
 f.handler(event('unbind-1','记住偏好'));await entered.promise;
 const row=f.bank.get("SELECT * FROM feishu_inbox WHERE message_id='unbind-1'");
 f.channels.router.unbind(f.user,f.binding.id,'123456');
 const rebound=f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code);
 assert.equal(rebound.auth_state,'valid');assert.equal(rebound.binding_generation,f.binding.binding_generation+1);assert.notEqual(rebound.binding_session_id,f.binding.binding_session_id);
 gate.resolve();await f.pipe.drain();
 assert.equal(f.bank.get('SELECT status FROM feishu_inbox WHERE id=?',row.id).status,'cancelled');
 assert.equal(f.bank.get("SELECT * FROM agent_memory WHERE user_id=? AND key='fs_test'",f.user.id),undefined);assert.equal(f.sent.length,0);
 const stale=createFeishuHandler(f.channels.router,{},()=>{},'fs-owner',f.binding);stale(event('old-callback','查余额'));
 assert.equal(f.bank.get("SELECT * FROM feishu_inbox WHERE message_id='old-callback'"),undefined);
 f.handler(event('unbind-1','旧事件重放'));await f.pipe.drain();assert.equal(f.sent.length,0);
 f.handler(event('new-message','查余额'));await f.pipe.drain();
 assert.equal(f.sent.length,1);assert.doesNotMatch(f.sent[0].data.content,/123\.45/);
});

test('飞书：业务拒绝有终态和App结果，重复事件不重跑模型或丢失结果，结果归属隔离',async t=>{
 const f=await setup(t,{reply:()=>({code:230002})});f.queue.push(llm([],'余额 ¥123.45'));
 const e=event('rejected','查余额');f.handler(e);await f.pipe.drain();f.handler(e);await f.pipe.drain();
 assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);
 const row=f.bank.get("SELECT * FROM feishu_inbox WHERE message_id='rejected'");
 const d=f.bank.get('SELECT * FROM feishu_deliveries WHERE request_id=?',row.id);assert.equal(d.status,'failed');assert.equal(d.safe_error_code,'FEISHU_230002');
 assert.doesNotMatch(row.input_cipher,/查余额/);assert.doesNotMatch(d.body_cipher,/123\.45/);
 assert.equal((await f.call('/channels/feishu/requests')).data[0].id,row.id);
 const result=await f.call(`/channels/feishu/requests/${row.id}`);assert.equal(result.status,200);assert.match(result.data.result.text,/123\.45/);
 assert.equal((await f.req(`/channels/feishu/requests/${row.id}`,undefined,f.bob.token)).status,404);
 assert.ok(f.bank.get("SELECT 1 FROM notifications WHERE user_id=? AND title='飞书回复送达未确认'",f.user.id));
});

test('飞书：明确限流只重试投递，金额开关变化后重新生成发送编号；响应丢失不自动重发',async t=>{
 let mode='rate';const f=await setup(t,{reply:()=>{if(mode==='rate')return {code:99991400};if(mode==='unknown')throw Error('connection reset');return {code:0};}});
 f.queue.push(llm([],'余额 ¥123.45'));f.handler(event('rate','查余额'));await f.pipe.drain();
 let d=f.bank.get('SELECT * FROM feishu_deliveries ORDER BY seq DESC LIMIT 1');assert.equal(d.status,'retry_wait');const first=f.sent[0].data.uuid;
 await f.call('/channels/preferences/feishu',{maskAmounts:true},'PATCH');mode='ok';f.bank.run('UPDATE feishu_deliveries SET next_at=0 WHERE id=?',d.id);await f.pipe.drain();
 assert.equal(f.requests.length,1);assert.equal(f.sent.length,2);assert.notEqual(f.sent[1].data.uuid,first);assert.doesNotMatch(f.sent[1].data.content,/123\.45/);
 mode='unknown';f.queue.push(llm([],'结果已生成'));f.handler(event('unknown','查余额'));await f.pipe.drain();
 d=f.bank.get('SELECT * FROM feishu_deliveries ORDER BY seq DESC LIMIT 1');assert.equal(d.status,'unknown');assert.equal(d.needs_review,1);
 await f.pipe.drain();assert.equal(f.sent.length,3);assert.equal(f.requests.length,2);
});

test('飞书：发送在途解绑不会复活通知，迟到的成功不能覆盖未知状态',async t=>{
 const gate=deferred(),entered=deferred();const f=await setup(t,{reply:async()=>{entered.resolve();return gate.promise;}});
 f.queue.push(llm([],'查询结果'));f.handler(event('inflight','查询'));await entered.promise;
 const d=f.bank.get('SELECT * FROM feishu_deliveries ORDER BY seq DESC LIMIT 1');
 f.channels.router.unbind(f.user,f.binding.id,'123456');f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code);
 gate.resolve({code:0});await f.pipe.drain();
 assert.equal(f.bank.get('SELECT status FROM feishu_deliveries WHERE id=?',d.id).status,'unknown');assert.equal(f.sent.length,1);
});

test('飞书：慢请求只提示一次，排队有界，取消命令不等待模型',async t=>{
 const gate=deferred(),entered=deferred();let calls=0;
 const f=await setup(t,{pipeline:{feedback:true,progressMs:15,maxPending:2,concurrency:1},chat:{fetch:async()=>{if(++calls===1){entered.resolve();await gate.promise;}return Response.json(llm([],'完成查询'));}}});
 const action=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'20'},{channel:'feishu',sessionId:f.binding.binding_session_id});
 f.handler(event('slow','查询'));await entered.promise;
 f.handler(event('queued','第二个查询'));f.handler(event('overflow','第三个查询'));f.handler(event('cancel','取消 '+action.id));
 await until(()=>f.services.owned(f.user,action.id).status==='cancelled');
 await until(()=>f.bank.get("SELECT count(*) n FROM feishu_deliveries WHERE kind='progress' AND status='api_accepted'").n>=1);
 assert.equal(f.bank.get("SELECT status FROM feishu_inbox WHERE message_id='overflow'").status,'failed');
 gate.resolve();await f.pipe.drain();
 assert.equal(calls,2);assert.equal(f.bank.get("SELECT count(*) n FROM feishu_deliveries d JOIN feishu_inbox i ON i.id=d.request_id WHERE i.message_id='slow' AND d.kind='progress'").n,1);
 assert.equal(f.bank.get("SELECT status FROM feishu_inbox WHERE message_id='queued'").status,'completed');
 const result=f.sent.filter(s=>s.path.message_id==='slow');assert.match(result[0].data.content,/正在(?:等待)?处理/);assert.match(result.at(-1).data.content,/完成查询/);
 f.handler(event('fast','帮助'));await f.pipe.drain();assert.equal(f.bank.get("SELECT count(*) n FROM feishu_deliveries d JOIN feishu_inbox i ON i.id=d.request_id WHERE i.message_id='fast' AND d.kind='progress'").n,0);
});

test('飞书：已取消提议的待重试回复刷新状态，不能继续提示用户确认',async t=>{
 let limited=true;const f=await setup(t,{reply:()=>({code:limited?99991400:0})});
 f.queue.push(llm([['propose_transfer',{recipient:f.recipient,amount:'20'}]]),llm([],'请在App核对操作。'));
 f.handler(event('proposal','转账20元'));await f.pipe.drain();
 const action=f.bank.get("SELECT * FROM agent_actions WHERE user_id=? AND channel='feishu' ORDER BY rowid DESC LIMIT 1",f.user.id);
 const row=f.bank.get("SELECT * FROM feishu_inbox WHERE message_id='proposal'"),delivery=f.bank.get('SELECT * FROM feishu_deliveries WHERE request_id=?',row.id);
 assert.equal(delivery.status,'retry_wait');assert.match(f.sent[0].data.content,/待授权确认/);
 f.channels.router.feishuCommand(f.binding,'取消 '+action.id);limited=false;
 f.bank.run('UPDATE feishu_deliveries SET next_at=0 WHERE id=?',delivery.id);await f.pipe.drain();
 const text=contentText(f.sent.at(-1).data.content);
 assert.match(text,/cancelled/);assert.doesNotMatch(text,/待授权确认|请在App内输入支付密码确认/);
 assert.equal(f.pipe.requestView(f.user,row.id).result.events.find(e=>e.type==='action').data.status,'cancelled');
});

test('飞书：回推在途解绑不会把outbox改回待重试，慢绑定不阻塞其他绑定',async t=>{
 const entered=deferred(),gate=deferred(),sent=[];
 const sdk={LoggerLevel:{warn:2},Client:class{im={v1:{message:{create:async a=>{sent.push(a);if(a.data.receive_id==='slow-owner'){entered.resolve();await gate.promise;throw Error('lost response');}return {code:0};}}}}},WSClient:class{start(){}close(){}},EventDispatcher:class{register(){return this;}}};
 const f=await fixture(t,{channels:{feishu:{appId:'test',appSecret:'test',sdk}}});await f.channels.start();
 const a=f.channels.router.bind('feishu','slow-owner',f.channels.router.createCode(f.user,'123456').code);
 const bob=f.bank.get('SELECT * FROM users WHERE id=?',f.bob.user.id),b=f.channels.router.bind('feishu','fast-owner',f.channels.router.createCode(bob,'123456').code);
 for(const [key,binding] of [['slow',a],['fast',b]])f.bank.run('INSERT INTO channel_outbox(id,binding_id,body,next_at) VALUES(?,?,?,?)',key,binding.id,'通知','2000-01-01');
 const flushing=f.channels.flush();await entered.promise;await until(()=>sent.some(s=>s.data.receive_id==='fast-owner'));
 f.channels.router.unbind(f.user,a.id,'123456');gate.resolve();await flushing;
 assert.equal(f.bank.get("SELECT status FROM channel_outbox WHERE id='slow'").status,'cancelled');assert.equal(f.bank.get("SELECT status FROM channel_outbox WHERE id='fast'").status,'sent');
 f.channels.router.bind('feishu','slow-owner',f.channels.router.createCode(f.user,'123456').code);await f.channels.flush();assert.equal(sent.filter(s=>s.data.receive_id==='slow-owner').length,1);
});

test('飞书：重启恢复未开始请求；已提交工具而未完成的请求只收尾，不重跑业务',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-recovery-')),path=join(dir,'bank.sqlite');let app,calls=0,sends=0;
 const sdk={LoggerLevel:{warn:2},Client:class{im={v1:{message:{reply:async()=>{sends++;return {code:0};}}}}},WSClient:class{start(){}close(){}},EventDispatcher:class{register(){return this;}}};
 const options={chat:{config:()=>({apiKey:'test',baseUrl:'https://llm.test',model:'test'}),fetch:async()=>{calls++;return Response.json(llm([],'恢复后的结果'));}},channels:{secret:'a'.repeat(64),feishu:{appId:'test',appSecret:'test',sdk},feishuPipeline:{feedback:false}}};
 t.after(async()=>{if(app){await app.channels.stop();app.bank.db.close();}rmSync(dir,{recursive:true,force:true});});
 app=createApp(path,options);const user=app.bank.get("SELECT * FROM users WHERE phone='13800138000'");app.services.enrollment.enable(user,app.services.enrollment.status(user.id).documents);
 const b=app.channels.router.bind('feishu','owner',app.channels.router.createCode(user,'123456').code);
 app.channels.feishuPipeline.ingest({externalId:'owner',messageId:'interrupted',text:'记住偏好'});
 const row=app.bank.get("SELECT * FROM feishu_inbox WHERE message_id='interrupted'");
 await app.channels.feishuPipeline.stop();
 await executeTool(app.services,user,'remember',{key:'recovery',value:'once',evidence:'once'},{channel:'feishu',sessionId:b.binding_session_id,bindingId:b.id,requestId:row.id,runId:row.run_id,toolCallId:'stable-tool',input:'once'});
 app.bank.run("UPDATE feishu_inbox SET status='running',lease_until=0 WHERE id=?",row.id);
 app.bank.db.close();app=null;
 app=createApp(path,options);
 app.channels.feishuPipeline.ingest({externalId:'owner',messageId:'queued',text:'查余额'});await app.channels.feishuPipeline.stop();app.bank.db.close();app=null;
 app=createApp(path,options);await app.channels.start();await app.channels.feishuPipeline.drain();
 assert.equal(calls,1);assert.equal(sends,2);
 assert.equal(app.bank.get("SELECT status FROM feishu_inbox WHERE message_id='interrupted'").status,'interrupted');
 assert.equal(app.bank.get("SELECT status FROM feishu_inbox WHERE message_id='queued'").status,'completed');
 assert.equal(app.bank.get('SELECT count(*) n FROM agent_tool_effects WHERE request_id=?',row.id).n,1);
 assert.equal(app.bank.get("SELECT value FROM memory_candidates WHERE key='recovery'").value,'once');
});

test('飞书：发送超时、非法响应和HTTP限流分类明确',async()=>{
 await assert.rejects(feishuRequest(()=>new Promise(()=>{}),{timeoutMs:5}),e=>e.deliveryState==='unknown'&&e.code==='FEISHU_SEND_TIMEOUT');
 await assert.rejects(feishuRequest(async()=>({})),e=>e.deliveryState==='unknown');
 await assert.rejects(feishuRequest(async()=>{throw {response:{status:429}};}),e=>e.deliveryState==='retry_wait');
});

test('飞书：普通回复用富文本post，表格用卡片且手机端16px；内容被拒时退回纯文本，其他错误不重复发送',async t=>{
 const f=await setup(t,{reply:arg=>arg.data.msg_type==='interactive'?{code:230099}:{code:0,data:{message_id:'m1'}}});
 f.queue.push(llm([],'# 账户\n**余额** ¥123.45\n可用'));f.handler(event('post','查余额'));await f.pipe.drain();
 assert.deepEqual(f.sent.map(s=>s.data.msg_type),['post']);
 const md=JSON.parse(f.sent[0].data.content).zh_cn.content[0][0];
 assert.equal(md.tag,'md');assert.equal(md.text,'**账户**  \n**余额** ¥123.45  \n可用');
 f.queue.push(llm([],'| 类别 | 金额 |\n|---|---|\n| 餐饮 | ¥12 |'));f.handler(event('card','按类别列表'));await f.pipe.drain();
 assert.deepEqual(f.sent.slice(1).map(s=>s.data.msg_type),['interactive','text']);
 const card=JSON.parse(f.sent[1].data.content),element=card.body.elements[0];
 assert.equal(card.schema,'2.0');assert.equal(element.tag,'markdown');assert.equal(element.text_size,'normal_v2');assert.equal(card.config.style.text_size.normal_v2.mobile,'heading');
 assert.match(element.content,/\| 餐饮 \| ¥12 \|/);
 assert.notEqual(f.sent[2].data.uuid,f.sent[1].data.uuid);assert.match(JSON.parse(f.sent[2].data.content).text,/\| 餐饮 \| ¥12 \|/);
 assert.equal(f.bank.get("SELECT d.status FROM feishu_deliveries d JOIN feishu_inbox i ON i.id=d.request_id WHERE i.message_id='card'").status,'api_accepted');
});

test('飞书：处理中给用户消息加Typing表情，回复送达后撤销，期间不再发文字进度',async t=>{
 const calls=[],gate=deferred();
 const typing={add:async(b,messageId)=>{calls.push(['add',messageId]);return 'reaction-1';},remove:async(b,messageId,reactionId)=>{calls.push(['remove',messageId,reactionId]);}};
 const f=await setup(t,{pipeline:{typing,feedback:true,progressMs:20},chat:{fetch:async()=>{await gate.promise;return Response.json(llm([],'余额已查询'));}}});
 f.handler(event('typing','查余额'));
 await until(()=>calls.length===1);assert.deepEqual(calls[0],['add','typing']);
 await new Promise(r=>setTimeout(r,60));f.pipe.kick();
 assert.equal(f.sent.length,0);assert.equal(f.bank.get("SELECT progress_sent FROM feishu_inbox WHERE message_id='typing'").progress_sent,1);
 gate.resolve();await f.pipe.drain();
 await until(()=>calls.length===2);assert.deepEqual(calls[1],['remove','typing','reaction-1']);
 assert.deepEqual(f.sent.map(s=>s.data.msg_type),['post']);
 f.handler(event('help','帮助'));await f.pipe.drain();assert.equal(calls.length,2);
});

test('飞书：表情回应失败时仍按时发送文字进度',async t=>{
 const gate=deferred();
 const f=await setup(t,{pipeline:{typing:{add:async()=>{throw new Error('no permission');},remove:async()=>{}},feedback:true,progressMs:20},chat:{fetch:async()=>{await gate.promise;return Response.json(llm([],'余额已查询'));}}});
 f.handler(event('no-typing','查余额'));
 await until(()=>f.sent.length===1);assert.equal(f.sent[0].data.msg_type,'text');assert.match(JSON.parse(f.sent[0].data.content).text,/请稍等/);
 gate.resolve();await f.pipe.drain();assert.equal(f.sent.at(-1).data.msg_type,'post');
});

test('飞书：普通问答不附App链接，账单统计等App卡片结果附上并转为可点链接',async t=>{
 const f=await setup(t);
 f.queue.push(llm([['detect_anomalies',{}]]),llm([],'本月未发现异常支出。'));f.handler(event('cards','有没有异常支出'));await f.pipe.drain();
 const content=contentText(f.sent.at(-1).data.content);
 assert.match(content,/异常支出明细请在App查看：\[https:\/\/bank\.test\/#feishu-requests\/FSREQ\w+\]\(https:\/\/bank\.test\/#feishu-requests\/FSREQ\w+\)/);
 f.queue.push(llm([],'可用余额 ¥123.45'));f.handler(event('plain','查余额'));await f.pipe.drain();
 assert.doesNotMatch(contentText(f.sent.at(-1).data.content),/App查看|feishu-requests/);
 f.queue.push(llm([],'流水'.repeat(4000)));f.handler(event('long','列出全部流水'));await f.pipe.drain();
 assert.match(contentText(f.sent.at(-1).data.content),/…\n\n回复内容较长，以上仅为部分，完整内容请在App查看：\[https/);
});

test('飞书：助手停止或授权失效时回调不失败，回复原因，命令可用，恢复后不执行旧消息',async t=>{
 const f=await setup(t),text=()=>contentText(f.sent.at(-1).data.content);
 assert.equal((await f.call('/agent/control/stop',{})).status,200);
 const stopped=event('stopped','转账给陈屿100元');assert.deepEqual(f.handler(stopped),{});await f.pipe.drain();
 assert.equal(f.bank.get("SELECT status FROM feishu_inbox WHERE message_id='stopped'").status,'failed');assert.match(text(),/智能助手已停止/);
 f.handler(event('help-stopped','帮助'));await f.pipe.drain();assert.match(text(),/可查余额/);
 f.handler(event('unsubscribe-stopped','退订日报'));await f.pipe.drain();assert.match(text(),/已退订飞书日报/);
 assert.equal((await f.call('/agent/control/resume',{pin:'123456'})).status,200);
 const replies=f.sent.length;f.handler(stopped);await f.pipe.drain();
 assert.equal(f.sent.length,replies);assert.equal(f.requests.length,0);assert.equal(f.bank.get("SELECT count(*) n FROM feishu_inbox WHERE message_id='stopped'").n,1);
 // Revoking the tool grant also stops the assistant; once resumed, the missing grant alone must still be answered.
 assert.equal((await f.call('/v1/puma/consents',{scope:'agent_tools',granted:false})).status,200);assert.equal((await f.call('/agent/control/resume',{pin:'123456'})).status,200);
 assert.deepEqual(f.handler(event('no-grant','查余额')),{});await f.pipe.drain();assert.match(text(),/授权已撤销或过期/);assert.equal(f.requests.length,0);
});

test('飞书：冻卡时普通消息回复原因，帮助、退订、取消可用；解冻后同一绑定恢复',async t=>{
 const f=await setup(t),text=()=>contentText(f.sent.at(-1).data.content),account=f.bank.get("SELECT id FROM accounts WHERE user_id=? AND type='debit'",f.user.id).id;
 const action=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'20'},{channel:'feishu',sessionId:f.binding.binding_session_id});
 await f.call('/channels/reports/feishu',{daily:true},'PATCH');
 f.bank.run("UPDATE accounts SET status='frozen' WHERE id=?",account);
 assert.deepEqual(f.handler(event('frozen','查余额')),{});await f.pipe.drain();
 assert.equal(f.bank.get("SELECT status FROM feishu_inbox WHERE message_id='frozen'").status,'failed');assert.match(text(),/账户状态暂不支持渠道查询/);assert.equal(f.requests.length,0);
 for(const [id,command,reply] of [['frozen-help','帮助',/可查余额/],['frozen-unsubscribe','退订日报',/已退订飞书日报/],['frozen-cancel','取消 '+action.id,/操作已取消/]]){assert.deepEqual(f.handler(event(id,command)),{});await f.pipe.drain();assert.match(text(),reply);}
 assert.equal(f.services.owned(f.user,action.id).status,'cancelled');assert.equal((await f.call('/channels/reports')).data.feishu.daily.enabled,false);
 f.bank.run("UPDATE accounts SET status='active' WHERE id=?",account);
 f.queue.push(llm([],'余额 ¥123.45'));f.handler(event('thawed','查余额'));await f.pipe.drain();
 assert.match(text(),/123\.45/);assert.equal(f.bank.get('SELECT binding_generation g FROM channel_bindings WHERE id=?',f.binding.id).g,f.binding.binding_generation);
});

test('飞书：冻卡前未发出的查询结果不再发送，处理中的请求回复冻结原因',async t=>{
 let limited=true;const gate=deferred(),entered=deferred();let calls=0;
 const f=await setup(t,{reply:()=>limited?{code:99991400}:{code:0},chat:{fetch:async()=>{if(++calls===2){entered.resolve();await gate.promise;}return Response.json(llm([],'余额 ¥123.45'));}}});
 const account=f.bank.get("SELECT id FROM accounts WHERE user_id=? AND type='debit'",f.user.id).id;
 f.handler(event('unsent','查余额'));await f.pipe.drain();
 const unsent=f.bank.get("SELECT d.* FROM feishu_deliveries d JOIN feishu_inbox i ON i.id=d.request_id WHERE i.message_id='unsent'");assert.equal(unsent.status,'retry_wait');
 limited=false;f.handler(event('running','查余额'));await entered.promise;
 f.bank.run("UPDATE accounts SET status='frozen' WHERE id=?",account);gate.resolve();
 f.bank.run('UPDATE feishu_deliveries SET next_at=0 WHERE id=?',unsent.id);await f.pipe.drain();
 assert.equal(f.bank.get('SELECT status FROM feishu_deliveries WHERE id=?',unsent.id).status,'cancelled');
 assert.match(contentText(f.sent.at(-1).data.content),/账户状态暂不支持渠道查询/);assert.equal(f.sent.filter(s=>s.path.message_id==='unsent').length,1);
});

test('飞书：非文本和超长消息回复说明，不进入模型，重复事件不重复回复',async t=>{
 const f=await setup(t),image=event('image','');image.message={...image.message,message_type:'image',content:JSON.stringify({image_key:'img'})};
 const messages=[image,event('long','查'.repeat(6001)),event('blank','   ')];
 for(const e of messages){assert.deepEqual(f.handler(e),{});f.handler(e);}
 await f.pipe.drain();
 assert.deepEqual(f.sent.map(s=>s.path.message_id).sort(),['blank','image','long']);for(const s of f.sent)assert.match(contentText(s.data.content),/仅支持不超过6000字的文字消息/);
 assert.equal(f.requests.length,0);assert.deepEqual(f.bank.all('SELECT status FROM feishu_inbox').map(r=>r.status),['failed','failed','failed']);
});
