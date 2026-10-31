import test from 'node:test';import assert from 'node:assert/strict';import { fixture,llm } from './helpers.mjs';import { createFeishuHandler } from '../server/channels/feishu.mjs';import { eventsText } from '../server/channels/router.mjs';import { safeBaseUrl } from '../server/channels/wechat.mjs';
test('飞书一次性绑定、假事件异步回复、消息去重与解绑',async t=>{const f=await fixture(t);const {code}=f.channels.router.createCode(f.user,'123456');const binding=f.channels.router.bind('feishu','open-alice',code);assert.throws(()=>f.channels.router.bind('feishu','open-bob',code));f.queue.push(llm([],'账户信息已查询。'));let resolve;const received=new Promise(r=>resolve=r);const handler=createFeishuHandler(f.channels.router,{im:{v1:{message:{reply:async arg=>resolve(arg)}}}});const data={sender:{sender_id:{open_id:'open-alice'},sender_type:'user'},message:{message_id:'f1',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'查余额'})}};assert.deepEqual(handler(data),{});const reply=await received;assert.equal(reply.path.message_id,'f1');assert.match(reply.data.content,/账户信息/);assert.equal(await f.channels.router.receive({channel:'feishu',externalId:'open-alice',messageId:'f1',text:'重复'}),'');assert.equal((await f.call(`/channels/${binding.id}/unbind`,{pin:'123456'})).status,200);assert.equal(f.bank.get('SELECT status FROM channel_bindings WHERE id=?',binding.id).status,'revoked');});
test('IM只能提议和取消，所有确认都必须回App输入支付密码或完成加强验证，结果推回IM',async t=>{
 const f=await fixture(t,{channels:{publicOrigin:'https://bank.test'}}),{code}=f.channels.router.createCode(f.user,'123456'),binding=f.channels.router.bind('feishu','open-alice',code),before=f.balance().balance;
 let i=0;const receive=text=>f.channels.router.receive({channel:'feishu',externalId:'open-alice',messageId:'c'+i++,text});
 const small=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'200'},{channel:'feishu',sessionId:binding.id});
 assert.ok(f.bank.get("SELECT id FROM notifications WHERE user_id=? AND title='操作待确认' AND body LIKE ?",f.user.id,`%${small.id}%`));
 const reply=await receive('确认');assert.match(reply,/App内完成支付密码验证/);assert.ok(reply.includes(`https://bank.test/#tasks?action=${small.id}`));
 assert.equal(f.services.owned(f.user,small.id).status,'proposed');assert.equal(f.balance().balance,before);
 assert.throws(()=>f.services.confirm(f.user,small.id,{pin:'123456'},{channel:'feishu',bindingId:binding.id}),e=>e.code==='APP_CONFIRMATION_REQUIRED');
 assert.equal((await f.call(`/agent/actions/${small.id}/confirm`,{pin:'000000'})).status,403);assert.equal(f.services.owned(f.user,small.id).status,'proposed');
 assert.equal((await f.call(`/agent/actions/${small.id}/confirm`,{pin:'123456'})).data.status,'completed');assert.equal(f.balance().balance,before-20000);
 assert.match(f.bank.get('SELECT body FROM channel_outbox WHERE binding_id=? ORDER BY rowid DESC LIMIT 1',binding.id).body,/操作完成/);
 const big=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'2000'},{channel:'feishu',sessionId:binding.id});assert.match(await receive('确认 '+big.id),/人脸模拟、模拟手机验证码和支付密码/);assert.equal(f.services.owned(f.user,big.id).status,'proposed');
 const token=await f.verify(big.id);await f.call(`/agent/actions/${big.id}/confirm`,{pin:'123456',verificationToken:token});assert.equal(f.services.owned(f.user,big.id).status,'completed');
 const drop=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'50'},{channel:'feishu',sessionId:binding.id});assert.match(await receive('取消 '+drop.id),/已取消/);assert.equal(f.services.owned(f.user,drop.id).status,'cancelled');
 const text=eventsText({text:'',events:[{type:'action',data:{id:'ACT1',title:'转账 ¥200.00',level:'yellow',args:{}}}]},{origin:'https://bank.test'});assert.match(text,/https:\/\/bank\.test\/#tasks\?action=ACT1/);assert.match(text,/取消 ACT1/);assert.doesNotMatch(text,/回复「确认/);
});
test('微信二维码、加密token、假轮询到Agent回复带context、过滤他人和-14失效',async t=>{let sent,headers,expired=false;const f=await fixture(t,{channels:{wechat:{enabled:true,autoStart:false,fetch:async(url,init)=>{if(url.includes('get_bot_qrcode'))return Response.json({qrcode:'qrcode-secret',qrcode_img_content:'https://weixin.qq.com/x/demo'});if(url.includes('get_qrcode_status'))return Response.json({status:'confirmed',bot_token:'private-bot-token',ilink_user_id:'wx-alice',ilink_bot_id:'bot-alice',baseurl:'https://ilinkai.weixin.qq.com'});if(url.includes('getupdates'))return Response.json(expired?{ret:-14}:{msgs:[{message_type:1,from_user_id:'intruder',message_id:'bad',item_list:[{type:1,text_item:{text:'查余额'}}]},{message_type:1,from_user_id:'wx-alice',message_id:'wx1',context_token:'context-secret',item_list:[{type:1,text_item:{text:'查余额'}}]}],get_updates_buf:'cursor-2'});if(url.includes('sendmessage')){sent=JSON.parse(init.body);headers=init.headers;return Response.json({ret:0});}throw Error('unknown URL');}}}});const qr=await f.channels.wechat.qr(f.user,'123456');assert.equal(qr.qrcode,undefined);await f.channels.wechat.qrStatus(f.user,qr.id);let binding=f.bank.get("SELECT * FROM channel_bindings WHERE channel='wechat'");assert.notEqual(binding.token,'private-bot-token');assert.equal(f.channels.router.crypto.decrypt(binding.token),'private-bot-token');f.queue.push(llm([],'余额查询结果'));await f.channels.wechat.pollOnce(binding);await f.channels.wechat.drain();assert.equal(f.requests.length,1);assert.equal(sent.msg.context_token,'context-secret');assert.equal(sent.msg.to_user_id,'wx-alice');assert.equal(headers.AuthorizationType,'ilink_bot_token');assert.ok(headers['X-WECHAT-UIN']);binding=f.bank.get('SELECT * FROM channel_bindings WHERE id=?',binding.id);assert.equal(binding.cursor,'cursor-2');expired=true;await assert.rejects(f.channels.wechat.pollOnce(binding),e=>e.code==='WECHAT_REAUTH_REQUIRED');assert.equal(f.bank.get('SELECT auth_state FROM channel_bindings WHERE id=?',binding.id).auth_state,'reauth_required');assert.throws(()=>safeBaseUrl('https://attacker.test'));assert.throws(()=>safeBaseUrl('http://127.0.0.1'));});
// Fake Feishu SDK: registerApp is resolved by the test, and the config patch replays Feishu's URL verification against our webhook.
function fakeFeishu(f){
 const state={sent:[],patches:[],publishes:[],patchCode:0,publishCode:0,sendCode:0,tokenCode:0};let registration;
 const sdk={LoggerLevel:{error:0},
  registerApp(options){return new Promise((resolve,reject)=>{registration={resolve,reject};options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{code:'abort'})));queueMicrotask(()=>options.onQRCodeReady({url:'https://accounts.feishu.cn/app/register?user_code=demo',expireIn:3600}));});},
  Client:class{constructor(o){this.im={v1:{message:{create:async a=>{state.sent.push({appId:o.appId,...a});return {code:state.sendCode};},reply:async a=>{state.sent.push({appId:o.appId,reply:true,...a});return {code:0};}}}};this.auth={tenantAccessToken:{internal:async()=>({code:state.tokenCode})}};this.application={v7:{applicationConfig:{patch:async a=>{state.patches.push(a);const path=new URL(a.data.event.request_url).pathname.replace(/^\/api/,'');const check=await f.req(path,{type:'url_verification',challenge:'c-1',token:a.data.event_and_callback_encrypt_strategy.verification_token});return {code:check.data.challenge==='c-1'?state.patchCode:210042};}},applicationPublish:{create:async a=>{state.publishes.push(a);return {code:state.publishCode};}}}};}},
  EventDispatcher:class{constructor(o){this.keys=o;this.handlers={};}register(h){Object.assign(this.handlers,h);return this;}},
  // Stand-in for the SDK adapter: challenge by verification token, events only with the binding's encrypt key.
  adaptExpress:dispatcher=>async(req,res)=>{const body=req.body;if(body.type==='url_verification')return body.token===dispatcher.keys.verificationToken?res.json({challenge:body.challenge}):res.status(401).json({});if(req.get('x-test-key')!==dispatcher.keys.encryptKey)return res.json({});res.json(await dispatcher.handlers[body.header.event_type](body.event));},
 };
 return {sdk,state,approve:result=>registration.resolve(result),deny:code=>registration.reject(Object.assign(new Error(code),{code}))};
}
const until=async(check,label)=>{for(let i=0;i<200;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw new Error('timed out: '+label);};
const feishuEvent=(sender,id,text)=>({schema:'2.0',header:{event_type:'im.message.receive_v1'},event:{sender:{sender_id:{open_id:sender},sender_type:'user'},message:{message_id:id,chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}}});
async function personalFixture(t,extra={}){let fake;const f=await fixture(t,{channels:{feishuPersonal:{enabled:true,publicOrigin:'https://bank.test',get sdk(){return fake.sdk;},...extra}}});fake=fakeFeishu(f);return {f,fake};}
test('飞书专属机器人：一键创建、webhook地址校验与发布、首个签名回调后标记生效、只认主人、推送与解绑',async t=>{
 const {f,fake}=await personalFixture(t),{state}=fake;
 assert.equal((await f.call('/channels/feishu/register',{pin:'000000'})).status,403);
 const started=await f.call('/channels/feishu/register',{pin:'123456'});assert.equal(started.status,200);assert.match(started.data.url,/^https:\/\/accounts\.feishu\.cn\//);assert.doesNotMatch(JSON.stringify(started.data),/secret/i);
 assert.equal((await f.call(`/channels/feishu/register/${started.data.id}`)).data.status,'wait');
 assert.equal((await f.req(`/channels/feishu/register/${started.data.id}`,undefined,f.bob.token)).status,404);
 fake.approve({client_id:'cli_alice',client_secret:'alice-app-secret',user_info:{open_id:'ou_alice',tenant_brand:'feishu'}});
 const done=await until(async()=>{const s=(await f.call(`/channels/feishu/register/${started.data.id}`)).data;return s.status!=='wait'&&s;},'registration');assert.equal(done.status,'confirmed');
 const binding=f.bank.get('SELECT * FROM channel_bindings WHERE id=?',done.bindingId);assert.equal(binding.status,'active');assert.equal(binding.external_id,'ou_alice');assert.equal(binding.base_url,'https://open.feishu.cn');assert.doesNotMatch(binding.token,/alice-app-secret/);
 const patch=state.patches[0].data;assert.equal(state.patches[0].path.app_id,'cli_alice');assert.equal(patch.event.subscription_type,'webhook');assert.equal(patch.event.request_url,`https://bank.test/api/channels/feishu/events/${binding.id}`);assert.deepEqual(patch.event.add_events,['im.message.receive_v1']);
 assert.equal(state.publishes[0].path.app_id,'cli_alice');assert.equal(state.publishes[0].data.version,'1.0.1');assert.equal(binding.transport,'pending');
 const key=patch.event_and_callback_encrypt_strategy.encryption_key;assert.equal(key.length,32);assert.equal(patch.event_and_callback_encrypt_strategy.verification_token.length,32);
 await until(()=>state.sent.find(s=>s.data.receive_id==='ou_alice'&&/专属助手/.test(s.data.content)),'welcome');
 const listed=async()=>(await f.call('/channels')).data.find(b=>b.id===binding.id);assert.equal((await listed()).personal,true);assert.equal((await listed()).live,false);
 assert.equal((await f.call('/channels/feishu/register',{pin:'123456'})).status,409);
 const events=`/channels/feishu/events/${binding.id}`,before=f.requests.length;
 await f.req(events,feishuEvent('ou_alice','m-unsigned','查余额'));assert.equal((await listed()).live,false);
 await f.req(events,feishuEvent('ou_intruder','m-intruder','查余额'),undefined,'POST',{'x-test-key':key});
 assert.equal(f.bank.get('SELECT transport FROM channel_bindings WHERE id=?',binding.id).transport,'webhook');assert.equal((await listed()).live,true);
 f.queue.push(llm([],'余额已查询。'));
 assert.deepEqual((await f.req(events,feishuEvent('ou_alice','m-1','查余额'),undefined,'POST',{'x-test-key':key})).data,{});
 const reply=await until(()=>state.sent.find(s=>s.reply),'reply');assert.equal(reply.appId,'cli_alice');assert.equal(reply.path.message_id,'m-1');assert.match(reply.data.content,/余额已查询/);assert.equal(f.requests.length,before+1);
 await f.req(events,feishuEvent('ou_alice','m-1','查余额'),undefined,'POST',{'x-test-key':key});await new Promise(r=>setTimeout(r,20));assert.equal(state.sent.filter(s=>s.reply).length,1);
 f.bank.run('INSERT INTO channel_outbox(id,binding_id,body,next_at) VALUES(?,?,?,?)','OUT1',binding.id,'【操作完成】测试推送','2000-01-01T00:00:00.000Z');f.bank.run('INSERT INTO channel_messages VALUES(?,?,?)','feishu','old-message','2000-01-01T00:00:00.000Z');
 await f.channels.flush();assert.equal(f.bank.get("SELECT status FROM channel_outbox WHERE id='OUT1'").status,'sent');assert.ok(state.sent.find(s=>s.appId==='cli_alice'&&/测试推送/.test(s.data.content)));assert.equal(f.bank.get("SELECT * FROM channel_messages WHERE message_id='old-message'"),undefined);
 assert.ok(f.channels.bots.cachedClients()>0);assert.equal((await f.call(`/channels/${binding.id}/unbind`,{pin:'123456'})).status,200);assert.equal(f.channels.bots.cachedClients(),0);
 await f.req(events,feishuEvent('ou_alice','m-2','查余额'),undefined,'POST',{'x-test-key':key});await new Promise(r=>setTimeout(r,20));assert.equal(state.sent.filter(s=>s.reply).length,1);
 assert.equal((await f.req('/chat/status')).data.channels.feishuPersonal,false);
});
test('飞书专属机器人：拒绝、配置或发布失败时回滚并在平台内提示、凭据失效撤销与创建上限',async t=>{
 const {f,fake}=await personalFixture(t,{maxPending:1}),{state}=fake;
 const first=(await f.call('/channels/feishu/register',{pin:'123456'})).data;
 assert.equal((await f.req('/channels/feishu/register',{pin:'123456'},f.bob.token)).status,429);
 fake.deny('access_denied');assert.equal((await until(async()=>{const s=(await f.call(`/channels/feishu/register/${first.id}`)).data;return s.status!=='wait'&&s;},'deny')).status,'denied');
 const setupFails=async(field,code,clientId,step)=>{state[field]=code;const started=(await f.call('/channels/feishu/register',{pin:'123456'})).data;fake.approve({client_id:clientId,client_secret:clientId+'-secret',user_info:{open_id:'ou_'+clientId}});
  const result=await until(async()=>{const s=(await f.call(`/channels/feishu/register/${started.id}`)).data;return s.status!=='wait'&&s;},step);state[field]=0;
  assert.equal(result.status,'failed');assert.match(result.error,new RegExp(`${step}失败（飞书错误码 ${code}）`));assert.match(result.error,/open\.feishu\.cn\/app/);
  assert.equal(f.bank.get('SELECT * FROM channel_bindings WHERE external_id=?','ou_'+clientId),undefined);assert.ok(f.bank.get("SELECT id FROM notifications WHERE user_id=? AND title='飞书机器人创建失败' AND body LIKE ?",f.user.id,`%${step}失败%`));};
 await setupFails('patchCode',99991672,'cli_config','配置');await setupFails('publishCode',210304,'cli_publish','发布');
 state.patchCode=0;const ok=(await f.call('/channels/feishu/register',{pin:'123456'})).data;fake.approve({client_id:'cli_ok',client_secret:'ok-secret',user_info:{open_id:'ou_ok'}});
 const bound=await until(async()=>{const s=(await f.call(`/channels/feishu/register/${ok.id}`)).data;return s.status==='confirmed'&&s;},'confirm');
 const binding=f.bank.get('SELECT * FROM channel_bindings WHERE id=?',bound.bindingId),action=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'200'},{channel:'feishu',sessionId:binding.id});
 state.sendCode=230002;await assert.rejects(f.channels.bots.send(binding,'网络抖动'));assert.equal(f.bank.get('SELECT status FROM channel_bindings WHERE id=?',binding.id).status,'active');
 state.tokenCode=10014;await assert.rejects(f.channels.bots.send(binding,'凭据失效'));
 const expired=f.bank.get('SELECT * FROM channel_bindings WHERE id=?',binding.id);assert.equal(expired.status,'expired');assert.equal(expired.token,null);assert.equal(f.services.owned(f.user,action.id).status,'cancelled');assert.ok(f.bank.get("SELECT id FROM notifications WHERE user_id=? AND title='飞书专属机器人已失效'",f.user.id));
});
test('飞书专属机器人：无人查看的创建会被中止，残留的配置中绑定不阻塞重建',async t=>{
 const {f}=await personalFixture(t,{idleAbortMs:1});f.bank.run("INSERT INTO channel_bindings(id,user_id,channel,external_id,token,base_url,status,created_at) VALUES('BIND-STALE',?,'feishu','ou_stale','x','https://open.feishu.cn','setup','2000-01-01T00:00:00.000Z')",f.user.id);
 const idle=(await f.call('/channels/feishu/register',{pin:'123456'})).data;assert.ok(idle.id);assert.equal(f.bank.get("SELECT id FROM channel_bindings WHERE id='BIND-STALE'"),undefined);
 await new Promise(r=>setTimeout(r,10));f.channels.bots.sweep();assert.equal((await f.call(`/channels/feishu/register/${idle.id}`)).data.status,'expired');
});

