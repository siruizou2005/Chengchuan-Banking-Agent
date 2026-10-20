import { performance } from 'node:perf_hooks';
import { MODULES, INTENTS, TOOL_MODULES } from './modules.mjs';
import { selectFinancialSkills } from './skills/selection.mjs';

export function routeBehavior({text='',tool,entry,previous}={}) {
  const started=performance.now(),reasons=[];
  // tool/entry are internal, validated workflow events; HTTP callers never supply them directly.
  const entries={ledger:'spending',wealth:'investment',loan:'debt_credit',budget:'budgeting'};
  const structural=(Object.hasOwn(TOOL_MODULES,tool)?TOOL_MODULES[tool]:null)||(Object.hasOwn(entries,entry)?entries[entry]:null);
  const matches=Object.entries(MODULES).filter(([,m])=>m.keywords.test(text)).map(([key])=>key);
  let primary=structural||matches[0],confidence=structural?1:matches.length?0.9:0.35;
  if(structural)reasons.push('trusted_workflow');else if(matches.length)reasons.push('module_keywords');
  if(!primary&&/^(继续|再详细|展开|然后|为什么|还有呢|按刚才|接着)/.test(text)&&previous&&Object.hasOwn(MODULES,previous.primary_module)){
    primary=previous.primary_module;confidence=0.7;reasons.push('owned_live_session');
  }
  primary||='general';if(!reasons.length)reasons.push('safe_general_fallback');
  let intent=/查看.*记忆|回忆|记得|recall/i.test(text)?'recall':/复盘|历史决策|过去.*(?:选择|原因)|行为规律|以前.*(?:为什么|怎么)|review/i.test(text)?'review':/以后|今后|记住|忘记|删除.*记忆|偏好|纠正/i.test(text)?'update_preference':/对比|比较|compare/i.test(text)?'compare':/规划|计划|方案|制定|plan/i.test(text)?'plan':/是否应该|该不该|怎么选|选哪个|决定|decide/i.test(text)?'decide':/是什么|解释|含义|概念|explain/i.test(text)?'explain':'analyze';
  if(reasons.includes('owned_live_session')&&INTENTS.includes(previous.intent))intent=previous.intent;
  const inherited=reasons.includes('owned_live_session')&&Array.isArray(previous.secondary_modules)?previous.secondary_modules:matches;
  const secondary=inherited.filter(m=>m!==primary&&Object.hasOwn(MODULES,m)).slice(0,2),modules=[primary,...secondary];
  const specialized=selectFinancialSkills({text,tool,modules,intent,previous,continuation:reasons.includes('owned_live_session')});
  const skills=intent==='update_preference'||intent==='recall'?[]:[...new Set([...specialized,...modules.flatMap(m=>MODULES[m].skills)])].filter(s=>s!=='risk_analysis'||/风险|回撤|risk/i.test(text)).slice(0,2);
  return {primary_module:primary,secondary_modules:secondary,intent,confidence,
    required_memory_types:['explicit','semantic','interaction',...(['review','recall'].includes(intent)?['episodic']:[]),...(['analyze','compare','explain'].includes(intent)?['behavioral']:[])],
    retrieval_depth:['review','recall'].includes(intent)?'detail':'summary',required_skills:skills,reasons,duration_ms:performance.now()-started};
}
