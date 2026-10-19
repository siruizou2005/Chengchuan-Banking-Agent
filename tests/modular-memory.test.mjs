import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, llm } from './helpers.mjs';
import { resolvePrincipal } from '../server/agent/principal.mjs';
import { routeBehavior } from '../server/agent/behavior-router.mjs';
import { loadSkills } from '../server/agent/skills/loader.mjs';
import { SKILLS } from '../server/agent/skills/registry.mjs';
import { toolDefinitions } from '../server/agent/tools.mjs';
import { createContextAssembler } from '../server/agent/context-assembler.mjs';
import { migratePersonalization } from '../server/agent/personalization-schema.mjs';
import { readFileSync } from 'node:fs';

const turn=(f,text,sessionId)=>f.call('/agent/chat',{messages:[{role:'user',content:text}],...(sessionId?{sessionId}:{})});
async function observations(f){
 const a=await turn(f,'分析投资产品甲的最大回撤');assert.equal(a.status,200);
 await turn(f,'比较投资产品乙的最大回撤',a.data.sessionId);
 const b=await turn(f,'分析投资产品丙的下行风险');assert.equal(b.status,200);
 return [a.data.sessionId,b.data.sessionId];
}

test('确定性路由覆盖模块、意图、结构事件优先和安全回退；Skill静态白名单',()=>{
 for(const [text,module,intent] of [['分析本月消费','spending','analyze'],['比较投资产品','investment','compare'],['制定预算方案','budgeting','plan'],['解释贷款是什么','debt_credit','explain'],['复盘退休规划','financial_planning','review'],['以后回答简短','general','update_preference'],['无明确主题','general','analyze']]){
  const r=routeBehavior({text});assert.equal(r.primary_module,module);assert.equal(r.intent,intent);
 }
 const combined=routeBehavior({text:'投资配置与退休规划'});assert.ok(combined.secondary_modules.includes('financial_planning'));
 assert.equal(routeBehavior({text:'投资',tool:'bill_report'}).primary_module,'spending');
 assert.equal(routeBehavior({text:'继续',previous:combined}).primary_module,'investment');
 assert.equal(routeBehavior({text:'新的话题',previous:combined}).primary_module,'general');
 assert.equal(routeBehavior({tool:'__proto__',entry:'constructor'}).primary_module,'general');
 assert.equal(loadSkills({intent:'analyze',required_skills:['../../.env','__proto__']}).text,'');
 const names=toolDefinitions.map(t=>t.function.name);
 for(const [id,meta] of Object.entries(SKILLS)){
  const body=JSON.parse(readFileSync(new URL(`../server/agent/skills/${meta.file}`,import.meta.url),'utf8'));
  assert.ok(body.inputs.length&&body.workflow.length&&body.limits.length&&body.output);
  for(const tool of body.sources)assert.ok(names.includes(tool),`${id}: unknown tool ${tool}`);
  const loaded=loadSkills({intent:meta.intents[0],required_skills:[id]});assert.match(loaded.text,/1\.0\.0/);assert.ok(loaded.bytes<=900);
 }
});

test('迁移保留旧确认值与候选，重复运行不改版本；失败整体回滚后可重试',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),m=f.services.memory;
 const old=m.update(p,{key:'watchlist',value:'AAPL'},{type:'explicit'});
 m.candidate(p,{key:'sectors',value:'新能源',evidence:'新能源'},{input:'新能源',messageId:'migration-candidate'});
 f.bank.run("DELETE FROM schema_migrations WHERE version='memory.modules.v1'");
 f.bank.run("UPDATE agent_memory SET module='general' WHERE memory_id=?",old.memory_id);
 f.bank.db.exec("CREATE TRIGGER migration_failure BEFORE UPDATE OF module ON agent_memory BEGIN SELECT RAISE(ABORT,'migration interrupted'); END");
 assert.throws(()=>migratePersonalization(f.bank.db),/migration interrupted/);
 assert.equal(f.bank.get("SELECT COUNT(*) n FROM schema_migrations WHERE version='memory.modules.v1'").n,0);
 f.bank.db.exec('DROP TRIGGER migration_failure');migratePersonalization(f.bank.db);migratePersonalization(f.bank.db);
 const current=m.owned(p,old.memory_id);assert.equal(current.status,'active');assert.equal(current.confirmed,1);assert.equal(current.version,old.version);assert.equal(current.module,'investment');
 const candidate=m.list(p).find(r=>r.status==='candidate');assert.equal(candidate.module,'investment');m.confirm(p,candidate.memory_id,candidate.version);assert.equal(m.profile(p).sectors,'新能源');
 assert.throws(()=>f.bank.run('INSERT INTO agent_memory(user_id,key,value,updated_at) VALUES(?,?,?,?)',f.user.id,'watchlist','MSFT',new Date().toISOString()),/UNIQUE/);
});

