import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { executeTool } from '../server/agent/tools.mjs';
import { createExecutionCoordinator, enqueueExecution } from '../server/agent/execution.mjs';
import { createRiskTransfers } from '../server/risk/transfers.mjs';
import { createMockPaymentAdapter } from '../server/risk/payment.mjs';

test('PUMA T04/T21: STOP cancels queued work and reminders; resume never revives old epoch', async t => {
  const f=await fixture(t), coordinator=createExecutionCoordinator(f.bank);
  const slot=await coordinator.acquire(f.user.id,'before-stop','app');
  enqueueExecution(f.bank,f.user.id,'old-queued','app');
  await executeTool(f.services,f.user,'set_reminder',{at:new Date(Date.now()+3600000).toISOString(),text:'提醒'});
  const abort=new AbortController(),off=f.services.agentControl.register(f.user.id,abort);t.after(off);
  const result=await f.call('/agent/control/stop',{});
  assert.equal(result.status,200);assert.equal(result.data.stopped,true);assert.equal(abort.signal.aborted,true);
  assert.equal(f.bank.get("SELECT COUNT(*) n FROM scheduled_tasks WHERE user_id=? AND status='pending'",f.user.id).n,0);
  await assert.rejects(executeTool(f.services,f.user,'get_overview',{}),{code:'AGENT_STOPPED'});
  assert.equal((await f.call('/agent/control/resume',{pin:'000000'})).status,403);
  assert.equal((await f.call('/agent/control/resume',{pin:'123456'})).status,200);
  assert.throws(()=>slot.assert(),{code:'EXECUTION_FENCED'});
  await assert.rejects(coordinator.acquire(f.user.id,'old-queued','app'),{code:'AGENT_STOPPED'});
  assert.equal((await executeTool(f.services,f.user,'get_overview',{})).ok,true);
  slot.release();
});

test('PUMA T01/T02/T03/T05: bound approvals, STOP preserves submitted provider truth', async t => {
  const f=await fixture(t), adapter=createMockPaymentAdapter(f.bank,{initialStatus:'PENDING'});
  const transfers=createRiskTransfers(f.bank,f.services,f.services.risk,{adapter});
  const body={sourceAccountRef:f.services.accountFor(f.user).id,beneficiaryRef:f.recipient,amountMinor:10000,currency:'CNY'};
  const d=transfers.drafts.create(f.user,body);
  assert.throws(()=>transfers.executor.submit(f.user,d.id),{code:'APPROVAL_REQUIRED'});
  const i=transfers.approvals.intent(f.user,d.id,{version:d.version,payloadHash:d.payloadHash});
  transfers.approvals.approve(f.user,d.id,{...Object.fromEntries(['version','payloadHash','challengeId'].map(k=>[k,i[k]])),pin:'123456',...(i.verificationActionId?{verificationToken:await f.verify(i.verificationActionId)}:{})});
  transfers.executor.submit(f.user,d.id);transfers.executor.submit(f.user,d.id);
  const before=transfers.drafts.view(f.user,d.id).status;
  const stopped=await f.call('/agent/control/stop',{});
  assert.equal(stopped.status,200);
  assert.equal(stopped.data.payments[0].status,before);
  assert.equal(transfers.drafts.view(f.user,d.id).status,before);
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM risk_mock_provider').n,1);
  assert.equal(stopped.data.providerCancellation,'UNSUPPORTED_BY_PROVIDER');
});

test('PUMA STOP revokes unsubmitted draft approval and allows owner inspection', async t => {
  const f=await fixture(t);
  const d=f.services.riskDrafts.create(f.user,{sourceAccountRef:f.services.accountFor(f.user).id,beneficiaryRef:f.recipient,amountMinor:10000,currency:'CNY'});
  assert.equal((await f.call('/agent/control/stop',{})).status,200);
  assert.equal((await f.call(`/v1/transfers/drafts/${d.id}`)).data.status,'CANCELLED');
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM risk_payments').n,0);
});

test('过期草稿不阻断 STOP、撤销授权和取消', async t => {
  const f=await fixture(t), body={sourceAccountRef:f.services.accountFor(f.user).id,beneficiaryRef:f.recipient,amountMinor:10000,currency:'CNY'};
  const create=(expired=false)=>{const d=f.services.riskDrafts.create(f.user,body);if(expired)f.bank.run("UPDATE risk_drafts SET expires_at='2020-01-01' WHERE id=?",d.id);return d.id;};
  const status=id=>f.bank.get('SELECT status FROM risk_drafts WHERE id=?',id).status;
  const stale=create(true), open=create();
  const stopped=await f.call('/agent/control/stop',{});
  assert.equal(stopped.status,200,JSON.stringify(stopped.data));assert.equal(stopped.data.stopped,true);
  assert.equal(status(stale),'EXPIRED');assert.equal(status(open),'CANCELLED');
  assert.equal((await f.call('/agent/control/resume',{pin:'123456'})).status,200);
  const lapsed=create(true);
  const revoked=await f.call('/v1/puma/consents',{scope:'agent_tools',granted:false});
  assert.equal(revoked.status,200,JSON.stringify(revoked.data));assert.equal(status(lapsed),'EXPIRED');
  const single=create(true);
  const cancelled=await f.call(`/v1/transfers/drafts/${single}/cancel`,{});
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.data));assert.equal(cancelled.data.status,'EXPIRED');assert.equal(status(single),'EXPIRED');
  const batch=[create(true),create()];
  assert.deepEqual(f.services.riskDrafts.cancelOpen(f.user).map(d=>d.status).sort(),['CANCELLED','EXPIRED']);
  assert.deepEqual(batch.map(status).sort(),['CANCELLED','EXPIRED']);
});

test('撤销 data_read 后不能读风险摘要', async t => {
  const f=await fixture(t);
  f.services.riskDrafts.create(f.user,{sourceAccountRef:f.services.accountFor(f.user).id,beneficiaryRef:f.recipient,amountMinor:10000,currency:'CNY'});
  assert.equal((await executeTool(f.services,f.user,'get_finance_risk_summary',{})).ok,true);
  assert.equal((await f.call('/v1/puma/consents',{scope:'data_read',granted:false})).status,200);
  await assert.rejects(executeTool(f.services,f.user,'get_finance_risk_summary',{}),{code:'DATA_CONSENT_REQUIRED'});
});

test('工具调用 id 含特殊字符仍可执行', async t => {
  const f=await fixture(t);
  for(const toolCallId of ['0:call_abc|fc_def','0:call+abc=','0:'+'x'.repeat(300)])assert.equal((await executeTool(f.services,f.user,'get_overview',{},{channel:'app',toolCallId})).ok,true,toolCallId);
});
