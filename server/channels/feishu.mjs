import { randomBytes } from 'node:crypto';
import { id,now } from '../db.mjs';
import { BusinessError,requireThat } from '../errors.mjs';
// SDK request errors dump the whole axios request, bearer token included, so clients log nothing.
const QUIET={error(){},warn(){},info(){},debug(){},trace(){}};
export function createFeishuHandler(router,client,onError=()=>{},owner) {
 return data=>{
  const message=data.message,sender=data.sender?.sender_id?.open_id;
  if(!message||message.chat_type!=='p2p'||message.message_type!=='text'||data.sender?.sender_type==='app'||!sender||(owner&&sender!==owner))return {};
  let text;try{text=JSON.parse(message.content).text;}catch{return {};}
  // The SDK dispatcher must acknowledge immediately; model processing is asynchronous.
  void router.receive({channel:'feishu',externalId:sender,messageId:message.message_id,text}).then(async reply=>{
   if(reply)await client.im.v1.message.reply({path:{message_id:message.message_id},data:{msg_type:'text',content:JSON.stringify({text:reply})}});
  }).catch(onError);
  return {};
 };
}
export async function startFeishu(router,options={}) {
 const appId=options.appId||process.env.FEISHU_APP_ID,appSecret=options.appSecret||process.env.FEISHU_APP_SECRET;
 if(!appId||!appSecret)return {stop:async()=>{},send:async()=>{throw new Error('飞书未配置');}};
 const sdk=options.sdk||await import('@larksuiteoapi/node-sdk');
 const client=new sdk.Client({appId,appSecret,logger:QUIET}),ws=new sdk.WSClient({appId,appSecret,loggerLevel:sdk.LoggerLevel.warn});
 ws.start({eventDispatcher:new sdk.EventDispatcher({}).register({'im.message.receive_v1':createFeishuHandler(router,client,()=>console.warn('Feishu message failed'))})});
 return {stop:async()=>{ws.close({force:true});},send:async(binding,text)=>{
  const result=await client.im.v1.message.create({params:{receive_id_type:'open_id'},data:{receive_id:binding.external_id,msg_type:'text',content:JSON.stringify({text})}});if(result.code)throw new Error('飞书推送失败');
 }};
}
const OPEN_API={feishu:'https://open.feishu.cn',lark:'https://open.larksuite.com'};
const SCOPES=['im:message','im:message:send_as_bot','im:message.p2p_msg:readonly','application:application:patch'];
const WELCOME='你好，我是你的澄川银行专属助手（模拟）。可以问我余额、账单，或让我提议转账、缴费；为保障资金安全，所有操作都需回澄川银行App确认，在这里可回复「取消 操作编号」放弃。发消息没有回复时，请回App「消息渠道绑定」查看机器人状态。';
const SETUP_HELP='请到飞书开发者后台 open.feishu.cn/app 删除刚创建的「…的澄川银行助手」，再回到本页重新创建；多次失败请联系客服。';
// Per-depositor bots created by Feishu's one-click registration. Events arrive by webhook, so an idle bot costs one
// database row: no connection, timer or client object until a message comes in or a push goes out.
export function createFeishuBots(services,router,options={}) {
 const {bank}=services,crypto=router.crypto,pending=new Map(),clients=new Map(),maxClients=options.maxClients||100,maxPending=options.maxPending||20;let watch;
 const origin=()=>options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
 const enabled=()=>(options.enabled??process.env.FEISHU_PERSONAL_ENABLED==='true')&&/^https:\/\/[^/]+$/.test(origin());
 const loadSdk=async()=>options.sdk||await import('@larksuiteoapi/node-sdk');
 const active=(sql,...args)=>bank.get(`SELECT * FROM channel_bindings WHERE channel='feishu' AND token IS NOT NULL AND ${sql}`,...args);
 function forget(bindingId){clients.delete(bindingId);}
 // Clients are cached most-recently-used last, so trimming walks from the stalest entry.
 function trim(){const cutoff=Date.now()-1800000;for(const [key,entry] of clients){if(clients.size<=maxClients&&entry.used>=cutoff)break;clients.delete(key);}}
 async function connect(binding){
  const cached=clients.get(binding.id);if(cached){clients.delete(binding.id);cached.used=Date.now();clients.set(binding.id,cached);return cached;}
  const sdk=await loadSdk(),secret=JSON.parse(crypto.decrypt(binding.token));
  const client=new sdk.Client({appId:secret.appId,appSecret:secret.appSecret,domain:binding.base_url||OPEN_API.feishu,logger:QUIET});
  const handler=createFeishuHandler(router,client,()=>console.warn('Feishu personal bot message failed'),binding.external_id);
  // The dispatcher only calls handlers for events whose signature checked out, which proves the published webhook is live.
  const dispatcher=new sdk.EventDispatcher({encryptKey:secret.encryptKey,verificationToken:secret.verificationToken}).register({'im.message.receive_v1':data=>{webhookLive(binding.id);return handler(data);}});
  const entry={secret,client,handle:sdk.adaptExpress(dispatcher,{autoChallenge:true}),used:Date.now()};trim();clients.set(binding.id,entry);return entry;
 }
 function webhookLive(bindingId){bank.run("UPDATE channel_bindings SET transport='webhook' WHERE id=? AND transport IS NOT 'webhook'",bindingId);}
 // Each setup call reports Feishu's own error code so the depositor and support know what failed and what to do next.
 async function setupStep(name,code,call){
  let result;try{result=await call();}catch(error){result={code:error?.response?.data?.code??-1};}
  if(result?.code!==0)throw Object.assign(new BusinessError(`飞书机器人${name}失败${result?.code>0?`（飞书错误码 ${result.code}）`:''}。${SETUP_HELP}`,502,code),{feishuCode:result?.code});
 }
 // Only expire when Feishu itself refuses to issue a token for the stored credentials; network errors keep the binding.
 async function credentialsRejected(entry){try{const result=await entry.client.auth.tenantAccessToken.internal({data:{app_id:entry.secret.appId,app_secret:entry.secret.appSecret}});return Boolean(result?.code);}catch(error){return Boolean(error?.response?.data?.code);}}
 async function send(binding,text){
  const entry=await connect(binding);
  try{const result=await entry.client.im.v1.message.create({params:{receive_id_type:'open_id'},data:{receive_id:binding.external_id,msg_type:'text',content:JSON.stringify({text})}});if(result?.code)throw new BusinessError('飞书推送失败',502,'FEISHU_SEND_FAILED');return result;}
  catch(error){if(await credentialsRejected(entry)){forget(binding.id);router.expire(binding,'飞书专属机器人已失效','请前往消息渠道绑定页面重新创建。');}throw error;}
 }
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
   bank.run("INSERT INTO channel_bindings(id,user_id,channel,external_id,token,base_url,status,created_at) VALUES(?,?,'feishu',?,?,?,'setup',?) ON CONFLICT(channel,external_id) DO UPDATE SET user_id=excluded.user_id,token=excluded.token,base_url=excluded.base_url,status='setup',cursor='',context_token=NULL,created_at=excluded.created_at",bindingId,entry.userId,openId,crypto.encrypt(JSON.stringify(secret)),result.user_info.tenant_brand==='lark'?OPEN_API.lark:OPEN_API.feishu,now());
   // Feishu verifies the request URL during this call, so the setup row must already answer the challenge.
   const {client}=await connect(bank.get('SELECT * FROM channel_bindings WHERE id=?',bindingId));
   await setupStep('配置','FEISHU_CONFIG_FAILED',()=>client.application.v7.applicationConfig.patch({path:{app_id:secret.appId},data:{event:{subscription_type:'webhook',request_url:`${origin()}/api/channels/feishu/events/${bindingId}`,add_events:['im.message.receive_v1']},event_and_callback_encrypt_strategy:{encryption_key:secret.encryptKey,verification_token:secret.verificationToken}}}));
   // The webhook only goes live once a new version is published; a company tenant may hold that version for admin review.
   await setupStep('发布','FEISHU_PUBLISH_FAILED',()=>client.application.v7.applicationPublish.create({path:{app_id:secret.appId},data:{version:'1.0.1',remark:'启用澄川银行事件回调',changelog:'启用 HTTP 事件回调',mobile_default_ability:'bot',pc_default_ability:'bot'}}));
   if(entry.status!=='setup')throw new BusinessError('创建已取消',409,'FEISHU_REGISTER_CANCELLED');
   bank.atomic(()=>{bank.run("UPDATE channel_bindings SET status='active',transport='pending' WHERE id=? AND status='setup'",bindingId);bank.audit(entry.userId,'channel.bound',bindingId,{channel:'feishu',mode:'personal'});bank.notify(entry.userId,'飞书专属机器人已绑定','可在飞书与它私聊查询账户、提议业务；为保障资金安全，所有操作都需回App确认。若发消息没有回复，请在「消息渠道绑定」查看机器人状态。');});
   Object.assign(entry,{status:'confirmed',bindingId,done:Date.now()});
   void send(bank.get('SELECT * FROM channel_bindings WHERE id=?',bindingId),WELCOME).catch(()=>{});
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
  const sdk=await loadSdk(),entry={id:id('FSREG'),userId:user.id,status:'wait',controller:new AbortController(),seen:Date.now(),until:Date.now()+600000};
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new BusinessError('飞书暂时无法生成二维码，请稍后再试',502,'FEISHU_REGISTER_ERROR')),15000);
   Promise.resolve().then(()=>sdk.registerApp({source:'chengchuan-bank',createOnly:true,signal:entry.controller.signal,appPreset:{name:'{user}的澄川银行助手',desc:'澄川银行储户专属助手（模拟）'},addons:{preset:false,scopes:{tenant:SCOPES},events:{items:{tenant:['im.message.receive_v1']}}},onQRCodeReady:info=>{clearTimeout(timer);entry.url=info.url;entry.until=Date.now()+Math.min(600,info.expireIn||600)*1000;resolve();}}))
    .then(result=>finish(entry,result),error=>{clearTimeout(timer);reject(error);if(entry.status==='wait')Object.assign(entry,{status:{access_denied:'denied',expired_token:'expired',abort:'expired'}[error?.code]||'failed',done:Date.now()});}).catch(()=>{});
  });
  pending.set(entry.id,entry);schedule();
  try{await ready;}catch(error){entry.controller.abort();pending.delete(entry.id);throw error.status?error:new BusinessError('飞书暂时无法生成二维码，请稍后再试',502,'FEISHU_REGISTER_ERROR');}
  return {id:entry.id,url:entry.url,expiresIn:Math.round((entry.until-Date.now())/1000)};
 }
 function status(user,registrationId){
  const entry=pending.get(registrationId);requireThat(entry?.userId===user.id,'二维码已过期，请重新生成',404,'FEISHU_REGISTER_EXPIRED');entry.seen=Date.now();
  return {status:entry.status==='setup'?'wait':entry.status,...(entry.bindingId?{bindingId:entry.bindingId}:{}),...(entry.error?{error:entry.error}:{})};
 }
 function stop(){for(const entry of pending.values())entry.controller.abort();pending.clear();clients.clear();clearInterval(watch);watch=undefined;}
 function routes(route){
  route('post','/channels/feishu/register','PIN授权一键创建飞书专属机器人',async(req,res)=>res.json(await register(req.user,req.body.pin)));
  route('get','/channels/feishu/register/:id','飞书专属机器人创建状态',(req,res)=>res.json(status(req.user,req.params.id)));
  route('post','/channels/feishu/events/:id','飞书专属机器人事件回调（签名校验）',event,false);
 }
 return {register,status,event,send,forget,stop,routes,enabled,sweep,pendingCount:()=>pending.size,cachedClients:()=>clients.size};
}
