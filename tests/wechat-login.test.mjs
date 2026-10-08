import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatFixture } from './wechat-helpers.mjs';
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
