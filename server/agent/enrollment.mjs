import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { AGREEMENTS } from './agreements.mjs';
import { resolvePrincipal } from './principal.mjs';

export const IM_NOT_ENABLED_REPLY='智能助手未开通或已关闭，请在澄川银行App「智能助手」中开通后再使用。';
// The assistant opens only after the user accepts the current agreements; closing it stops App, IM and API conversations alike.
export function createEnrollment(services,options={}) {
 const {bank}=services,{get,all,run,atomic,audit}=bank;
 const documents=()=>options.agreements||AGREEMENTS;
 let channels=null;
 const accepted=userId=>all('SELECT document,version,accepted_at FROM agent_consents WHERE user_id=? AND revoked_at IS NULL ORDER BY accepted_at,document',userId);
 function status(userId) {
  const user=get('SELECT agent_enabled_at,agent_onboarding FROM users WHERE id=?',userId),current=accepted(userId);
  const valid=documents().every(d=>current.some(c=>c.document===d.id&&c.version===d.version));
  return {
   status:!user?.agent_enabled_at?'not_enabled':valid?'enabled':'reconsent_required',
   enabledAt:user?.agent_enabled_at||null,onboarding:user?.agent_onboarding||'pending',
   documents:documents().map(({body:_body,...d})=>d),
   accepted:current.map(c=>({id:c.document,version:c.version,acceptedAt:c.accepted_at})),
  };
 }
 const enabled=userId=>status(userId).status==='enabled';
 const available=userId=>!services.guard.disabled()&&enabled(userId);
 function assertEnabled(userId) {
  const state=status(userId).status;
  requireThat(state==='enabled',state==='reconsent_required'?'智能助手服务协议已更新，请在App「智能助手」重新阅读并同意后使用':'请先在App「智能助手」阅读协议并开通智能助手',403,'AGENT_NOT_ENABLED');
 }
 function document(docId) {const doc=documents().find(d=>d.id===docId);requireThat(doc,'协议不存在',404,'NOT_FOUND');return doc;}
 function enable(user,acceptedDocs) {
  const current=documents();
  requireThat(Array.isArray(acceptedDocs)&&acceptedDocs.length===current.length&&current.every(d=>acceptedDocs.some(a=>a?.id===d.id&&a?.version===d.version)),'协议已更新，请刷新后重新阅读并同意',409,'AGREEMENT_VERSION_MISMATCH');
  return atomic(()=>{
   if(enabled(user.id))return status(user.id);
   const at=now();
   run('UPDATE agent_consents SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',at,user.id);
   for(const d of current)run('INSERT INTO agent_consents(id,user_id,document,version,accepted_at) VALUES(?,?,?,?,?)',id('CONSENT'),user.id,d.id,d.version,at);
   run('UPDATE users SET agent_enabled_at=? WHERE id=?',at,user.id);
   audit(user.id,'agent.enabled','',{documents:current.map(d=>({id:d.id,title:d.title,version:d.version})),acceptedAt:at});
   return status(user.id);
  });
 }
 // Clearing removes what the assistant learned and the visible conversations; audit rows and decision traces stay.
 function clear(user) {
  const p=resolvePrincipal(bank,user,{channel:'app'}),scope=[p.tenant_id,p.user_id];
  services.memory.clearAll(p);
  // Earlier rejections go too: a full reset should not keep blocking those suggestions.
  for(const table of ['memory_rejections','memory_evidence','behavior_hypotheses','behavior_events','memory_module_summaries','user_memory_modules','memory_module_suggestions'])run(`DELETE FROM ${table} WHERE tenant_id=? AND user_id=?`,...scope);
  run("UPDATE agent_sessions SET archived=CASE WHEN channel='app' THEN 1 ELSE archived END,history='[]',task_context='{}' WHERE user_id=?",user.id);
  run('DELETE FROM hidden_spend_analyses WHERE user_id=?',user.id);
  // Decision traces stay as the record of what the assistant did; what the customer said and was told does not.
  run("UPDATE agent_runs SET input='',output='',events='[]' WHERE user_id=?",user.id);
  channels.clearRecords(user.id);
  services.memory.invalidate(p,{reason:'assistant_data_cleared'});
  run("UPDATE users SET agent_onboarding='pending',agent_onboarding_state='{}' WHERE id=?",user.id);
 }
 function disable(user,{unbindChannels=false,clearData=false,pin}={}) {
  requireThat(typeof unbindChannels==='boolean'&&typeof clearData==='boolean','关闭选项无效',400,'INVALID_BODY');
  requireThat(get('SELECT agent_enabled_at FROM users WHERE id=?',user.id)?.agent_enabled_at,'智能助手尚未开通',409,'AGENT_NOT_ENABLED');
  // Unbinding and clearing cannot be undone, so they need the payment PIN like an ordinary unbind.
  if(unbindChannels||clearData)services.pin(user,pin);
  return atomic(()=>{
   const at=now();
   run('UPDATE agent_consents SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',at,user.id);
   run('UPDATE users SET agent_enabled_at=NULL WHERE id=?',user.id);
   // Proposals from conversations die with the assistant; mandates the user already confirmed keep running.
   const pending=all("SELECT id FROM agent_actions WHERE user_id=? AND session_id IS NOT NULL AND status IN ('proposed','awaiting_verification')",user.id);
   for(const a of pending)services.cancel(user,a.id);
   const cancelled=pending.length+services.cancelConversationDrafts(user.id);
   const unbound=unbindChannels?channels.revokeAll(user):0;
   if(clearData)clear(user);
   audit(user.id,'agent.disabled','',{unbindChannels,clearData,cancelledActions:cancelled,unboundChannels:unbound});
   return {...status(user.id),cancelledActions:cancelled,unboundChannels:unbound};
  });
 }
 return {status,enabled,available,assertEnabled,document,enable,disable,attachChannels:value=>{channels=value;}};
}

