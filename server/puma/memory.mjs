import { now } from '../db.mjs';
import { resolvePrincipal } from '../agent/principal.mjs';
import { routeBehavior } from '../agent/behavior-router.mjs';
export function createPumaMemory(bank,services,evidence,policy) {
  function context(user,query) {
    const p=resolvePrincipal(bank,user);
    if(policy.flags.puma_memory_v2==='disabled'||!services.memory.enabled(p))return {facts:[],hypotheses:[],status:'DISABLED'};
    const items=services.memory.retrieve(p,query,routeBehavior({text:query})).items;
    const facts=[];
    for(const item of items){
      const row=bank.get("SELECT * FROM agent_memory WHERE user_id=? AND key=? AND status='active' AND confirmed=1",user.id,item.key);
      if(!row||!row.source_message_id||!['explicit','confirmed'].includes(row.source_type)||row.expires_at&&row.expires_at<=now())continue;
      let provenance=bank.get('SELECT * FROM puma_memory_provenance WHERE memory_id=? AND version=?',row.memory_id,row.version);
      if(!provenance){
        const event=evidence.ingest({user_id:user.id,type:row.version>1?'PROFILE_CORRECTED':'USER_INTENT_STATED',occurred_at:row.updated_at,source:'trusted_ui',initiated_by:'USER',correlation_id:row.memory_id,resource_ref:`${row.memory_id}:${row.version}`,consent_scope:'personalization',evidence_quality:'SUFFICIENT'});
        bank.run('INSERT INTO puma_memory_provenance VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',row.memory_id,row.version,user.id,row.memory_type==='episodic'?'EPISODE':'VERIFIED_FACT',JSON.stringify([event.event_id]),'USER_CONFIRMED',null,row.updated_at,row.expires_at,'personalization',row.version>1?row.updated_at:null,row.version>1?`${row.memory_id}:${row.version-1}`:null,0);
        provenance=bank.get('SELECT * FROM puma_memory_provenance WHERE memory_id=? AND version=?',row.memory_id,row.version);
      }
      facts.push({...item,...provenance,source_event_ids:JSON.parse(provenance.source_event_ids)});
    }
    return {facts,hypotheses:services.memoryEvolution.hints(p,routeBehavior({text:query})).map(h=>({...h,record_type:'INFERRED_HYPOTHESIS',verification_status:'UNVERIFIED',model_version:'presentation-v0',consent_scope:'personalization'})),status:'AVAILABLE',mode:policy.flags.puma_memory_v2};
  }
  return {context};
}
