import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { requireThat } from '../errors.mjs';
import { canonical } from '../authorization.mjs';

// One durable FIFO and execution lease for App, Feishu and WeChat.
export function enqueueExecution(bank,userId,requestId,channel,deadline=Date.now()+30000) {
  bank.run("INSERT OR IGNORE INTO agent_execution_queue(request_id,user_id,channel,status,owner,deadline,created_at) VALUES(?,?,?,'queued','',?,?)",requestId,userId,channel,deadline,Date.now());
}
export function createExecutionCoordinator(bank, options = {}) {
  const owner = randomUUID(), ttl = options.leaseMs || 60000, waitMs = options.queueMs || 30000;
  async function acquire(userId, requestId, channel, signal) {
    const time = Date.now();
    bank.atomic(()=>{
      enqueueExecution(bank,userId,requestId,channel,time+waitMs);
      requireThat(bank.run("UPDATE agent_execution_queue SET owner=? WHERE request_id=? AND user_id=? AND channel=? AND status='queued' AND owner=''",owner,requestId,userId,channel).changes,'请求已领取或结束',409,'EXECUTION_FENCED');
    });
    try {
      for (;;) {
        signal?.throwIfAborted();
        const claim = bank.atomic(() => {
          const t = Date.now();
          bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE user_id=? AND status='queued' AND deadline<=?",userId,t);
          requireThat(bank.get("SELECT 1 FROM agent_execution_queue WHERE request_id=? AND status='queued'",requestId),'等待处理超时，请稍后重试',429,'CHAT_QUEUE_TIMEOUT');
          const first = bank.get("SELECT request_id FROM agent_execution_queue WHERE user_id=? AND status='queued' ORDER BY seq LIMIT 1",userId);
          if (first?.request_id !== requestId) return;
          bank.run('INSERT OR IGNORE INTO user_execution_leases(user_id) VALUES(?)',userId);
          if (!bank.run('UPDATE user_execution_leases SET request_id=?,lease_owner=?,lease_epoch=lease_epoch+1,lease_until=? WHERE user_id=? AND lease_until<=?',requestId,owner,t+ttl,userId,t).changes) return;
          bank.run("UPDATE agent_execution_queue SET status='running' WHERE request_id=?",requestId);
          return bank.get('SELECT * FROM user_execution_leases WHERE user_id=?',userId);
        });
        if (claim) {
          const assert = () => requireThat(bank.get('SELECT 1 FROM user_execution_leases WHERE user_id=? AND request_id=? AND lease_owner=? AND lease_epoch=? AND lease_until>?',userId,requestId,owner,claim.lease_epoch,Date.now()),'本次执行已停止',409,'EXECUTION_FENCED');
          const heartbeat=setInterval(()=>{bank.run('UPDATE user_execution_leases SET lease_until=? WHERE user_id=? AND request_id=? AND lease_owner=? AND lease_epoch=? AND lease_until>?',Date.now()+ttl,userId,requestId,owner,claim.lease_epoch,Date.now());},Math.max(10,Math.floor(ttl/3)));heartbeat.unref?.();
          return { assert, release() { clearInterval(heartbeat); bank.atomic(()=>{bank.run('UPDATE user_execution_leases SET lease_until=0 WHERE user_id=? AND request_id=? AND lease_owner=? AND lease_epoch=?',userId,requestId,owner,claim.lease_epoch);bank.run("UPDATE agent_execution_queue SET status='finished' WHERE request_id=? AND owner=?",requestId,owner);}); } };
        }
        await delay(25,undefined,{signal});
      }
    } catch (error) { bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id=? AND status='queued'",requestId); throw error; }
  }
  return { acquire };
}

export function assertChannelExecution(bank, context, userId) {
  context.assertExecution?.();
  if (!['wechat','feishu'].includes(context.channel)) return;
  const binding=bank.get("SELECT * FROM channel_bindings WHERE (id=? OR binding_session_id=?) AND user_id=? AND channel=? AND status='active' AND auth_state='valid'",context.bindingId||context.sessionId||null,context.sessionId||null,userId,context.channel);
  requireThat(binding,'消息渠道需要重新认证，请回App连接',403,'CHANNEL_REAUTH_REQUIRED');
  if(context.bindingGeneration!==undefined) requireThat(binding.binding_generation===context.bindingGeneration && binding.binding_session_id===context.bindingSessionId,'渠道绑定已变更',409,'BINDING_FENCED');
  requireThat(!bank.get("SELECT 1 FROM accounts WHERE user_id=? AND type='debit' AND status<>'active'",userId),'账户状态暂不支持渠道查询，请回App查看',403,'CHANNEL_ACCOUNT_UNAVAILABLE');
}

// Only synchronous, same-database effects may enter this helper.
export function commitToolEffect(bank,userId,name,args,context,perform) {
  const requestId=context.requestId||context.runId, toolId=context.toolCallId;
  const digest=createHash('sha256').update(JSON.stringify(canonical({name,args}))).digest('hex');
  if(!requestId||!toolId) return bank.atomic(()=>{assertChannelExecution(bank,context,userId);return perform();});
  const previous=bank.get('SELECT * FROM agent_tool_effects WHERE request_id=? AND tool_call_id=?',requestId,toolId);
  if(previous) {
    assertChannelExecution(bank,context,userId);
    requireThat(previous.args_digest===digest,'重复工具调用参数不一致',409,'TOOL_EFFECT_MISMATCH');
    requireThat(previous.status==='committed','此工具调用需要核对，不能重复执行',409,'TOOL_EFFECT_UNRESOLVED');
    return JSON.parse(previous.result_json);
  }
  bank.atomic(()=>{
    assertChannelExecution(bank,context,userId);
    bank.run("INSERT INTO agent_tool_effects(request_id,run_id,tool_call_id,effect_type,args_digest,status,binding_id,binding_session_id,binding_generation,created_at) VALUES(?,?,?,?,?,'prepared',?,?,?,?)",requestId,context.runId||null,toolId,name,digest,context.bindingId||null,context.bindingSessionId||null,context.bindingGeneration||null,Date.now());
  });
  try {
    return bank.atomic(()=>{
      assertChannelExecution(bank,context,userId);
      requireThat(bank.get("SELECT 1 FROM agent_tool_effects WHERE request_id=? AND tool_call_id=? AND status='prepared'",requestId,toolId),'工具调用已处理',409,'TOOL_EFFECT_UNRESOLVED');
      const result=perform();requireThat(!result?.then,'副作用事务不能执行异步操作',500);
      bank.run("UPDATE agent_tool_effects SET status='committed',effect_ref=?,result_json=?,committed_at=? WHERE request_id=? AND tool_call_id=?",result.actionId||result.data?.id||`${requestId}:${toolId}`,JSON.stringify(result),Date.now(),requestId,toolId);
      return result;
    });
  } catch(error) { bank.run("UPDATE agent_tool_effects SET status='failed',safe_error_code=? WHERE request_id=? AND tool_call_id=? AND status='prepared'",error.code||'TOOL_ERROR',requestId,toolId); throw error; }
}
