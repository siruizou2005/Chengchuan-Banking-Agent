import test from 'node:test';
import assert from 'node:assert/strict';
import { backup } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBank } from '../server/db.mjs';
import { channelPreferences,maskMoney } from '../server/channels/preferences.mjs';
import { wechatResultText } from '../server/channels/wechat-state.mjs';
import { fixture,llm } from './helpers.mjs';
import { wechatFixture } from './wechat-helpers.mjs';

test('渠道开关按用户和渠道隔离，校验输入，解绑/重绑与重启保留',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.call('/channels/preferences')).data,{feishu:{maskAmounts:false},wechat:{maskAmounts:false}});
  assert.equal((await f.call('/channels/preferences/wechat',{maskAmounts:true,userId:f.bob.user.id},'PATCH')).status,200);
  assert.deepEqual((await f.call('/channels/preferences')).data,{feishu:{maskAmounts:false},wechat:{maskAmounts:true}});
  assert.equal((await f.req('/channels/preferences',undefined,f.bob.token)).data.wechat.maskAmounts,false);
  assert.equal((await f.req('/channels/preferences/wechat',{maskAmounts:false},undefined,'PATCH')).status,401);
  for(const value of ['false',0,null,{}])assert.equal((await f.call('/channels/preferences/feishu',{maskAmounts:value},'PATCH')).status,400);
  assert.equal((await f.call('/channels/preferences/other',{maskAmounts:true},'PATCH')).status,400);
  await f.call('/channels/preferences/feishu',{maskAmounts:true},'PATCH');
  const {code}=f.channels.router.createCode(f.user,'123456'),b=f.channels.router.bind('feishu','owner',code);await f.call(`/channels/${b.id}/unbind`,{pin:'123456'});
  f.channels.router.bind('feishu','owner',f.channels.router.createCode(f.user,'123456').code);assert.equal((await f.call('/channels/preferences')).data.feishu.maskAmounts,true);
  const dir=await mkdtemp(join(tmpdir(),'channel-preferences-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'bank.sqlite');await backup(f.bank.db,path);
  const reopened=createBank(path);try{assert.deepEqual(channelPreferences(reopened,f.user.id),{feishu:{maskAmounts:true},wechat:{maskAmounts:true}});}finally{reopened.db.close();}
});

test('飞书微信独立展示金额，隐藏中文/无单位/符号金额，保留编号与链接',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code);
  const answer='余额：123.45；可用资金 100.50元，收入￥200.00，支出一百元。日期2026-10-08，收益率2.18%。';
  const fs=async id=>{f.queue.push(llm([],answer));return f.channels.router.receive({channel:'feishu',externalId:'fs-owner',messageId:id,text:'查询余额'});};
  assert.match(await fs('show'),/123\.45/);
  await f.call('/channels/preferences/feishu',{maskAmounts:true},'PATCH');assert.doesNotMatch(await fs('hide'),/123\.45|100\.50|200\.00|一百/);
  f.queue.push(llm([],answer));await f.receive('查询余额','wx-show');await f.channels.wechat.drain();assert.match(f.state.sent.at(-1).msg.item_list[0].text_item.text,/123\.45/);
  await f.call('/channels/preferences/wechat',{maskAmounts:true},'PATCH');await f.call('/channels/preferences/feishu',{maskAmounts:false},'PATCH');
  f.queue.push(llm([],answer));await f.receive('查询余额','wx-hide');await f.channels.wechat.drain();const hidden=f.state.sent.at(-1).msg.item_list[0].text_item.text;
  assert.doesNotMatch(hidden,/123\.45|100\.50|200\.00|一百/);assert.match(hidden,/2026-10-08/);assert.match(hidden,/2\.18%/);assert.match(await fs('show-again'),/123\.45/);
  const id=f.bank.get("SELECT id FROM wechat_inbox WHERE upstream_message_id='wx-hide'").id;assert.match((await f.call('/channels/wechat/requests/'+id)).data.result.text,/123\.45/);
  const masked=maskMoney('转账 ¥1,234.56，RMB300，200美元，100万元，ACT123456，https://bank.test/#tasks?action=ACT123456，尾号****1206');
  assert.doesNotMatch(masked,/1,234\.56|300|200|100/);assert.match(masked,/ACT123456/);assert.match(masked,/\*\*\*\*1206/);
  const long=wechatResultText({text:'账单明细🙂'.repeat(1000),events:[]},'WXREQ123','https://bank.test',f.bank);
  assert.ok(Buffer.byteLength(long)<3500);assert.match(long,/完整结果：https:\/\/bank.test\/#wechat-requests\/WXREQ123/);assert.doesNotMatch(long,/\uFFFD/);
});