test('模块检索按意图与三级预算加载；缓存不能绕过删除、到期或用户隔离',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),m=f.services.memory;
 const put=(key,value,extra={})=>m.update(p,{key,value,...extra},{type:'explicit'});
 put('language','中文');put('spend_note','消费偏好',{module:'spending'});put('invest_note','投资偏好',{module:'investment'});
 put('review_note','投资历史事件',{module:'investment',memory_type:'episodic'});put('plan_only','计划时才使用',{module:'investment',intent:'plan'});
 put('archive_note','无关历史备注',{module:'investment'});f.bank.run("UPDATE agent_memory SET importance=0.1 WHERE user_id=? AND key='archive_note'",f.user.id);
 const query='分析投资',r=routeBehavior({text:query});let result=m.retrieve(p,query,r);
 assert.deepEqual(new Set(result.items.map(i=>i.key)),new Set(['language','invest_note']));
 assert.ok(m.retrieve(p,query,r).cache_hits>0);
 assert.ok(m.retrieve(p,'复盘投资',routeBehavior({text:'复盘投资'})).items.some(i=>i.key==='review_note'&&i.source_message_id));
 assert.ok(!m.retrieve(p,query,r,{bytes:40}).items.some(i=>i.key==='invest_note'));
 const strict=createContextAssembler(m,f.services.memoryEvolution,{totalBytes:180,skillBytes:100,memory:{items:1,bytes:80,core:80,module:80,history:0}}).assemble(p,query,r);
 assert.ok(strict.metrics.augmentation_bytes<=180);assert.ok(strict.metrics.memory_bytes<=80);
 const bob=resolvePrincipal(f.bank,f.bob.user);assert.deepEqual(m.retrieve(bob,query,r).items,[]);
 assert.throws(()=>m.retrieve({...p,tenant_id:'other'},query,r),e=>e.code==='INVALID_PRINCIPAL');
 const row=m.list(p).find(r=>r.key==='invest_note');m.remove(p,row.memory_id,row.version);assert.ok(!m.retrieve(p,query,r).items.some(i=>i.key==='invest_note'));
 put('expiring','短期投资信息',{module:'investment',expires_at:new Date(Date.now()+500).toISOString()});m.retrieve(p,query,r);
 await new Promise(r=>setTimeout(r,550));assert.ok(!m.retrieve(p,query,r).items.some(i=>i.key==='expiring'));
 assert.throws(()=>put('language','中文',{memory_type:'behavioral'}),e=>e.code==='INVALID_MEMORY');
});

