import { requireThat } from '../errors.mjs';
export function registerAgentRoutes(route,services,agent) {
 const {bank}=services;
 const chat=async(req,res)=>{
  requireThat(!req.body.expectedUserId||req.body.expectedUserId===req.user.id,'登录账户已变化，请重新开始对话',409,'ACCOUNT_CHANGED');
  const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
  res.json(await agent.runTurn({user:req.user,channel:'app',messages:req.body.messages,sessionId:req.body.sessionId,signal:abort.signal}));
 };
 route('post','/agent/chat','智能体工具对话',chat);route('post','/chat','兼容智能体对话',chat);
 route('get','/agent/actions','本人待确认与已执行动作',(req,res)=>res.json(services.snapshot(req.user).agentActions));
 route('post','/agent/actions','从业务页面提议操作',(req,res)=>res.status(201).json(services.propose(req.user,req.body.tool,req.body.args,{channel:'app'})));
 route('post','/agent/actions/:id/confirm','PIN及必要强验证后执行动作',(req,res)=>res.json(services.confirm(req.user,req.params.id,req.body,{channel:'app'})));
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
 route('delete','/agent/sessions/:id','删除对话（仅归档，决策链路与审计保留）',(req,res)=>{requireThat(bank.run("UPDATE agent_sessions SET archived=1 WHERE id=? AND user_id=? AND channel='app' AND archived=0",req.params.id,req.user.id).changes,'对话不存在',404,'NOT_FOUND');bank.audit(req.user.id,'agent.session.archived',req.params.id);res.json({ok:true});});
 route('post','/agent/unlock','支付密码解除智能体锁定',(req,res)=>{services.pin(req.user,req.body.pin);services.guard.unlock(req.user.id);res.json({ok:true});});
 route('get','/agent/splits/:id/:index','本人收到的AA收款请求',(req,res)=>{
  const action=bank.get("SELECT * FROM agent_actions WHERE id=? AND tool='propose_split' AND status='completed'",req.params.id);
  requireThat(action,'收款请求不存在',404);const request=JSON.parse(action.result).requests[Number(req.params.index)];requireThat(request?.toUserId===req.user.id,'收款请求不存在',404);
  const recipient=bank.get("SELECT a.id,u.name FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.id=? AND a.type='debit'",action.user_id);
  res.json({amount:(request.amount/100).toFixed(2),recipient:recipient.id,name:recipient.name,note:JSON.parse(action.args).note||'AA分摊'});
 });
}
