import test from 'node:test';
import assert from 'node:assert/strict';
import { backup } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { executeTool } from '../server/agent/tools.mjs';
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
