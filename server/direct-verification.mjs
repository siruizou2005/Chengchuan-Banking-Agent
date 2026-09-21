import { createHmac, randomBytes } from 'node:crypto';
import { id, now } from './db.mjs';
import { cents, requireThat } from './errors.mjs';
import { classify, dailyTotal } from './agent/policy.mjs';
export function registerDirectVerification(route,services) {
 const {bank}=services,secret=randomBytes(32);
 const digest=(path,body)=>createHmac('sha256',secret).update(JSON.stringify([path,Object.fromEntries(Object.entries(body).filter(([k])=>!['pin','verificationToken','verificationActionId'].includes(k)).sort(([a],[b])=>a.localeCompare(b)))])).digest('hex');
 function inspect(user,path,body) {
  const ctx={dailyLimit:user.daily_limit,dailyTotal:dailyTotal(bank,user.id)};
  if(/^\/transactions\/[A-Za-z0-9]+\/confirm$/.test(path)){
   const tx=bank.get('SELECT * FROM transactions WHERE id=? AND user_id=?',path.split('/')[2],user.id);requireThat(tx,'交易不存在',404);
   const tool={transfer:'propose_transfer',payment:'propose_payment',deposit:'propose_subscribe_product',investment:'propose_subscribe_product',redeem:'propose_redeem',loan_draw:'propose_loan_draw',loan_repay:'propose_loan_repay',credit_repay:'propose_credit_repay',credit_spend:'propose_payment'}[tx.type];
   if(['transfer','payment'].includes(tx.type))ctx.dailyTotal-=tx.amount;
   return {red:tx.status==='pending'&&classify(tool,{amount:(tx.amount/100).toFixed(2)},ctx)==='red',title:tx.title+` ¥${(tx.amount/100).toFixed(2)}`,resource:tx.id};
  }
  if(path==='/settings')return {red:body.newPassword!==undefined||body.newPin!==undefined||(body.dailyLimit!==undefined&&cents(body.dailyLimit)>user.daily_limit),title:body.newPassword!==undefined?'修改登录密码':body.newPin!==undefined?'修改支付密码':`修改日限额至 ¥${body.dailyLimit}`,resource:'settings'};
  if(path==='/credit-card'||/^\/accounts\/[A-Za-z0-9]+$/.test(path))return {red:['active','lost'].includes(body.status),title:`卡片${body.status==='lost'?'挂失':'状态调整'}`,resource:path};
  requireThat(false,'该操作无需强验证意图',400,'INVALID_INTENT');
 }
 function start(user,path,body={}) {
  const check=inspect(user,path,body);if(!check.red)return {required:false};
  const binding=digest(path,body),previous=bank.all("SELECT * FROM agent_actions WHERE user_id=? AND tool='direct_operation' AND status='proposed' AND expires_at>?",user.id,now()).find(a=>JSON.parse(a.args).digest===binding);
  if(previous)return {required:true,actionId:previous.id};
  const actionId=id('DIRECT');bank.run('INSERT INTO agent_actions(id,user_id,channel,tool,args,title,level,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',actionId,user.id,'app','direct_operation',JSON.stringify({path,digest:binding,resource:check.resource}),check.title,'red',now(),new Date(Date.now()+900000).toISOString(),now());
  bank.audit(user.id,'agent.action.proposed',actionId,{source:'business_page',path,level:'red'});return {required:true,actionId};
 }
 function consume(user,path,body) {
  const check=inspect(user,path,body);if(!check.red)return;
  const a=bank.get("SELECT * FROM agent_actions WHERE id=? AND user_id=? AND tool='direct_operation' AND status='proposed' AND expires_at>?",body.verificationActionId||'',user.id,now());
  requireThat(a&&JSON.parse(a.args).digest===digest(path,body),'此操作需先完成App强验证',403,'VERIFICATION_REQUIRED');
  services.verification.consume(user,a.id,body.verificationToken);
  bank.run("UPDATE agent_actions SET status='completed',updated_at=? WHERE id=?",now(),a.id);bank.audit(user.id,'agent.action.completed',a.id,{source:'business_page'});
 }
 route('post','/verify/intent','业务页面强验证意图（绑定具体参数）',(req,res)=>res.json(start(req.user,req.body.path,req.body.body||{})));
 return {start,consume};
}