test('微信待发与明确限流重试使用最新开关，业务通知同样生效',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();await f.channels.wechat.delivery.stop();
  f.queue.push(llm([],'余额123.45元'));await f.receive('查余额','pending');await f.channels.wechat.drain();await f.call('/channels/preferences/wechat',{maskAmounts:true},'PATCH');
  f.channels.wechat.delivery.start();await f.channels.wechat.delivery.drain();assert.doesNotMatch(f.state.sent.at(-1).msg.item_list[0].text_item.text,/123\.45/);
  await f.call('/channels/preferences/wechat',{maskAmounts:false},'PATCH');f.state.sendOverride=()=>Response.json({ret:429},{status:429});
  f.queue.push(llm([],'余额567.89元'));await f.receive('再查','retry');await f.channels.wechat.drain();const before=f.state.sent.at(-1).msg;assert.match(before.item_list[0].text_item.text,/567\.89/);
  await f.call('/channels/preferences/wechat',{maskAmounts:true},'PATCH');f.state.sendOverride=null;f.bank.run("UPDATE wechat_deliveries SET next_at=0 WHERE status='retry_wait'");await f.channels.wechat.delivery.drain();
  assert.notEqual(f.state.sent.at(-1).msg.client_id,before.client_id);assert.doesNotMatch(f.state.sent.at(-1).msg.item_list[0].text_item.text,/567\.89/);
  const action=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'12.34'},{channel:'wechat',sessionId:f.binding().binding_session_id});f.services.confirm(f.user,action.id,{pin:'123456'});await f.channels.flush();
  assert.match(f.state.sent.at(-1).msg.item_list[0].text_item.text,/操作完成/);assert.doesNotMatch(f.state.sent.at(-1).msg.item_list[0].text_item.text,/12\.34/);
  await f.call('/channels/preferences/wechat',{maskAmounts:false},'PATCH');f.services.pushResult(f.services.owned(f.user,action.id),'【操作完成】转账 ¥12.34');await f.channels.flush();assert.match(f.state.sent.at(-1).msg.item_list[0].text_item.text,/12\.34/);
});

test('飞书业务回推按实际发送时的开关处理',async t=>{
  const sent=[];const sdk={LoggerLevel:{warn:2},Client:class{im={v1:{message:{create:async arg=>{sent.push(JSON.parse(arg.data.content).text);return {code:0};}}}}},WSClient:class{start(){}close(){}},EventDispatcher:class{register(){return this;}}};
  const f=await fixture(t,{channels:{feishu:{appId:'test',appSecret:'test',sdk}}});const b=f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code);
  await f.channels.start();
  f.bank.run('INSERT INTO channel_outbox(id,binding_id,body,next_at) VALUES(?,?,?,?)','out1',b.id,'【操作完成】转账 ¥88.88','2000-01-01');
  await f.call('/channels/preferences/feishu',{maskAmounts:true},'PATCH');await f.channels.flush();assert.doesNotMatch(sent.at(-1),/88\.88/);
  await f.call('/channels/preferences/feishu',{maskAmounts:false},'PATCH');f.bank.run('INSERT INTO channel_outbox(id,binding_id,body,next_at) VALUES(?,?,?,?)','out2',b.id,'【操作完成】转账 ¥88.88','2000-01-01');await f.channels.flush();assert.match(sent.at(-1),/88\.88/);
});