export function registerEnrollmentRoutes(route,services) {
 const {enrollment,onboarding}=services;
 const view=user=>({...enrollment.status(user.id),onboardingState:onboarding.state(user.id)});
 route('get','/agent/enrollment','智能助手开通状态、当前协议版本与引导进度',(req,res)=>res.json(view(req.user)));
 route('get','/agent/agreements/:id','智能助手协议全文（Markdown）',(req,res)=>res.json(enrollment.document(req.params.id)));
 route('post','/agent/enrollment','同意当前全部协议并开通智能助手',(req,res)=>{enrollment.enable(req.user,req.body.documents);res.json(view(req.user));});
 route('post','/agent/enrollment/disable','关闭智能助手；可选同时解绑渠道或清空记忆与对话（需支付密码）',(req,res)=>res.json({...enrollment.disable(req.user,{unbindChannels:req.body.unbindChannels??false,clearData:req.body.clearData??false,pin:req.body.pin}),onboardingState:onboarding.state(req.user.id)}));
 route('post','/agent/onboarding/advance','App内完成飞书/微信绑定或风险测评后推进首次引导',(req,res)=>{enrollment.assertEnabled(req.user.id);res.json(onboarding.advance(req.user,req.body?.field));});
 route('post','/agent/onboarding/answer','点选项或提交卡片直接保存一项首次引导，不调用模型',(req,res)=>{enrollment.assertEnabled(req.user.id);res.json(onboarding.answerDirectly(req.user,resolvePrincipal(services.bank,req.user,{channel:'app'}),req.body,typeof req.body.sessionId==='string'?req.body.sessionId:undefined,id('ONBOARD')));});
 route('post','/agent/onboarding/end','结束首次引导（已记下的偏好保留）',(req,res)=>{enrollment.assertEnabled(req.user.id);res.json(onboarding.end(req.user));});
 route('post','/agent/onboarding/reset','重新开始首次引导',(req,res)=>{enrollment.assertEnabled(req.user.id);res.json(onboarding.reset(req.user));});
}
