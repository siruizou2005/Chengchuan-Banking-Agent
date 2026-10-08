import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatFixture,llm,until } from './wechat-helpers.mjs';
import { fixture } from './helpers.mjs';
import { executeTool } from '../server/agent/tools.mjs';
import { commitToolEffect,createExecutionCoordinator } from '../server/agent/execution.mjs';

test('工具效果同事务幂等：重复调用复用、参数冲突拒绝、失败回滚、未决不重放',async t=>{
  const f=await fixture(t);const context={channel:'app',requestId:'effect-request',runId:'effect-run',toolCallId:'effect-tool'};
  const first=await executeTool(f.services,f.user,'propose_transfer',{recipient:f.recipient,amount:'20'},context);
  const second=await executeTool(f.services,f.user,'propose_transfer',{recipient:f.recipient,amount:'20'},context);assert.equal(first.actionId,second.actionId);
  assert.equal(f.bank.get('SELECT count(*) n FROM agent_actions').n,1);
  await assert.rejects(executeTool(f.services,f.user,'propose_transfer',{recipient:f.recipient,amount:'21'},context),e=>e.code==='TOOL_EFFECT_MISMATCH');
  assert.throws(()=>commitToolEffect(f.bank,f.user.id,'test',{},{...context,toolCallId:'rollback'},()=>{f.bank.run('INSERT INTO agent_memory VALUES(?,?,?,?)',f.user.id,'rollback','bad',new Date().toISOString());throw Error('crash');}));
  assert.equal(f.bank.get("SELECT * FROM agent_memory WHERE key='rollback'"),undefined);
  assert.equal(f.bank.get("SELECT status FROM agent_tool_effects WHERE tool_call_id='rollback'").status,'failed');
  f.bank.run("UPDATE agent_tool_effects SET status='prepared' WHERE tool_call_id='effect-tool'");await assert.rejects(executeTool(f.services,f.user,'propose_transfer',{recipient:f.recipient,amount:'20'},context),e=>e.code==='TOOL_EFFECT_UNRESOLVED');
});

test('旧执行租约不能提交工具副作用或最终消息',async t=>{
  let release;const waiting=new Promise(r=>release=r);
  const f=await wechatFixture(t,{wechat:{feedback:false},chat:{fetch:async()=>{await waiting;return Response.json(llm([['remember',{key:'unsafe',value:'should not commit'}]]));}}});await f.bind();await f.receive('记住偏好','old-worker');
  const work=f.channels.wechat.drain();await until(()=>f.bank.get("SELECT * FROM wechat_inbox WHERE status='running'"));
  f.bank.run("UPDATE wechat_inbox SET lease_until=0 WHERE status='running'");f.channels.wechat.inbox.maintain();release();await work;
  assert.equal(f.bank.get("SELECT * FROM agent_memory WHERE key='unsafe'"),undefined);assert.equal(f.bank.get('SELECT status FROM wechat_inbox').status,'interrupted');assert.equal(f.bank.get("SELECT count(*) n FROM wechat_deliveries WHERE kind='final'").n,0);
  const binding=f.binding();await f.call(`/channels/${binding.id}/unbind`,{pin:'123456'});assert.equal(f.binding().status,'revoked');
});

test('微信入库即排队，不被后到App插队；普通执行槽占满时取消命令仍可处理',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=await wechatFixture(t,{wechat:{executionConcurrency:1},chat:{fetch:async()=>{await wait;return Response.json(llm());}}});await f.bind();
  await f.receive('先到微信','first');const coordinator=createExecutionCoordinator(f.bank);let acquired=false;
  const app=coordinator.acquire(f.user.id,'later-app','app').then(slot=>{acquired=true;return slot;});
  await new Promise(r=>setTimeout(r,40));assert.equal(acquired,false);
  const action=f.services.propose(f.user,'propose_transfer',{recipient:f.recipient,amount:'1'},{channel:'wechat',sessionId:f.binding().binding_session_id});
  const work=f.channels.wechat.drain();await until(()=>f.bank.get("SELECT 1 FROM wechat_inbox WHERE status='running'"));
  await f.receive('取消 '+action.id,'cancel-during-wait');f.channels.wechat.inbox.kick();
  await until(()=>f.services.owned(f.user,action.id).status==='cancelled');assert.equal(acquired,false);
  release();await work;const slot=await app;slot.release();assert.equal(acquired,true);
});

test('App与微信共用FIFO执行槽，过期持有者不能续写',async t=>{
  const f=await fixture(t),a=createExecutionCoordinator(f.bank),b=createExecutionCoordinator(f.bank);
  const first=await a.acquire(f.user.id,'app-request','app');
  let claimed=false;const second=b.acquire(f.user.id,'wx-request','wechat').then(s=>{claimed=true;return s;});
  await new Promise(r=>setTimeout(r,50));assert.equal(claimed,false);first.release();const next=await second;next.assert();assert.throws(()=>first.assert(),e=>e.code==='EXECUTION_FENCED');next.release();
});
