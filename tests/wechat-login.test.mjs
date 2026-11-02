import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatFixture,llm,until } from './wechat-helpers.mjs';
import { safeBaseUrl } from '../server/channels/wechat-protocol.mjs';

test('微信登录协议：POST取码、验证码、身份隔离、加密绑定、取消及重新认证代次',async t=>{
  const f=await wechatFixture(t);
  const qr=await f.channels.wechat.qr(f.user,'123456');
  const req=f.state.requests[0];assert.equal(req.init.method,'POST');assert.deepEqual(JSON.parse(req.init.body),{local_token_list:[]});assert.equal(req.init.headers['iLink-App-Id'],'bot');assert.equal(req.init.headers['iLink-App-ClientVersion'],'132105');assert.equal(req.init.headers.Authorization,undefined);assert.ok(req.init.headers['X-WECHAT-UIN']);
  assert.equal((await f.req(`/channels/wechat/qr/${qr.id}`,undefined,f.bob.token)).status,404);
  f.state.status={status:'need_verifycode'};assert.equal((await f.channels.wechat.qrStatus(f.user,qr.id)).status,'awaiting_code');
  assert.equal((await f.call(`/channels/wechat/qr/${qr.id}/verify`,{code:'AB12'})).status,200);
  f.state.status={status:'confirmed',bot_token:'private-token',ilink_user_id:'wx-owner',ilink_bot_id:'wx-bot',baseurl:'https://ilinkai.weixin.qq.com'};
  assert.equal((await f.channels.wechat.qrStatus(f.user,qr.id)).status,'confirmed');
  const poll=f.state.requests.at(-1);assert.match(poll.url,/verify_code=AB12/);assert.equal(poll.init.headers.AuthorizationType,undefined);
  const old=f.binding();assert.notEqual(old.token,'private-token');assert.equal(old.external_bot_id,'wx-bot');assert.equal(old.auth_state,'valid');
  await assert.rejects(f.channels.wechat.qr(f.user,'123456'),e=>e.code==='WECHAT_BOT_EXISTS');
  f.bank.run("UPDATE channel_bindings SET auth_state='reauth_required' WHERE id=?",old.id);
  const next=await f.bind();assert.equal(next.binding_generation,old.binding_generation+1);assert.notEqual(next.binding_session_id,old.binding_session_id);
  assert.doesNotMatch(JSON.stringify((await f.call('/channels')).data),/private-token|wx-owner|wx-bot|binding_session/);
});

test('微信登录异常：重定向拒绝、取消、缺凭据不假成功',async t=>{
  const f=await wechatFixture(t);
  let qr=await f.channels.wechat.qr(f.user,'123456');f.state.status={status:'scaned_but_redirect',redirect_host:'evil.example'};
  assert.equal((await f.channels.wechat.qrStatus(f.user,qr.id)).status,'failed');assert.equal(f.binding(),undefined);
  qr=await f.channels.wechat.qr(f.user,'123456');await f.call(`/channels/wechat/qr/${qr.id}` ,{},'DELETE');assert.equal((await f.channels.wechat.qrStatus(f.user,qr.id)).status,'cancelled');
  qr=await f.channels.wechat.qr(f.user,'123456');f.state.status={status:'confirmed',bot_token:'x'};assert.equal((await f.channels.wechat.qrStatus(f.user,qr.id)).status,'failed');
  for(const url of ['http://127.0.0.1','https://ilinkai.weixin.qq.com.evil.example','https://u:p@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com:444'])assert.throws(()=>safeBaseUrl(url));
});

// Production mode: the long poll stays open until a message arrives or the loop is aborted.
function heldPolls(f){const waiting=[];f.state.updatesOverride=init=>new Promise((resolve,reject)=>{waiting.push(resolve);init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});return waiting;}
const scan=async(f)=>{const w=f.channels.wechat,qr=await w.qr(f.user,'123456');await until(async()=>(await w.qrStatus(f.user,qr.id)).status==='confirmed');};
const updates=(f,cursor,...messages)=>Response.json({ret:0,msgs:messages,get_updates_buf:cursor});

test('微信：改密后旧长轮询还没返回就重扫，新绑定也能接上轮询并收件',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false,autoStart:true}}),waiting=heldPolls(f);
  await scan(f);await until(()=>waiting.length===1);const first=f.binding();
  f.bank.run("UPDATE channel_bindings SET auth_state='reauth_required' WHERE id=?",first.id);
  await scan(f);assert.equal(f.binding().binding_generation,first.binding_generation+1);
  await until(()=>waiting.length===2);assert.equal(f.bank.get("SELECT count(*) n FROM channel_bindings WHERE status='active' AND lease_owner IS NOT NULL").n,1);
  f.queue.push(llm([],'新绑定的回复'));waiting[1](updates(f,'c1',f.message('查余额','after-rescan')));
  await until(()=>f.state.sent.some(s=>s.msg.item_list[0].text_item.text==='新绑定的回复'));
});

test('微信：冻卡期间扫码或已连接时冻卡，轮询都不退出，解冻后继续收件',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false,autoStart:true}}),waiting=heldPolls(f),last=()=>f.state.sent.at(-1)?.msg.item_list[0].text_item.text;
  const account=f.bank.get("SELECT id FROM accounts WHERE user_id=? AND type='debit'",f.user.id).id;
  f.bank.run("UPDATE accounts SET status='frozen' WHERE id=?",account);
  await scan(f);await until(()=>waiting.length===1);
  waiting[0](updates(f,'c1',f.message('查余额','frozen')));await until(()=>/账户状态暂不支持渠道查询/.test(last()));
  await until(()=>waiting.length===2);f.bank.run("UPDATE accounts SET status='active' WHERE id=?",account);
  f.queue.push(llm([],'解冻后的回复'));waiting[1](updates(f,'c2',f.message('查余额','thawed')));await until(()=>last()==='解冻后的回复');
  await until(()=>waiting.length===3);f.bank.run("UPDATE accounts SET status='frozen' WHERE id=?",account);
  waiting[2](updates(f,'c3',f.message('查余额','frozen-again')));await until(()=>/账户状态暂不支持渠道查询/.test(last()));
  await until(()=>waiting.length===4);assert.equal(f.binding().auth_state,'valid');
});
