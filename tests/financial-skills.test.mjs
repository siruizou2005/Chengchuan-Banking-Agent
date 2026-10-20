import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SKILLS } from '../server/agent/skills/registry.mjs';
import { loadSkills } from '../server/agent/skills/loader.mjs';
import { routeBehavior } from '../server/agent/behavior-router.mjs';
import { toolDefinitions } from '../server/agent/tools.mjs';
import { fixture, llm } from './helpers.mjs';

const adapted=['cashflow_reconciliation','budget_variance','product_comparison'];
const root=new URL('../server/agent/skills/',import.meta.url),upstream=new URL('upstream/anthropic-financial-services/',root);

test('Anthropic来源固定版本、Apache许可和原文校验可追溯；适配只使用现有工具',()=>{
 const manifest=JSON.parse(readFileSync(new URL('sources.json',upstream),'utf8'));
 assert.equal(manifest.repository,'https://github.com/anthropics/financial-services');assert.equal(manifest.license,'Apache-2.0');assert.match(manifest.commit,/^[a-f0-9]{40}$/);
 assert.deepEqual(manifest.files.filter(f=>f.skill).map(f=>f.skill).sort(),[...adapted].sort());
 for(const file of manifest.files){
  const bytes=readFileSync(new URL(file.file,upstream));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
  assert.equal(file.url,`${manifest.repository}/blob/${manifest.commit}/${file.path}`);
 }
 assert.match(readFileSync(new URL('LICENSE',upstream),'utf8'),/Apache License/);
 const tools=new Set(toolDefinitions.map(t=>t.function.name));
 for(const id of adapted){const body=JSON.parse(readFileSync(new URL(SKILLS[id].file,root),'utf8'));assert.ok(SKILLS[id].provenance.startsWith('anthropic-financial-services/'));assert.ok(body.sources.every(tool=>tools.has(tool)));}
});

test('三个完整适配工作流包含所有结构字段，默认900字节可装载，预算不足整段跳过',()=>{
 for(const id of adapted){
  const body=JSON.parse(readFileSync(new URL(SKILLS[id].file,root),'utf8')),route={intent:'analyze',required_skills:[id]},loaded=loadSkills(route);
  assert.deepEqual(loaded.loaded,[{id,version:'1.0.0'}]);assert.ok(loaded.bytes>0&&loaded.bytes<=900);
  for(const value of [body.instructions,...body.inputs,...body.sources,...body.workflow,...body.limits,body.output])assert.ok(loaded.text.includes(value),`${id}: missing ${value}`);
  assert.equal(loadSkills(route,loaded.bytes).text,loaded.text);assert.equal(loadSkills(route,loaded.bytes-1).text,'');
 }
 const unknown=loadSkills({intent:'analyze',required_skills:['../../.env','upstream/anthropic-financial-services/comps-analysis.md','constructor']});assert.equal(unknown.text,'');
 const all=loadSkills({intent:'analyze',required_skills:adapted});assert.ok(all.bytes<=900);assert.equal(all.loaded.length,1);
});

test('专项任务才选择适配Skill，偏好命令和回忆不加载，承接保留辅助模块',()=>{
 for(const [text,id] of [['核对本月流水和交易','cashflow_reconciliation'],['核对交易','cashflow_reconciliation'],['分析本月支出为什么超过预算','budget_variance'],['比较两款基金','product_comparison'],['对比存款产品','product_comparison']]){
  const route=routeBehavior({text});assert.equal(route.required_skills[0],id,text);assert.ok(loadSkills(route).loaded.some(s=>s.id===id));
 }
 assert.ok(!routeBehavior({text:'分析本月账单'}).required_skills.some(id=>adapted.includes(id)));
 assert.ok(!routeBehavior({text:'制定储蓄预算'}).required_skills.includes('budget_variance'));
 assert.deepEqual(routeBehavior({text:'以后比较基金时简短回答'}).required_skills,[]);
 assert.deepEqual(routeBehavior({text:'查看我的记忆'}).required_skills,[]);
 const previous=routeBehavior({text:'分析支出为什么超过预算'}),continued=routeBehavior({text:'继续',previous});
 assert.ok(continued.secondary_modules.includes('budgeting'));assert.equal(continued.required_skills[0],'budget_variance');
 assert.equal(routeBehavior({text:'解释这个差别',tool:'compare_products'}).required_skills[0],'product_comparison');
});

test('实际Agent按需注入完整结构，无额外分类总结调用，记录选中版本与预算',async t=>{
 const f=await fixture(t);
 for(const [text,id] of [['核对本月流水和交易','cashflow_reconciliation'],['本月支出为什么超过预算','budget_variance'],['对比两款基金','product_comparison']]){
  const response=await f.chat(text);assert.equal(response.status,200);
  const prompt=f.requests.at(-1).messages.find(m=>m.role==='system'&&m.content.includes(`[${id}@`));assert.ok(prompt);
  for(const field of ['输入：','工具：','步骤：','限制：','输出：'])assert.ok(prompt.content.includes(field));
  assert.ok(!prompt.content.includes('Comparable Company Analysis'));assert.ok(!prompt.content.includes('mcp__'));assert.ok(!prompt.content.includes('3,550,000'));
 }
 assert.equal(f.requests.length,3);const metrics=(await f.call('/agent/memory/context')).data;
 assert.ok(metrics.every(m=>m.skill_bytes<=900&&m.augmentation_bytes<=3200));
 assert.deepEqual(new Set(metrics.flatMap(m=>m.skill_versions.map(s=>s.id)).filter(id=>adapted.includes(id))),new Set(adapted));
 assert.ok(metrics.every(m=>m.skill_versions.length<=2));
});

test('已有工具循环可切换到比较Skill，推荐与测评仍遵循原业务约束',async t=>{
 const f=await fixture(t);
 const products=f.services.state(f.user).products;
 // Get valid product IDs from the same data API used by this application.
 const ids=(products||[]).slice(0,2).map(p=>p.id);
 assert.equal(ids.length,2);
 f.queue.push(llm([['compare_products',{ids}]]),llm([], '请核对产品比较数据。'));
 const response=await f.chat('分析这些投资产品');assert.equal(response.status,200);assert.equal(f.requests.length,2);
 const prompt=f.requests[1].messages.find(m=>m.role==='system'&&m.content.includes('[product_comparison@1.0.0]'));
 assert.ok(prompt);assert.match(prompt.content,/wealth_advice/);assert.match(prompt.content,/不由聊天推断风险能力/);assert.ok(f.requests[1].messages.some(m=>m.role==='tool'));
});
