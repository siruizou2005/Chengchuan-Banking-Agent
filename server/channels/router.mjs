import { createCipheriv,createDecipheriv,randomBytes,randomInt } from 'node:crypto';
import { id,now } from '../db.mjs';
import { hash,requireThat } from '../errors.mjs';
import { STATS_LABEL } from '../agent/analytics.mjs';
export function createChannelCrypto(secret=process.env.CHANNEL_SECRET) {
 const key=()=>{requireThat(typeof secret==='string'&&/^[a-f0-9]{64}$/i.test(secret),'请配置64位十六进制CHANNEL_SECRET',503,'CHANNEL_SECRET_REQUIRED');return Buffer.from(secret,'hex');};
 return {encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64')).join('.');},decrypt(value){const [iv,tag,data]=value.split('.').map(s=>Buffer.from(s,'base64')),decipher=createDecipheriv('aes-256-gcm',key(),iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');}};
}
export function eventsText(result,{maskAmounts=false}={}) {
 const yuan=n=>maskAmounts?'****':(n/100).toFixed(2);
 const text=[result.text];
 for(const event of result.events||[]){const a=event.data;
  if(['action','plan'].includes(event.type)){text.push(a.level==='red'?`【待App强验证·红】${a.title}\n操作编号：${a.id}\n请打开澄川银行App完成人脸模拟、短信验证码及支付密码确认。`:`【待确认·黄】${a.title}${a.args.note?'\n备注：'+a.args.note:''}\n操作编号：${a.id}\n回复「确认 ${a.id}」执行，「取消 ${a.id}」放弃。`);}
  if(event.type==='report')text.push(a.totals?`【账单·${a.label}】${a.from}至${a.to}\n消费¥${yuan(a.totals.consumption)}（已扣退款），转账给他人¥${yuan(a.totals.transferOut)}，收入¥${yuan(a.totals.income)}\n${a.categories.slice(0,6).map(c=>`${c.name} ¥${yuan(c.amount)}`).join('；')}${a.excluded.length?'\n不计入消费：'+a.excluded.map(e=>`${e.name} 转出¥${yuan(e.out)} 转入¥${yuan(e.in)}`).join('；'):''}`:`【账单·${a.period}】收入¥${yuan(a.income)}，支出¥${yuan(a.expense)}\n${a.categories.map(c=>`${c.name} ¥${yuan(c.amount)}`).join('；')}`);
  if(event.type==='stats')text.push(`【统计·${a.label}·${STATS_LABEL[a.by]}】合计¥${yuan(a.total)}\n${[...a.buckets].filter(b=>b.count).sort((x,y)=>y.amount-x.amount).slice(0,8).map(b=>`${b.key} ¥${yuan(b.amount)}`).join('；')}`);
  if(event.type==='subscriptions')text.push('【订阅】'+a.subscriptions.map(s=>`${s.merchant} ¥${yuan(s.amount)}/月（${s.status}）`).join('；'));
 }
 const output=text.join('\n\n');return maskAmounts?output.replace(/(?:¥|￥)\s*[\d,.]+/g,'¥****'):output;
}
export function createChannelRouter(services,agent,options={}) {
 const {bank}=services,{get,run,all,atomic,audit,notify}=bank,crypto=createChannelCrypto(options.secret||process.env.CHANNEL_SECRET),busy=new Set();
 function createCode(user,pin){services.pin(user,pin);const code=String(randomInt(100000,1000000));atomic(()=>{run("UPDATE channel_codes SET used=1 WHERE user_id=? AND channel='feishu'",user.id);run('INSERT INTO channel_codes VALUES(?,?,?,?,?,0)',id('BIND'),user.id,hash(code),'feishu',new Date(Date.now()+300000).toISOString());audit(user.id,'channel.code_created','',{channel:'feishu'});});return {code,expiresIn:300};}
 function bind(channel,externalId,code){const key=`bind:${channel}:${hash(externalId)}`;services.checkRate(key);services.badAttempt(key);return atomic(()=>{
  const row=get('SELECT * FROM channel_codes WHERE code_hash=? AND channel=? AND used=0 AND expires_at>?',hash(code),channel,now());requireThat(row,'绑定码无效或已过期',403,'INVALID_BIND_CODE');
  requireThat(!get("SELECT id FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",channel,externalId),'该渠道账号已绑定，请先在App解绑',409);
  const bindingId=id('BIND');run("INSERT INTO channel_bindings(id,user_id,channel,external_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(channel,external_id) DO UPDATE SET user_id=excluded.user_id,status='active',token=NULL,cursor='',context_token=NULL,created_at=excluded.created_at",bindingId,row.user_id,channel,externalId,now());run('UPDATE channel_codes SET used=1 WHERE id=?',row.id);audit(row.user_id,'channel.bound',bindingId,{channel});notify(row.user_id,'消息渠道已绑定',`已授权${channel==='feishu'?'飞书':'微信'}聊天中确认黄色操作。红色操作仍需App验证。`);return get('SELECT * FROM channel_bindings WHERE channel=? AND external_id=?',channel,externalId);
 });}
 function unbind(user,bindingId,pin){services.pin(user,pin);atomic(()=>{requireThat(run("UPDATE channel_bindings SET status='revoked',token=NULL,context_token=NULL WHERE id=? AND user_id=?",bindingId,user.id).changes,'绑定不存在',404);for(const a of all("SELECT id FROM agent_actions WHERE user_id=? AND session_id=? AND status IN ('proposed','confirmed','awaiting_verification')",user.id,bindingId))services.cancel(user,a.id);run("UPDATE channel_outbox SET status='cancelled' WHERE binding_id=? AND status='pending'",bindingId);audit(user.id,'channel.unbound',bindingId);});return {ok:true};}
 async function receive({channel,externalId,messageId,text,contextToken}){
  if(!['feishu','wechat'].includes(channel)||typeof text!=='string'||text.length>6000||!externalId||!messageId)return '';
  if(!run('INSERT OR IGNORE INTO channel_messages VALUES(?,?,?)',channel,messageId,now()).changes)return '';
  try{
   if(channel==='feishu'&&/^绑定\s*\d{6}$/.test(text.trim())){bind(channel,externalId,text.match(/\d{6}/)[0]);return '绑定成功，可查询账户或提议业务。回复「确认」授权黄色操作；红色操作需回App。';}
   const binding=get("SELECT * FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",channel,externalId);
   if(!binding)return channel==='feishu'?'请在澄川银行App「消息渠道绑定」生成绑定码，再回复「绑定 123456」。':'请在澄川银行App「消息渠道绑定」重新扫码。';
   if(contextToken)run('UPDATE channel_bindings SET context_token=? WHERE id=?',crypto.encrypt(contextToken),binding.id);
   const user=get('SELECT * FROM users WHERE id=?',binding.user_id);
   if(/^(帮助|help)$/i.test(text.trim()))return '可查余额、分析账单、提议转账或规划生日。黄色操作回复「确认」，红色操作请回App；解绑请到App安全中心。';
   if(text.trim()==='解绑')return '请回App安全中心输入支付密码解绑。';
   const command=text.trim().match(/^(确认|取消)(?:\s+([A-Za-z0-9]+))?$/);
   if(command){
    services.expireActions();const candidates=all("SELECT * FROM agent_actions WHERE user_id=? AND channel=? AND session_id=? AND status IN ('proposed','confirmed','awaiting_verification') ORDER BY created_at DESC,rowid DESC",user.id,channel,binding.id);
    let a;
    if(command[2])a=get('SELECT * FROM agent_actions WHERE id=? AND user_id=? AND channel=? AND session_id=?',command[2],user.id,channel,binding.id);
    else {if(candidates.length>1)return '有多笔待处理操作，请指定操作编号：\n'+candidates.map(a=>`${a.id} · ${a.title}`).join('\n');a=candidates[0];}
    if(!a){audit(user.id,'channel.confirmation.rejected','',{channel,bindingId:binding.id,code:'NOT_FOUND'});return '本会话没有该待确认操作。';}
    if(['completed','cancelled','failed','expired'].includes(a.status))return `【${a.status==='completed'?'操作完成':'操作已结束'}】编号：${a.id}`;
    if(command[1]==='取消'){services.cancel(user,a.id);return `操作已取消。编号：${a.id}`;}
    if(a.level==='red')return '此操作必须回澄川银行App完成人脸模拟、短信验证码和支付密码验证。';
    const result=services.confirm(user,a.id,{}, {channel,bindingId:binding.id});
    if(result.tool==='list_subscriptions'&&result.status==='completed')return eventsText({text:`【查询完成】编号：${result.id}`,events:[{type:'subscriptions',data:result.result}]},{maskAmounts:options.maskAmounts??process.env.CHANNEL_MASK_AMOUNTS==='true'});
    return `【${result.status==='completed'?'操作完成':result.status==='confirmed'?'已授权，等待执行':'操作未完成'}】${result.title}\n编号：${result.id}${result.error?'\n'+result.error:''}`;
   }
   if(busy.has(binding.id))return '上一条消息正在处理，请稍后重试。';busy.add(binding.id);
   try{run('INSERT OR IGNORE INTO agent_sessions(id,user_id,channel,updated_at) VALUES(?,?,?,?)',binding.id,user.id,channel,now());return eventsText(await agent.runTurn({user,channel,sessionId:binding.id,messages:[{role:'user',content:text}]}),{maskAmounts:options.maskAmounts??process.env.CHANNEL_MASK_AMOUNTS==='true'});}finally{busy.delete(binding.id);}
  }catch(error){const binding=get("SELECT * FROM channel_bindings WHERE channel=? AND external_id=? AND status='active'",channel,externalId);if(binding)audit(binding.user_id,'channel.request.rejected','',{channel,bindingId:binding.id,code:error.code||'CHANNEL_ERROR'});return error.status?error.message:'渠道处理暂时失败，请稍后重试。';}
 }
 function register(route){
  route('get','/channels','已绑定渠道',(req,res)=>res.json(services.snapshot(req.user).bindings));
  route('post','/channels/code','PIN授权飞书绑定码',(req,res)=>res.json(createCode(req.user,req.body.pin)));
  route('post','/channels/:id/unbind','PIN解绑消息渠道',(req,res)=>res.json(unbind(req.user,req.params.id,req.body.pin)));
 }
 return {receive,createCode,bind,unbind,register,crypto};
}
