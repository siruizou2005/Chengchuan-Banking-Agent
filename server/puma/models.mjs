import { now } from '../db.mjs';
import { extractFeatures, normalizeTransactions } from '../risk/features.mjs';
import { ageInYears } from '../risk/age.mjs';
import { routeBehavior } from '../agent/behavior-router.mjs';
import { injectionFlags } from '../agent/guard.mjs';
import { consentAllowed } from './consent.mjs';
export const SCAM_TYPES=['BANK_IMPERSONATION','INVESTMENT','ROMANCE','FAMILY_IMPERSONATION','INVOICE_CHANGE'];
const cues={BANK_IMPERSONATION:/安全账户|冒充银行|银行客服.*转账/,INVESTMENT:/稳赚|保本高收益|虚假收益/,ROMANCE:/网恋.*(?:汇款|转账)/,FAMILY_IMPERSONATION:/冒充.*(?:亲属|家人)|家人.*紧急汇款/,INVOICE_CHANGE:/发票.*(?:账户|变更)|供应商.*更换账户/};
const meta=()=>({model_version:'puma-statistical-v0',feature_version:'puma-features-v1',training_data_version:'NONE_RULE_BASELINE',inferred_at:now(),mode:'shadow'});
export function verifiedAgeGroup(identity,at=now()) {
  const age=ageInYears(identity,at);
  return age===null||age<18?'UNKNOWN':age<60?'18-59':age<65?'60-64':age<70?'65-69':age<80?'70-79':'80+';
}
// No FX feed exists in this simulator. Keep currencies separate instead of inventing rates.
export function behaviorBaseline(rows,userId,at=now()) {
  const currencies=[...new Set(rows.filter(r=>r.user_id===userId).map(r=>r.currency))];
  return {...meta(),profile_type:'BehaviorProfile',verified_age_group:'UNKNOWN',currencies:Object.fromEntries(currencies.map(currency=>{
    const f=extractFeatures({rows,userId,currency,at});
    return [currency,{...f,evidence_quality:f.sampleCount>=20?'SUFFICIENT':'LIMITED',forecast:{amount_minor:f.sampleCount>=20?f.single?.median:null,status:f.sampleCount>=20?'BASELINE_ESTIMATE':'UNKNOWN'},source_transaction_ids:normalizeTransactions(rows).filter(r=>r.user_id===userId&&r.currency===currency&&Date.parse(r.occurred_at)<=Date.parse(at)).map(r=>r.transaction_id).slice(-50)}];
  })),fx_status:currencies.length>1?'NO_TRUSTED_FX_SEPARATE_CURRENCIES':'NOT_REQUIRED'};
}
export function createPumaModels(bank,services,evidence,policy) {
  const allowed=user=>services.memory.enabled({user_id:user.id})&&consentAllowed(bank,user.id,'data_read');
  function behavior(user) {
    if(!allowed(user)||policy.flags.puma_behavior_model==='disabled')return {...meta(),status:'DISABLED'};
    return behaviorBaseline(services.risk.rows(user.id),user.id);
  }
  function intent(user,input,eventIds=[]) {
    if(!allowed(user)||policy.flags.puma_behavior_model==='disabled')return {...meta(),status:'DISABLED',candidates:[]};
    const sources=evidence.references(user.id,eventIds).filter(e=>e.type==='USER_INTENT_STATED'&&e.source==='trusted_ui'&&e.evidence_quality==='SUFFICIENT'&&Date.parse(e.occurred_at)>Date.now()-86400000);
    if(!sources.length||injectionFlags(input).length)return {...meta(),status:'UNKNOWN',candidates:[{intent:'UNKNOWN',confidence:1}],evidence_ids:[]};
    const route=routeBehavior({text:input});
    return {...meta(),status:'HYPOTHESIS',candidates:[{intent:route.intent,task_scope:route.primary_module,confidence:route.confidence},{intent:'UNKNOWN',confidence:1-route.confidence}],evidence_ids:sources.map(e=>e.event_id),expires_at:new Date(Date.now()+3600000).toISOString()};
  }
  function traits(user) {
    return {...meta(),mode:'research_only',status:allowed(user)&&consentAllowed(bank,user.id,'trait_research')&&policy.flags.puma_trait_research==='shadow'?'INSUFFICIENT_EVIDENCE':'DISABLED',hypotheses:[],reason:'NO_VALIDATED_PSYCHOLOGICAL_LABELS'};
  }
  function scam(user,{text='',evidenceIds=[]}={}) {
    const sources=evidence.references(user.id,evidenceIds).filter(e=>e.evidence_quality==='SUFFICIENT'&&Date.parse(e.occurred_at)>Date.now()-86400000);
    return {...meta(),status:policy.flags.puma_scam_risk_shadow==='disabled'?'DISABLED':'RESEARCH_ONLY',predictions:SCAM_TYPES.map(type=>({prediction_target:type,time_horizon:'CURRENT_TRANSACTION',score:sources.length&&cues[type].test(text)?0.5:null,calibration_status:'RESEARCH_ONLY',evidence_ids:sources.map(e=>e.event_id),uncertainty:sources.length?'UNCALIBRATED':'INSUFFICIENT_EVIDENCE'})),enforceable:false};
  }
  return {behavior,intent,traits,scam};
}
