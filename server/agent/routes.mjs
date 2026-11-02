import { requireThat } from '../errors.mjs';
import { resolvePrincipal } from './principal.mjs';
import { id } from '../db.mjs';
import { MODULES } from './modules.mjs';
export function registerAgentRoutes(route,services,agent) {
 const {bank}=services;
 const chat=async(req,res)=>{
  requireThat(!req.body.expectedUserId||req.body.expectedUserId===req.user.id,'登录账户已变化，请重新开始对话',409,'ACCOUNT_CHANGED');
  requireThat(!req.body.sessionId||typeof req.body.sessionId==='string','会话不存在',404,'NOT_FOUND');
  const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
  res.json(await agent.runTurn({user:req.user,channel:'app',messages:req.body.messages,sessionId:req.body.sessionId,messageId:req.body.messageId||req.get('Idempotency-Key'),signal:abort.signal}));
 };
 route('post','/agent/chat','智能体工具对话',chat);route('post','/chat','兼容智能体对话',chat);
 const principal=req=>resolvePrincipal(bank,req.user,{channel:'app'});
 route('get','/agent/memory','本人画像、长期记忆与待确认项',(req,res)=>{const p=principal(req);res.json({enabled:services.memory.enabled(p),profile:services.memory.profile(p),memories:services.memory.list(p)});});
 route('post','/agent/memory','保存本人明确偏好',(req,res)=>res.json(services.memory.update(principal(req),{key:req.body.key,value:req.body.value,category:req.body.category,expires_at:req.body.expires_at,module:req.body.module,memory_type:req.body.memory_type,intent:req.body.intent},{type:'explicit',messageId:id('EDIT')})));
 route('get','/agent/memory/behavior','本人行为假设与证据编号',(req,res)=>res.json(services.memoryEvolution.view(principal(req))));
 route('get','/agent/memory/behavior/:id/evidence','本人假设证据来源（无原文）',(req,res)=>res.json(services.memoryEvolution.evidenceView(principal(req),req.params.id)));
 route('post','/agent/memory/behavior/:id/feedback','确认或拒绝本人行为假设',(req,res)=>res.json(services.memoryEvolution.feedback(principal(req),req.params.id,req.body.action,req.body.version)));
 route('post','/agent/memory/consolidate','有版本保护的确定性证据整合',(req,res)=>res.json(services.memoryEvolution.consolidate(principal(req),{expectedEpoch:req.body.epoch})));
 route('get','/agent/memory/modules','模块定义、本人已激活模块及结构建议',(req,res)=>{
  const p=principal(req);res.json({registry:MODULES,active:bank.all('SELECT module,activated_at,updated_at FROM user_memory_modules WHERE tenant_id=? AND user_id=?',p.tenant_id,p.user_id),suggestions:services.memoryEvolution.suggestions(p),epoch:services.memory.epoch(p)});
 });
 route('get','/agent/memory/context','本人上下文成本与路由调试（无原文）',(req,res)=>{const p=principal(req);res.json(bank.all('SELECT * FROM memory_context_metrics WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100',p.tenant_id,p.user_id).map(r=>({...r,route:JSON.parse(r.route_json),skill_versions:JSON.parse(r.skill_versions),route_json:undefined})));});
 route('patch','/agent/memory/:id','纠正本人记忆（版本检查）',(req,res)=>{
  const p=principal(req),row=services.memory.owned(p,req.params.id);requireThat(Number.isInteger(req.body.version),'请提供当前记忆版本',400,'INVALID_MEMORY');
  requireThat(row.version===req.body.version,'记忆已更新，请刷新',409,'MEMORY_CONFLICT');
  res.json(services.memory.update(p,{key:row.key,value:req.body.value,category:row.category,module:req.body.module??row.module,memory_type:req.body.memory_type??row.memory_type,intent:req.body.intent??row.intent,expires_at:req.body.expires_at,version:row.status==='candidate'?undefined:req.body.version},{type:'explicit',messageId:id('EDIT')}));
 });
 route('post','/agent/memory/:id/confirm','确认本人候选记忆',(req,res)=>res.json(services.memory.confirm(principal(req),req.params.id,req.body.version)));
 route('delete','/agent/memory/:id','删除本人记忆并阻止旧历史恢复',(req,res)=>{requireThat(Number.isInteger(req.body.version),'请提供当前记忆版本',400,'INVALID_MEMORY');res.json(services.memory.remove(principal(req),req.params.id,req.body.version));});
 route('get','/agent/inference','本人模型调用审计（无原始对话）',(req,res)=>{const p=principal(req);res.json(bank.all('SELECT request_id,step,trigger_source,model,input_bytes,input_tokens,output_tokens,cost,status,error_code,created_at,finished_at FROM inference_calls WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100',p.tenant_id,p.user_id));});
 route('get','/agent/actions','本人待确认与已执行动作',(req,res)=>res.json(services.snapshot(req.user).agentActions));
 route('post','/agent/actions','从业务页面提议操作',(req,res)=>res.status(201).json(services.propose(req.user,req.body.tool,req.body.args,{channel:'app'})));
 route('post','/agent/actions/:id/confirm','PIN及必要加强验证后执行动作',(req,res)=>res.json(services.confirm(req.user,req.params.id,req.body,{channel:'app'})));
 route('post','/agent/actions/:id/cancel','取消待确认或定时操作',(req,res)=>res.json(services.cancel(req.user,req.params.id)));
 route('get','/agent/plans','本人联动计划',(req,res)=>res.json(services.plans(req.user)));
 route('post','/agent/plans/:id/abort','中断计划并释放未使用资金',(req,res)=>res.json(services.abortPlan(req.user,req.params.id)));
 route('post','/agent/plans/:id/handover','中断计划并转人工',(req,res)=>{const plan=services.abortPlan(req.user,req.params.id,'转人工接管');res.json(services.handover(req.user,`计划${plan.title}：${req.body.reason||'用户请求人工接管'}`));});
 route('get','/agent/runs','脱敏的智能体决策链路',(req,res)=>res.json(bank.all('SELECT * FROM agent_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 100',req.user.id).map(r=>({...r,trace:JSON.parse(r.trace),injection:JSON.parse(r.injection),events:JSON.parse(r.events||'[]')}))));
 // App 聊天的对话历史：会话列表按最近更新排序；详情由 agent_runs 逐轮回放（含服务端卡片 events）；删除只归档会话，审计链路保留。
 route('get','/agent/sessions','本人App对话历史列表',(req,res)=>res.json(bank.all("SELECT s.id,s.updated_at,s.handover,(SELECT r.input FROM agent_runs r WHERE r.session_id=s.id ORDER BY r.created_at,r.rowid LIMIT 1) AS title,(SELECT COUNT(*) FROM agent_runs r WHERE r.session_id=s.id) AS turns FROM agent_sessions s WHERE s.user_id=? AND s.channel='app' AND s.archived=0 ORDER BY s.updated_at DESC LIMIT 100",req.user.id).filter(s=>s.turns>0)));
 route('get','/agent/sessions/:id','回放一段对话的消息与卡片',(req,res)=>{
  const s=bank.get("SELECT * FROM agent_sessions WHERE id=? AND user_id=? AND channel='app' AND archived=0",req.params.id,req.user.id);requireThat(s,'对话不存在',404,'NOT_FOUND');
  const messages=bank.all('SELECT * FROM agent_runs WHERE session_id=? AND user_id=? ORDER BY created_at,rowid',s.id,req.user.id).flatMap(r=>[{role:'user',text:r.input,at:r.created_at},{role:'assistant',text:r.output,events:JSON.parse(r.events||'[]'),trace:JSON.parse(r.trace),runId:r.id,at:r.created_at}]);
  res.json({id:s.id,handover:Boolean(s.handover),updatedAt:s.updated_at,messages});
 });
 route('delete','/agent/sessions/:id','归档对话并撤销衍生证据（保留审计）',(req,res)=>{bank.atomic(()=>{
  requireThat(bank.run("UPDATE agent_sessions SET archived=1,history='[]',task_context='{}' WHERE id=? AND user_id=? AND channel='app' AND archived=0",req.params.id,req.user.id).changes,'对话不存在',404,'NOT_FOUND');
  const p=principal(req);services.memory.invalidate(p,{sessionId:req.params.id,reason:'session_removed'});services.memoryEvolution.consolidate(p);bank.audit(req.user.id,'agent.session.archived',req.params.id);
 });res.json({ok:true});});
 route('post','/agent/unlock','支付密码解除智能体锁定',(req,res)=>{services.pin(req.user,req.body.pin);services.guard.unlock(req.user.id);res.json({ok:true});});
 route('get','/agent/splits/:id/:index','本人收到的AA收款请求',(req,res)=>{
  // A split inside a plan runs as a scheduled task, and its links carry the task id.
  const split=bank.get("SELECT user_id,args,result FROM agent_actions WHERE id=? AND tool='propose_split' AND status='completed'",req.params.id)||bank.get("SELECT user_id,args,result FROM scheduled_tasks WHERE id=? AND kind='propose_split' AND status='completed'",req.params.id);
  requireThat(split,'收款请求不存在',404);const request=JSON.parse(split.result).requests[Number(req.params.index)];requireThat(request?.toUserId===req.user.id,'收款请求不存在',404);
  const recipient=bank.get("SELECT a.id,u.name FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.id=? AND a.type='debit'",split.user_id);
  res.json({amount:(request.amount/100).toFixed(2),recipient:recipient.id,name:recipient.name,note:JSON.parse(split.args).note||'AA分摊'});
 });
}
