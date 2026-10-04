import { id, now } from './db.mjs';
import { requireThat, hash, BusinessError } from './errors.mjs';
import { decide } from './agent/policy.mjs';
import { paramsDigest, canonical, actionParams } from './authorization.mjs';

export function registerDirectVerification(route,services) {
 const {bank,authorization}=services;
 const fresh=user=>bank.get('SELECT * FROM users WHERE id=?',user.id);
 function inspect(user,path,body) {
  user=fresh(user);let tool,args,title,resource,transaction;
  if(/^\/transactions\/[A-Za-z0-9]+\/confirm$/.test(path)) {
   transaction=bank.get('SELECT * FROM transactions WHERE id=? AND user_id=?',path.split('/')[2],user.id);requireThat(transaction,'交易不存在',404,'NOT_FOUND');
   tool={transfer:'propose_transfer',payment:'propose_payment',deposit:'propose_subscribe_product',investment:'propose_subscribe_product',redeem:'propose_redeem',loan_draw:'propose_loan_draw',loan_repay:'propose_loan_repay',credit_repay:'propose_credit_repay',credit_spend:'propose_payment'}[transaction.type];
   args={amount:(transaction.amount/100).toFixed(2)};title=transaction.title+' ¥'+args.amount;resource=transaction.id;
  }else if(path==='/settings') {
   tool=body.newPassword!==undefined||body.newPin!==undefined?'change_credentials':'propose_set_daily_limit';args={amount:body.dailyLimit||String(user.daily_limit/100)};title='修改安全设置';resource='settings';
  }else if(path==='/credit-card'||/^\/accounts\/[A-Za-z0-9]+$/.test(path)) {
   const card=path==='/credit-card'?bank.get('SELECT * FROM credit_cards WHERE user_id=?',user.id):bank.get('SELECT * FROM accounts WHERE id=? AND user_id=?',path.split('/')[2],user.id);
   requireThat(card,'卡片不存在',404,'NOT_FOUND');
   requireThat(['active','frozen','lost'].includes(body.status),'状态无效');
   tool='propose_card_action';args={action:body.status==='frozen'?'freeze':body.status==='lost'?'report_lost':'unfreeze'};title='卡片状态调整';resource=card.id;
  }else requireThat(false,'不支持的业务确认入口',400,'INVALID_INTENT');
  const decision=decide(bank,user,tool,args,{excludeId:transaction?.id,phase:'execute',confirmed:true});
  const credentialHashes=Object.fromEntries(['newPin','newPassword'].filter(k=>body[k]!==undefined).map(k=>[k+'Digest',hash(String(body[k]))]));
  const digest=paramsDigest({path,body:canonical(body),credentialHashes,transaction:transaction?{id:transaction.id,amount:transaction.amount,payload:JSON.parse(transaction.payload)}:undefined});
  return {decision,digest,title,resource,transaction};
 }
 function create(user,path,check) {
  const actionId=id('DIRECT'),args={path,digest:check.digest,resource:check.resource};
  bank.run('INSERT INTO agent_actions(id,user_id,channel,tool,args,title,level,created_at,expires_at,updated_at,decision) VALUES(?,?,?,?,?,?,?,?,?,?,?)',actionId,user.id,'app','direct_operation',JSON.stringify(args),check.title,check.decision.level,now(),new Date(Date.now()+900000).toISOString(),now(),JSON.stringify(check.decision));
  const action=bank.get('SELECT * FROM agent_actions WHERE id=?',actionId);
  bank.run('UPDATE agent_actions SET params_digest=? WHERE id=?',paramsDigest(actionParams(action)),actionId);
  bank.audit(user.id,'policy.evaluated',actionId,{source:'business_page',phase:'propose',decision:check.decision});return action;
 }
 function start(user,path,body={}) {
  const check=inspect(user,path,body);
  if(check.decision.level!=='red'||check.transaction?.status==='completed')return {required:false,decision:check.decision};
  const previous=bank.all("SELECT * FROM agent_actions WHERE user_id=? AND tool='direct_operation' AND status='proposed' AND expires_at>?",user.id,now()).find(a=>JSON.parse(a.args).digest===check.digest);
  const action=previous||bank.atomic(()=>create(user,path,check));
  return {required:true,actionId:action.id,decision:check.decision};
 }
 // Called inside the transaction that submits the actual business change.
 function consume(user,path,body) {
  const check=inspect(user,path,body);let action,factors=['explicit_confirmation','pin'];
  if(check.decision.level==='red') {
   action=bank.get("SELECT * FROM agent_actions WHERE id=? AND user_id=? AND tool='direct_operation' AND status='proposed' AND expires_at>?",body.verificationActionId||'',user.id,now());
   if(!action||JSON.parse(action.args).digest!==check.digest){const error=new BusinessError('此操作需先完成App加强验证',403,'VERIFICATION_REQUIRED');error.decision=check.decision;throw error;}
   factors.push(...services.verification.consume(user,action.id,body.verificationToken));
  }else action=create(user,path,check);
  const args=JSON.parse(action.args);
  authorization.issue(user,action,check.decision,factors,{channel:'app'},action.expires_at);
  const permit=authorization.permit(user,action,'direct_operation',args,check.decision,{transactionId:check.transaction?.id});
  bank.audit(user.id,'policy.evaluated',action.id,{phase:'execute',decision:check.decision});
  return {action,permit};
 }
 function complete(proof,result={ok:true}) {authorization.complete(proof.permit,result);services.completeAction(proof.action,result);}
 function fail(user,path,error) {
  for(const action of bank.all("SELECT * FROM agent_actions WHERE user_id=? AND tool='direct_operation' AND status='proposed'",user.id))if(JSON.parse(action.args).path===path){authorization.revoke(action.id,error.code);bank.run('UPDATE verifications SET used=1 WHERE action_id=?',action.id);bank.run("UPDATE agent_actions SET status='failed',error=? WHERE id=?",error.message,action.id);bank.audit(user.id,'authorization.execution_rejected',action.id,{code:error.code});}
 }
 route('post','/verify/intent','业务页面模拟加强验证意图（绑定具体参数）',(req,res)=>res.json(start(req.user,req.body.path,req.body.body||{})));
 return {start,consume,complete,fail};
}
