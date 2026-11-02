import { loadPumaPolicy } from './config.mjs';
import { createEvidenceStore } from './evidence.mjs';
import { createConsentService } from './consent.mjs';
import { createPumaMemory } from './memory.mjs';
import { createPumaModels } from './models.mjs';
import { createDelegateRegistry } from './delegates.mjs';
import { requireThat, BusinessError } from '../errors.mjs';
import { id, now } from '../db.mjs';

export function createPumaService(bank,services,options={}) {
  const policy=loadPumaPolicy(options),evidence=createEvidenceStore(bank),consents=createConsentService(bank,services);
  const memory=createPumaMemory(bank,services,evidence,policy),models=createPumaModels(bank,services,evidence,policy),delegates=createDelegateRegistry(bank,services,policy,options);
  function research(user,input) {
    requireThat(typeof input==='string'&&input.length>0&&input.length<=2000,'请输入当前任务',400,'INVALID_TASK_SCOPE');
    if(!consents.allowed(user,'personalization'))return {status:'DISABLED',behavior:models.behavior(user),traits:models.traits(user)};
    const event=evidence.ingest({user_id:user.id,type:'USER_INTENT_STATED',occurred_at:now(),source:'trusted_ui',initiated_by:'USER',correlation_id:'task',resource_ref:'task',consent_scope:'personalization',evidence_quality:'SUFFICIENT'});
    return {context:memory.context(user,input),behavior:models.behavior(user),intent:models.intent(user,input,[event.event_id]),traits:models.traits(user),scam:models.scam(user,{text:input,evidenceIds:[event.event_id]})};
  }
  function observe(user,input) {
    if(!services.memory.enabled({user_id:user.id})||!consents.allowed(user,'data_read')||policy.flags.puma_behavior_model==='disabled')return;
    try {
      const result=research(user,input.slice(0,2000));
      bank.audit(user.id,'puma.shadow.inferred','',{modelVersion:'puma-statistical-v0',intentStatus:result.intent?.status,traitStatus:result.traits?.status});
      return result;
    }catch {bank.run('INSERT INTO puma_metrics(user_id,kind,value,created_at) VALUES(?,?,1,?)',user.id,'MODEL_UNAVAILABLE',now());}
  }
  return {policy,evidence,consents,memory,models,delegates,research,observe};
}
export function registerPumaRoutes(route,bank,services,transfers) {
  const p=services.puma;
  route('get','/v1/puma/config','PUMA 模拟功能状态',(req,res)=>res.json({version:p.policy.version,flags:p.policy.flags,simulation:true,livePaymentEnabled:false}));
  route('get','/v1/puma/consents','本人范围授权记录',(req,res)=>res.json(p.consents.list(req.user)));
  route('post','/v1/puma/consents','独立数据、个性化及工具授权',(req,res)=>res.json(p.consents.update(req.user,req.body)));
  route('get','/v1/puma/events','本人事件引用',(req,res)=>res.json(p.evidence.list(req.user)));
  route('get','/v1/puma/risk-flags','本人规范化风险案件',(req,res)=>{
    services.risk.expire();
    res.json(bank.all('SELECT f.*,l.scope,l.subject_ref,l.severity,l.evidence_ids,l.model_or_rule_version,l.review_owner,l.review_due FROM risk_flags f LEFT JOIN puma_risk_links l ON l.flag_id=f.id WHERE f.user_id=? ORDER BY f.created_at DESC LIMIT 100',req.user.id).map(f=>({...f,status:({FALSE_POSITIVE:'CONFIRMED_LEGITIMATE',RESOLVED:'INCONCLUSIVE',CONFIRMED:'UNDER_REVIEW'})[f.status]||f.status,review_outcome:bank.get('SELECT outcome FROM puma_feedback WHERE flag_id=? ORDER BY created_at DESC LIMIT 1',f.id)?.outcome||null,evidence_ids:JSON.parse(f.evidence_ids||'[]')})));
  });
  route('post','/internal/puma/review-feedback','有证据的独立复核结论',(req,res)=>{
    services.risk.queue(req.user);
    const body=req.body,flag=typeof body.flagId==='string'&&bank.get('SELECT * FROM risk_flags WHERE id=?',body.flagId);
    requireThat(flag&&['CONFIRMED_FRAUD','CONFIRMED_LEGITIMATE','INCONCLUSIVE'].includes(body.outcome)&&Array.isArray(body.evidenceIds)&&body.evidenceIds.length>0,'审核结论或证据无效',400,'INVALID_REVIEW_FEEDBACK');
    p.evidence.references(flag.user_id,body.evidenceIds);
    bank.atomic(()=>{
      services.risk.review(req.user,{flagId:flag.id,disposition:({CONFIRMED_FRAUD:'CONFIRMED',CONFIRMED_LEGITIMATE:'FALSE_POSITIVE',INCONCLUSIVE:'RESOLVED'})[body.outcome],rationale:body.rationale,nextReviewAt:body.nextReviewAt});
      bank.run('INSERT INTO puma_feedback VALUES(?,?,?,?,?,?)',id('PF'),flag.id,req.user.id,body.outcome,JSON.stringify(body.evidenceIds),now());
      bank.audit(flag.user_id,'risk.review.feedback',flag.id,{outcome:body.outcome,reviewerId:req.user.id});
    });res.json({status:body.outcome,supervisedLabel:body.outcome==='INCONCLUSIVE'?null:body.outcome});
  });
  route('get','/v1/puma/behavior','本人影子行为统计',(req,res)=>res.json(p.models.behavior(req.user)));
  route('post','/v1/puma/context','本人任务最小上下文与研究候选',(req,res)=>res.json(p.research(req.user,req.body.taskScope)));
  route('get','/v1/puma/delegates','本人保护关系',(req,res)=>res.json(p.delegates.list(req.user)));
  route('post','/v1/puma/delegates','PIN 授权建立保护关系',(req,res)=>res.status(201).json(p.delegates.register(req.user,req.body)));
  route('post','/v1/puma/delegates/:id/verify','关系参与者独立验证',(req,res)=>res.json(p.delegates.verify(req.user,req.params.id,req.body)));
  route('post','/v1/puma/delegates/:id/revoke','撤销自愿保护关系',(req,res)=>res.json(p.delegates.revoke(req.user,req.params.id,req.body)));
  route('post','/internal/puma/delegates/:id/legal-review','独立法定权限审核',(req,res)=>res.json(p.delegates.legalReview(req.user,req.params.id,req.body)));
  route('get','/v1/puma/delegate-approvals','本人待共同确认交易',(req,res)=>res.json(p.delegates.incoming(req.user)));
  route('post','/v1/puma/delegate-approvals/:id/confirm','交易绑定共同确认',(req,res)=>{
    const result=p.delegates.confirm(req.user,req.params.id,req.body);
    const owner=bank.get('SELECT * FROM users WHERE id=?',result.ownerId),d=transfers.drafts.view(owner,result.draftId);
    let submitted=false;
    // The delegate's decision stands on its own. A failed submission concerns the owner's approval, funds or risk, so it goes to the owner and is not disclosed here.
    if(result.status==='APPROVED'&&d.status==='USER_APPROVED')try{submitted=Boolean(transfers.executor.submit(owner,d.id).paymentId);}catch(error){
      if(!(error instanceof BusinessError))throw error;
      bank.audit(owner.id,'puma.delegate.submit_deferred',d.id,{code:error.code});
      bank.notify(owner.id,'共同确认已完成，付款尚未提交',`${error.message}。可在转账草稿中查看并处理。`);
    }
    res.json({status:result.status,submitted});
  });
  route('get','/internal/puma/metrics','受控 PUMA 运行指标',(req,res)=>{services.risk.queue(req.user);res.json(bank.all('SELECT kind,COUNT(*) count,AVG(value) mean,MAX(value) max FROM puma_metrics GROUP BY kind'));});
}
