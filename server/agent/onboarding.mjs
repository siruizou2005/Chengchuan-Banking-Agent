import { requireThat } from '../errors.mjs';
import { now } from '../db.mjs';
import { channelNames, setChannelPreference } from '../channels/preferences.mjs';

// First conversation after enrollment: the model asks, the server validates and saves. Only the App channel runs it.
export const ONBOARDING_FIELDS = Object.freeze(['preferred_name','focus_areas','answer_length','mask_amounts','investment_goal']);
export const FIELD_LABEL = Object.freeze({preferred_name:'称呼',focus_areas:'关注业务',answer_length:'回复详略',mask_amounts:'飞书/微信隐藏金额',investment_goal:'理财目标'});
export const FOCUS_AREAS = Object.freeze(['账单分析','理财','转账','信用卡与贷款','生活缴费']);
export const GOAL_OPTIONS = Object.freeze(['备用金随用随取','稳健增值','长期增值','暂不考虑理财']);
export const ONBOARDING_TOOLS = new Set(['save_onboarding_answer','skip_onboarding']);
const field={type:'string',enum:ONBOARDING_FIELDS};
const evidence={type:'string',minLength:1,maxLength:200,description:'本轮用户原文中支持该操作的片段，须逐字摘录'};
export const onboardingToolDefinitions=[
 {type:'function',function:{name:'save_onboarding_answer',description:`保存用户在首次引导中亲口说出的偏好；一句话说了多项就分别调用。value取值：preferred_name为用户希望的称呼（不超过20字，须原样出现在evidence中）；focus_areas为${FOCUS_AREAS.join('、')}中的一项或多项，用顿号分隔；answer_length为简短或详细；mask_amounts为隐藏或显示（同时作用于飞书和微信）；investment_goal为${GOAL_OPTIONS.join('、')}之一，或用户原话（不超过40字）`,parameters:{type:'object',properties:{field,value:{type:'string',minLength:1,maxLength:60},evidence},required:['field','value','evidence'],additionalProperties:false}}},
 {type:'function',function:{name:'skip_onboarding',description:'用户表示某些问题不想回答时传fields；表示不想继续引导、以后再说时传all=true，结束引导',parameters:{type:'object',properties:{fields:{type:'array',items:field,minItems:1,maxItems:5},all:{type:'boolean'},evidence},required:['evidence'],additionalProperties:false}}},
];
export const ONBOARDING_OPENING='开通成功！想先花一分钟了解你，方便以后按你的习惯来服务，每个问题都可以说「跳过」。先问一下，我该怎么称呼你？';
export const ONBOARDING_INSTRUCTIONS=`当前是用户开通智能助手后的首次引导，App已向用户显示开场白：「${ONBOARDING_OPENING}」。目标是用轻松自然的对话了解以下偏好：称呼、关注业务、回复详略、飞书/微信中是否隐藏金额、理财目标。这些问题属于本行服务，回答引导问题时不要调用decline_off_topic。规则：
1. 每次只问一到两项，语气亲切简短，不要一次列出全部问题；用户可以随时跳过，不要追问被跳过的问题。
2. 用户回答后，用save_onboarding_answer保存；用户一句话里说了多项就分别保存；用户说跳过或不想答，用skip_onboarding。只保存用户本轮亲口表达的内容，不要猜测；含糊时先确认。
3. 用户如果提出银行业务请求，先按正常规则办理，最后一句再问是否继续设置偏好。
4. 风险偏好以正式风险测评为准，不要评估或记录用户的风险承受能力；引导状态里riskLevel为0表示尚未测评，问理财目标时可提醒用户在理财页完成风险测评。
5. 引导期间不使用memory_candidates和remember。保存后说「已记下」，不要说「已完成」。
6. 全部问完或用户结束引导后，用一两句话总结已记下的偏好，并告诉用户可以在「我的 → 个性化与记忆」中随时修改。`;
const compact=text=>String(text).normalize('NFKC').replace(/\s+/g,'').toLowerCase();

