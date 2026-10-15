import { randomBytes,randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { id,now } from '../db.mjs';
import { BusinessError,requireThat } from '../errors.mjs';
// SDK request errors dump the whole axios request, bearer token included, so clients log nothing.
const QUIET={error(){},warn(){},info(){},debug(){},trace(){}};
const requestScope=new AsyncLocalStorage();
function boundedHttp(sdk) {
 const http=sdk.defaultHttpInstance;if(!http)return {};
 return {httpInstance:{...http,request:request=>{
  const scope=requestScope.getStore();scope?.signal?.throwIfAborted();scope?.assertCurrent?.();
  const remaining=scope?scope.deadline-Date.now():15000;
  if(remaining<=0)throw Object.assign(new Error('Feishu request deadline'),{deliveryState:'unknown',code:'FEISHU_SEND_TIMEOUT'});
  return http.request({...request,timeout:Math.min(request.timeout||15000,remaining),...(scope?.signal?{signal:scope.signal}:{})});
 }}};
}
// Resolved SDK calls can carry business errors. Ambiguous network outcomes are not automatically retried.
export async function feishuRequest(call,{signal,timeoutMs=8000}={}) {
 let timer,abort;
 const failure=(code,state)=>Object.assign(new BusinessError('飞书发送暂未完成，请在App查看结果',502,code),{deliveryState:state});
 try{
  signal?.throwIfAborted();
  const result=await Promise.race([Promise.resolve().then(()=>{signal?.throwIfAborted();return call();}),new Promise((_,reject)=>{
   timer=setTimeout(()=>reject(failure('FEISHU_SEND_TIMEOUT','unknown')),timeoutMs);
   abort=()=>reject(failure('FEISHU_SEND_ABORTED','unknown'));signal?.addEventListener('abort',abort,{once:true});
  })]);
  if(result?.code!==0)throw failure(result?.code==null?'FEISHU_INVALID_RESPONSE':`FEISHU_${String(result.code).replace(/[^0-9]/g,'').slice(0,12)}`,result?.code==null?'unknown':result.code===99991400?'retry_wait':'failed');
  return result;
 }catch(error){
  if(error.deliveryState)throw error;
  const code=error?.response?.data?.code,status=error?.response?.status;
  throw failure(code!=null?`FEISHU_${String(code).replace(/[^0-9]/g,'').slice(0,12)}`:'FEISHU_NETWORK_ERROR',status===429||code===99991400?'retry_wait':status>=500?'unknown':code!=null&&code!==0?'failed':'unknown');
 }finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
}
// Like OpenClaw, replies go out as rich-text posts, which use the chat's own font size. Only tables and code blocks,
// which the post md tag cannot render, use a JSON 2.0 card; its markdown is 14px by default, so the card defines
// Feishu's documented custom size that is 16px on phones, matching chat text.
// Bare links become markdown links in both formats.
const linkify=text=>String(text).replace(/(^|[^([\]<])(https?:\/\/[^\s<>()[\]（），。；、！？]+)/g,(_,lead,url)=>`${lead}[${url}](${url})`);
export const needsFeishuCard=text=>/```[\s\S]*?```/.test(text)||/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
export function feishuCard(text) {
 return {schema:'2.0',config:{width_mode:'fill',style:{text_size:{normal_v2:{default:'normal',pc:'normal',mobile:'heading'}}}},body:{elements:[{tag:'markdown',content:linkify(text),text_size:'normal_v2'}]}};
}
// Post md is CommonMark: single line breaks would join lines, so they become hard breaks; headings render as bold.
export function feishuPost(text) {
 const md=linkify(text).replace(/^#{1,6}\s+(.+)$/gm,'**$1**').replace(/([^\n])\n(?=[^\n])/g,'$1  \n');
 return {zh_cn:{content:[[{tag:'md',text:md}]]}};
}
// Content rejections: invalid parameter, card build failure, content too long. Other errors would fail as text too.
const CONTENT_REJECTED=new Set(['FEISHU_230001','FEISHU_230099','FEISHU_230025']);
export function sendFeishuMessage(client,binding,text,options={}) {
 const deadline=Date.now()+(options.timeoutMs||8000),uuid=options.uuid||randomUUID();
 const attempt=(msgType,content,id)=>{
  const data={msg_type:msgType,content:JSON.stringify(content),uuid:id};
  return feishuRequest(()=>{
   options.assertCurrent?.();
   return options.messageId?client.im.v1.message.reply({path:{message_id:options.messageId},data}):client.im.v1.message.create({params:{receive_id_type:'open_id'},data:{...data,receive_id:binding.external_id}});
  },{...options,timeoutMs:Math.max(1,deadline-Date.now())});
 };
 return requestScope.run({...options,deadline},async()=>{
  if(options.format==='text')return attempt('text',{text},uuid);
  // Only a definite rejection falls back to text; an uncertain outcome may already have delivered the message.
  try{return await (needsFeishuCard(text)?attempt('interactive',feishuCard(text),uuid):attempt('post',feishuPost(text),uuid));}
  catch(error){if(error.deliveryState!=='failed'||!CONTENT_REJECTED.has(error.code))throw error;return attempt('text',{text},`${uuid}-text`);}
 });
}
// Feishu bots have no typing state, so a "Typing" emoji reaction on the depositor's message stands in for one.
// Reactions only need im:message, which both bots already hold; failures are ignored.
export function feishuTyping(client) {
 return {
  async add(messageId){const result=await feishuRequest(()=>client.im.v1.messageReaction.create({path:{message_id:messageId},data:{reaction_type:{emoji_type:'Typing'}}}),{timeoutMs:3000});return result.data?.reaction_id||null;},
  async remove(messageId,reactionId){await feishuRequest(()=>client.im.v1.messageReaction.delete({path:{message_id:messageId,reaction_id:reactionId}}),{timeoutMs:3000});},
 };
}
export function createFeishuHandler(router,client,onError=()=>{},owner,binding) {
 return data=>{
  const message=data.message,sender=data.sender?.sender_id?.open_id;
  if(!message||message.chat_type!=='p2p'||message.message_type!=='text'||data.sender?.sender_type==='app'||!sender||(owner&&sender!==owner))return {};
  let text;try{text=JSON.parse(message.content).text;}catch{return {};}
  const input={channel:'feishu',externalId:sender,messageId:message.message_id,text,binding};
  // Persist before acknowledging; the model and delivery run independently of the dispatcher.
  if(router.acceptFeishu?.(input,binding?undefined:(b,body,options)=>sendFeishuMessage(client,b,body,options)))return {};
  void router.receive(input).then(async reply=>{
   if(reply)await sendFeishuMessage(client,{external_id:sender},reply,{messageId:message.message_id});
  }).catch(onError);
  return {};
 };
}
export async function startFeishu(router,options={}) {
 const appId=options.appId||process.env.FEISHU_APP_ID,appSecret=options.appSecret||process.env.FEISHU_APP_SECRET;
 if(!appId||!appSecret)return {stop:async()=>{},send:async()=>{throw new Error('飞书未配置');},typing:null};
 const sdk=options.sdk||await import('@larksuiteoapi/node-sdk');
 const client=new sdk.Client({appId,appSecret,logger:QUIET,...boundedHttp(sdk)}),ws=new sdk.WSClient({appId,appSecret,loggerLevel:sdk.LoggerLevel.warn});
 ws.start({eventDispatcher:new sdk.EventDispatcher({}).register({'im.message.receive_v1':createFeishuHandler(router,client,()=>console.warn('Feishu message failed'))})});
  return {stop:async()=>{ws.close({force:true});},send:(binding,text,options)=>sendFeishuMessage(client,binding,text,options),typing:feishuTyping(client)};
}
const OPEN_API={feishu:'https://open.feishu.cn',lark:'https://open.larksuite.com'};
const SCOPES=['im:message','im:message:send_as_bot','im:message.p2p_msg:readonly','application:application:patch'];
const WELCOME='你好，我是你的澄川银行专属助手。可以问我余额、账单，或让我提议转账、缴费；为保障资金安全，所有操作都需回澄川银行App确认，在这里可回复「取消 操作编号」放弃。发消息没有回复时，请回App「消息渠道绑定」查看机器人状态。';
const SETUP_HELP='请到飞书开发者后台 open.feishu.cn/app 删除刚创建的「…的澄川银行助手」，再回到本页重新创建；多次失败请联系客服。';
// Per-depositor bots created by Feishu's one-click registration. Events arrive by webhook, so an idle bot costs one
// database row: no connection, timer or client object until a message comes in or a push goes out.
export function createFeishuBots(services,router,options={}) {
 const {bank}=services,crypto=router.crypto,pending=new Map(),clients=new Map(),jobs=new Set(),maxClients=options.maxClients||100,maxPending=options.maxPending||20;let watch;
 function track(task){jobs.add(task);void task.finally(()=>jobs.delete(task)).catch(()=>{});return task;}
 const origin=()=>options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
 const enabled=()=>(options.enabled??process.env.FEISHU_PERSONAL_ENABLED==='true')&&/^https:\/\/[^/]+$/.test(origin());
 const loadSdk=async()=>options.sdk||await import('@larksuiteoapi/node-sdk');
 const active=(sql,...args)=>bank.get(`SELECT * FROM channel_bindings WHERE channel='feishu' AND token IS NOT NULL AND ${sql}`,...args);
 function forget(bindingId){clients.delete(bindingId);}
 // Clients are cached most-recently-used last, so trimming walks from the stalest entry.
 function trim(){const cutoff=Date.now()-1800000;for(const [key,entry] of clients){if(clients.size<=maxClients&&entry.used>=cutoff)break;clients.delete(key);}}
 async function connect(binding){
  const cached=clients.get(binding.id);if(cached&&cached.generation===binding.binding_generation){clients.delete(binding.id);cached.used=Date.now();clients.set(binding.id,cached);return cached;}
  const sdk=await loadSdk(),secret=JSON.parse(crypto.decrypt(binding.token));
  const client=new sdk.Client({appId:secret.appId,appSecret:secret.appSecret,domain:binding.base_url||OPEN_API.feishu,logger:QUIET,...boundedHttp(sdk)});
  const handler=createFeishuHandler(router,client,()=>console.warn('Feishu personal bot message failed'),binding.external_id,binding);
  // The dispatcher only calls handlers for events whose signature checked out, which proves the published webhook is live.
  const dispatcher=new sdk.EventDispatcher({encryptKey:secret.encryptKey,verificationToken:secret.verificationToken,logger:QUIET}).register({'im.message.receive_v1':data=>{webhookLive(binding);return handler(data);}});
  const entry={secret,client,handle:sdk.adaptExpress(dispatcher,{autoChallenge:true}),used:Date.now(),generation:binding.binding_generation};trim();clients.set(binding.id,entry);return entry;
 }
 function webhookLive(binding){bank.run("UPDATE channel_bindings SET transport='webhook' WHERE id=? AND binding_generation=? AND status='active' AND transport IS NOT 'webhook'",binding.id,binding.binding_generation);}
 // Each setup call reports Feishu's own error code so the depositor and support know what failed and what to do next.
 async function setupStep(name,code,call){
  let result;try{result=await call();}catch(error){result={code:error?.response?.data?.code??-1};}
  if(result?.code!==0)throw Object.assign(new BusinessError(`飞书机器人${name}失败${result?.code>0?`（飞书错误码 ${result.code}）`:''}。${SETUP_HELP}`,502,code),{feishuCode:result?.code});
 }
 // Only expire when Feishu itself refuses to issue a token for the stored credentials; network errors keep the binding.
 async function credentialsRejected(entry){try{await feishuRequest(()=>entry.client.auth.tenantAccessToken.internal({data:{app_id:entry.secret.appId,app_secret:entry.secret.appSecret}}));return false;}catch(error){return error.deliveryState==='failed';}}
 async function send(binding,text,options={}){
  const entry=await connect(binding);
  requireThat(bank.get("SELECT 1 FROM channel_bindings WHERE id=? AND status='active' AND auth_state='valid' AND binding_generation=?",binding.id,binding.binding_generation),'飞书绑定已变更',409,'BINDING_FENCED');
  try{return await sendFeishuMessage(entry.client,binding,text,options);}
  catch(error){if(error.deliveryState==='failed'&&await credentialsRejected(entry)){forget(binding.id);router.expire(binding,'飞书专属机器人已失效','请前往消息渠道绑定页面重新创建。');}throw error;}
 }
 // Typing reactions skip the binding fence: they show progress only and carry no account data.
 const typing={add:async(binding,messageId)=>feishuTyping((await connect(binding)).client).add(messageId),remove:async(binding,messageId,reactionId)=>feishuTyping((await connect(binding)).client).remove(messageId,reactionId)};
 async function event(req,res){
  const binding=active("id=? AND status IN ('setup','active')",req.params.id);if(!binding)return res.json({});
  try{await (await connect(binding)).handle(req,res);}catch{if(!res.headersSent)res.status(400).json({});}
 }
 function sweep(){
  const time=Date.now();
  for(const [key,entry] of pending){
   // A phone leaves the page while the depositor confirms inside Feishu, so allow a few minutes without polling.
   if(entry.status==='wait'&&(time>entry.until||time-entry.seen>(options.idleAbortMs||180000))){entry.status='expired';entry.done=time;entry.controller.abort();}
   else if(entry.done&&time-entry.done>600000)pending.delete(key);
  }
  if(!pending.size){clearInterval(watch);watch=undefined;}
 }
 // The sweep timer only exists while a registration is in progress.
 function schedule(){if(!watch&&pending.size){watch=setInterval(sweep,10000);watch.unref?.();}}
 async function finish(entry,result){
  if(entry.status!=='wait')return;entry.status='setup';let bindingId,created=false;
  try{
   const openId=result?.user_info?.open_id;requireThat(result?.client_id&&result?.client_secret&&openId,'飞书返回的机器人信息不完整',502,'FEISHU_REGISTER_ERROR');
   const secret={appId:result.client_id,appSecret:result.client_secret,encryptKey:randomBytes(16).toString('hex'),verificationToken:randomBytes(16).toString('hex')};
   const previous=bank.get("SELECT * FROM channel_bindings WHERE channel='feishu' AND external_id=?",openId);requireThat(!previous||previous.user_id===entry.userId||previous.status!=='active','此飞书机器人已绑定其他银行用户',409);
   bindingId=previous?.id||id('BIND');created=!previous;forget(bindingId);
   bank.run("INSERT INTO channel_bindings(id,user_id,channel,external_id,token,base_url,status,created_at,binding_session_id) VALUES(?,?,'feishu',?,?,?,'setup',?,?) ON CONFLICT(channel,external_id) DO UPDATE SET user_id=excluded.user_id,token=excluded.token,base_url=excluded.base_url,status='setup',auth_state='valid',binding_generation=channel_bindings.binding_generation+1,binding_session_id=excluded.binding_session_id,transport='pending',last_inbound_at=NULL,last_api_accepted_at=NULL,last_error_code=NULL,connection_state='awaiting_first_message',cursor='',context_token=NULL,created_at=excluded.created_at",bindingId,entry.userId,openId,crypto.encrypt(JSON.stringify(secret)),result.user_info.tenant_brand==='lark'?OPEN_API.lark:OPEN_API.feishu,now(),randomUUID());
   // Feishu verifies the request URL during this call, so the setup row must already answer the challenge.
   const {client}=await connect(bank.get('SELECT * FROM channel_bindings WHERE id=?',bindingId));
   await setupStep('配置','FEISHU_CONFIG_FAILED',()=>client.application.v7.applicationConfig.patch({path:{app_id:secret.appId},data:{event:{subscription_type:'webhook',request_url:`${origin()}/api/channels/feishu/events/${bindingId}`,add_events:['im.message.receive_v1']},event_and_callback_encrypt_strategy:{encryption_key:secret.encryptKey,verification_token:secret.verificationToken}}}));
    requireThat(entry.status==='setup','创建已取消',409,'FEISHU_REGISTER_CANCELLED');
   // The webhook only goes live once a new version is published; a company tenant may hold that version for admin review.
   await setupStep('发布','FEISHU_PUBLISH_FAILED',()=>client.application.v7.applicationPublish.create({path:{app_id:secret.appId},data:{version:'1.0.1',remark:'启用澄川银行事件回调',changelog:'启用 HTTP 事件回调',mobile_default_ability:'bot',pc_default_ability:'bot'}}));
   if(entry.status!=='setup')throw new BusinessError('创建已取消',409,'FEISHU_REGISTER_CANCELLED');
   bank.atomic(()=>{requireThat(bank.run("UPDATE channel_bindings SET status='active',transport='pending' WHERE id=? AND status='setup'",bindingId).changes,'创建已取消',409,'FEISHU_REGISTER_CANCELLED');bank.audit(entry.userId,'channel.bound',bindingId,{channel:'feishu',mode:'personal'});bank.notify(entry.userId,'飞书专属机器人已绑定','可在飞书与它私聊查询账户、提议业务；为保障资金安全，所有操作都需回App确认。若发消息没有回复，请在「消息渠道绑定」查看机器人状态。');});
   Object.assign(entry,{status:'confirmed',bindingId,done:Date.now()});
   track(send(bank.get('SELECT * FROM channel_bindings WHERE id=?',bindingId),WELCOME).catch(()=>{}));
  }catch(error){
   if(bindingId){forget(bindingId);if(created)bank.run("DELETE FROM channel_bindings WHERE id=? AND status='setup'",bindingId);else bank.run("UPDATE channel_bindings SET status='revoked',token=NULL WHERE id=? AND status='setup'",bindingId);}
   const failed=entry.status==='setup',message=error.status?error.message:`飞书机器人配置失败。${SETUP_HELP}`;
   Object.assign(entry,{status:failed?'failed':entry.status,error:message,done:Date.now()});
   bank.audit(entry.userId,'channel.feishu_register_failed','',{code:error.code||'FEISHU_ERROR',feishuCode:error.feishuCode});
   // The depositor may have left the page by now, so the next step also goes to the in-app message centre.
   if(failed)bank.notify(entry.userId,'飞书机器人创建失败',message);
  }
 }
 async function register(user,pin){
  requireThat(enabled(),'飞书专属机器人未开启',503,'FEISHU_PERSONAL_DISABLED');services.pin(user,pin);crypto.encrypt('configuration-check');
  const key=`feishu-register:${user.id}`;services.checkRate(key);services.badAttempt(key);
  // A restart during setup leaves a hidden row that would otherwise block this depositor forever.
  bank.run("DELETE FROM channel_bindings WHERE user_id=? AND channel='feishu' AND status='setup' AND created_at<?",user.id,new Date(Date.now()-600000).toISOString());
  requireThat(!active("user_id=? AND status IN ('setup','active')",user.id),'已绑定飞书专属机器人，请先解绑',409,'FEISHU_BOT_EXISTS');
  sweep();for(const entry of pending.values())if(entry.userId===user.id&&entry.status==='wait'){entry.status='expired';entry.done=Date.now();entry.controller.abort();}
  requireThat([...pending.values()].filter(e=>['wait','setup'].includes(e.status)).length<maxPending,'当前创建人数较多，请稍后再试',429,'FEISHU_REGISTER_BUSY');
  const entry={id:id('FSREG'),userId:user.id,status:'wait',controller:new AbortController(),seen:Date.now(),until:Date.now()+600000};
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new BusinessError('飞书暂时无法生成二维码，请稍后再试',502,'FEISHU_REGISTER_ERROR')),15000);
   track(Promise.resolve().then(async()=>{const sdk=await loadSdk();entry.controller.signal.throwIfAborted();return sdk.registerApp({source:'chengchuan-bank',createOnly:true,signal:entry.controller.signal,appPreset:{name:'{user}的澄川银行助手',desc:'澄川银行储户专属助手（模拟）'},addons:{preset:false,scopes:{tenant:SCOPES},events:{items:{tenant:['im.message.receive_v1']}}},onQRCodeReady:info=>{clearTimeout(timer);entry.url=info.url;entry.until=Date.now()+Math.min(600,info.expireIn||600)*1000;resolve();}});})
    .then(result=>finish(entry,result),error=>{clearTimeout(timer);reject(error);if(entry.status==='wait')Object.assign(entry,{status:{access_denied:'denied',expired_token:'expired',abort:'expired'}[error?.code]||'failed',done:Date.now()});}).catch(()=>{}));
  });
  pending.set(entry.id,entry);schedule();
  try{await ready;}catch(error){entry.controller.abort();pending.delete(entry.id);throw error.status?error:new BusinessError('飞书暂时无法生成二维码，请稍后再试',502,'FEISHU_REGISTER_ERROR');}
  return {id:entry.id,url:entry.url,expiresIn:Math.round((entry.until-Date.now())/1000)};
 }
 function status(user,registrationId){
  const entry=pending.get(registrationId);requireThat(entry?.userId===user.id,'二维码已过期，请重新生成',404,'FEISHU_REGISTER_EXPIRED');entry.seen=Date.now();
  return {status:entry.status==='setup'?'wait':entry.status,...(entry.bindingId?{bindingId:entry.bindingId}:{}),...(entry.error?{error:entry.error}:{})};
 }
 async function stop(){for(const entry of pending.values()){if(['wait','setup'].includes(entry.status))entry.status='expired';entry.controller.abort();}clearInterval(watch);watch=undefined;while(jobs.size)await Promise.allSettled([...jobs]);pending.clear();clients.clear();}
 function routes(route){
  route('post','/channels/feishu/register','PIN授权一键创建飞书专属机器人',async(req,res)=>res.json(await register(req.user,req.body.pin)));
  route('get','/channels/feishu/register/:id','飞书专属机器人创建状态',(req,res)=>res.json(status(req.user,req.params.id)));
  route('post','/channels/feishu/events/:id','飞书专属机器人事件回调（签名校验）',event,false);
 }
 return {register,status,event,send,typing,forget,stop,routes,enabled,sweep,pendingCount:()=>pending.size,cachedClients:()=>clients.size};
}