test('一次与重复消息不形成结论，三次跨会话证据仅产生展示假设；推理次数不增加',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),e=f.services.memoryEvolution;
 const a=await turn(f,'分析投资产品甲的最大回撤');let h=e.view(p)[0];assert.equal(h.status,'observing');assert.equal(h.evidence_count,1);
 await turn(f,'分析投资产品甲的最大回撤');assert.equal(e.view(p)[0].evidence_count,1);
 await turn(f,'比较投资产品乙的最大回撤',a.data.sessionId);assert.equal(e.view(p)[0].status,'observing');
 await turn(f,'分析投资产品丙的下行风险');h=e.view(p)[0];assert.equal(h.status,'tentative');assert.equal(h.evidence_count,3);assert.equal(h.session_count,2);assert.equal(h.user_confirmed,0);assert.equal(h.confidence_kind,'heuristic_not_probability');
 await turn(f,'比较投资产品丁');assert.equal(f.requests.length,5);assert.match(JSON.stringify(f.requests.at(-1)),/presentation:downside_first/);
 assert.equal(f.bank.get("SELECT count(*) n FROM agent_memory WHERE key IN ('risk_level','risk_tolerance','analysis_style')").n,0);
 const events=f.bank.all('SELECT * FROM behavior_events');assert.ok(events.every(v=>!JSON.stringify(v).includes('产品甲')));
 const evidence=(await f.call(`/agent/memory/behavior/${h.hypothesis_id}/evidence`)).data;assert.equal(evidence.length,3);assert.ok(evidence.every(v=>f.bank.get('SELECT 1 FROM agent_runs WHERE id=? AND user_id=?',v.run_id,f.user.id)));
 assert.equal((await f.req(`/agent/memory/behavior/${h.hypothesis_id}/evidence`,undefined,f.bob.token)).status,404);
 const metrics=(await f.call('/agent/memory/context')).data;assert.ok(metrics.every(v=>v.augmentation_bytes<=3200&&v.memory_bytes<=2400));assert.ok(!JSON.stringify(metrics).includes('产品甲'));
 assert.equal((await f.req('/agent/memory/behavior',undefined,f.bob.token)).data.length,0);
 assert.equal((await f.req(`/agent/memory/behavior/${h.hypothesis_id}/feedback`,{action:'confirm',version:h.version},f.bob.token)).status,404);
 const calls=f.bank.all('SELECT input_bytes FROM inference_calls');assert.ok(calls.every(v=>v.input_bytes>1000));
});

test('反向证据立即停用假设；确认、版本冲突、明确纠正与删除压制旧事件',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),e=f.services.memoryEvolution,m=f.services.memory;
 await observations(f);let h=e.view(p)[0];
 const confirmed=await f.call(`/agent/memory/behavior/${h.hypothesis_id}/feedback`,{action:'confirm',version:h.version});assert.equal(confirmed.status,200);assert.equal(confirmed.data.status,'confirmed');assert.equal(m.profile(p).analysis_style,'先说明下行风险');
 assert.equal((await f.call(`/agent/memory/behavior/${h.hypothesis_id}/feedback`,{action:'reject',version:h.version})).status,409);
 const before=f.requests.length;await f.chat('以后不要优先讲风险');assert.equal(f.requests.length,before);assert.equal(m.profile(p).analysis_style,'按问题自然顺序说明');
 const row=m.list(p).find(r=>r.key==='analysis_style');m.remove(p,row.memory_id,row.version);
 await observations(f);assert.equal(e.hints(p,routeBehavior({text:'比较投资'})).length,0);assert.equal(m.profile(p).analysis_style,undefined);assert.equal(e.view(p)[0].status,'rejected');assert.equal(e.view(p)[0].user_confirmed,0);
 assert.equal(f.bank.get('SELECT COUNT(*) n FROM behavior_events WHERE revoked=0').n,0);
});

test('当前反向要求不注入旧假设，反向证据与拒绝不会被整合恢复',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),e=f.services.memoryEvolution;
 await observations(f);await f.chat('比较投资时不要先讲风险，请先分析收益');
 assert.ok(!JSON.stringify(f.requests.at(-1)).includes('presentation:downside_first'));
 let h=e.view(p)[0];assert.equal(h.status,'contested');assert.equal(h.counter_count,1);assert.equal(h.counter_evidence_ids.length,1);
 assert.equal((await f.call(`/agent/memory/behavior/${h.hypothesis_id}/feedback`,{action:'confirm',version:h.version})).status,409);
 const epoch=f.services.memory.epoch(p);assert.equal((await f.call(`/agent/memory/behavior/${h.hypothesis_id}/feedback`,{action:'reject',version:h.version})).status,200);
 assert.equal((await f.call('/agent/memory/consolidate',{epoch})).status,409);
 await f.chat('分析新的投资产品下行风险');assert.equal(e.view(p)[0].status,'rejected');assert.equal(e.history(p,routeBehavior({text:'复盘投资'})).length,0);
});

