import { readFileSync } from 'node:fs';
import { requireThat } from '../errors.mjs';
export const DEFAULT_PUMA_POLICY=JSON.parse(readFileSync(new URL('./policy.json',import.meta.url),'utf8'));
export const MODES=['disabled','shadow','monitored_canary','enabled'];
export const enforcing = mode => mode === 'enabled' || mode === 'monitored_canary';
export function validatePumaPolicy(input={}) {
  const p={...DEFAULT_PUMA_POLICY,...input,flags:{...DEFAULT_PUMA_POLICY.flags,...input.flags},rules:{...DEFAULT_PUMA_POLICY.rules,...input.rules}};
  requireThat(Object.keys(input).every(k=>Object.hasOwn(DEFAULT_PUMA_POLICY,k)) && /^[\w.-]{1,80}$/.test(p.version) && p.livePaymentEnabled===false,'PUMA 配置无效或请求真实支付',503,'INVALID_PUMA_POLICY');
  requireThat(Object.entries(p.flags).every(([k,v])=>Object.hasOwn(DEFAULT_PUMA_POLICY.flags,k)&&MODES.includes(v)),'PUMA 开关无效',503,'INVALID_PUMA_POLICY');
  requireThat(['disabled','shadow'].includes(p.flags.puma_trait_research)&&['disabled','shadow'].includes(p.flags.puma_scam_risk_shadow),'研究模型只能以 shadow 运行',503,'RESEARCH_ONLY');
  requireThat(Object.entries(p.rules).every(([k,v])=>Object.hasOwn(DEFAULT_PUMA_POLICY.rules,k)&&Number.isSafeInteger(v)&&v>0),'PUMA 阈值无效',503,'INVALID_PUMA_POLICY');
  if(p.flags.puma_behavior_model!=='disabled') requireThat(p.flags.puma_memory_v2!=='disabled','行为模型依赖记忆适配',503,'INVALID_PUMA_DEPENDENCY');
  if(p.flags.puma_dynamic_policy!=='disabled') requireThat(p.flags.puma_scam_risk_shadow!=='disabled','动态策略依赖影子风险契约',503,'INVALID_PUMA_DEPENDENCY');
  return Object.freeze({...p,flags:Object.freeze(p.flags),rules:Object.freeze(p.rules)});
}
export function loadPumaPolicy(options={}) {
  const file=options.policyFile||process.env.PUMA_POLICY_FILE;
  return validatePumaPolicy({...file?JSON.parse(readFileSync(file,'utf8')):{},...options.policy});
}