test('飞书专属机器人：解绑后仍可扫码自动重建，重新配置发布并隔离旧密钥和会话',async t=>{
 const {f,fake}=await personalFixture(t);
 async function create(secret){
  const started=(await f.call('/channels/feishu/register',{pin:'123456'})).data;
  assert.match(started.url,/accounts\.feishu\.cn/);
  fake.approve({client_id:'cli_recreate',client_secret:secret,user_info:{open_id:'ou_recreate'}});
  const status=await until(async()=>{const s=(await f.call(`/channels/feishu/register/${started.id}`)).data;return s.status==='confirmed'&&s;},'scan creation');
  return f.bank.get('SELECT * FROM channel_bindings WHERE id=?',status.bindingId);
 }
 const first=await create('first-secret'),firstKey=fake.state.patches[0].data.event_and_callback_encrypt_strategy.encryption_key;
 await f.call(`/channels/${first.id}/unbind`,{pin:'123456'});
 const next=await create('second-secret'),nextKey=fake.state.patches[1].data.event_and_callback_encrypt_strategy.encryption_key;
 assert.equal(fake.state.publishes.length,2);assert.equal(next.auth_state,'valid');assert.equal(next.binding_generation,first.binding_generation+1);assert.notEqual(next.binding_session_id,first.binding_session_id);assert.notEqual(firstKey,nextKey);
 const path=`/channels/feishu/events/${next.id}`;
 await f.req(path,feishuEvent('ou_recreate','old-signature','查余额'),undefined,'POST',{'x-test-key':firstKey});assert.equal(f.requests.length,0);
 f.queue.push(llm([],'新机器人查询结果'));
 await f.req(path,feishuEvent('ou_recreate','new-signature','查余额'),undefined,'POST',{'x-test-key':nextKey});await f.channels.feishuPipeline.drain();
 assert.equal(f.requests.length,1);assert.ok(fake.state.sent.some(s=>s.reply&&/新机器人查询结果/.test(s.data.content)));
 // Exercise the installed SDK's AES decryption and signature verification, not the fake adapter.
 const sdk=await import('@larksuiteoapi/node-sdk'),{createHash,createCipheriv,randomBytes}=await import('node:crypto');
 fake.sdk.EventDispatcher=sdk.EventDispatcher;fake.sdk.adaptExpress=sdk.adaptExpress;f.channels.bots.forget(next.id);
 const payload=feishuEvent('ou_recreate','sdk-signed','真实SDK签名测试'),iv=randomBytes(16),cipher=createCipheriv('aes-256-cbc',createHash('sha256').update(nextKey).digest(),iv);
 payload.header.token=fake.state.patches[1].data.event_and_callback_encrypt_strategy.verification_token;
 const body={encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(payload)),cipher.final()]).toString('base64')};
 const timestamp=String(Math.floor(Date.now()/1000)),nonce='test-nonce',signature=createHash('sha256').update(timestamp+nonce+nextKey+JSON.stringify(body)).digest('hex');
 const headers={'x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,'x-lark-signature':'invalid'};
 const sendSigned=async()=>{const response=await fetch(f.url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});await response.text();assert.equal(response.status,200);};
 await sendSigned();assert.equal(f.requests.length,1);
 f.queue.push(llm([],'签名校验后的结果'));headers['x-lark-signature']=signature;
 await sendSigned();await f.channels.feishuPipeline.drain();assert.equal(f.requests.length,2);
 await sendSigned();await f.channels.feishuPipeline.drain();assert.equal(f.requests.length,2);
});