test('衰减、会话到期、归档和旧任务的epoch保护；详细证据按需加载',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),e=f.services.memoryEvolution,m=f.services.memory;
 const sessions=await observations(f),h=e.view(p)[0];
 assert.ok(e.view(p,Date.now()+86400000)[0].confidence<h.confidence);
 assert.equal(e.view(p,Date.now()+31*86400000)[0].status,'expired');
 const detail=f.services.contextAssembler.assemble(p,'复盘投资行为规律',routeBehavior({text:'复盘投资行为规律'}));assert.match(JSON.stringify(detail.messages),/evidence:/);
 assert.ok(!JSON.stringify(f.services.contextAssembler.assemble(p,'分析投资',routeBehavior({text:'分析投资'})).messages).includes('evidence:'));
 const epoch=m.epoch(p);assert.equal((await f.call(`/agent/sessions/${sessions[0]}`,{},'DELETE')).status,200);
 assert.notEqual(e.view(p)[0].status,'tentative');assert.throws(()=>e.collect(p,{input:'分析最大回撤',requestId:'late',sessionId:sessions[1],route:routeBehavior({text:'分析投资'}),expectedEpoch:epoch}),err=>err.code==='MEMORY_CONTEXT_CHANGED');
 f.bank.run('UPDATE agent_sessions SET updated_at=? WHERE id=?',new Date(Date.now()-8*86400000).toISOString(),sessions[1]);assert.equal(e.view(p)[0].status,'expired');
 await turn(f,'继续分析投资产品',sessions[1]);assert.equal(e.view(p)[0].evidence_count,0);
});

test('实际工具重新路由，账户事实仍来自工具；不信任用户提供的Skill与路由',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user);
 f.queue.push(llm([['get_loans',{}]]),llm([], '请核对贷款资料。'));
 const a=await f.call('/agent/chat',{entry:'wealth',module:'investment',messages:[{role:'user',content:'帮我核对账户信息'}]});assert.equal(a.status,200);assert.equal(f.requests.length,2);
 assert.match(JSON.stringify(f.requests[1]),/debt_analysis@1.0.0/);assert.ok(f.requests[1].messages.some(m=>m.role==='tool'));
 assert.equal((await f.call('/agent/memory/context')).data[0].route.primary_module,'debt_credit');
 await turn(f,'继续分析',a.data.sessionId);assert.match(JSON.stringify(f.requests.at(-1)),/debt_analysis@1.0.0/);
 f.services.memory.update(p,{key:'note',value:'SKILL_FAKE_OVERRIDE',module:'investment'},{type:'explicit'});
 await f.chat('分析投资');assert.ok(f.requests.at(-1).messages.some(m=>m.role==='user'&&m.content.includes('SKILL_FAKE_OVERRIDE')));
 assert.ok(!f.requests.at(-1).messages.some(m=>m.role==='system'&&m.content.includes('SKILL_FAKE_OVERRIDE')));
 assert.throws(()=>f.services.memory.update(p,{key:'risk_tolerance',value:'低'},{type:'explicit'}),err=>err.code==='UNSAFE_MEMORY');
});

test('跨渠道行为证据可组合，解绑及凭据失效撤销来源并阻止衍生假设继续使用',async t=>{
 const f=await fixture(t),p=resolvePrincipal(f.bank,f.user),e=f.services.memoryEvolution;
 const binding=f.channels.router.bind('feishu','memory-owner',f.channels.router.createCode(f.user,'123456').code,'bot-memory');
 await f.channels.router.runFeishu(binding,'分析投资甲最大回撤');
 await f.channels.router.runFeishu(binding,'分析投资乙最大回撤');
 await f.chat('分析投资丙最大回撤');assert.equal(e.view(p)[0].status,'tentative');
 const epoch=f.services.memory.epoch(p);f.channels.router.unbind(f.user,binding.id,'123456');
 assert.ok(f.services.memory.epoch(p)>epoch);assert.notEqual(e.view(p)[0].status,'tentative');assert.equal(e.view(p)[0].evidence_count,1);
 assert.equal(f.bank.get('SELECT archived FROM agent_sessions WHERE id=?',binding.binding_session_id).archived,1);
 assert.equal(e.evidenceView(p,e.view(p)[0].hypothesis_id).length,1);
 const another=f.channels.router.bind('feishu','memory-owner-next',f.channels.router.createCode(f.user,'123456').code,'bot-memory');
 await f.channels.router.runFeishu(another,'分析投资丁最大回撤');assert.equal(e.view(p)[0].evidence_count,2);
 const before=f.services.memory.epoch(p);f.bank.run("UPDATE channel_bindings SET auth_state='reauth_required' WHERE id=?",another.id);
 assert.ok(f.services.memory.epoch(p)>before);assert.equal(e.view(p)[0].evidence_count,1);
});
