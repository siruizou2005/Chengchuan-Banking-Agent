import { randomUUID, createHash } from 'node:crypto';
import { id } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { enqueueExecution } from '../agent/execution.mjs';
import { bindingFor, assertLease, resultLink, wechatResultText } from './wechat-state.mjs';

const commandPattern=/^(帮助|help|解绑|确认(?:\s+[A-Za-z0-9]+)?|取消(?:\s+[A-Za-z0-9]+)?)$/i;
export function createWeChatInbox(services,router,delivery,options={}) {
  const {bank}=services,crypto=router.crypto,owner=randomUUID(),active=new Map(),ttl=options.executionLeaseMs||60000;
  const origin=options.publicOrigin??process.env.PUBLIC_ORIGIN??'',maxPending=options.maxPending||Number(process.env.WECHAT_MAX_PENDING_PER_USER)||3;
  const progressMs=options.progressMs??Number(process.env.WECHAT_PROGRESS_AFTER_MS||4000),feedback=options.feedback??process.env.WECHAT_FEEDBACK_ENABLED!=='false';
  const typing=options.indicator,acknowledging=new Set();
  let stopped=false;
  function ingest(binding,data,assertPoll=()=>{}) {
    const acks=[];
    const accepted=bank.atomic(()=>{
      assertPoll();bindingFor(bank,binding);
      const accepted=[];
      for(const message of data.msgs||[]) {
        if(message.message_type!==1||message.group_id||message.from_user_id!==binding.external_id)continue;
        const upstreamId=message.message_id??message.msg_id;
        if(!upstreamId||(typeof upstreamId==='number'&&!Number.isSafeInteger(upstreamId))) {
          const digest=createHash('sha256').update(String(data.get_updates_buf||binding.cursor)).digest('hex');
          bank.run("INSERT OR IGNORE INTO wechat_quarantine(binding_id,binding_generation,reason,batch_digest,created_at) VALUES(?,?,'MISSING_STABLE_MESSAGE_ID',?,?)",binding.id,binding.binding_generation,digest,Date.now());continue;
        }
        if(bank.get('SELECT 1 FROM wechat_inbox WHERE binding_id=? AND binding_generation=? AND upstream_message_id=?',binding.id,binding.binding_generation,String(upstreamId)))continue;
        const text=(message.item_list||[]).filter(i=>i.type===1&&typeof i.text_item?.text==='string').map(i=>i.text_item.text).join('\n');
        const isCommand=commandPattern.test(text.trim()),requestId=id('WXREQ'),time=Date.now();
        const context=typeof message.context_token==='string'&&message.context_token?crypto.encrypt(message.context_token):null;
        if(context)bank.run('UPDATE channel_bindings SET context_token=?,context_updated_at=? WHERE id=?',context,time,binding.id);
        const count=bank.get("SELECT count(*) AS n FROM wechat_inbox WHERE user_id=? AND status IN ('queued','running') AND is_command=0",binding.user_id).n;
        const reason=!text||text.length>6000?'仅支持不超过6000字的文字消息，请用文字描述需求。':process.env.AGENT_DISABLED==='true'&&!isCommand?'智能助手暂不可用，请在App办理。':!isCommand&&count>=maxPending?'当前请求较多，这次还未开始处理，请稍后重试。':null;
        bank.run(`INSERT INTO wechat_inbox(id,binding_id,binding_session_id,binding_generation,user_id,upstream_message_id,upstream_created_at,input_cipher,context_token_cipher,status,is_command,received_at,queue_deadline,run_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,requestId,binding.id,binding.binding_session_id,binding.binding_generation,binding.user_id,String(upstreamId),Number.isFinite(message.create_time_ms)?message.create_time_ms:null,crypto.encrypt(text.slice(0,6000)),context,reason?'failed':'queued',isCommand?1:0,time,time+(options.queueMs||30000),id('RUN'));
        if(reason){bank.run('UPDATE wechat_inbox SET result_json=?,finished_at=? WHERE id=?',JSON.stringify({text:reason,events:[]}),time,requestId);delivery.enqueue(binding,{requestId,kind:'error',body:reason,context});}
        else if(feedback&&!isCommand)acks.push({plain:message.context_token});
        if(!reason&&!isCommand)enqueueExecution(bank,binding.user_id,requestId,'wechat',time+(options.queueMs||30000));
        accepted.push(requestId);
      }
      if(typeof data.get_updates_buf==='string'&&data.get_updates_buf)bank.run('UPDATE channel_bindings SET cursor=? WHERE id=?',data.get_updates_buf,binding.id);
      bank.run("UPDATE channel_bindings SET last_poll_at=?,last_inbound_at=CASE WHEN ? > 0 THEN ? ELSE last_inbound_at END,connection_state=CASE WHEN ?>0 THEN 'receiving' ELSE connection_state END WHERE id=?",Date.now(),accepted.length,Date.now(),accepted.length,binding.id);
      return accepted;
    });
    if(acks.length){const task=acknowledge(binding,acks).catch(()=>{}).finally(()=>acknowledging.delete(task));acknowledging.add(task);}
    return accepted;
  }
  // Typing is best effort; text feedback waits for the deadline measured from receipt.
  async function acknowledge(binding,acks) {
    await typing?.start(binding,acks.at(-1).plain).catch(()=>false);
  }
  function complete(row,result,error=null) {
    bank.atomic(()=>{
      assertLease(bank,'wechat_inbox',row,owner);const binding=bindingFor(bank,row);
      requireThat(bank.run("UPDATE wechat_inbox SET status=?,finished_at=?,result_json=?,safe_error_code=? WHERE id=? AND status='running' AND lease_epoch=?",error?'failed':'completed',Date.now(),JSON.stringify(result),error?.code||null,row.id,row.lease_epoch).changes,'请求已结束',409,'WORKER_FENCED');
      delivery.cancelFeedback(row.id);
      const body=error?'这次未能完成处理。已生成的操作可在App查看；查询可以稍后重试。\n'+resultLink(origin,row.id):row.is_command?result.text:wechatResultText(result,row.id,origin,bank);
      delivery.enqueue(binding,{requestId:row.id,kind:error?'error':row.is_command?'command':'final',body,context:row.context_token_cipher});
    });
  }
  function maintain(){
    bank.atomic(()=>{
      for(const row of bank.all("SELECT * FROM wechat_inbox WHERE (status='running' AND lease_until<=?) OR (status='queued' AND queue_deadline<=?)",Date.now(),Date.now())) {
        const text=row.status==='queued'?'当前请求较多，这次还未开始处理，请稍后重试。':'这次请求处理中断，已生成的操作请在App查看。';
        bank.run("UPDATE wechat_inbox SET status='interrupted',finished_at=?,lease_epoch=lease_epoch+1,result_json=?,safe_error_code='REQUEST_INTERRUPTED' WHERE id=? AND status=? AND lease_epoch=?",Date.now(),JSON.stringify({text,events:[]}),row.id,row.status,row.lease_epoch);
        delivery.cancelFeedback(row.id);
        bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id=? AND status IN ('queued','running')",row.id);
        try{const binding=bindingFor(bank,row);delivery.enqueue(binding,{requestId:row.id,kind:'error',body:text+'\n'+resultLink(origin,row.id),context:row.context_token_cipher});}catch{}
      }
      if(feedback)for(const row of bank.all("SELECT * FROM wechat_inbox WHERE status IN ('queued','running') AND is_command=0 AND progress_sent=0 AND received_at<=?",Date.now()-progressMs)){
        try{const binding=bindingFor(bank,row);delivery.enqueue(binding,{requestId:row.id,kind:'progress',body:'正在处理',context:row.context_token_cipher});bank.run('UPDATE wechat_inbox SET progress_sent=1 WHERE id=?',row.id);}catch{bank.run('UPDATE wechat_inbox SET progress_sent=1 WHERE id=?',row.id);}
      }
    });
  }
  function claim(command=false){
    return bank.atomic(()=>{
      for(const row of bank.all("SELECT * FROM wechat_inbox WHERE status='queued' AND queue_deadline>? AND is_command=? ORDER BY seq LIMIT 100",Date.now(),command?1:0)) {
        if(!row.is_command&&[...active.values()].some(a=>a.userId===row.user_id&&!a.command))continue;
        try{bindingFor(bank,row);}catch{bank.run("UPDATE wechat_inbox SET status='cancelled',finished_at=?,safe_error_code='CHANNEL_REAUTH_REQUIRED' WHERE id=?",Date.now(),row.id);bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id=? AND status='queued'",row.id);delivery.cancelFeedback(row.id);continue;}
        if(bank.run("UPDATE wechat_inbox SET status='running',lease_owner=?,lease_epoch=lease_epoch+1,lease_until=?,started_at=? WHERE id=? AND status='queued'",owner,Date.now()+ttl,Date.now(),row.id).changes)return bank.get('SELECT * FROM wechat_inbox WHERE id=?',row.id);
      }
    });
  }
  async function execute(row,abort){
    const heartbeat=setInterval(()=>{
      try{bindingFor(bank,row);const n=bank.run("UPDATE wechat_inbox SET lease_until=? WHERE id=? AND status='running' AND lease_owner=? AND lease_epoch=? AND lease_until>?",Date.now()+ttl,row.id,owner,row.lease_epoch,Date.now()).changes;if(!n)abort.abort();}catch{abort.abort();}
    },Math.max(10,Math.floor(ttl/3)));heartbeat.unref?.();
    try{
      const binding=bindingFor(bank,row),text=crypto.decrypt(row.input_cipher);
      if(row.is_command){complete(row,{text:router.wechatCommand(binding,text),events:[]});return;}
      const execution={requestId:row.id,runId:row.run_id,bindingId:row.binding_id,bindingSessionId:row.binding_session_id,bindingGeneration:row.binding_generation,
        assertExecution:()=>{assertLease(bank,'wechat_inbox',row,owner);bindingFor(bank,row);requireThat(bank.get("SELECT 1 FROM wechat_inbox WHERE id=? AND status='running'",row.id),'请求已停止',409,'WORKER_FENCED');}};
      await router.runWeChat(binding,text,execution,{signal:abort.signal,onFinish:(result,error)=>complete(row,result,error)});
    }catch(error){
      const current=bank.get('SELECT * FROM wechat_inbox WHERE id=?',row.id);
      if(current?.status==='running'&&current.lease_epoch===row.lease_epoch) {
        try{complete(row,{text:'这次处理未完成，已有操作请在App查看。',events:[]},error);}catch{
          bank.run("UPDATE wechat_inbox SET status='interrupted',finished_at=?,safe_error_code=?,lease_epoch=lease_epoch+1 WHERE id=? AND status='running' AND lease_epoch=?",Date.now(),error.code||'REQUEST_INTERRUPTED',row.id,row.lease_epoch);delivery.cancelFeedback(row.id);
        }
      }
    }finally{clearInterval(heartbeat);delivery.kick();}
  }
  function kick(){
    if(stopped||options.isEnabled?.()===false)return;maintain();delivery.kick();
    function launch(row){const abort=new AbortController();const task=execute(row,abort).finally(()=>{active.delete(row.id);if(!stopped)queueMicrotask(kick);});active.set(row.id,{abort,task,userId:row.user_id,command:Boolean(row.is_command),bindingId:row.binding_id});}
    // Cancellation/help must remain available even when every model worker is waiting.
    if(![...active.values()].some(v=>v.command)){const row=claim(true);if(row)launch(row);}
    while([...active.values()].filter(v=>!v.command).length<(options.executionConcurrency||4)){const row=claim();if(!row)break;launch(row);}
    options.onKick?.();
  }
  // Earliest moment maintain() has work: an expired lease or queue deadline, or a progress notice falling due.
  function nextDue(){
    const lease=bank.get("SELECT min(lease_until) v FROM wechat_inbox WHERE status='running'").v,deadline=bank.get("SELECT min(queue_deadline) v FROM wechat_inbox WHERE status='queued'").v;
    let due=Math.min(lease??Infinity,deadline??Infinity);
    if(feedback)for(const row of bank.all("SELECT received_at FROM wechat_inbox WHERE status IN ('queued','running') AND is_command=0 AND progress_sent=0"))
      due=Math.min(due,row.received_at+progressMs);
    return due;
  }
  async function drain(){await Promise.all(acknowledging);kick();while(active.size)await Promise.all([...active.values()].map(v=>v.task));await delivery.drain();}
  async function stop(){stopped=true;for(const v of active.values())v.abort.abort();await Promise.all([...active.values()].map(v=>v.task));await Promise.all(acknowledging);}
  function revoke(bindingId){
    for(const v of active.values())if(v.bindingId===bindingId)v.abort.abort();
    bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id IN (SELECT id FROM wechat_inbox WHERE binding_id=?) AND status IN ('queued','running')",bindingId);
    bank.run("UPDATE wechat_inbox SET status='cancelled',finished_at=?,lease_epoch=lease_epoch+1 WHERE binding_id=? AND status IN ('queued','running')",Date.now(),bindingId);
  }
  function requestView(user,requestId){
    const row=bank.get('SELECT * FROM wechat_inbox WHERE id=? AND user_id=?',requestId,user.id);requireThat(row,'未找到该请求',404,'NOT_FOUND');
    const result=row.result_json?JSON.parse(row.result_json):null;
    // Refresh action cards; a stored result is not evidence that an action remains confirmable.
    if(result?.events)result.events=result.events.map(e=>['action','plan'].includes(e.type)?{...e,data:services.actionView(services.owned(user,e.data.id))}:e);
    return {id:row.id,status:row.status,receivedAt:row.received_at,finishedAt:row.finished_at,result,
      deliveries:bank.all('SELECT kind,status,api_accepted_at,response_quality,needs_review FROM wechat_deliveries WHERE request_id=? ORDER BY created_at',row.id)};
  }
  return {ingest,kick,nextDue,drain,stop,revoke,maintain,requestView,start(){stopped=false;}};
}
