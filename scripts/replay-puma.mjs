import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { behaviorBaseline, verifiedAgeGroup } from '../server/puma/models.mjs';
import { extractFeatures } from '../server/risk/features.mjs';
import { evaluatePolicy } from '../server/risk/policy.mjs';
import { DEFAULT_AGE_POLICY } from '../server/risk/age.mjs';
import { RULE_REGISTRY } from '../server/puma/rules.mjs';

const at='2026-10-30T12:00:00Z',result=[];
for(const purpose of ['medical','housing','internal'])for(const age of [59,60,64,65,69,70,79,80]){
 const candidate={amountMinor:5000000,currency:'CNY',beneficiaryRef:'known',ownAccount:purpose==='internal',category:'transfer'};
 const rows=Array.from({length:15},(_,i)=>({transaction_id:`tx${i}`,user_id:'replay',account_ref:'account',currency:'CNY',amount_minor:10000,direction:'OUT',status:'SETTLED',category:'transfer',payee_ref:'known',occurred_at:`2026-10-${String(i+1).padStart(2,'0')}T12:00:00Z`}));
 const features=extractFeatures({rows,userId:'replay',currency:'CNY',at,candidate});
 const identity={verified:true,sourceRef:'synthetic',dob:`${2026-age}-01-01`};
 const evaluation=evaluatePolicy(features,candidate,{at},identity,DEFAULT_AGE_POLICY);
 assert.notEqual(evaluation.finalAction,'BLOCK');
 result.push({purpose,ageGroup:verifiedAgeGroup(identity,at),action:evaluation.finalAction,notices:features.notices});
 assert.equal(behaviorBaseline(rows,'replay',at).currencies.CNY.forecast.status,'UNKNOWN');
}
for(const purpose of ['medical','housing','internal'])assert.equal(new Set(result.filter(r=>r.purpose===purpose).map(r=>r.action)).size,1);
mkdirSync('test-results/puma',{recursive:true});
writeFileSync('test-results/puma/replay.json',JSON.stringify({dataset:'SYNTHETIC_ONLY',at,rules:RULE_REGISTRY.length,precision:null,recall:null,reason:'NO_VERIFIED_OUTCOME_DATA',result},null,2));
console.log(`PASS: ${result.length} synthetic age/purpose replays; no fabricated accuracy metrics.`);
