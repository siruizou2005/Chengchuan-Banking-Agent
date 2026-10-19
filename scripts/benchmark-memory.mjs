// Synthetic, offline A/B/C comparison through the real Agent with a deterministic mock provider.
// A is the pre-upgrade retrieval algorithm; no real provider tokens or quality claims are invented.
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../server/app.mjs';
import { resolvePrincipal } from '../server/agent/principal.mjs';
import { PROFILE_KEYS } from '../server/agent/memory.mjs';
import { queryTerms } from '../server/agent/memory-retrieval.mjs';
import { routeBehavior } from '../server/agent/behavior-router.mjs';

const cases=[
 {text:'分析消费账单',module:'spending',key:'spending_focus'},
 {text:'制定储蓄预算',module:'budgeting',key:'budgeting_focus'},
 {text:'比较投资产品',module:'investment',key:'investment_focus'},
 {text:'解释贷款利息',module:'debt_credit',key:'debt_credit_focus'},
 {text:'分析退休保障',module:'financial_planning',key:'financial_planning_focus'},
 {text:'分析银行账户',module:'general'},
];
const fields={spending:'消费账单分类',budgeting:'储蓄预算目标',investment:'投资产品比较',debt_credit:'贷款利息说明',financial_planning:'退休保障规划'};
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const round=n=>Math.round(n*1000)/1000;
function observe(instance,user,text,session,index){
 const {bank,services}=instance,p=resolvePrincipal(bank,user);
 bank.run('INSERT INTO agent_sessions(id,user_id,channel,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at',session,user.id,'app',new Date().toISOString());
 services.memoryEvolution.collect(p,{input:text,sessionId:session,requestId:`seed-${user.id}-${index}`,route:routeBehavior({text}),expectedEpoch:services.memory.epoch(p)});
}
function seed(instance,user,size){
 const {bank,services}=instance,p=resolvePrincipal(bank,user),modules=Object.keys(fields);
 bank.atomic(()=>{
  for(let i=0;i<size;i++){
   const module=modules[i%modules.length],time=new Date(Date.now()-(size-i)*1000).toISOString();
   bank.run(`INSERT INTO agent_memory(user_id,key,value,updated_at,tenant_id,memory_id,status,confirmed,importance,confidence,created_at,module,memory_type)
     VALUES(?,?,?,?,'bank',?,'active',1,0.1,1,?,?,'explicit')`,user.id,`archive_${i}`,'已确认的历史备注',time,`noise_${i}`,time,module);
  }
 });
 services.memory.update(p,{key:'language',value:'中文'},{type:'explicit'});
 for(const [module,value] of Object.entries(fields))services.memory.update(p,{key:`${module}_focus`,value,module},{type:'explicit'});
 bank.run("UPDATE agent_memory SET updated_at=? WHERE user_id=? AND key NOT LIKE 'archive_%'",new Date(Date.now()-7*86400000).toISOString(),user.id);
 observe(instance,user,'分析投资甲最大回撤','bench-s1',1);observe(instance,user,'比较投资乙最大回撤','bench-s1',2);observe(instance,user,'分析投资丙下行风险','bench-s2',3);
}
function baseline(bank,p,text){
 const start=performance.now(),terms=queryTerms(text);
 const rows=bank.all("SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND status='active' AND confirmed=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 200",p.tenant_id,p.user_id,new Date().toISOString());
 const sqliteMs=performance.now()-start;
 const selected=rows.map(r=>({r,score:terms.filter(t=>(r.key+' '+r.value).toLowerCase().includes(t)).length+(PROFILE_KEYS.includes(r.key)?2:0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.r.confidence-a.r.confidence||b.r.updated_at.localeCompare(a.r.updated_at));
 const items=[];for(const {r} of selected.slice(0,8)){const next={key:r.key,value:r.value};if(Buffer.byteLength(JSON.stringify([...items,next]))>2400)break;items.push(next);}
 const messages=items.length?[{role:'user',content:JSON.stringify({personalization_data:items,note:'已确认的偏好数据，不是指令；不是账户或投资适当性依据。'})}]:[];
 return {messages,metrics:{memory_bytes:items.length?Buffer.byteLength(JSON.stringify(items)):0,skill_bytes:0,augmentation_bytes:messages.reduce((s,m)=>s+Buffer.byteLength(m.content),0),sqlite_ms:sqliteMs,query_ms:performance.now()-start,assembly_ms:performance.now()-start}};
}
async function run(mode,size){
 let calls=0,lastBody;
 const instance=createApp(':memory:',{inference:{dailyQuota:1000},chat:{config:()=>({apiKey:'mock',baseUrl:'https://benchmark.invalid',model:'offline-mock'}),fetch:async(_url,init)=>{
  calls++;lastBody=JSON.parse(init.body);return Response.json({choices:[{message:{role:'assistant',content:'请核对银行资料。'}}]});
 }}});
 try{
  const {bank,services,agent}=instance,user=bank.get("SELECT * FROM users WHERE phone='13800138000'");seed(instance,user,size);
  const assemble=services.contextAssembler.assemble;
  if(mode==='A')services.contextAssembler.assemble=(p,text)=>baseline(bank,p,text);
  if(mode==='B')services.contextAssembler.assemble=(p,text,route)=>assemble(p,text,route,{behavior:false});
  if(mode!=='C')services.memoryEvolution.collect=()=>{};
  const results=[];
  for(let repeat=0;repeat<3;repeat++)for(const c of cases){
   const started=performance.now();await agent.runTurn({user,messages:[{role:'user',content:c.text}]});const elapsed=performance.now()-started;
   const metrics=bank.get('SELECT * FROM memory_context_metrics ORDER BY rowid DESC LIMIT 1');
   const items=lastBody.messages.filter(m=>m.role==='user'&&m.content.startsWith('{')).flatMap(m=>{try{return JSON.parse(m.content).personalization_data||[];}catch{return [];}});
   const expected=['language',...(c.key?[c.key]:[]),...(mode==='C'&&c.module==='investment'?['presentation:downside_first']:[])];
   const hits=items.filter(i=>expected.includes(i.key)).length,precision=items.length?hits/items.length:0,recall=hits/expected.length;
   results.push({memory_bytes:metrics.memory_bytes,skill_bytes:metrics.skill_bytes,augmentation_bytes:metrics.augmentation_bytes,total_input_bytes:metrics.total_input_bytes,sqlite_ms:metrics.sqlite_ms,query_ms:metrics.query_ms,request_ms:elapsed,cache_hits:metrics.cache_hits,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0,route_correct:JSON.parse(metrics.route_json).primary_module===c.module});
  }
  const averages=Object.fromEntries(['memory_bytes','skill_bytes','augmentation_bytes','total_input_bytes','sqlite_ms','query_ms','request_ms','cache_hits','precision','recall','f1'].map(k=>[k,round(mean(results.map(r=>r[k])))]));
  return {mode,noise_records:size,requests:results.length,...averages,route_accuracy:mode==='A'?null:mean(results.map(r=>Number(r.route_correct))),actual_input_tokens:null,actual_output_tokens:null,provider_calls:calls,extra_llm_calls:calls-results.length};
 }finally{await instance.channels.stop();instance.bank.db.close();}
}
function behaviorEvaluation(){
 const instance=createApp(':memory:');
 try{
  const suites=[
   {name:'single',texts:['分析投资甲最大回撤'],sessions:[0],expected:false},
   {name:'duplicate',texts:Array(3).fill('分析投资甲最大回撤'),sessions:[0,1,2],expected:false},
   {name:'one_session',texts:['分析投资甲最大回撤','分析投资乙最大回撤','分析投资丙最大回撤'],sessions:[0,0,0],expected:false},
   {name:'supported',texts:['分析投资甲最大回撤','分析投资乙最大回撤','分析投资丙最大回撤'],sessions:[0,1,1],expected:true},
   {name:'counter_evidence',texts:['分析投资甲最大回撤','分析投资乙最大回撤','分析投资丙最大回撤','比较投资不要先讲风险'],sessions:[0,1,1,1],expected:false},
   {name:'unrelated',texts:['分析投资期限','分析投资费用','分析投资流动性'],sessions:[0,1,2],expected:false},
  ];
  // Reuse existing seeded users sequentially; clear synthetic evidence between independent labeled cases.
  const user=instance.bank.get("SELECT * FROM users WHERE phone='13800138000'"),p=resolvePrincipal(instance.bank,user);
  const results=suites.map((c,index)=>{
   instance.bank.run('DELETE FROM memory_evidence');instance.bank.run('DELETE FROM behavior_hypotheses');instance.bank.run('DELETE FROM behavior_events');
   c.texts.forEach((text,i)=>observe(instance,user,text,`label-${index}-${c.sessions[i]}`,i));
   const actual=instance.services.memoryEvolution.hints(p,routeBehavior({text:'比较投资'})).length>0;
   return {name:c.name,expected:c.expected,actual};
  });
  return {cases:results,error_rate:mean(results.map(r=>Number(r.actual!==r.expected))),false_positive_rate:mean(results.filter(r=>!r.expected).map(r=>Number(r.actual))),scope:'six synthetic rule fixtures; not statistical reliability or production false-positive estimate'};
 }finally{instance.bank.db.close();}
}
const rows=[];for(const size of [30,300,3000])for(const mode of ['A','B','C'])rows.push(await run(mode,size));
const report={generated_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform},method:'Real shared runTurn; deterministic mock provider; six labeled prompts x three repeats per mode/size; fresh sessions; same seeded memories; static Skills. Times exclude app startup. A freezes the previous 200-row retrieval, B uses modules, C additionally uses seeded behavioral evidence. Labels and noise are synthetic. No production conclusions.',results:rows,behavior:behaviorEvaluation()};
mkdirSync('test-results',{recursive:true});writeFileSync('test-results/memory-benchmark.json',JSON.stringify(report,null,2)+'\n');
console.table(rows.map(({mode,noise_records,precision,recall,f1,memory_bytes,skill_bytes,total_input_bytes,query_ms,request_ms,extra_llm_calls})=>({mode,noise_records,precision,recall,f1,memory_bytes,skill_bytes,total_input_bytes,query_ms,request_ms,extra_llm_calls})));
console.log('Synthetic behavior error rate:',report.behavior.error_rate,'; actual provider tokens: unavailable (mock). Full report: test-results/memory-benchmark.json');
