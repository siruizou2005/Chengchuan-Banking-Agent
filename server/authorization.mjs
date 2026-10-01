import { createHash } from 'node:crypto';
import { id, now } from './db.mjs';
import { requireThat, hash, cents } from './errors.mjs';
import { POLICY_VERSION, rank, actionAmount } from './agent/policy.mjs';

const secrets = /^(pin|password|oldPassword|newPin|newPassword|verificationToken|verificationActionId|code|frameHash)$/i;
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k=>!secrets.test(k)).map(k=>[k,canonical(value[k])]));
  return value;
}
export const paramsDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function actionParams(action) {
  const args = JSON.parse(action.args);
  if (args.steps) args.steps = args.steps.map(({status,result,actionId,...step})=>step);
  return {tool:action.tool,args};
}
export function createAuthorization(bank) {
  const permits = new WeakSet();
  function revoke(actionId,reason='revoked',status='revoked') {
    for (const a of bank.all("SELECT * FROM operation_authorizations WHERE action_id=? AND status='active'",actionId)) {
      bank.run('UPDATE operation_authorizations SET status=?,revoked_at=? WHERE id=?',status,now(),a.id);
      bank.audit(a.user_id,'authorization.revoked',a.id,{actionId,reason,status});
    }
  }
  function issue(user,action,decision,factors,context,expiresAt) {
    revoke(action.id,'superseded');
    const plan = bank.get('SELECT id FROM agent_plans WHERE action_id=?',action.id);
    const args = JSON.parse(action.args);
    const steps = args.steps || [{id:'single',tool:action.tool,args}];
    const scope = {steps:steps.map(s=>({id:s.id,tool:s.tool,digest:paramsDigest(s.args),amount:actionAmount(s.tool,s.args)})),budget:steps.reduce((n,s)=>n+actionAmount(s.tool,s.args),0)};
    const authorizationId = id('AUTH'),revision = bank.get('SELECT COALESCE(MAX(revision),0)+1 AS n FROM operation_authorizations WHERE action_id=?',action.id).n;
    bank.run('INSERT INTO operation_authorizations(id,user_id,action_id,plan_id,revision,params_digest,scope,approved_level,factors,policy_version,channel,binding_id,valid_from,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',authorizationId,user.id,action.id,plan?.id||null,revision,paramsDigest(actionParams(action)),JSON.stringify(scope),decision.level,JSON.stringify(factors),POLICY_VERSION,context.channel||'app',action.channel!=='app'?action.session_id:null,now(),expiresAt,'active',now());
    bank.audit(user.id,'authorization.issued',authorizationId,{runId:action.run_id,actionId:action.id,planId:plan?.id,revision,paramsDigest:paramsDigest(actionParams(action)),scope,decision,factors,channel:context.channel,bindingId:action.channel!=='app'?action.session_id:null});
    return bank.get('SELECT * FROM operation_authorizations WHERE id=?',authorizationId);
  }
  function active(user,action,at=now()) {
    const authorization = bank.get("SELECT * FROM operation_authorizations WHERE user_id=? AND action_id=? AND status='active' ORDER BY revision DESC LIMIT 1",user.id,action.id);
    requireThat(authorization && authorization.valid_from<=at && authorization.expires_at>at,'授权不存在、已撤销或过期',403,'AUTHORIZATION_INVALID');
    requireThat(authorization.params_digest===paramsDigest(actionParams(action)),'操作参数已变化，请重新提议并授权',403,'AUTHORIZATION_MISMATCH');
    if (authorization.binding_id) requireThat(bank.get("SELECT id FROM channel_bindings WHERE id=? AND user_id=? AND status='active'",authorization.binding_id,user.id),'原渠道已解绑，授权已失效',403,'AUTHORIZATION_INVALID');
    return authorization;
  }
  function permit(user,action,tool,args,decision,{stepId='single',key=action.id,at=now(),transactionId}={}) {
    const authorization = active(user,action,at),scope=JSON.parse(authorization.scope);
    const step=scope.steps.find(s=>s.id===stepId);
    requireThat(step && step.tool===tool && step.digest===paramsDigest(args) && step.amount===actionAmount(tool,args),'授权步骤或参数不匹配',403,'AUTHORIZATION_MISMATCH');
    requireThat(!bank.get('SELECT id FROM authorization_executions WHERE execution_key=? OR (action_id=? AND step_id=?)',key,action.id,stepId),'该步骤已执行',409,'ALREADY_EXECUTED');
    requireThat(rank[authorization.approved_level]>=rank[decision.level] && (decision.level!=='red'||JSON.parse(authorization.factors).includes('simulated_sms')),'需补充App强验证',403,'SUPPLEMENTAL_VERIFICATION_REQUIRED');
    const spent=bank.get('SELECT COALESCE(SUM(amount),0) AS n FROM authorization_executions WHERE action_id=?',action.id).n;
    requireThat(spent+step.amount<=scope.budget,'超出已授权预算',403,'AUTHORIZATION_BUDGET');
    const p=Object.freeze({userId:user.id,runId:action.run_id,planId:authorization.plan_id,actionId:action.id,authorizationId:authorization.id,key,stepId,tool,digest:step.digest,amount:step.amount,at,transactionId,bodyFingerprint:args._transaction?hash(JSON.stringify(canonical(args._transaction))):undefined});
    permits.add(p); return p;
  }
  function assertPermit(p,user,tool,args) {requireThat(p&&permits.has(p)&&p.userId===user.id&&p.tool===tool&&p.digest===paramsDigest(args),'缺少可信执行上下文',403,'AUTHORIZATION_REQUIRED');}
  function assertSettlement(p,user,tx) {requireThat(p&&permits.has(p)&&p.userId===user.id&&(p.transactionId===tx.id||p.bodyFingerprint===tx.fingerprint)&&(!p.standingKey||tx.idempotency_key===p.standingKey),'资金提交缺少匹配的操作授权',403,'AUTHORIZATION_REQUIRED');}
  function complete(p,result) {
    requireThat(permits.has(p),'缺少可信执行上下文',403,'AUTHORIZATION_REQUIRED');
    bank.run('INSERT INTO authorization_executions(id,action_id,authorization_id,execution_key,step_id,amount,result,created_at) VALUES(?,?,?,?,?,?,?,?)',id('EXEC'),p.actionId,p.authorizationId,p.key,p.stepId,p.amount,JSON.stringify(result),now());
    bank.audit(p.userId,'authorization.executed',p.authorizationId,{runId:p.runId,actionId:p.actionId,planId:p.planId,stepId:p.stepId,executionKey:p.key,transactionId:result?.id});
    permits.delete(p);
  }
  function standing(user,subscription,body,at) {
    const current=bank.get("SELECT * FROM subscriptions WHERE id=? AND user_id=? AND status='active'",subscription.id,user.id);
    const mandate=bank.get("SELECT * FROM subscription_mandates WHERE subscription_id=? AND user_id=? AND status='active'",subscription.id,user.id);
    requireThat(current && current.next_at===subscription.next_at && current.next_at<=at && mandate && mandate.merchant===current.merchant && mandate.amount===current.amount && mandate.period==='monthly','持续订阅授权与商户、金额或周期不匹配',403,'MANDATE_INVALID');
    requireThat(body.type==='payment'&&body.billType==='merchant'&&body.merchant===`订阅 · ${current.merchant}`&&cents(body.amount)===current.amount&&Object.keys(body).every(k=>['type','billType','merchant','amount'].includes(k)),'代扣参数超出持续订阅授权范围',403,'MANDATE_INVALID');
    const p=Object.freeze({userId:user.id,subscriptionId:current.id,mandateSource:mandate.source,standingKey:`subscription:${current.id}:${current.next_at}`,bodyFingerprint:hash(JSON.stringify(canonical(body))),at}); permits.add(p); return p;
  }
  return {issue,revoke,active,permit,assertPermit,assertSettlement,complete,standing};
}
