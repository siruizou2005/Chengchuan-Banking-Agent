import { randomUUID } from 'node:crypto';
import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { enqueueExecution, assertChannelExecution } from '../agent/execution.mjs';
import { redact } from '../agent/guard.mjs';
import { eventsText } from './router.mjs';
import { channelText } from './preferences.mjs';

const commandPattern=/^(帮助|help|解绑|确认(?:\s+[A-Za-z0-9]+)?|取消(?:\s+[A-Za-z0-9]+)?)$/i;
const pending=['queued','running'];
const appCards={report:'账单图表',stats:'统计图表',subscriptions:'订阅明细',products:'产品对比',anomalies:'异常支出明细'};
export const feishuResultLink=(origin,requestId)=>`${origin||''}/#feishu-requests/${requestId}`;

// Acknowledgement follows durable acceptance. Network calls never run inside a transaction.
export function createFeishuPipeline(services,router,send,options={}) {
  const {bank}=services,crypto=router.crypto,owner=randomUUID(),executions=new Map(),sends=new Map(),replyTransports=new Map();
  const origin=options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
  const leaseMs=options.leaseMs||60000,sendMs=options.sendTimeoutMs||8000;
  const progressMs=options.progressMs??Number(process.env.FEISHU_PROGRESS_AFTER_MS||4000);
  const maxPending=options.maxPending||3,concurrency=options.concurrency||4;
  const typingOn=Boolean(options.typing)&&options.typingEnabled!==false&&process.env.FEISHU_TYPING_ENABLED!=='false',typing=new Map();
  let stopped=false,timer;
  // The reaction id lives in memory. After a restart the emoji stays on the message, which carries no data.
  function startTyping(b,requestId,messageId) {
    if(!typingOn)return;
    const entry={b,messageId,reactionId:null,done:false,timer:setTimeout(()=>stopTyping(requestId),options.typingMaxMs||300000)};entry.timer.unref?.();
    typing.set(requestId,entry);
    options.typing.add(b,messageId).then(reactionId=>{
      entry.reactionId=reactionId;
      if(entry.done){removeTyping(entry);return;}
      // A visible reaction replaces the delayed "正在处理" text.
      if(reactionId)bank.run('UPDATE feishu_inbox SET progress_sent=1 WHERE id=? AND progress_sent=0',requestId);
    },()=>{});
  }
  function removeTyping(entry) {if(entry.reactionId)Promise.resolve().then(()=>options.typing.remove(entry.b,entry.messageId,entry.reactionId)).catch(()=>{});}
  function stopTyping(requestId) {
    const entry=typing.get(requestId);if(!entry)return;
    typing.delete(requestId);clearTimeout(entry.timer);entry.done=true;removeTyping(entry);
  }
  function bindingFor(row) {
    const b=bank.get("SELECT * FROM channel_bindings WHERE id=? AND channel='feishu' AND status='active'",row.binding_id||row.id);
    requireThat(b&&b.binding_generation===row.binding_generation&&b.binding_session_id===row.binding_session_id&&b.user_id===row.user_id,'飞书绑定已变更',409,'BINDING_FENCED');
    assertChannelExecution(bank,{channel:'feishu',bindingId:b.id},b.user_id);return b;
  }
  function assertTask(table,row,status) {
    requireThat(bank.get(`SELECT 1 FROM ${table} WHERE id=? AND status=? AND lease_owner=? AND lease_epoch=? AND lease_until>?`,row.id,status,owner,row.lease_epoch,Date.now()),'请求已停止',409,'WORKER_FENCED');
    return bindingFor(row);
  }
  function enqueue(b,{requestId=null,messageId=null,kind,body,sourceId=null}) {
    const time=Date.now();
    bank.run(`INSERT OR IGNORE INTO feishu_deliveries(id,binding_id,binding_session_id,binding_generation,user_id,request_id,message_id,source_outbox_id,kind,body_cipher,uuid,created_at,next_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id('FSOUT'),b.id,b.binding_session_id,b.binding_generation,b.user_id,requestId,messageId,sourceId,kind,crypto.encrypt(body),randomUUID(),time,time,time+(kind==='progress'?5000:86400000));
  }
  function cancelFeedback(requestId) {bank.run("UPDATE feishu_deliveries SET status='cancelled' WHERE request_id=? AND kind='progress' AND status IN ('pending','retry_wait')",requestId);}
  function resultText(result,requestId) {
    const events=(result.events||[]).map(e=>{
      if(!['action','plan'].includes(e.type))return e;
      const action=bank.get('SELECT * FROM agent_actions WHERE id=?',e.data.id);
      return action?{...e,data:services.actionView(action)}:e;
    });
    const actions=events.filter(e=>['action','plan'].includes(e.type));
    let text=actions.length?actions.map(e=>['proposed','awaiting_verification'].includes(e.data.status)?eventsText({text:'',events:[e]},{origin}):`操作状态已更新（${e.data.status}）。编号：${e.data.id}\n请在App查看：${origin}/#tasks?action=${e.data.id}`).join('\n\n'):eventsText({...result,events},{origin});
    // Keep a conservative local text budget; the complete result remains accessible in the App.
    let truncated=false;
    if(Buffer.byteLength(text)>12000){let shortened='',bytes=0;for(const c of text){bytes+=Buffer.byteLength(c);if(bytes>11000)break;shortened+=c;}text=shortened+'…';truncated=true;}
    // Link to the App only when it shows more than Feishu, and say why: a cut-off reply, or a result the App draws as a card.
    // Proposals already carry their own confirmation link.
    const cards=[...new Set(events.map(e=>appCards[e.type]).filter(Boolean))].join('、'),link=feishuResultLink(origin,requestId);
    if(truncated)return text+`\n\n回复内容较长，以上仅为部分${cards?`；完整内容及${cards}`:'，完整内容'}请在App查看：${link}`;
    return cards?text+`\n\n${cards}请在App查看：${link}`:text;
  }
  function ingest(input,reply) {
    requireThat(!stopped,'飞书正在停止，请稍后重试',503,'FEISHU_STOPPING');
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>6000||typeof input.messageId!=='string'||!input.messageId)return true;
    const b=bank.get("SELECT * FROM channel_bindings WHERE channel='feishu' AND external_id=? AND status='active'",input.externalId);
    // A shared bot cannot resolve an identity from a personal bot or another App ID.
    if(!input.binding&&b&&(b.token||(input.botAccountId&&b.external_bot_id!==input.botAccountId)))return false;
    if(input.binding&&(b?.id!==input.binding.id||b?.binding_generation!==input.binding.binding_generation))return true;
    if(!b)return false;
    // Only the shared bot accepts binding codes; it must not interpret them as an Agent request.
    if(!input.binding&&/^绑定\s*\d{6}$/.test(input.text.trim()))return false;
    let requestId,queued=false;
    bank.atomic(()=>{
      bindingFor(b);
      if(bank.get('SELECT 1 FROM feishu_inbox WHERE binding_id=? AND message_id=?',b.id,input.messageId)||bank.get("SELECT 1 FROM channel_messages WHERE channel='feishu' AND message_id=?",input.messageId))return;
      requestId=id('FSREQ');const time=Date.now(),command=commandPattern.test(input.text.trim());
      const count=bank.get("SELECT count(*) n FROM feishu_inbox WHERE user_id=? AND status IN ('queued','running') AND is_command=0",b.user_id).n;
      const reason=!command&&count>=maxPending?'当前请求较多，这次还未开始处理，请稍后重试。':!command&&process.env.AGENT_DISABLED==='true'?'智能助手暂不可用，请在App办理。':null;
      bank.run(`INSERT INTO feishu_inbox(id,binding_id,binding_session_id,binding_generation,user_id,message_id,input_cipher,status,is_command,received_at,queue_deadline,run_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,requestId,b.id,b.binding_session_id,b.binding_generation,b.user_id,input.messageId,crypto.encrypt(input.text),reason?'failed':'queued',command?1:0,time,time+(options.queueMs||30000),id('RUN'));
      if(reason){bank.run('UPDATE feishu_inbox SET result_json=?,finished_at=? WHERE id=?',JSON.stringify({text:reason,events:[]}),time,requestId);enqueue(b,{requestId,messageId:input.messageId,kind:'final',body:reason});}
      else if(!command){enqueueExecution(bank,b.user_id,requestId,'feishu',time+(options.queueMs||30000));queued=true;}
      bank.run("UPDATE channel_bindings SET last_inbound_at=?,connection_state='receiving' WHERE id=?",time,b.id);
    });
    if(requestId&&reply)replyTransports.set(requestId,reply);
    if(queued)startTyping(b,requestId,input.messageId);
    queueMicrotask(kick);return true;
  }
  function complete(row,result,error) {
    bank.atomic(()=>{
      const b=assertTask('feishu_inbox',row,'running');
      const safe=redact(result);
      bank.run('UPDATE feishu_inbox SET status=?,result_json=?,safe_error_code=?,finished_at=? WHERE id=?',error?'failed':'completed',JSON.stringify(safe),error?.code||null,Date.now(),row.id);
      cancelFeedback(row.id);enqueue(b,{requestId:row.id,messageId:row.message_id,kind:'final',body:safe.text||'请在App查看本次结果。'});
    });
  }
  function notice(row) {
    if(row.kind==='progress')return;
    if(!bank.get("SELECT 1 FROM audit WHERE action='feishu.delivery_notice' AND resource_id=?",row.id)){
      bank.notify(row.user_id,'飞书回复送达未确认',`结果保存在App，无需重复提交业务。查看：${row.request_id?feishuResultLink(origin,row.request_id):`${origin}/#tasks`}`);
      bank.audit(row.user_id,'feishu.delivery_notice',row.id,{code:row.safe_error_code||'SEND_UNKNOWN',requestId:row.request_id});
    }
  }
  function bridge() {
    bank.atomic(()=>{
      for(const out of bank.all("SELECT o.* FROM channel_outbox o JOIN channel_bindings b ON b.id=o.binding_id WHERE b.channel='feishu' AND o.status='pending' AND o.next_at<=? LIMIT 100",now())){
        const b=bank.get('SELECT * FROM channel_bindings WHERE id=?',out.binding_id);
        try{bindingFor(b);if(out.binding_generation!=null)bindingFor({...out,user_id:b.user_id});}
        catch{bank.run("UPDATE channel_outbox SET status='cancelled' WHERE id=? AND status='pending'",out.id);continue;}
        enqueue(b,{kind:'action_result',body:out.body,sourceId:out.id});
        bank.run("UPDATE channel_outbox SET status='forwarded' WHERE id=? AND status='pending'",out.id);
      }
    });
  }
  function maintain() {
    bank.atomic(()=>{
      for(const row of bank.all("SELECT * FROM feishu_inbox WHERE (status='running' AND lease_until<=?) OR (status='queued' AND queue_deadline<=?)",Date.now(),Date.now())){
        // Never rerun a model after an uncertain interruption: earlier tool effects may already exist.
        const saved=bank.get('SELECT output,events FROM agent_runs WHERE id=? AND user_id=?',row.run_id,row.user_id);
        const result=saved?{text:saved.output,events:JSON.parse(saved.events||'[]')}:{text:row.status==='queued'?'等待处理超时，这次尚未开始处理，请稍后重试。':'本次处理中断，已生成的操作可在App查看。',events:[]};
        bank.run('UPDATE feishu_inbox SET status=?,result_json=?,finished_at=?,lease_epoch=lease_epoch+1 WHERE id=?',saved?'completed':'interrupted',JSON.stringify(result),Date.now(),row.id);
        bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id=? AND status IN ('queued','running')",row.id);
        cancelFeedback(row.id);
        try{enqueue(bindingFor(row),{requestId:row.id,messageId:row.message_id,kind:'final',body:result.text});}catch{}
      }
      if(options.feedback!==false&&process.env.FEISHU_FEEDBACK_ENABLED!=='false')for(const row of bank.all("SELECT * FROM feishu_inbox WHERE status IN ('queued','running') AND is_command=0 AND progress_sent=0 AND received_at<=?",Date.now()-progressMs)){
        try{enqueue(bindingFor(row),{requestId:row.id,messageId:row.message_id,kind:'progress',body:row.started_at?'正在处理，请稍等。':'请求已收到，正在等待处理，请稍等。'});}catch{}
        bank.run('UPDATE feishu_inbox SET progress_sent=1 WHERE id=?',row.id);
      }
      for(const row of bank.all("SELECT * FROM feishu_deliveries WHERE (status='sending' AND lease_until<=?) OR (status IN ('pending','retry_wait') AND expires_at<=?)",Date.now(),Date.now())){
        const status=row.status==='sending'?'unknown':'expired';
        bank.run('UPDATE feishu_deliveries SET status=?,needs_review=?,lease_epoch=lease_epoch+1 WHERE id=?',status,status==='unknown'?1:0,row.id);
        if(row.source_outbox_id)bank.run("UPDATE channel_outbox SET status=? WHERE id=? AND status='forwarded'",status,row.source_outbox_id);
        notice(row);replyTransports.delete(row.request_id);if(row.kind==='final')stopTyping(row.request_id);
      }
    });
  }
  function claimExecution(command) {
    return bank.atomic(()=>{
      for(const row of bank.all("SELECT * FROM feishu_inbox WHERE status='queued' AND is_command=? ORDER BY seq LIMIT 100",command?1:0)){
        if(!command&&[...executions.values()].some(v=>!v.command&&v.userId===row.user_id))continue;
        try{bindingFor(row);}catch{
          bank.run("UPDATE feishu_inbox SET status='cancelled',finished_at=?,lease_epoch=lease_epoch+1 WHERE id=?",Date.now(),row.id);
          bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id=? AND status='queued'",row.id);
          cancelFeedback(row.id);replyTransports.delete(row.id);stopTyping(row.id);continue;
        }
        bank.run("UPDATE feishu_inbox SET status='running',lease_owner=?,lease_epoch=lease_epoch+1,lease_until=? WHERE id=? AND status='queued'",owner,Date.now()+leaseMs,row.id);
        return bank.get('SELECT * FROM feishu_inbox WHERE id=?',row.id);
      }
    });
  }
  async function execute(row,abort) {
    const heartbeat=setInterval(()=>{
      try{assertTask('feishu_inbox',row,'running');bank.run('UPDATE feishu_inbox SET lease_until=? WHERE id=? AND lease_epoch=?',Date.now()+leaseMs,row.id,row.lease_epoch);}catch{abort.abort();}
    },Math.max(10,Math.floor(leaseMs/3)));heartbeat.unref();
    try{
      const b=assertTask('feishu_inbox',row,'running'),text=crypto.decrypt(row.input_cipher);
      if(row.is_command){complete(row,{text:router.feishuCommand(b,text),events:[]});return;}
      await router.runFeishu(b,text,{requestId:row.id,runId:row.run_id,assertExecution:()=>assertTask('feishu_inbox',row,'running')},{signal:abort.signal,
        onStage:stage=>{if(stage==='running'){assertTask('feishu_inbox',row,'running');bank.run('UPDATE feishu_inbox SET started_at=? WHERE id=?',Date.now(),row.id);}},
        onFinish:(result,error)=>complete(row,result,error)});
    }catch(error){
      const current=bank.get('SELECT * FROM feishu_inbox WHERE id=?',row.id);
      if(current?.status==='running'&&current.lease_epoch===row.lease_epoch){
        try{complete(row,{text:'本次处理未完成，已有操作请在App查看；查询可以稍后重试。',events:[]},error);}
        catch{bank.run("UPDATE feishu_inbox SET status='interrupted',finished_at=?,lease_epoch=lease_epoch+1 WHERE id=? AND status='running' AND lease_epoch=?",Date.now(),row.id,row.lease_epoch);cancelFeedback(row.id);}
      }
    }finally{clearInterval(heartbeat);}
  }
  function claimSend() {
    return bank.atomic(()=>{
      for(const row of bank.all("SELECT * FROM feishu_deliveries WHERE status IN ('pending','retry_wait') AND next_at<=? ORDER BY seq LIMIT 100",Date.now())){
        if(sends.has(row.binding_id)||bank.get("SELECT 1 FROM feishu_deliveries WHERE binding_id=? AND status='sending' AND lease_until>?",row.binding_id,Date.now()))continue;
        if(bank.get("SELECT 1 FROM feishu_deliveries WHERE binding_id=? AND seq<? AND status IN ('pending','retry_wait','sending')",row.binding_id,row.seq))continue;
        try{bindingFor(row);}catch{bank.run("UPDATE feishu_deliveries SET status='cancelled' WHERE id=?",row.id);if(row.kind==='final')stopTyping(row.request_id);continue;}
        if(row.kind==='progress'&&!pending.includes(bank.get('SELECT status FROM feishu_inbox WHERE id=?',row.request_id)?.status)){bank.run("UPDATE feishu_deliveries SET status='cancelled' WHERE id=?",row.id);continue;}
        bank.run("UPDATE feishu_deliveries SET status='sending',lease_owner=?,lease_epoch=lease_epoch+1,lease_until=?,attempts=attempts+1 WHERE id=? AND status IN ('pending','retry_wait')",owner,Date.now()+sendMs+5000,row.id);
        return bank.get('SELECT * FROM feishu_deliveries WHERE id=?',row.id);
      }
    });
  }
  async function deliver(row,abort) {
    try{
      const b=assertTask('feishu_deliveries',row,'sending');let body=crypto.decrypt(row.body_cipher);
      if(row.kind==='final'){
        const result=bank.get('SELECT result_json FROM feishu_inbox WHERE id=?',row.request_id)?.result_json;
        if(result)body=resultText(JSON.parse(result),row.request_id);
      }
      body=channelText(bank,b.user_id,'feishu',body);
      if(row.sent_body_cipher&&crypto.decrypt(row.sent_body_cipher)!==body)row.uuid=randomUUID();
      bank.run('UPDATE feishu_deliveries SET sent_body_cipher=?,uuid=? WHERE id=?',crypto.encrypt(body),row.uuid,row.id);
      const transport=row.request_id&&replyTransports.get(row.request_id);
      const result=await (transport||send)(b,body,{messageId:row.message_id,uuid:row.uuid,format:row.kind==='progress'?'text':'card',signal:abort.signal,timeoutMs:sendMs,assertCurrent:()=>assertTask('feishu_deliveries',row,'sending')});
      bank.atomic(()=>{
        assertTask('feishu_deliveries',row,'sending');
        bank.run("UPDATE feishu_deliveries SET status='api_accepted',api_accepted_at=?,server_message_id=? WHERE id=?",Date.now(),result?.data?.message_id||null,row.id);
        bank.run('UPDATE channel_bindings SET last_api_accepted_at=?,last_error_code=NULL WHERE id=? AND binding_generation=?',Date.now(),b.id,b.binding_generation);
        if(row.source_outbox_id)bank.run("UPDATE channel_outbox SET status='sent' WHERE id=? AND status='forwarded'",row.source_outbox_id);
      });
    }catch(error){
      bank.atomic(()=>{
        if(!bank.get("SELECT 1 FROM feishu_deliveries WHERE id=? AND status='sending' AND lease_owner=? AND lease_epoch=?",row.id,owner,row.lease_epoch))return;
        let status=error.deliveryState||'unknown';
        try{bindingFor(row);}catch{status='cancelled';}
        if(row.lease_until<=Date.now())status='unknown';
        if(status==='retry_wait'&&(row.attempts>=5||row.kind==='progress'))status='failed';
        bank.run('UPDATE feishu_deliveries SET status=?,next_at=?,safe_error_code=?,needs_review=? WHERE id=?',status,Date.now()+Math.min(60000,1000*2**(row.attempts-1)),error.code||'SEND_UNKNOWN',status==='unknown'?1:0,row.id);
        bank.run('UPDATE channel_bindings SET last_error_code=? WHERE id=? AND binding_generation=?',error.code||'SEND_UNKNOWN',row.binding_id,row.binding_generation);
        if(row.source_outbox_id&&['failed','unknown','cancelled'].includes(status))bank.run('UPDATE channel_outbox SET status=? WHERE id=? AND status=\'forwarded\'',status,row.source_outbox_id);
        if(['failed','unknown','expired'].includes(status))notice({...row,safe_error_code:error.code});
      });
    }finally{
      const status=bank.get('SELECT status FROM feishu_deliveries WHERE id=?',row.id)?.status;
      if(row.kind!=='progress'&&status!=='retry_wait')replyTransports.delete(row.request_id);
      // The reaction stays until the reply is settled, so it disappears as the answer arrives.
      if(row.kind==='final'&&status!=='retry_wait')stopTyping(row.request_id);
    }
  }
  function schedule() {
    clearTimeout(timer);if(stopped)return;
    const work=bank.get("SELECT min(lease_until) t FROM feishu_inbox WHERE status='running'").t;
    const queued=bank.get("SELECT min(queue_deadline) t FROM feishu_inbox WHERE status='queued'").t;
    const sendDue=bank.get("SELECT min(CASE WHEN status='sending' THEN lease_until ELSE min(next_at,expires_at) END) t FROM feishu_deliveries WHERE status IN ('pending','retry_wait','sending')").t;
    const feedback=options.feedback!==false&&process.env.FEISHU_FEEDBACK_ENABLED!=='false'?bank.get("SELECT min(received_at) t FROM feishu_inbox WHERE status IN ('queued','running') AND is_command=0 AND progress_sent=0").t:null;
    const due=Math.min(work??Infinity,queued??Infinity,sendDue??Infinity,feedback==null?Infinity:feedback+progressMs);
    if(Number.isFinite(due)){timer=setTimeout(kick,Math.max(100,Math.min(1000,due-Date.now())));timer.unref();}
  }
  function kick() {
    if(stopped)return;
    try{
      bridge();maintain();
      function launch(row){const abort=new AbortController();const task=execute(row,abort).finally(()=>{executions.delete(row.id);if(!stopped)queueMicrotask(kick);});executions.set(row.id,{task,abort,bindingId:row.binding_id,userId:row.user_id,command:Boolean(row.is_command)});}
      if(![...executions.values()].some(v=>v.command)){const row=claimExecution(true);if(row)launch(row);}
      while([...executions.values()].filter(v=>!v.command).length<concurrency){const row=claimExecution(false);if(!row)break;launch(row);}
      while(sends.size<concurrency){const row=claimSend();if(!row)break;const abort=new AbortController();const task=deliver(row,abort).finally(()=>{sends.delete(row.binding_id);if(!stopped)queueMicrotask(kick);});sends.set(row.binding_id,{task,abort});}
    }catch{console.warn('Feishu worker could not claim work');}
    schedule();
  }
  function cancelBinding(bindingId) {
    bank.atomic(()=>{
      bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE request_id IN (SELECT id FROM feishu_inbox WHERE binding_id=?) AND status IN ('queued','running')",bindingId);
      bank.run("UPDATE feishu_inbox SET status='cancelled',finished_at=?,lease_epoch=lease_epoch+1 WHERE binding_id=? AND status IN ('queued','running')",Date.now(),bindingId);
      bank.run("UPDATE feishu_deliveries SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'cancelled' END,needs_review=CASE WHEN status='sending' THEN 1 ELSE needs_review END,lease_epoch=lease_epoch+1 WHERE binding_id=? AND status IN ('pending','retry_wait','sending')",bindingId);
    });
    for(const v of executions.values())if(v.bindingId===bindingId)v.abort.abort();
    sends.get(bindingId)?.abort.abort();
    for(const row of bank.all('SELECT id FROM feishu_inbox WHERE binding_id=?',bindingId)){replyTransports.delete(row.id);stopTyping(row.id);}
  }
  function requestView(user,requestId) {
    const row=bank.get('SELECT * FROM feishu_inbox WHERE id=? AND user_id=?',requestId,user.id);requireThat(row,'未找到该请求',404,'NOT_FOUND');
    const result=row.result_json?JSON.parse(row.result_json):null;
    if(result?.events)result.events=result.events.map(e=>['action','plan'].includes(e.type)?{...e,data:services.actionView(services.owned(user,e.data.id))}:e);
    return {id:row.id,status:row.status,receivedAt:row.received_at,finishedAt:row.finished_at,result,deliveries:bank.all('SELECT kind,status,api_accepted_at,needs_review FROM feishu_deliveries WHERE request_id=? ORDER BY seq',row.id)};
  }
  async function drain(){kick();while(executions.size||sends.size)await Promise.all([...executions.values(),...sends.values()].map(v=>v.task));}
  async function flush(){kick();while(sends.size)await Promise.all([...sends.values()].map(v=>v.task));}
  async function stop(){stopped=true;clearTimeout(timer);for(const v of [...executions.values(),...sends.values()])v.abort.abort();await Promise.all([...executions.values(),...sends.values()].map(v=>v.task));replyTransports.clear();for(const entry of typing.values())clearTimeout(entry.timer);typing.clear();}
  function routes(route){
    route('get','/channels/feishu/requests','本人飞书请求记录',(req,res)=>res.json(bank.all('SELECT id,status,received_at FROM feishu_inbox WHERE user_id=? ORDER BY seq DESC LIMIT 30',req.user.id)));
    route('get','/channels/feishu/requests/:id','本人飞书请求结果',(req,res)=>res.json(requestView(req.user,req.params.id)));
  }
  return {ingest,kick,drain,flush,stop,cancelBinding,requestView,routes,maintain,start(){stopped=false;kick();}};
}
