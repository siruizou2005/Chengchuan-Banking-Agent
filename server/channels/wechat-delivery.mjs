import { randomUUID } from 'node:crypto';
import { id } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { bindingFor, assertLease, resultLink, wechatResultText } from './wechat-state.mjs';
import { channelText } from './preferences.mjs';
import { accountUnavailable } from './refusal.mjs';
import { REPORT_DELIVERY_MS, reportDeliveryNotice } from './reports.mjs';

const transient=new Set(['ack','progress']),ACTION_RESULT_MS=900000;
// Refusals and command replies must reach a depositor whose card is frozen; account data must not.
const accountData=new Set(['final','report','action_result']);
export function createWeChatDelivery(services,crypto,send,options={}) {
  const {bank}=services,owner=randomUUID(),active=new Map(),ttl=options.sendLeaseMs||15000;
  const concurrency=options.sendConcurrency||Number(process.env.WECHAT_SEND_CONCURRENCY)||4;
  const origin=options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
  let stopped=false;
  function enqueue(binding,{requestId=null,kind,body,context=null,sourceOutboxId=null,expiresMs,partIndex=0}) {
    const time=Date.now(),deliveryId=id('WXOUT');
    const duration=expiresMs??(kind==='ack'?3000:kind==='progress'?5000:kind==='action_result'?ACTION_RESULT_MS:kind==='report'?REPORT_DELIVERY_MS:300000);
    bank.run(`INSERT OR IGNORE INTO wechat_deliveries(id,binding_id,binding_session_id,binding_generation,request_id,kind,part_index,client_id,body_cipher,context_token_cipher,priority,next_at,expires_at,created_at,source_outbox_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,deliveryId,binding.id,binding.binding_session_id,binding.binding_generation,requestId,kind,partIndex,id('wx'),crypto.encrypt(body),context,kind==='progress'?3:kind==='ack'?1:0,time,time+duration,time,sourceOutboxId);
    return deliveryId;
  }
  function notice(row) {
    if(transient.has(row.kind))return;
    const binding=bank.get('SELECT user_id FROM channel_bindings WHERE id=? AND binding_generation=? AND binding_session_id=?',row.binding_id,row.binding_generation,row.binding_session_id);
    if(binding&&!bank.get("SELECT id FROM audit WHERE action='wechat.delivery_notice' AND resource_id=?",row.id)) {
      const report=row.kind==='report'&&reportDeliveryNotice(bank,origin,row.source_outbox_id,'wechat');
      if(report)bank.notify(binding.user_id,report.title,report.body);
      else bank.notify(binding.user_id,'微信回复送达未确认',`结果已生成，微信回复暂时无法确认送达。请在App查看：${row.request_id?resultLink(origin,row.request_id):'/#tasks'}`);
      bank.audit(binding.user_id,'wechat.delivery_notice',row.id,{requestId:row.request_id});
    }
  }
  function cancelFeedback(requestId) {
    bank.run("UPDATE wechat_deliveries SET status='cancelled' WHERE request_id=? AND kind IN ('ack','progress') AND status IN ('pending','retry_wait')",requestId);
  }
  // Notices wait here while the channel is switched off; once their delivery window has passed they must not all arrive when it returns.
  function expireOutbox(at=Date.now()) {
    bank.run("UPDATE channel_outbox SET status='expired' WHERE status='pending' AND binding_id IN (SELECT id FROM channel_bindings WHERE channel='wechat') AND next_at<=CASE WHEN kind='report' THEN ? ELSE ? END",new Date(at-REPORT_DELIVERY_MS).toISOString(),new Date(at-ACTION_RESULT_MS).toISOString());
  }
  function bridge() {
    bank.atomic(()=>{
      expireOutbox();
      for(const out of bank.all("SELECT o.* FROM channel_outbox o JOIN channel_bindings b ON b.id=o.binding_id WHERE b.channel='wechat' AND o.status='pending' LIMIT 50")) {
        const binding=bank.get('SELECT * FROM channel_bindings WHERE id=?',out.binding_id);
        // A report belongs to the binding generation it was written for; it carries its own App link.
        const report=out.kind==='report';
        if(binding.status!=='active'||(report&&out.binding_generation!==binding.binding_generation)){bank.run("UPDATE channel_outbox SET status='cancelled' WHERE id=?",out.id);continue;}
        enqueue(binding,{kind:report?'report':'action_result',body:report?out.body:out.body+`\n详情：${origin}/#tasks`,sourceOutboxId:out.id});
        bank.run("UPDATE channel_outbox SET status='forwarded' WHERE id=? AND status='pending'",out.id);
      }
    });
  }
  function maintain() {
    bank.atomic(()=>{
      for(const row of bank.all("SELECT * FROM wechat_deliveries WHERE status='sending' AND lease_until<=?",Date.now())) {
        bank.run("UPDATE wechat_deliveries SET status='unknown',needs_review=1,safe_error_code='SEND_LEASE_EXPIRED',lease_epoch=lease_epoch+1 WHERE id=? AND status='sending' AND lease_epoch=?",row.id,row.lease_epoch);notice(row);
      }
      for(const row of bank.all("SELECT * FROM wechat_deliveries WHERE status IN ('pending','retry_wait') AND expires_at<=?",Date.now())) {
        bank.run("UPDATE wechat_deliveries SET status='expired' WHERE id=?",row.id);notice(row);
      }
      bank.run("UPDATE wechat_deliveries SET needs_review=1 WHERE status='unknown' AND started_at<=?",Date.now()-(options.unknownReviewMs||300000));
    });
  }
  function claim() {
    return bank.atomic(()=>{
      for(const row of bank.all("SELECT d.* FROM wechat_deliveries d WHERE d.status IN ('pending','retry_wait') AND d.next_at<=? AND d.expires_at>? ORDER BY d.priority,d.created_at,d.rowid LIMIT 100",Date.now(),Date.now())) {
        if(active.has(row.binding_id)||bank.get("SELECT 1 FROM wechat_deliveries WHERE binding_id=? AND status='sending' AND lease_until>?",row.binding_id,Date.now()))continue;
        let binding;
        try{binding=bindingFor(bank,row);requireThat(!accountData.has(row.kind)||!accountUnavailable(bank,binding.user_id),'账户状态暂不支持渠道查询',403,'CHANNEL_ACCOUNT_UNAVAILABLE');}catch{bank.run("UPDATE wechat_deliveries SET status='cancelled',safe_error_code='BINDING_UNAVAILABLE' WHERE id=?",row.id);notice(row);continue;}
        const inbox=row.request_id&&bank.get('SELECT * FROM wechat_inbox WHERE id=?',row.request_id);
        if(transient.has(row.kind)&&(!inbox||!['queued','running'].includes(inbox.status))){bank.run("UPDATE wechat_deliveries SET status='cancelled' WHERE id=?",row.id);continue;}
        if(!row.context_token_cipher) {
          // A reply belongs to its incoming message. Only proactive notifications may use the latest context.
          if(row.request_id||!binding.context_token)continue;
          bank.run('UPDATE wechat_deliveries SET context_token_cipher=? WHERE id=?',binding.context_token,row.id);
        }
        if(!bank.run("UPDATE wechat_deliveries SET status='sending',attempts=attempts+1,lease_owner=?,lease_until=?,lease_epoch=lease_epoch+1,started_at=? WHERE id=? AND status IN ('pending','retry_wait')",owner,Date.now()+ttl,Date.now(),row.id).changes)continue;
        return bank.get('SELECT * FROM wechat_deliveries WHERE id=?',row.id);
      }
    });
  }
  async function deliver(row,abort) {
    try {
      const binding=bank.atomic(()=>{
        assertLease(bank,'wechat_deliveries',row,owner);const binding=bindingFor(bank,row);
        let body=crypto.decrypt(row.body_cipher);
        if(row.kind==='final'){
          const result=bank.get('SELECT result_json FROM wechat_inbox WHERE id=?',row.request_id)?.result_json;
          if(result)body=wechatResultText(JSON.parse(result),row.request_id,origin,bank);
        }
        if(row.kind==='action_result'||row.kind==='report'){
          const out=bank.get('SELECT body FROM channel_outbox WHERE id=?',row.source_outbox_id);
          if(out)body=row.kind==='report'?out.body:out.body+`\n详情：${origin}/#tasks`;
        }
        body=channelText(bank,binding.user_id,'wechat',body);
        // A setting/status change changes the message content; a known rejected attempt may use a new identity.
        if(row.attempts>1&&body!==crypto.decrypt(row.body_cipher))row.client_id=id('wx');
        row.body_cipher=crypto.encrypt(body);
        bank.run('UPDATE wechat_deliveries SET body_cipher=?,client_id=? WHERE id=?',row.body_cipher,row.client_id,row.id);
        return binding;
      });
      const evidence=await send(binding,crypto.decrypt(row.body_cipher),{signal:abort.signal,clientId:row.client_id,context:crypto.decrypt(row.context_token_cipher),timeoutMs:transient.has(row.kind)?2000:options.sendTimeoutMs||Number(process.env.WECHAT_SEND_TIMEOUT_MS)||8000});
      bank.atomic(()=>{
        assertLease(bank,'wechat_deliveries',row,owner);bindingFor(bank,row);
        bank.run("UPDATE wechat_deliveries SET status='api_accepted',api_accepted_at=?,http_status=?,response_quality=?,server_message_id=?,delivery_evidence='api_response' WHERE id=? AND lease_epoch=?",Date.now(),evidence.httpStatus,evidence.responseQuality,evidence.data?.message_id==null?null:String(evidence.data.message_id),row.id,row.lease_epoch);
        bank.run('UPDATE channel_bindings SET last_api_accepted_at=? WHERE id=? AND binding_generation=?',Date.now(),row.binding_id,row.binding_generation);
      });
    }catch(error){
      bank.atomic(()=>{
        const current=bank.get("SELECT * FROM wechat_deliveries WHERE id=? AND status='sending' AND lease_owner=? AND lease_epoch=?",row.id,owner,row.lease_epoch);
        if(!current)return;
        if(current.lease_until<=Date.now()){
          bank.run("UPDATE wechat_deliveries SET status='unknown',needs_review=1,safe_error_code='SEND_LEASE_EXPIRED',lease_epoch=lease_epoch+1 WHERE id=? AND lease_epoch=?",row.id,row.lease_epoch);notice(row);return;
        }
        let status=error.deliveryState||'unknown';
        if(['BINDING_FENCED','CHANNEL_REAUTH_REQUIRED'].includes(error.code))status='cancelled';
        if(status==='retry_wait'&&(transient.has(row.kind)||row.attempts>=6))status='failed';
        const next=Date.now()+(error.retryAfterMs||Math.min(30000,1000*2**(row.attempts-1))*(0.8+Math.random()*0.4));
        bank.run('UPDATE wechat_deliveries SET status=?,next_at=?,safe_error_code=?,http_status=?,upstream_code=?,needs_review=0 WHERE id=? AND lease_epoch=?',status,Math.ceil(next),error.code||'SEND_UNKNOWN',error.httpStatus||null,error.upstreamCode==null?null:String(error.upstreamCode),row.id,row.lease_epoch);
        if(!['retry_wait','cancelled'].includes(status))notice(row);
      });
    }
  }
  function kick() {
    if(stopped||options.isEnabled?.()===false)return;bridge();maintain();
    while(active.size<concurrency){const row=claim();if(!row)break;const abort=new AbortController();const task=deliver(row,abort).finally(()=>{active.delete(row.binding_id);if(!transient.has(row.kind))options.indicator?.settle(row.binding_id);if(!stopped)queueMicrotask(kick);});active.set(row.binding_id,{abort,task});}
    options.onKick?.();
  }
  // Earliest moment maintain()/claim() has work. A due send that is still pending is blocked (its binding is
  // sending, or the reply lacks context) and is retried when that send finishes, or expires.
  function nextDue(){
    const lease=bank.get("SELECT min(lease_until) v FROM wechat_deliveries WHERE status='sending'").v;
    const waiting=bank.get("SELECT min(CASE WHEN next_at>? THEN min(next_at,expires_at) ELSE expires_at END) v FROM wechat_deliveries WHERE status IN ('pending','retry_wait')",Date.now()).v;
    const review=bank.get("SELECT min(started_at) v FROM wechat_deliveries WHERE status='unknown' AND needs_review=0").v;
    return Math.min(lease??Infinity,waiting??Infinity,review==null?Infinity:review+(options.unknownReviewMs||300000));
  }
  async function drain(){kick();while(active.size)await Promise.all([...active.values()].map(v=>v.task));}
  async function stop(){stopped=true;for(const v of active.values())v.abort.abort();await Promise.all([...active.values()].map(v=>v.task));}
  function revoke(bindingId){for(const [key,v] of active)if(key===bindingId)v.abort.abort();bank.run("UPDATE wechat_deliveries SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'cancelled' END,needs_review=CASE WHEN status='sending' THEN 1 ELSE needs_review END,lease_epoch=lease_epoch+1 WHERE binding_id=? AND status IN ('pending','retry_wait','sending')",bindingId);}
  return {enqueue,cancelFeedback,kick,nextDue,drain,stop,revoke,maintain,expireOutbox,start(){stopped=false;}};
}