export function createOnboarding(services) {
 const {bank}=services;
 function state(userId) {
  const row=bank.get('SELECT agent_onboarding,agent_onboarding_state,risk_level FROM users WHERE id=?',userId);
  let saved={};try{saved=JSON.parse(row?.agent_onboarding_state||'{}');}catch{}
  const answered=ONBOARDING_FIELDS.filter(f=>saved.answered?.includes(f)),skipped=ONBOARDING_FIELDS.filter(f=>saved.skipped?.includes(f)&&!answered.includes(f));
  const remaining=ONBOARDING_FIELDS.filter(f=>!answered.includes(f)&&!skipped.includes(f));
  return {status:row?.agent_onboarding||'pending',answered,skipped,remaining,next:remaining[0]||null,riskLevel:row?.risk_level||0,personalization:services.memory.enabled()};
 }
 const active=(user,channel)=>channel==='app'&&state(user.id).status==='pending';
 function normalize(fieldName,value,input) {
  if(fieldName==='mask_amounts'){requireThat(['隐藏','显示'].includes(value),'mask_amounts须为隐藏或显示',400,'INVALID_ONBOARDING');return value==='隐藏';}
  requireThat(services.memory.enabled(),'个性化功能已关闭，只能设置隐藏金额',503,'PERSONALIZATION_DISABLED');
  if(fieldName==='focus_areas'){
   const areas=[...new Set(value.split(/[、,，;；\s]+/).filter(Boolean))];
   requireThat(areas.length&&areas.every(a=>FOCUS_AREAS.includes(a)),`关注业务只能从${FOCUS_AREAS.join('、')}中选择`,400,'INVALID_ONBOARDING');
   value=FOCUS_AREAS.filter(a=>areas.includes(a)).join('、');
  }
  // Free text must be the user's own words, so the model cannot invent a name or goal.
  if(fieldName==='preferred_name'||(fieldName==='investment_goal'&&!GOAL_OPTIONS.includes(value)))requireThat(compact(input).includes(compact(value)),'称呼或理财目标须是用户原话',400,'ONBOARDING_EVIDENCE_REQUIRED');
  if(fieldName==='investment_goal')requireThat(value.length<=40,'理财目标不超过40字',400,'INVALID_ONBOARDING');
  return services.memory.validate(fieldName,value).value;
 }
 // Validates a tool call against this turn's input and returns the staged change; nothing is written until the turn finishes.
 function stage(user,name,args,input,staged) {
  requireThat(typeof args?.evidence==='string'&&args.evidence.trim()&&compact(input).includes(compact(args.evidence)),'evidence须逐字摘自本轮用户消息',400,'ONBOARDING_EVIDENCE_REQUIRED');
  let changes;
  if(name==='save_onboarding_answer'){
   requireThat(ONBOARDING_FIELDS.includes(args.field)&&typeof args.value==='string'&&args.value.trim().length>0&&args.value.length<=60,'引导字段无效',400,'INVALID_ONBOARDING');
   changes=[{field:args.field,value:normalize(args.field,args.value.trim(),input)}];
  }else{
   requireThat(args.all===true||(Array.isArray(args.fields)&&args.fields.length&&args.fields.every(f=>ONBOARDING_FIELDS.includes(f))),'请说明跳过哪些问题',400,'INVALID_ONBOARDING');
   changes=args.all===true?[{all:true}]:args.fields.map(f=>({field:f,skip:true}));
  }
  staged.push(...changes);
  const done=new Set(staged.filter(s=>s.field).map(s=>s.field)),current=state(user.id);
  return {saved:changes.map(c=>c.all?'全部跳过':`${FIELD_LABEL[c.field]}${c.skip?'（跳过）':''}`),remaining:staged.some(s=>s.all)?[]:current.remaining.filter(f=>!done.has(f)).map(f=>FIELD_LABEL[f])};
 }
 function finishWith(userId,answered,skipped,ended) {
  const remaining=ONBOARDING_FIELDS.filter(f=>!answered.includes(f)&&!skipped.includes(f));
  const status=remaining.length&&!ended?'pending':answered.length?'completed':'skipped';
  bank.run('UPDATE users SET agent_onboarding=?,agent_onboarding_state=? WHERE id=?',status,JSON.stringify({answered,skipped,updatedAt:now()}),userId);
  if(status!=='pending')bank.audit(userId,`agent.onboarding.${status}`,'',{answered,skipped});
 }
 // Runs inside the turn's transaction; memory writes bump the epoch, which the caller accounts for.
 function apply(user,principal,staged,messageId) {
  const current=state(user.id);if(current.status!=='pending'||!staged.length)return;
  const answered=[...current.answered],skipped=[...current.skipped];
  for(const [index,item] of staged.entries()){
   if(item.all)continue;
   if(item.skip){if(!answered.includes(item.field)&&!skipped.includes(item.field))skipped.push(item.field);bank.audit(user.id,'agent.onboarding.skipped','',{field:item.field});continue;}
   if(item.field==='mask_amounts')for(const channel of channelNames)setChannelPreference(bank,user.id,channel,item.value);
   else services.memory.update(principal,{key:item.field,value:item.value},{type:'explicit',messageId:`${messageId}:onboarding:${index}`});
   if(!answered.includes(item.field))answered.push(item.field);
   const was=skipped.indexOf(item.field);if(was>=0)skipped.splice(was,1);
   bank.audit(user.id,'agent.onboarding.saved','',{field:item.field});
  }
  finishWith(user.id,answered,skipped,staged.some(s=>s.all));
 }
 // Ends the guide from the App (e.g. 「全部跳过」); answers already saved are kept.
 function end(user) {
  bank.atomic(()=>{const current=state(user.id);if(current.status==='pending')finishWith(user.id,current.answered,current.skipped,true);});
  return state(user.id);
 }
 function reset(user) {
  bank.atomic(()=>{bank.run("UPDATE users SET agent_onboarding='pending',agent_onboarding_state='{}' WHERE id=?",user.id);bank.audit(user.id,'agent.onboarding.reset');});
  return state(user.id);
 }
 return {state,active,stage,apply,end,reset};
}
