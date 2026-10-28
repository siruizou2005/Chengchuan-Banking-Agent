import { createCipheriv,createDecipheriv,randomBytes,randomInt,randomUUID } from 'node:crypto';
import { id,now } from '../db.mjs';
import { hash,requireThat } from '../errors.mjs';
import { STATS_LABEL } from '../agent/analytics.mjs';
import { channelPreferences, setChannelPreference, channelText, maskMoney } from './preferences.mjs';
import { assertChannelExecution } from '../agent/execution.mjs';
import { redactIdentity } from '../privacy.mjs';
import { unsubscribeCommand } from './reports.mjs';
export function createChannelCrypto(secret=process.env.CHANNEL_SECRET) {
 const key=()=>{requireThat(typeof secret==='string'&&/^[a-f0-9]{64}$/i.test(secret),'请配置64位十六进制CHANNEL_SECRET',503,'CHANNEL_SECRET_REQUIRED');return Buffer.from(secret,'hex');};
 return {encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64')).join('.');},decrypt(value){const [iv,tag,data]=value.split('.').map(s=>Buffer.from(s,'base64')),decipher=createDecipheriv('aes-256-gcm',key(),iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');}};
}
// Where to confirm an IM-originated action: a deep link when the public origin is known, otherwise directions.
export const appLink=(origin,actionId)=>origin?`${origin}/#tasks?action=${actionId}`:'澄川银行App「智能助手 → 操作与计划」';
export function eventsText(result,{maskAmounts=false,origin=''}={}) {
 const yuan=n=>maskAmounts?'****':(n/100).toFixed(2);
 const text=[result.text];
 for(const event of result.events||[]){const a=event.data;
  if(['action','plan'].includes(event.type)){text.push(a.level==='red'?`【待App加强验证】${a.title}\n操作编号：${a.id}\n请在App内完成人脸模拟、短信验证码及支付密码确认：${appLink(origin,a.id)}`:`【待授权确认】${a.title}${a.args.note?'\n备注：'+a.args.note:''}\n操作编号：${a.id}\n为保障资金安全，请在App内输入支付密码确认：${appLink(origin,a.id)}\n回复「取消 ${a.id}」可放弃。`);}
  if(event.type==='report')text.push(a.totals?`【账单·${a.label}】${a.from}至${a.to}\n消费¥${yuan(a.totals.consumption)}（已扣退款），转账给他人¥${yuan(a.totals.transferOut)}，收入¥${yuan(a.totals.income)}\n${a.categories.slice(0,6).map(c=>`${c.name} ¥${yuan(c.amount)}`).join('；')}${a.excluded.length?'\n不计入消费：'+a.excluded.map(e=>`${e.name} 转出¥${yuan(e.out)} 转入¥${yuan(e.in)}`).join('；'):''}`:`【账单·${a.period}】收入¥${yuan(a.income)}，支出¥${yuan(a.expense)}\n${a.categories.map(c=>`${c.name} ¥${yuan(c.amount)}`).join('；')}`);
  if(event.type==='stats')text.push(`【统计·${a.label}·${STATS_LABEL[a.by]}】合计¥${yuan(a.total)}\n${[...a.buckets].filter(b=>b.count).sort((x,y)=>y.amount-x.amount).slice(0,8).map(b=>`${b.key} ¥${yuan(b.amount)}`).join('；')}`);
  if(event.type==='advice'){const p=a.profile,lines=[`【配置建议·${a.user.risk}】活期可用¥${yuan(p.available)}，月均支出¥${yuan(p.monthlySpend)}，建议可投资¥${yuan(p.investable)}`];
   if(a.gate)lines.push(`${a.gate.title}：${a.gate.text}`);
   for(const b of a.plan?.buckets||[])lines.push(`${b.label}${b.share}%：${b.products.map(x=>`${x.name}¥${yuan(x.amount)}（${x.reason}）`).join('；')}`);
   if(a.plan?.excluded.total)lines.push(`已排除${a.plan.excluded.total}款：${a.plan.excluded.reasons.map(r=>`${r.reason}${r.count}款`).join('、')}`);
   text.push(lines.join('\n'));}
  if(event.type==='products')text.push(`【${a.title||'产品'}】`+a.products.slice(0,8).map(p=>`${p.name}（${p.risk}，${p.rateLabel||'收益'}${p.rate??'--'}%）`).join('；'));
  if(event.type==='subscriptions')text.push('【订阅】'+a.subscriptions.map(s=>`${s.merchant} ¥${yuan(s.amount)}/月（${s.status}）`).join('；'));
 }
 const output=redactIdentity(text.join('\n\n'));return maskAmounts?maskMoney(output):output;
}
export function createChannelRouter(services,agent,options={}) {
 const {bank}=services,{get,run,all,atomic,audit,notify}=bank,crypto=createChannelCrypto(options.secret||process.env.CHANNEL_SECRET),revokeListeners=[];
 const origin=()=>options.publicOrigin??process.env.PUBLIC_ORIGIN??'',textOptions=()=>({origin:origin()});
 const revoked=bindingId=>{for(const listener of revokeListeners)listener(bindingId);};
 // Shared by every channel whose upstream credentials stop working: cancel what the binding started, then tell the user.
 function expire(binding,title,body){const changed=atomic(()=>{if(!run("UPDATE channel_bindings SET status='expired',auth_state='revoked',token=NULL,context_token=NULL WHERE id=? AND status='active' AND binding_generation=?",binding.id,binding.binding_generation).changes)return false;for(const a of all("SELECT id FROM agent_actions WHERE user_id=? AND session_id IN (?,?) AND status IN ('proposed','confirmed','awaiting_verification')",binding.user_id,binding.id,binding.binding_session_id))services.cancel({id:binding.user_id},a.id);run("UPDATE channel_outbox SET status='cancelled' WHERE binding_id=? AND status IN ('pending','forwarded')",binding.id);audit(binding.user_id,'channel.expired',binding.id,{channel:binding.channel});notify(binding.user_id,title,body);return true;});if(changed)revoked(binding.id);}
 function createCode(user,pin){services.enrollment.assertEnabled(user.id);services.pin(user,pin);const code=String(randomInt(100000,1000000));atomic(()=>{run("UPDATE channel_codes SET used=1 WHERE user_id=? AND channel='feishu'",user.id);run('INSERT INTO channel_codes VALUES(?,?,?,?,?,0)',id('BIND'),user.id,hash(code),'feishu',new Date(Date.now()+300000).toISOString());audit(user.id,'channel.code_created','',{channel:'feishu'});});return {code,expiresIn:300};}
 function bind(channel,externalId,code,botAccountId=options.feishu?.appId||process.env.FEISHU_APP_ID||'shared-local'){const key=`bind:${channel}:${hash(externalId)}`;services.checkRate(key);services.badAttempt(key);return atomic(()=>{
  const row=get('SELECT * FROM channel_codes WHERE code_hash=? AND channel=? AND used=0 AND expires_at>?',hash(code),channel,now());requireThat(row,'绑定码无效或已过期',403,'INVALID_BIND_CODE');
  requireThat(!get("SELECT id FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",channel,externalId),'该渠道账号已绑定，请先在App解绑',409);
  const bindingId=id('BIND');run("INSERT INTO channel_bindings(id,user_id,channel,external_id,created_at,binding_session_id) VALUES(?,?,?,?,?,?) ON CONFLICT(channel,external_id) DO UPDATE SET user_id=excluded.user_id,status='active',auth_state='valid',binding_generation=channel_bindings.binding_generation+1,binding_session_id=excluded.binding_session_id,token=NULL,base_url=NULL,transport=NULL,cursor='',context_token=NULL,last_inbound_at=NULL,last_api_accepted_at=NULL,last_error_code=NULL,connection_state='awaiting_first_message',created_at=excluded.created_at",bindingId,row.user_id,channel,externalId,now(),randomUUID());run('UPDATE channel_bindings SET external_bot_id=? WHERE channel=? AND external_id=?',botAccountId,channel,externalId);run('UPDATE channel_codes SET used=1 WHERE id=?',row.id);audit(row.user_id,'channel.bound',bindingId,{channel});notify(row.user_id,'消息渠道已绑定',`已绑定${channel==='feishu'?'飞书':'微信'}。可在私聊中查询账户、提议业务；为保障资金安全，所有操作都需回App确认。`);return get('SELECT * FROM channel_bindings WHERE channel=? AND external_id=?',channel,externalId);
 });}
 function revoke(user,bindingId){atomic(()=>{requireThat(run("UPDATE channel_bindings SET status='revoked',auth_state='revoked',token=NULL,context_token=NULL WHERE id=? AND user_id=?",bindingId,user.id).changes,'绑定不存在',404);const binding=get('SELECT binding_session_id FROM channel_bindings WHERE id=?',bindingId);for(const a of all("SELECT id FROM agent_actions WHERE user_id=? AND session_id IN (?,?) AND status IN ('proposed','confirmed','awaiting_verification')",user.id,bindingId,binding.binding_session_id))services.cancel(user,a.id);run("UPDATE channel_outbox SET status='cancelled' WHERE binding_id=? AND status IN ('pending','forwarded')",bindingId);revoked(bindingId);audit(user.id,'channel.unbound',bindingId);});}
 function unbind(user,bindingId,pin){services.pin(user,pin);revoke(user,bindingId);return {ok:true};}
 // Closing the assistant with "unbind" revokes every live binding; the caller has already checked the PIN.
 function revokeAll(user){const rows=all("SELECT id FROM channel_bindings WHERE user_id=? AND status='active'",user.id);for(const b of rows)revoke(user,b.id);return rows.length;}
 function wechatCommand(binding,text){
  const value=text.trim();
  if(/^(帮助|help)$/i.test(value))return '可以查询余额、分析账单、提议业务。完整结果请在App查看，所有业务确认都需回App完成；这里可回复「取消 操作编号」。';
  if(value==='解绑')return '请回App「消息渠道绑定」输入支付密码解绑。';
  const unsubscribed=unsubscribeCommand(bank,binding,value);if(unsubscribed)return unsubscribed;
  const command=value.match(/^(确认|取消)(?:\s+([A-Za-z0-9]+))?$/);if(!command)return null;
  return atomic(()=>{
   requireThat(get("SELECT id FROM channel_bindings WHERE id=? AND status='active' AND auth_state='valid' AND binding_generation=?",binding.id,binding.binding_generation),'请回App重新连接微信',403,'CHANNEL_REAUTH_REQUIRED');
   services.expireActions();
   const rows=all("SELECT * FROM agent_actions WHERE user_id=? AND channel='wechat' AND session_id IN (?,?) ORDER BY created_at DESC,rowid DESC",binding.user_id,binding.id,binding.binding_session_id);
   const pending=rows.filter(a=>['proposed','confirmed','awaiting_verification'].includes(a.status));
   if(!command[2]&&pending.length>1)return '有多笔操作，请指定编号：\n'+pending.map(a=>a.id).join('\n');
   const action=command[2]?rows.find(a=>a.id===command[2]):pending[0];if(!action)return '本会话没有该待处理操作。';
   if(['cancelled','failed','expired','completed'].includes(action.status))return `该操作已结束，详情请在App查看。编号：${action.id}`;
   if(command[1]==='取消'){services.cancel({id:binding.user_id},action.id);return `操作已取消。编号：${action.id}`;}
   return `请在App核对操作并完成${action.level==='red'?'加强验证和支付密码':'支付密码'}确认：${appLink(origin(),action.id)}\n编号：${action.id}`;
  });
 }
 function runWeChat(binding,text,execution,hooks={}){
  const user=get('SELECT * FROM users WHERE id=?',binding.user_id),sessionId=binding.binding_session_id;
  run('INSERT OR IGNORE INTO agent_sessions(id,user_id,channel,updated_at) VALUES(?,?,?,?)',sessionId,user.id,'wechat',now());
  return agent.runTurn({user,channel:'wechat',sessionId,messages:[{role:'user',content:text}],execution,...hooks});
 }
 async function receive(input){
  const before=get("SELECT * FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",input.channel,input.externalId);
  const reply=await receiveRaw(input);
  const binding=get("SELECT * FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",input.channel,input.externalId);
  if(before&&(!binding||binding.user_id!==before.user_id||binding.binding_generation!==before.binding_generation))return '';
  return binding?channelText(bank,binding.user_id,input.channel,reply):reply;
 }
 async function receiveRaw({channel,externalId,messageId,text,contextToken,botAccountId}){
  if(!['feishu','wechat'].includes(channel)||typeof text!=='string'||text.length>6000||!externalId||!messageId)return '';
  if(channel==='feishu'&&get('SELECT 1 FROM feishu_inbox i JOIN channel_bindings b ON b.id=i.binding_id WHERE b.external_id=? AND i.message_id=?',externalId,messageId))return '';
  if(!run('INSERT OR IGNORE INTO channel_messages VALUES(?,?,?)',channel,messageId,now()).changes)return '';
  try{
   if(channel==='feishu'&&/^绑定\s*\d{6}$/.test(text.trim())){bind(channel,externalId,text.match(/\d{6}/)[0],botAccountId);return '绑定成功，可查询账户或提议业务。为保障资金安全，所有操作都需回澄川银行App确认；在这里可回复「取消 操作编号」放弃。';}
   const binding=get("SELECT * FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",channel,externalId);
   if(!binding)return channel==='feishu'?'请在澄川银行App「消息渠道绑定」生成绑定码，再回复「绑定 123456」。':'请在澄川银行App「消息渠道绑定」重新扫码。';
   if(channel==='feishu'&&(binding.token||(botAccountId&&binding.external_bot_id!==botAccountId)))return '';
   if(contextToken)run('UPDATE channel_bindings SET context_token=? WHERE id=?',crypto.encrypt(contextToken),binding.id);
   const command=feishuCommand(binding,text);if(command!==null)return command;
   return eventsText(await runFeishu(binding,text),textOptions());
  }catch(error){const binding=get("SELECT * FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",channel,externalId);if(binding)audit(binding.user_id,'channel.request.rejected','',{channel,bindingId:binding.id,code:error.code||'CHANNEL_ERROR'});return error.status?error.message:'渠道处理暂时失败，请稍后重试。';}
 }
 function feishuContext(binding){return {channel:binding.channel,bindingId:binding.id,bindingSessionId:binding.binding_session_id,bindingGeneration:binding.binding_generation};}
 function runFeishu(binding,text,execution={},hooks={}){
  assertChannelExecution(bank,feishuContext(binding),binding.user_id);
  const user=get('SELECT * FROM users WHERE id=?',binding.user_id),sessionId=binding.binding_session_id;
  run('INSERT OR IGNORE INTO agent_sessions(id,user_id,channel,updated_at) VALUES(?,?,?,?)',sessionId,user.id,binding.channel,now());
  return agent.runTurn({user,channel:binding.channel,sessionId,messages:[{role:'user',content:text}],execution:{...feishuContext(binding),...execution},...hooks});
 }
 function feishuCommand(binding,text){return atomic(()=>{
   assertChannelExecution(bank,feishuContext(binding),binding.user_id);
   const user={id:binding.user_id},channel=binding.channel,legacySession=binding.binding_generation===1?binding.id:binding.binding_session_id;
   if(/^(帮助|help)$/i.test(text.trim()))return '可查余额、分析账单、提议转账或规划生日。所有操作都需回澄川银行App确认，在这里可回复「取消 操作编号」放弃。解绑请到App安全中心。';
   if(text.trim()==='解绑')return '请回App安全中心输入支付密码解绑。';
   const unsubscribed=unsubscribeCommand(bank,binding,text);if(unsubscribed)return unsubscribed;
   const command=text.trim().match(/^(确认|取消)(?:\s+([A-Za-z0-9]+))?$/);
   if(command){
    services.expireActions();const candidates=all("SELECT * FROM agent_actions WHERE user_id=? AND channel=? AND session_id IN (?,?) AND status IN ('proposed','confirmed','awaiting_verification') ORDER BY created_at DESC,rowid DESC",user.id,channel,legacySession,binding.binding_session_id);
    let a;
    if(command[2])a=get('SELECT * FROM agent_actions WHERE id=? AND user_id=? AND channel=? AND session_id IN (?,?)',command[2],user.id,channel,legacySession,binding.binding_session_id);
    else {if(candidates.length>1)return '有多笔待处理操作，请指定操作编号：\n'+candidates.map(a=>`${a.id} · ${a.title}`).join('\n');a=candidates[0];}
    if(!a){audit(user.id,'channel.confirmation.rejected','',{channel,bindingId:binding.id,code:'NOT_FOUND'});return '本会话没有该待确认操作。';}
    if(['completed','cancelled','failed','expired'].includes(a.status))return `【${a.status==='completed'?'操作完成':'操作已结束'}】编号：${a.id}`;
    if(command[1]==='取消'){services.cancel(user,a.id);return `操作已取消。编号：${a.id}`;}
    if(a.status==='confirmed')return `【已授权，等待执行】${a.title}\n编号：${a.id}`;
    // Confirming needs an in-app factor (PIN, plus face and SMS when required); IM only points the user there.
    return `为保障资金安全，确认需在澄川银行App内完成${a.level==='red'?'人脸模拟、短信验证码和支付密码验证':'支付密码验证'}：${appLink(origin(),a.id)}\n编号：${a.id}`;
   }
   return null;
 });}
 function register(route){
  route('get','/channels/preferences','本人各渠道金额显示设置',(req,res)=>res.json(channelPreferences(bank,req.user.id)));
  route('patch','/channels/preferences/:channel','修改本人单个渠道的金额显示设置',(req,res)=>res.json(setChannelPreference(bank,req.user.id,req.params.channel,req.body.maskAmounts)));
  route('get','/channels','已绑定渠道',(req,res)=>res.json(services.snapshot(req.user).bindings));
  route('post','/channels/code','PIN授权飞书绑定码',(req,res)=>res.json(createCode(req.user,req.body.pin)));
  route('post','/channels/:id/unbind','PIN解绑消息渠道',(req,res)=>res.json(unbind(req.user,req.params.id,req.body.pin)));
 }
 return {receive,createCode,bind,unbind,revokeAll,expire,wechatCommand,runWeChat,feishuCommand,runFeishu,onRevoke:listener=>revokeListeners.push(listener),register,crypto};
}
