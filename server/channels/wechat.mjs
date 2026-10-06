import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { id,now } from '../db.mjs';
import { BusinessError,requireThat } from '../errors.mjs';
const origin='https://ilinkai.weixin.qq.com';
export function safeBaseUrl(value) {
 const url=new URL(value||origin);requireThat(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(url.hostname==='ilinkai.weixin.qq.com'||url.hostname.endsWith('.ilinkai.weixin.qq.com')),'微信返回的服务地址无效',502,'INVALID_CHANNEL_HOST');return url.origin;
}
export function createWeChat(services,router,options={}) {
 const {bank}=services,transport=options.fetch||fetch,crypto=router.crypto,pending=new Map(),loops=new Map();let stopped=false;
 const enabled=()=>options.enabled??process.env.WECHAT_ENABLED==='true';
 async function request(base,path,{token,body,signal}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),35000);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  try{
   const response=await transport(safeBaseUrl(base)+path,{method:body?'POST':'GET',signal:controller.signal,headers:{'Content-Type':'application/json','iLink-App-ClientVersion':'1',...(token?{Authorization:`Bearer ${token}`,AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')}:{})},...(body?{body:JSON.stringify({...body,base_info:{channel_version:'1.0.2'}})}:{})});
   if(!response.ok)throw new BusinessError('微信服务暂时不可用',502,'WECHAT_ERROR');const data=await response.json();
   if(data.ret===-14||data.errcode===-14)throw new BusinessError('微信会话已失效，请重新扫码',403,'WECHAT_EXPIRED');
   if((data.ret&&data.ret!==0)||(data.errcode&&data.errcode!==0))throw new BusinessError('微信服务返回异常',502,'WECHAT_ERROR');return data;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 const expireBinding=binding=>router.expire(binding,'微信绑定已失效','请前往消息渠道绑定页面重新扫码。');
 async function qr(user,pin){requireThat(enabled(),'微信渠道未开启',503,'WECHAT_DISABLED');services.pin(user,pin);crypto.encrypt('configuration-check');const data=await request(origin,'/ilink/bot/get_bot_qrcode?bot_type=3');requireThat(data.qrcode&&data.qrcode_img_content,'二维码响应无效',502);for(const [key,value] of pending)if(value.until<Date.now()||value.userId===user.id)pending.delete(key);const qrId=id('QR');pending.set(qrId,{userId:user.id,qrcode:data.qrcode,until:Date.now()+300000});return {id:qrId,qrcode_img_content:data.qrcode_img_content,expiresIn:300};}
 async function qrStatus(user,qrId){
  const entry=pending.get(qrId);requireThat(entry?.userId===user.id&&entry.until>Date.now(),'二维码已过期，请重新生成',404,'QR_EXPIRED');if(entry.bindingId)return {status:'confirmed',bindingId:entry.bindingId};requireThat(!entry.polling,'二维码查询进行中',429,'QR_BUSY');entry.polling=true;
  try{const data=await request(origin,`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(entry.qrcode)}`);
   if(data.status==='confirmed'){
    requireThat(typeof data.bot_token==='string'&&typeof data.ilink_user_id==='string','微信登录响应无效',502);const base=safeBaseUrl(data.baseurl);
    const previous=bank.get("SELECT * FROM channel_bindings WHERE channel='wechat' AND external_id=?",data.ilink_user_id);requireThat(!previous||previous.user_id===user.id||previous.status!=='active','此微信账号已绑定其他银行用户，请先解绑',409);
    const bindingId=previous?.id||id('BIND');bank.atomic(()=>{bank.run("INSERT INTO channel_bindings(id,user_id,channel,external_id,token,base_url,created_at) VALUES(?,?,'wechat',?,?,?,?) ON CONFLICT(channel,external_id) DO UPDATE SET user_id=excluded.user_id,token=excluded.token,base_url=excluded.base_url,status='active',cursor='',context_token=NULL,created_at=excluded.created_at",bindingId,user.id,data.ilink_user_id,crypto.encrypt(data.bot_token),base,now());bank.audit(user.id,'channel.bound',bindingId,{channel:'wechat'});bank.notify(user.id,'微信已绑定','需授权确认的操作，请在微信私聊中核对后逐笔确认；需加强验证的操作，请回App完成验证。');});entry.bindingId=bindingId;if(options.autoStart!==false)startBinding(bindingId);return {status:'confirmed',bindingId};
   }
   if(data.status==='expired')pending.delete(qrId);return {status:data.status==='scanned'?'scaned':data.status};
  }finally{entry.polling=false;}
 }
 async function send(binding,text,signal){try{return await request(binding.base_url,'/ilink/bot/sendmessage',{token:crypto.decrypt(binding.token),signal,body:{msg:{to_user_id:binding.external_id,message_type:2,message_state:2,context_token:binding.context_token?crypto.decrypt(binding.context_token):'',item_list:[{type:1,text_item:{text}}]}}});}catch(error){if(error.code==='WECHAT_EXPIRED')expireBinding(binding);throw error;}}
 async function pollOnce(binding,signal){
  let data;try{data=await request(binding.base_url,'/ilink/bot/getupdates',{token:crypto.decrypt(binding.token),signal,body:{get_updates_buf:binding.cursor||''}});}catch(error){if(error.code==='WECHAT_EXPIRED')expireBinding(binding);throw error;}
  for(const message of data.msgs||[]){
   if(message.message_type!==1||message.from_user_id!==binding.external_id)continue;
   const text=(message.item_list||[]).filter(i=>i.type===1&&i.text_item).map(i=>i.text_item.text).join('\n');if(!text)continue;
   const current=bank.get("SELECT * FROM channel_bindings WHERE id=? AND status='active'",binding.id);if(!current)break;
   const reply=await router.receive({channel:'wechat',externalId:binding.external_id,messageId:String(message.message_id||message.msg_id||''),text,contextToken:message.context_token});
   if(reply){const updated=bank.get("SELECT * FROM channel_bindings WHERE id=? AND status='active'",binding.id);if(updated)await send(updated,reply,signal);}
  }
  if(typeof data.get_updates_buf==='string')bank.run('UPDATE channel_bindings SET cursor=? WHERE id=?',data.get_updates_buf,binding.id);return data;
 }
 function startBinding(bindingId){if(stopped||loops.has(bindingId)||!enabled())return;const abort=new AbortController();const task=(async()=>{let backoff=1000;while(!abort.signal.aborted&&!stopped){const binding=bank.get("SELECT * FROM channel_bindings WHERE id=? AND status='active'",bindingId);if(!binding?.token)break;try{await pollOnce(binding,abort.signal);backoff=1000;await delay(200,undefined,{signal:abort.signal});}catch(error){if(abort.signal.aborted||error.code==='WECHAT_EXPIRED')break;await delay(backoff,undefined,{signal:abort.signal}).catch(()=>{});backoff=Math.min(backoff*2,60000);}}})().catch(()=>{}).finally(()=>loops.delete(bindingId));loops.set(bindingId,{abort,task});}
 function start(){stopped=false;if(enabled())for(const binding of bank.all("SELECT id FROM channel_bindings WHERE channel='wechat' AND status='active'"))startBinding(binding.id);}
 async function stop(){stopped=true;for(const loop of loops.values())loop.abort.abort();await Promise.all([...loops.values()].map(l=>l.task));}
 function register(route){route('post','/channels/wechat/qr','PIN授权微信扫码绑定',async(req,res)=>res.json(await qr(req.user,req.body.pin)));route('get','/channels/wechat/qr/:id','微信扫码状态',async(req,res)=>res.json(await qrStatus(req.user,req.params.id)));}
 return {qr,qrStatus,pollOnce,send,start,startBinding,stop,register,enabled};
}
