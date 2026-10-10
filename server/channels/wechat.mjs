import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { createWeChatProtocol, WECHAT_ORIGIN, safeBaseUrl } from './wechat-protocol.mjs';
import { createWeChatDelivery } from './wechat-delivery.mjs';
import { createWeChatInbox } from './wechat-inbox.mjs';
import { createWeChatTyping } from './wechat-typing.mjs';
import { bindingFor, assertLease } from './wechat-state.mjs';
export { safeBaseUrl } from './wechat-protocol.mjs';

const labels={waiting_scan:'请用微信扫码',waiting_confirmation:'已扫码，请在微信中确认',awaiting_code:'请输入微信扫码页面显示的验证码',confirmed:'绑定成功，请向助手发送“你好”',expired:'二维码已过期，请重新生成',failed:'连接未完成，请重新生成二维码',cancelled:'已取消连接'};
export function createWeChat(services,router,options={}) {
  const {bank}=services,crypto=router.crypto,protocol=createWeChatProtocol(options),owner=randomUUID(),pending=new Map(),loops=new Map(),rate=new Map();
  let stopped=false,started=false,wake,wakeAt=null,planned=false,cleaned=0;
  const enabled=()=>options.enabled??process.env.WECHAT_ENABLED==='true';
  const accepting=()=>options.accepting??process.env.WECHAT_ACCEPT_NEW_MESSAGES!=='false';
  const setting=(key,fallback,min,max)=>{
    const value=process.env[key]===undefined?fallback:Number(process.env[key]);
    requireThat(Number.isInteger(value)&&value>=min&&value<=max,`${key} 配置无效`,503,'WECHAT_CONFIG');return value;
  };
  const workerOptions={
    progressMs:setting('WECHAT_PROGRESS_AFTER_MS',4000,500,60000),
    sendTimeoutMs:setting('WECHAT_SEND_TIMEOUT_MS',8000,500,12000),
    maxPending:setting('WECHAT_MAX_PENDING_PER_USER',3,1,10),
    sendConcurrency:setting('WECHAT_SEND_CONCURRENCY',4,1,8),
    unknownReviewMs:setting('WECHAT_UNKNOWN_REVIEW_AFTER_MS',300000,1000,86400000),
    ...options,isEnabled:enabled,
  };
  const typing=createWeChatTyping(services,request,{...workerOptions,onDrop:reschedule});
  const delivery=createWeChatDelivery(services,crypto,send,{...workerOptions,indicator:typing,onKick:reschedule});
  const inbox=createWeChatInbox(services,router,delivery,{...workerOptions,indicator:typing,onKick:reschedule});
  function halt(bindingId){stopBinding(bindingId);inbox.revoke(bindingId);delivery.revoke(bindingId);typing.end(bindingId);}
  function reauth(binding,code='WECHAT_REAUTH_REQUIRED') {
    bank.atomic(()=>{
      const changed=bank.run("UPDATE channel_bindings SET auth_state='reauth_required',reauth_required_at=?,connection_state='degraded',last_error_code=? WHERE id=? AND binding_generation=? AND auth_state='valid'",Date.now(),code,binding.id,binding.binding_generation).changes;
      if(changed){bank.notify(binding.user_id,'微信需要重新认证','请回App「消息渠道绑定」重新扫码；此前操作状态可在App查看。');bank.audit(binding.user_id,'wechat.reauth_required',binding.id,{code});}
    });
    halt(binding.id);
  }
  async function request(binding,path,args){
    try{return await protocol.request(binding.base_url,path,{...args,token:crypto.decrypt(binding.token)});}
    catch(error){if(error.code==='WECHAT_REAUTH_REQUIRED')reauth(binding);throw error;}
  }
  async function send(binding,text,{signal,clientId=id('wx'),context,timeoutMs=8000}={}) {
    bindingFor(bank,binding);requireThat(context,'微信会话缺少回复上下文',409,'WECHAT_CONTEXT_REQUIRED');
    return request(binding,'/ilink/bot/sendmessage',{signal,timeoutMs,send:true,body:{msg:{from_user_id:'',to_user_id:binding.external_id,client_id:clientId,message_type:2,message_state:2,context_token:context,item_list:[{type:1,text_item:{text}}]}}});
  }
  function view(e){return {id:e.id,status:e.status,expiresAt:new Date(e.until).toISOString(),retryAfterMs:1000,message:e.error||labels[e.status],...(e.bindingId?{bindingId:e.bindingId}:{})};}
  function own(user,qrId){const e=pending.get(qrId);requireThat(e?.userId===user.id,'二维码会话已失效，请重新生成',404,'QR_EXPIRED');if(Date.now()>e.until&&!['confirmed','cancelled','failed'].includes(e.status)){e.status='expired';e.controller.abort();}return e;}
  async function qr(user,pin){
    requireThat(enabled()&&accepting(),'微信渠道暂不接受新连接',503,'WECHAT_DISABLED');services.pin(user,pin);sweep();crypto.encrypt('configuration-check');
    requireThat(!bank.get("SELECT user_id FROM channel_bindings WHERE channel='wechat' AND status='active' GROUP BY user_id HAVING count(*)>1"),'微信绑定存在历史冲突，请联系管理员核对',503,'WECHAT_BINDING_CONFLICT');
    requireThat(!bank.get("SELECT id FROM channel_bindings WHERE user_id=? AND channel='wechat' AND status='active' AND auth_state='valid'",user.id),'已连接微信助手，请先解绑',409,'WECHAT_BOT_EXISTS');
    const times=(rate.get(user.id)||[]).filter(t=>Date.now()-t<60000);requireThat(times.length<3,'二维码请求过于频繁，请稍后重试',429,'QR_RATE_LIMIT');times.push(Date.now());rate.set(user.id,times);
    for(const e of pending.values())if(e.userId===user.id&&!['confirmed','failed','expired','cancelled'].includes(e.status)){e.status='cancelled';e.controller.abort();}
    requireThat([...pending.values()].filter(e=>!['confirmed','failed','expired','cancelled'].includes(e.status)).length<(options.maxPendingLogin||20),'连接请求较多，请稍后重试',429,'QR_BUSY');
    const {data}=await protocol.request(WECHAT_ORIGIN,'/ilink/bot/get_bot_qrcode?bot_type=3',{body:{local_token_list:[]},login:true,timeoutMs:15000});
    requireThat(typeof data.qrcode==='string'&&data.qrcode&&typeof data.qrcode_img_content==='string'&&data.qrcode_img_content,'二维码响应无效',502,'WECHAT_QR_INVALID');
    for(const e of pending.values())if(e.userId===user.id&&!['confirmed','failed','expired','cancelled'].includes(e.status)){e.status='cancelled';e.controller.abort();}
    const e={id:id('QR'),userId:user.id,qrcode:data.qrcode,base:WECHAT_ORIGIN,until:Date.now()+300000,status:'waiting_scan',controller:new AbortController(),redirects:0};pending.set(e.id,e);
    if(options.autoStart!==false)e.task=watchLogin(e);
    return {...view(e),qrcode_img_content:data.qrcode_img_content,expiresIn:300};
  }
  async function pollLogin(e){
    if(e.polling||e.controller.signal.aborted||e.status==='awaiting_code'&&!e.verifyCode)return;e.polling=true;
    try{
      const code=e.verifyCode;delete e.verifyCode;
      const {data}=await protocol.request(e.base,`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(e.qrcode)}${code?`&verify_code=${encodeURIComponent(code)}`:''}`,{signal:e.controller.signal,timeoutMs:35000});
      if(e.controller.signal.aborted||Date.now()>e.until)return;
      if(data.status==='confirmed'){
        requireThat(typeof data.bot_token==='string'&&data.bot_token&&typeof data.ilink_user_id==='string'&&data.ilink_user_id&&typeof data.ilink_bot_id==='string'&&data.ilink_bot_id,'微信登录响应无效',502,'WECHAT_LOGIN_INVALID');
        const base=safeBaseUrl(data.baseurl);
        bank.atomic(()=>{
          const previous=bank.get("SELECT * FROM channel_bindings WHERE channel='wechat' AND external_id=?",data.ilink_user_id);
          requireThat(!previous||previous.user_id===e.userId||previous.status!=='active','此微信账号已绑定其他银行用户，请先解绑',409,'WECHAT_OWNER_CONFLICT');
          requireThat(!bank.get("SELECT id FROM channel_bindings WHERE user_id=? AND channel='wechat' AND status='active' AND external_id<>?",e.userId,data.ilink_user_id),'已有其他微信连接，请先解绑',409,'WECHAT_BOT_EXISTS');
          if(previous?.status==='active')router.expire(previous,'微信连接已更新','旧连接的未执行授权已撤销，请核对App操作列表。');
          const bindingId=previous?.id||id('BIND'),generation=(previous?.binding_generation||0)+1,session=id('WXSESSION');
          bank.run(`INSERT INTO channel_bindings(id,user_id,channel,external_id,token,base_url,created_at,external_bot_id,binding_generation,binding_session_id,authorized_at)
            VALUES(?,?,'wechat',?,?,?,?,?,?,?,?) ON CONFLICT(channel,external_id) DO UPDATE SET user_id=excluded.user_id,token=excluded.token,base_url=excluded.base_url,created_at=excluded.created_at,external_bot_id=excluded.external_bot_id,binding_generation=excluded.binding_generation,binding_session_id=excluded.binding_session_id,authorized_at=excluded.authorized_at,status='active',auth_state='valid',connection_state='awaiting_first_message',cursor='',context_token=NULL,context_updated_at=NULL,last_inbound_at=NULL,last_api_accepted_at=NULL,last_error_code=NULL,reauth_required_at=NULL,lease_until=0,lease_epoch=channel_bindings.lease_epoch+1`,bindingId,e.userId,data.ilink_user_id,crypto.encrypt(data.bot_token),base,now(),data.ilink_bot_id,generation,session,Date.now());
          bank.audit(e.userId,'channel.bound',bindingId,{channel:'wechat',generation});bank.notify(e.userId,'微信助手已连接','请在微信向助手发一句“你好”。查询详情与业务确认均可在App查看。');e.bindingId=bindingId;
        });
        e.status='confirmed';e.qrcode='';e.controller.abort();if(options.autoStart!==false)startBinding(e.bindingId);
      }else if(data.status==='scaned_but_redirect'){
        requireThat(typeof data.redirect_host==='string'&&++e.redirects<=3,'微信服务跳转无效',502,'WECHAT_REDIRECT_INVALID');e.base=safeBaseUrl(data.redirect_host.startsWith('https://')?data.redirect_host:`https://${data.redirect_host}`);e.status='waiting_confirmation';
      }else if(data.status==='need_verifycode')e.status='awaiting_code';
      else if(data.status==='scaned'||data.status==='scanned')e.status='waiting_confirmation';
      else if(data.status==='wait')e.status='waiting_scan';
      else if(data.status==='expired'){e.status='expired';e.controller.abort();}
      else {e.status='failed';e.error=data.status==='verify_code_blocked'?'验证次数过多，请重新生成二维码。':'未能取得有效连接凭据，请重新扫码。';e.controller.abort();}
    }catch(error){if(e.controller.signal.aborted||error.code==='WECHAT_NETWORK')return;e.status='failed';e.error=error.status?error.message:'微信连接失败，请重新扫码。';e.controller.abort();}
    finally{e.polling=false;}
  }
  async function watchLogin(e){while(!stopped&&!e.controller.signal.aborted&&Date.now()<e.until){await pollLogin(e);await delay(500,undefined,{signal:e.controller.signal}).catch(()=>{});}if(Date.now()>=e.until&&e.status!=='confirmed')e.status='expired';}
  async function qrStatus(user,qrId){const e=own(user,qrId);if(options.autoStart===false&&!['confirmed','expired','cancelled','failed'].includes(e.status))await pollLogin(e);return view(e);}
  function verify(user,qrId,code){const e=own(user,qrId);requireThat(e.status==='awaiting_code','当前不需要验证码',409,'QR_INVALID_STATE');requireThat(typeof code==='string'&&/^[A-Za-z0-9 -]{1,32}$/.test(code.trim()),'请输入微信页面显示的验证码',400,'INVALID_CODE');e.verifyCode=code.trim();return view(e);}
  function cancelQR(user,qrId){const e=own(user,qrId);requireThat(e.status!=='confirmed','连接已完成，请使用解绑',409);e.status='cancelled';e.qrcode='';delete e.verifyCode;e.controller.abort();return view(e);}
  function claimPoll(binding){return bank.atomic(()=>{
    bindingFor(bank,binding);const time=Date.now();
    if(!bank.run('UPDATE channel_bindings SET lease_owner=?,lease_epoch=CASE WHEN lease_owner=? AND lease_until>? THEN lease_epoch ELSE lease_epoch+1 END,lease_until=? WHERE id=? AND binding_generation=? AND (lease_owner=? OR lease_until<=?)',owner,owner,time,time+60000,binding.id,binding.binding_generation,owner,time).changes)return null;
    return bank.get('SELECT * FROM channel_bindings WHERE id=?',binding.id);
  });}
  async function pollOnce(binding,signal){
    if(!enabled()||!accepting())return {msgs:[]};const lease=claimPoll(binding);if(!lease)return {msgs:[]};
    const result=await request(lease,'/ilink/bot/getupdates',{signal,timeoutMs:45000,body:{get_updates_buf:lease.cursor||''}});
    inbox.ingest(lease,result.data,()=>assertLease(bank,'channel_bindings',lease,owner));if(options.autoStart!==false)inbox.kick();return result.data;
  }
  function stopBinding(bindingId){loops.get(bindingId)?.abort.abort();}
  function startBinding(bindingId){
    if(stopped||loops.has(bindingId)||!enabled()||!accepting())return;const abort=new AbortController();
    let rebound=false;
    const task=(async()=>{let backoff=1000;while(!abort.signal.aborted&&!stopped&&enabled()&&accepting()){
      const binding=bank.get("SELECT * FROM channel_bindings WHERE id=? AND status='active' AND auth_state='valid'",bindingId);if(!binding?.token)break;
      try{await pollOnce(binding,abort.signal);backoff=1000;await delay(200,undefined,{signal:abort.signal});}
      catch(error){rebound=error.code==='BINDING_FENCED';if(abort.signal.aborted||rebound||['WECHAT_REAUTH_REQUIRED','CHANNEL_REAUTH_REQUIRED'].includes(error.code))break;bank.run("UPDATE channel_bindings SET connection_state='degraded',last_error_code=? WHERE id=?",error.code||'WECHAT_ERROR',bindingId);await delay(backoff*(0.8+Math.random()*0.4),undefined,{signal:abort.signal}).catch(()=>{});backoff=Math.min(backoff*2,30000);}
    }})().finally(()=>{
      if(loops.get(bindingId)?.abort===abort)loops.delete(bindingId);bank.run('UPDATE channel_bindings SET lease_until=0 WHERE id=? AND lease_owner=?',bindingId,owner);
      // Password/PIN changes and frozen accounts only flip auth_state in SQL; the poll loop is where that surfaces.
      if(abort.signal.aborted||stopped)return;
      if(bank.get("SELECT 1 FROM channel_bindings WHERE id=? AND status='active' AND auth_state<>'valid'",bindingId))halt(bindingId);
      // A re-scan replaced this binding's generation while the old poll was in flight: carry on with the new one.
      else if(rebound)queueMicrotask(()=>startBinding(bindingId));
    });loops.set(bindingId,{abort,task});
  }
  function sweep(){const t=Date.now();for(const [key,e] of pending)if(e.until<t){e.controller.abort();pending.delete(key);}for(const [key,times] of rate)if(times.every(v=>t-v>60000))rate.delete(key);}
  // Request text and context are purged after a day, quarantine records after a week; passes are batched hourly.
  function purgeDue(){
    const day=86400000,first=(sql,age)=>{const v=bank.get(sql).v;return v==null?Infinity:v+age;};
    const due=Math.min(
      first("SELECT min(finished_at) v FROM wechat_inbox WHERE status NOT IN ('queued','running') AND (input_cipher IS NOT NULL OR context_token_cipher IS NOT NULL)",day),
      first("SELECT min(created_at) v FROM wechat_deliveries WHERE status IN ('api_accepted','cancelled','expired','failed','unknown') AND (body_cipher IS NOT NULL OR context_token_cipher IS NOT NULL)",day),
      first('SELECT min(created_at) v FROM wechat_quarantine',7*day));
    return due===Infinity?due:Math.max(due,cleaned+3600000);
  }
  function purge(){
    const t=Date.now();if(t<purgeDue())return;cleaned=t;
    bank.run("UPDATE wechat_inbox SET input_cipher=NULL,context_token_cipher=NULL WHERE finished_at<? AND status NOT IN ('queued','running')",t-86400000);
    bank.run("UPDATE wechat_deliveries SET body_cipher=NULL,context_token_cipher=NULL WHERE created_at<? AND status IN ('api_accepted','cancelled','expired','failed','unknown')",t-86400000);
    bank.run('DELETE FROM wechat_quarantine WHERE created_at<?',t-7*86400000);
  }
  // Work is driven by events (a poll result, a finished task or send); the only timer is set for the
  // earliest pending deadline and none exists while nothing is pending.
  function reschedule(){if(planned||!started||stopped)return;planned=true;setImmediate(plan);}
  function plan(){
    planned=false;clearTimeout(wake);wake=undefined;wakeAt=null;if(!started||stopped||!enabled())return;
    const due=Math.min(inbox.nextDue(),delivery.nextDue(),purgeDue());if(due===Infinity)return;
    // A deadline already passed but not cleared waits 250ms, so an unexpected state cannot spin.
    const delayMs=due>Date.now()?due-Date.now():250;wakeAt=Date.now()+delayMs;
    wake=setTimeout(()=>{wake=undefined;wakeAt=null;sweep();purge();inbox.kick();reschedule();},delayMs);wake.unref?.();
  }
  function start(){
    stopped=false;started=true;delivery.start();inbox.start();
    if(enabled()){for(const b of bank.all("SELECT id FROM channel_bindings WHERE channel='wechat' AND status='active' AND auth_state<>'valid'"))halt(b.id);for(const b of bank.all("SELECT id FROM channel_bindings WHERE channel='wechat' AND status='active' AND auth_state='valid'"))startBinding(b.id);inbox.kick();reschedule();}
  }
  async function stop(){stopped=true;started=false;clearTimeout(wake);wake=undefined;wakeAt=null;typing.clear();for(const e of pending.values())e.controller.abort();for(const l of loops.values())l.abort.abort();await inbox.stop();await delivery.stop();await Promise.allSettled([...loops.values()].map(l=>l.task));await Promise.allSettled([...pending.values()].map(e=>e.task));}
  router.onRevoke(halt);
  function register(route){
    route('post','/channels/wechat/qr','PIN授权微信扫码绑定',async(req,res)=>res.json(await qr(req.user,req.body.pin)));
    route('get','/channels/wechat/qr/:id','微信连接状态',async(req,res)=>res.json(await qrStatus(req.user,req.params.id)));
    route('post','/channels/wechat/qr/:id/verify','提交微信扫码验证码',(req,res)=>res.json(verify(req.user,req.params.id,req.body.code)));
    route('delete','/channels/wechat/qr/:id','取消微信扫码连接',(req,res)=>res.json(cancelQR(req.user,req.params.id)));
    route('get','/channels/wechat/requests/:id','本人微信请求和投递状态',(req,res)=>res.json(inbox.requestView(req.user,req.params.id)));
    route('get','/channels/wechat/requests','本人最近微信请求',(req,res)=>res.json(bank.all('SELECT id,status,received_at FROM wechat_inbox WHERE user_id=? ORDER BY seq DESC LIMIT 30',req.user.id)));
  }
  return {qr,qrStatus,verify,cancelQR,pollOnce,send,start,startBinding,stop,register,enabled,inbox,delivery,typing,nextWake:()=>wakeAt,drain:()=>inbox.drain(),flush:()=>delivery.drain()};
}
