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
