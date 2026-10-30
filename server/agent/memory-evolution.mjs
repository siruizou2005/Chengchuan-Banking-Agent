import { createHash } from 'node:crypto';
import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { assertPrincipal } from './principal.mjs';
import { injectionFlags } from './guard.mjs';

// Closed allowlist: hypotheses can only suggest presentation, never financial assumptions.
export const BEHAVIORS=Object.freeze({
  downside_first:{module:'investment',key:'analysis_style',value:'先说明下行风险',text:'可能偏好先了解下行风险',positive:/最大回撤|下行风险|先(?:讲|看|分析).*风险/,negative:/不(?:要|用|需要).*先.*(?:风险|回撤)|先.*收益.*再.*风险/},
  structured_comparison:{module:'general',key:'analysis_style',value:'优先表格比较',text:'可能偏好用表格比较方案',positive:/(?:用|给|以).*表格.*(?:比较|对比)|(?:比较|对比).*表格/,negative:/不(?:要|用|需要).*表格/},
  concise_explanation:{module:'general',key:'answer_length',value:'简短',text:'可能偏好简短解释',positive:/简短|简要|简洁|一句话/,negative:/不要.*简短|详细展开|完整解释/},
});
const number=(value,fallback,min)=>Math.max(min,Number.isFinite(Number(value))?Number(value):fallback);
export function createMemoryEvolution(bank,memory,options={}) {
  const config={minimumEvidence:number(options.minimumEvidence??process.env.MEMORY_MIN_EVIDENCE,3,3),minimumSessions:number(options.minimumSessions??process.env.MEMORY_MIN_SESSIONS,2,2),windowDays:number(options.windowDays,30,1),halfLifeDays:number(options.halfLifeDays,14,1)};
  const scope=p=>{assertPrincipal(bank,p);return [p.tenant_id,p.user_id];};
  const activeStates=['observing','tentative','contested','expired'];
  function evidence(p,signal,at=Date.now()) {
    return bank.all(`SELECT e.* FROM behavior_events e JOIN agent_sessions s ON s.id=e.session_id AND s.user_id=e.user_id
      WHERE e.tenant_id=? AND e.user_id=? AND e.signal=? AND e.revoked=0 AND e.created_at>? AND s.archived=0 AND s.updated_at>?
      AND (e.source_channel='app' OR EXISTS (SELECT 1 FROM channel_bindings b WHERE b.user_id=e.user_id AND b.channel=e.source_channel AND b.binding_session_id=e.session_id AND b.status='active' AND b.auth_state='valid'))
      ORDER BY e.created_at DESC LIMIT 100`,...scope(p),signal,new Date(at-config.windowDays*86400000).toISOString(),new Date(at-7*86400000).toISOString());
  }
  function score(rows,at=Date.now()) {
    const positive=rows.filter(e=>e.polarity===1),negative=rows.filter(e=>e.polarity===-1),sessions=new Set(positive.map(e=>e.session_id)).size;
    const age=positive.length?Math.max(0,at-Math.max(...positive.map(e=>Date.parse(e.created_at))))/86400000:Infinity;
    const confidence=Math.max(0,Math.min(.85,.45+.08*positive.length-.18*negative.length)*2**(-age/config.halfLifeDays));
    const status=!rows.length?'expired':negative.length?'contested':positive.length>=config.minimumEvidence&&sessions>=config.minimumSessions&&confidence>=.65?'tentative':'observing';
    return {status,confidence:Math.round(confidence*1000)/1000,evidence_count:positive.length,session_count:sessions,counter_count:negative.length,
      evidence_ids:positive.map(e=>e.event_id),counter_evidence_ids:negative.map(e=>e.event_id)};
  }
  function audit(p,row,action) {bank.run('INSERT INTO memory_changes(tenant_id,user_id,memory_id,action,version,source_message_id,created_at) VALUES(?,?,?,?,?,?,?)',...scope(p),row.hypothesis_id,action,row.version,null,now());}
  function consolidate(p,{expectedEpoch=memory.epoch(p),at=Date.now()}={}) {
    if(!memory.enabled(p))return [];
    return bank.atomic(()=>{
      requireThat(expectedEpoch===memory.epoch(p),'记忆已更新，旧整合任务已取消',409,'MEMORY_CONTEXT_CHANGED');
      for(const [signal,def] of Object.entries(BEHAVIORS)){
        const old=bank.get('SELECT * FROM behavior_hypotheses WHERE tenant_id=? AND user_id=? AND signal=?',...scope(p),signal);
        if(old&&!activeStates.includes(old.status))continue;
        const rows=evidence(p,signal,at);if(!rows.length&&!old)continue;
        const state=score(rows,at),time=new Date(at).toISOString(),hypothesisId=old?.hypothesis_id||id('HYP');
        const until=new Date(rows.length?Math.max(...rows.map(e=>Date.parse(e.created_at)))+config.windowDays*86400000:at).toISOString();
        const changed=!old||old.status!==state.status||old.confidence!==state.confidence||old.evidence_count!==state.evidence_count||old.counter_count!==state.counter_count||old.session_count!==state.session_count;
        if(changed){
          bank.run(`INSERT INTO behavior_hypotheses(hypothesis_id,tenant_id,user_id,module,signal,hypothesis,status,confidence,epoch,evidence_count,session_count,counter_count,created_at,updated_at,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,signal) DO UPDATE SET status=excluded.status,confidence=excluded.confidence,epoch=excluded.epoch,evidence_count=excluded.evidence_count,session_count=excluded.session_count,counter_count=excluded.counter_count,updated_at=excluded.updated_at,expires_at=excluded.expires_at,version=behavior_hypotheses.version+1`,
            hypothesisId,...scope(p),def.module,signal,def.text,state.status,state.confidence,expectedEpoch,state.evidence_count,state.session_count,state.counter_count,old?.created_at||time,time,until);
          audit(p,{hypothesis_id:hypothesisId,version:(old?.version||0)+1},`behavior.${state.status}`);
        }
        bank.run('DELETE FROM memory_evidence WHERE tenant_id=? AND user_id=? AND hypothesis_id=?',...scope(p),hypothesisId);
        for(const row of rows)bank.run('INSERT INTO memory_evidence VALUES(?,?,?,?,?)',...scope(p),hypothesisId,row.event_id,row.polarity);
      }
      return view(p,at);
    });
  }
  function collect(p,{input,requestId,sessionId,route,expectedEpoch,runId}) {
    if(!memory.enabled(p)||route.intent==='update_preference'||injectionFlags(input).length)return;
    requireThat(expectedEpoch===memory.epoch(p),'旧事件不能更新记忆',409,'MEMORY_CONTEXT_CHANGED');
    const session=bank.get('SELECT 1 FROM agent_sessions WHERE id=? AND user_id=? AND channel=? AND archived=0',sessionId,scope(p)[1],p.channel);
    requireThat(session,'会话不存在',404,'NOT_FOUND');
    for(const module of [route.primary_module,...route.secondary_modules])if(module!=='general')memory.activate(p,module);
    for(const [signal,def] of Object.entries(BEHAVIORS)){
      if(def.module!=='general'&&![route.primary_module,...route.secondary_modules].includes(def.module))continue;
      const old=bank.get('SELECT status FROM behavior_hypotheses WHERE tenant_id=? AND user_id=? AND signal=?',...scope(p),signal);
      if(old&&!activeStates.includes(old.status))continue;
      if(bank.get("SELECT 1 FROM agent_memory WHERE tenant_id=? AND user_id=? AND key=? AND status IN ('active','deleted')",...scope(p),def.key))continue;
      const polarity=def.negative.test(input)?-1:def.positive.test(input)?1:0;if(!polarity)continue;
      const fingerprint=createHash('sha256').update(p.user_id+'\0'+input.normalize('NFKC').replace(/\s|[。！？!?，,]/g,'')).digest('hex');
      bank.run(`INSERT OR IGNORE INTO behavior_events(event_id,tenant_id,user_id,request_id,session_id,source_channel,module,intent,signal,polarity,fingerprint,epoch,created_at,run_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id('EV'),...scope(p),requestId,sessionId,p.channel,def.module,route.intent,signal,polarity,fingerprint,expectedEpoch,now(),runId||null);
    }
    // Durable events and bounded rule consolidation share the completed-turn transaction. No detached task/LLM.
    consolidate(p,{expectedEpoch});
  }
  function view(p,at=Date.now()) {
    return bank.all('SELECT * FROM behavior_hypotheses WHERE tenant_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 30',...scope(p)).map(row=>{
      const current=score(evidence(p,row.signal,at),at);
      return {...row,...(activeStates.includes(row.status)?current:{evidence_ids:current.evidence_ids,counter_evidence_ids:current.counter_evidence_ids}),confidence_kind:'heuristic_not_probability'};
    });
  }
  function hints(p,route) {
    if(!memory.enabled(p)||!['analyze','compare','explain'].includes(route.intent))return [];
    const result=[];
    for(const row of view(p)){
      if(row.status!=='tentative'||!['general',route.primary_module,...route.secondary_modules].includes(row.module))continue;
      const def=BEHAVIORS[row.signal];
      if(bank.get("SELECT 1 FROM agent_memory WHERE tenant_id=? AND user_id=? AND key=? AND status IN ('active','deleted') AND (expires_at IS NULL OR expires_at>?)",...scope(p),def.key,now()))continue;
      result.push({hypothesis_id:row.hypothesis_id,signal:row.signal,presentation_only:def.value,user_confirmed:false});
    }
    return result.slice(0,2);
  }
  function feedback(p,hypothesisId,action,version) {
    requireThat(['confirm','reject'].includes(action),'反馈类型无效',400,'INVALID_MEMORY');
    return bank.atomic(()=>{
      const row=bank.get('SELECT * FROM behavior_hypotheses WHERE tenant_id=? AND user_id=? AND hypothesis_id=?',...scope(p),hypothesisId);
      requireThat(row,'行为假设不存在',404,'NOT_FOUND');requireThat(row.version===version,'假设已变化，请刷新',409,'MEMORY_CONFLICT');
      requireThat(activeStates.includes(row.status),'假设已确认或撤销',409,'MEMORY_CONFLICT');
      const def=BEHAVIORS[row.signal];
      if(action==='confirm'){
        requireThat(score(evidence(p,row.signal)).status==='tentative','证据不足或存在反向证据',409,'MEMORY_CONFIRMATION_REQUIRED');
        memory.update(p,{key:def.key,value:def.value,memory_type:'interaction'},{type:'confirmed',messageId:id('CONFIRM')});
      }else memory.invalidate(p,{signal:row.signal,reason:'rejected'});
      bank.run('UPDATE behavior_hypotheses SET status=?,user_confirmed=?,version=version+1,epoch=?,updated_at=? WHERE tenant_id=? AND user_id=? AND hypothesis_id=?',action==='confirm'?'confirmed':'rejected',action==='confirm'?1:0,memory.epoch(p),now(),...scope(p),hypothesisId);
      const updated=view(p).find(r=>r.hypothesis_id===hypothesisId);audit(p,updated,`behavior.${action}`);return updated;
    });
  }
  function invalidate(p,{key,reason,signal,sessionId}={}) {
    if(sessionId){bank.run('UPDATE behavior_events SET revoked=1 WHERE tenant_id=? AND user_id=? AND session_id=?',...scope(p),sessionId);return;}
    for(const [code,def] of Object.entries(BEHAVIORS)){
      if(code!==signal&&def.key!==key)continue;
      bank.run('UPDATE behavior_events SET revoked=1 WHERE tenant_id=? AND user_id=? AND signal=?',...scope(p),code);
      const status=reason==='explicit_update'?'superseded':'rejected';
      bank.run("UPDATE behavior_hypotheses SET status=?,user_confirmed=0,version=version+1,updated_at=? WHERE tenant_id=? AND user_id=? AND signal=?",status,now(),...scope(p),code);
      const row=bank.get('SELECT * FROM behavior_hypotheses WHERE tenant_id=? AND user_id=? AND signal=?',...scope(p),code);if(row)audit(p,row,`behavior.${status}`);
    }
  }
  function suggestions(p) {
    for(const row of bank.all("SELECT module,COUNT(*) count FROM agent_memory WHERE tenant_id=? AND user_id=? AND status='active' GROUP BY module HAVING count>48",...scope(p))){
      bank.run('INSERT OR IGNORE INTO memory_module_suggestions(suggestion_id,tenant_id,user_id,module,kind,metrics_json,created_at) VALUES(?,?,?,?,?,?,?)',id('SUG'),...scope(p),row.module,'review_partition',JSON.stringify({active_records:row.count,query_limit:48}),now());
    }
    return bank.all('SELECT * FROM memory_module_suggestions WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC',...scope(p));
  }
  memory.setChangeListener(invalidate);
  function history(p,route){
    if(!memory.enabled(p)||route.retrieval_depth!=='detail')return [];
    return Object.entries(BEHAVIORS).filter(([,d])=>['general',route.primary_module,...route.secondary_modules].includes(d.module))
      .flatMap(([signal,def])=>evidence(p,signal).slice(0,3).map(e=>({key:`evidence:${e.event_id}`,value:def.text,polarity:e.polarity,created_at:e.created_at,unconfirmed:true}))).slice(0,6);
  }
  function evidenceView(p,hypothesisId){
    const row=bank.get('SELECT signal FROM behavior_hypotheses WHERE tenant_id=? AND user_id=? AND hypothesis_id=?',...scope(p),hypothesisId);
    requireThat(row,'行为假设不存在',404,'NOT_FOUND');
    return evidence(p,row.signal).map(({event_id,run_id,request_id,session_id,source_channel,module,intent,polarity,created_at})=>({event_id,run_id,request_id,session_id,source_channel,module,intent,polarity,created_at}));
  }
  return {collect,consolidate,view,hints,feedback,suggestions,history,evidenceView,config};
}
