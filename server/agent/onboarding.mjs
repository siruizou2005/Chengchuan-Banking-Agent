import { requireThat } from '../errors.mjs';
import { id, now } from '../db.mjs';
import { boundedHistory } from './memory.mjs';
import { channelNames, setChannelPreference } from '../channels/preferences.mjs';
import { REPORT_KINDS, setReportSubscriptions } from '../channels/reports.mjs';

// First conversation after enrollment: the model asks, the server validates and saves. Only the App channel runs it.
// Binding a channel happens in the App card below the chat and the risk questionnaire on its own page; the model only records the choice.
export const ONBOARDING_FIELDS = Object.freeze(['preferred_name','focus_areas','answer_length','investment_goal','channels','mask_amounts','reports','risk']);
export const FIELD_LABEL = Object.freeze({preferred_name:'称呼',focus_areas:'关注业务',answer_length:'回复详略',investment_goal:'理财目标',channels:'绑定飞书/微信',mask_amounts:'飞书/微信隐藏金额',reports:'账单推送',risk:'风险测评'});
export const FOCUS_AREAS = Object.freeze(['账单分析','理财','转账','信用卡与贷款','生活缴费']);
export const GOAL_OPTIONS = Object.freeze(['备用金随用随取','稳健增值','长期增值','暂不考虑理财']);
export const CHANNEL_LABEL = Object.freeze({wechat:'微信',feishu:'飞书'});
const CHANNEL_CHOICES={微信:['wechat'],飞书:['feishu'],都绑:['wechat','feishu']},REPORT_NAMES={日报:'daily',周报:'weekly',月报:'monthly'};
export const ONBOARDING_TOOLS = new Set(['save_onboarding_answer','skip_onboarding']);
const field={type:'string',enum:ONBOARDING_FIELDS},saveField={type:'string',enum:ONBOARDING_FIELDS.filter(f=>f!=='risk')};
const evidence={type:'string',minLength:1,maxLength:200,description:'本轮用户原文中支持该操作的片段，须逐字摘录'};
export const onboardingToolDefinitions=[
 {type:'function',function:{name:'save_onboarding_answer',description:`保存用户在首次引导中亲口说出的偏好；一句话说了多项就分别调用。value取值：preferred_name为用户希望的称呼（不超过20字，须原样出现在evidence中）；focus_areas为${FOCUS_AREAS.join('、')}中的一项或多项，用顿号分隔；answer_length为简短、适中或详细；investment_goal为${GOAL_OPTIONS.join('、')}之一，或用户原话（不超过40字）；channels为用户想绑定的渠道：微信、飞书或都绑（只记下选择，用户在App卡片里扫码完成绑定）；mask_amounts为隐藏或显示（同时作用于飞书和微信）；reports为日报、周报、月报中的一项或多项，用顿号分隔。风险测评只能在App专门页面完成，不能保存`,parameters:{type:'object',properties:{field:saveField,value:{type:'string',minLength:1,maxLength:60},evidence},required:['field','value','evidence'],additionalProperties:false}}},
 {type:'function',function:{name:'skip_onboarding',description:'用户表示某些问题不想回答时传fields；表示不想继续引导、以后再说时传all=true，结束引导',parameters:{type:'object',properties:{fields:{type:'array',items:field,minItems:1,maxItems:ONBOARDING_FIELDS.length},all:{type:'boolean'},evidence},required:['evidence'],additionalProperties:false}}},
];
export const ONBOARDING_OPENING='开通成功！想先花一分钟了解你，方便以后按你的习惯来服务，每个问题都可以说「跳过」。先问一下，我该怎么称呼你？';
export const ONBOARDING_INSTRUCTIONS=`当前是用户开通智能助手后的首次引导，App已向用户显示开场白：「${ONBOARDING_OPENING}」。目标是用轻松自然的对话依次了解：称呼、关注业务、回复详略、理财目标；再问是否绑定飞书/微信、飞书/微信中是否隐藏金额、要不要账单推送；最后是风险测评。引导状态的remaining是还没处理的项目，按它的顺序问，不在remaining里的不要问。这些问题属于本行服务，回答引导问题时不要调用decline_off_topic。规则：
1. 每次只问一到两项，语气亲切简短，不要一次列出全部问题；用户可以随时跳过，不要追问被跳过的问题。
2. 用户回答后，用save_onboarding_answer保存；用户一句话里说了多项就分别保存；用户说跳过或不想答，用skip_onboarding。只保存用户本轮亲口表达的内容，不要猜测；含糊时先确认。
3. 绑定飞书/微信：只提引导状态channels.available里的渠道，问用户绑微信、飞书还是两个都绑；用户选好后保存channels，并请用户在下方卡片输入支付密码、扫二维码完成绑定。绑定只能在卡片里完成：不要在对话中索要支付密码或验证码；是否绑好以channels.bound为准，不要自己说已绑定。
4. 账单推送：日报每天、周报每周一、月报每月1日，都在上午8:00推送到已绑定的飞书/微信；问用户要哪几种，选好后保存reports。
5. 风险测评是最后一项，由用户点下方卡片的「去测评」到专门页面完成；不要自己出题，也不要评估或记录用户的风险承受能力。用户不想做就用skip_onboarding跳过。
6. 用户如果提出银行业务请求，先按正常规则办理，最后一句再问是否继续设置。
7. 引导期间不使用memory_candidates和remember。保存后说「已记下」，不要说「已完成」。
8. 全部问完或用户结束引导后，用一两句话总结已记下的偏好，并告诉用户可以在「我的 → 个性化与记忆」中随时修改；跳过了风险测评时，提醒以后在「理财 → 风险测评」完成后可以按结果给出配置建议。`;
// Prompts for answers saved without the model: each states the next question in the same voice as the opening line.
const NEXT_QUESTION={preferred_name:'我该怎么称呼你？',focus_areas:'你最关注哪些业务？可以多选。',answer_length:'希望我的回复简短、适中还是详细？',investment_goal:'你的理财目标是什么？',channels:'要不要绑定飞书或微信？绑定后可以在那边查询和接收推送。',mask_amounts:'在飞书、微信里要隐藏金额吗？',reports:'要不要账单推送？日报每天、周报每周一、月报每月1日上午8:00发送。',risk:'最后做一下风险测评吧，到专门页面答5道题，理财建议才能按结果来。不想做也可以跳过。'};
const DONE_TEXT='首次设置就到这里，以后可以在「我的 → 个性化与记忆」修改偏好，在「消息渠道绑定」调整飞书、微信和账单推送。有什么可以帮你？';
const compact=text=>String(text).normalize('NFKC').replace(/\s+/g,'').toLowerCase();

export function createOnboarding(services) {
 const {bank}=services;
 function read(userId) {
  let saved={};try{saved=JSON.parse(bank.get('SELECT agent_onboarding_state FROM users WHERE id=?',userId)?.agent_onboarding_state||'{}');}catch{}
  return {answered:saved.answered||[],skipped:saved.skipped||[],choices:saved.choices||{}};
 }
 function channelState(userId,choices) {
  const availability=services.channelAvailability?.()||{},available=channelNames.filter(c=>availability[c]);
  const bound=channelNames.filter(c=>bank.get("SELECT 1 FROM channel_bindings WHERE user_id=? AND channel=? AND status='active' AND auth_state='valid'",userId,c));
  return {available,bound,choice:(choices.channels||[]).filter(c=>available.includes(c)),feishu:availability.feishu||null};
 }
 // Some steps follow from facts (an assessed risk level, every available channel already bound); others do not apply
 // (nothing can be bound, or there is no binding to hide amounts in or to push reports to) and are left out.
 function progress(userId,saved) {
  const riskLevel=bank.get('SELECT risk_level FROM users WHERE id=?',userId)?.risk_level||0,channels=channelState(userId,saved.choices);
  const derived=[...(riskLevel>0?['risk']:[]),...(channels.bound.length&&channels.available.every(c=>channels.bound.includes(c))?['channels']:[])];
  const answered=ONBOARDING_FIELDS.filter(f=>saved.answered.includes(f)||derived.includes(f)),skipped=ONBOARDING_FIELDS.filter(f=>saved.skipped.includes(f)&&!answered.includes(f));
  const settled=f=>answered.includes(f)||skipped.includes(f),unbindable=!channels.available.length;
  const unavailable=ONBOARDING_FIELDS.filter(f=>!settled(f)&&(f==='channels'?unbindable:['mask_amounts','reports'].includes(f)&&!channels.bound.length&&(unbindable||settled('channels'))));
  return {answered,skipped,unavailable,remaining:ONBOARDING_FIELDS.filter(f=>!settled(f)&&!unavailable.includes(f)),channels,riskLevel};
 }
 function state(userId) {
  const status=bank.get('SELECT agent_onboarding FROM users WHERE id=?',userId)?.agent_onboarding||'pending',{unavailable,remaining,...rest}=progress(userId,read(userId));
  return {status,...rest,remaining,unavailable,total:ONBOARDING_FIELDS.length-unavailable.length,next:remaining[0]||null,personalization:services.memory.enabled()};
 }
 const active=(user,channel)=>channel==='app'&&state(user.id).status==='pending';
 function normalize(fieldName,value,input,current) {
  if(fieldName==='mask_amounts'){requireThat(['隐藏','显示'].includes(value),'mask_amounts须为隐藏或显示',400,'INVALID_ONBOARDING');return value==='隐藏';}
  if(fieldName==='channels'){
   const choice=CHANNEL_CHOICES[value];requireThat(choice,'channels须为微信、飞书或都绑',400,'INVALID_ONBOARDING');
   const closed=choice.filter(c=>!current.channels.available.includes(c));
   requireThat(!closed.length,`${closed.map(c=>CHANNEL_LABEL[c]).join('、')}暂未开放绑定`,409,'CHANNEL_UNAVAILABLE');
   const open=choice.filter(c=>!current.channels.bound.includes(c));
   requireThat(open.length,`${choice.map(c=>CHANNEL_LABEL[c]).join('、')}已经绑定`,409,'CHANNEL_ALREADY_BOUND');
   return open;
  }
  if(fieldName==='reports'){
   const names=[...new Set(value.split(/[、,，;；\s和与]+/).filter(Boolean))];
   requireThat(names.length&&names.every(n=>REPORT_NAMES[n]),'reports只能是日报、周报、月报',400,'INVALID_ONBOARDING');
   return Object.fromEntries(REPORT_KINDS.map(kind=>[kind,names.some(n=>REPORT_NAMES[n]===kind)]));
  }
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
  let changes;const current=state(user.id);
  if(name==='save_onboarding_answer'){
   requireThat(saveField.enum.includes(args.field)&&typeof args.value==='string'&&args.value.trim().length>0&&args.value.length<=60,'引导字段无效',400,'INVALID_ONBOARDING');
   changes=[{field:args.field,value:normalize(args.field,args.value.trim(),input,current)}];
  }else{
   requireThat(args.all===true||(Array.isArray(args.fields)&&args.fields.length&&args.fields.every(f=>ONBOARDING_FIELDS.includes(f))),'请说明跳过哪些问题',400,'INVALID_ONBOARDING');
   changes=args.all===true?[{all:true}]:args.fields.map(f=>({field:f,skip:true}));
  }
  staged.push(...changes);
  // Choosing a channel is not an answer yet: the step finishes when the binding is scanned in the App.
  const done=new Set(staged.filter(s=>s.field&&(s.skip||s.field!=='channels')).map(s=>s.field));
  const label=c=>c.all?'全部跳过':c.skip?`${FIELD_LABEL[c.field]}（跳过）`:c.field==='channels'?`${FIELD_LABEL.channels}：已选择${c.value.map(x=>CHANNEL_LABEL[x]).join('、')}，等用户在卡片中扫码`:FIELD_LABEL[c.field];
  return {saved:changes.map(label),remaining:staged.some(s=>s.all)?[]:current.remaining.filter(f=>!done.has(f)).map(f=>FIELD_LABEL[f])};
 }
 function finishWith(userId,saved,ended) {
  const status=progress(userId,saved).remaining.length&&!ended?'pending':saved.answered.length?'completed':'skipped';
  bank.run('UPDATE users SET agent_onboarding=?,agent_onboarding_state=? WHERE id=?',status,JSON.stringify({...saved,updatedAt:now()}),userId);
  if(status!=='pending')bank.audit(userId,`agent.onboarding.${status}`,'',{answered:saved.answered,skipped:saved.skipped});
 }
 function answer(saved,fieldName){if(!saved.answered.includes(fieldName))saved.answered.push(fieldName);saved.skipped=saved.skipped.filter(f=>f!==fieldName);}
 // Runs inside the turn's transaction; memory writes bump the epoch, which the caller accounts for.
 function apply(user,principal,staged,messageId) {
  const current=state(user.id);if(current.status!=='pending'||!staged.length)return;
  const saved=read(user.id);
  for(const [index,item] of staged.entries()){
   if(item.all)continue;
   if(item.skip){if(!saved.answered.includes(item.field)&&!saved.skipped.includes(item.field))saved.skipped.push(item.field);bank.audit(user.id,'agent.onboarding.skipped','',{field:item.field});continue;}
   bank.audit(user.id,'agent.onboarding.saved','',{field:item.field});
   if(item.field==='channels'){saved.choices={...saved.choices,channels:item.value};continue;}
   if(item.field==='mask_amounts')for(const channel of channelNames)setChannelPreference(bank,user.id,channel,item.value);
   // Reports go to the channels already bound; with none yet they wait in every channel until one is bound.
   else if(item.field==='reports')for(const channel of current.channels.bound.length?current.channels.bound:channelNames)setReportSubscriptions(bank,user.id,channel,item.value);
   else services.memory.update(principal,{key:item.field,value:item.value},{type:'explicit',messageId:`${messageId}:onboarding:${index}`});
   answer(saved,item.field);
  }
  finishWith(user.id,saved,staged.some(s=>s.all));
 }
 // The App reports a step finished outside the conversation: a binding scanned in the card, or the risk questionnaire.
 function advance(user,fieldName) {
  requireThat(['channels','risk'].includes(fieldName),'该项请在对话中回答',400,'INVALID_ONBOARDING');
  bank.atomic(()=>{
   const current=state(user.id);if(current.status!=='pending')return;
   requireThat(fieldName==='channels'?current.channels.bound.length:current.riskLevel>0,fieldName==='channels'?'尚未绑定飞书或微信':'尚未完成风险测评',409,'ONBOARDING_STEP_INCOMPLETE');
   const saved=read(user.id);answer(saved,fieldName);bank.audit(user.id,'agent.onboarding.saved','',{field:fieldName});finishWith(user.id,saved,false);
  });
  return state(user.id);
 }
 // Ends the guide from the App (e.g. 「全部跳过」); answers already saved are kept.
 function end(user) {
  bank.atomic(()=>{if(state(user.id).status==='pending')finishWith(user.id,read(user.id),true);});
  return state(user.id);
 }
 // Tapping an option or submitting the card answers directly: the server validates and saves it with no model call.
 function answerDirectly(user,principal,{field:fieldName,value,skip,label},sessionId,messageId) {
  requireThat(ONBOARDING_FIELDS.includes(fieldName),'引导字段无效',400,'INVALID_ONBOARDING');
  requireThat(skip===true||(fieldName!=='risk'&&typeof value==='string'&&value.trim().length>0&&value.length<=60),'引导字段无效',400,'INVALID_ONBOARDING');
  const text=typeof label==='string'&&label.trim()?label.trim().slice(0,60):String(value||`${FIELD_LABEL[fieldName]}这个问题跳过`);
  return bank.atomic(()=>{
   const current=state(user.id);requireThat(current.status==='pending','首次引导已结束',409,'ONBOARDING_FINISHED');
   if(sessionId)requireThat(bank.get("SELECT 1 FROM agent_sessions WHERE id=? AND user_id=? AND channel='app' AND archived=0",sessionId,user.id),'会话不存在',404,'NOT_FOUND');
   const change=skip===true?{field:fieldName,skip:true}:{field:fieldName,value:normalize(fieldName,value.trim(),value,current)};
   apply(user,principal,[change],messageId);
   const next=state(user.id),acknowledged=fieldName==='preferred_name'&&!skip?`好的，${value.trim()}。`:skip?'好的，这项先跳过。':'已记下。';
   const reply=fieldName==='channels'&&!skip&&next.next==='channels'?'好的，请在下方输入支付密码生成二维码，扫码后就绑定好了。':next.status==='pending'&&next.next?`${acknowledged}${NEXT_QUESTION[next.next]}`:DONE_TEXT;
   const at=now(),session=sessionId||id('SESSION');
   bank.run('INSERT OR IGNORE INTO agent_sessions(id,user_id,channel,updated_at) VALUES(?,?,?,?)',session,user.id,'app',at);
   const history=services.memory.recent(principal,session);
   bank.run('UPDATE agent_sessions SET history=?,updated_at=? WHERE id=?',JSON.stringify(boundedHistory([...history,{role:'user',content:text},{role:'assistant',content:reply}])),at,session);
   bank.run("INSERT INTO agent_runs(id,user_id,channel,session_id,input,injection,trace,output,duration_ms,tokens,created_at,events,topic) VALUES(?,?,'app',?,?,'[]','[]',?,0,0,?,'[]','onboarding')",id('RUN'),user.id,session,text,reply,at);
   return {state:next,reply,sessionId:session,text};
  });
 }
 function reset(user) {
  bank.atomic(()=>{bank.run("UPDATE users SET agent_onboarding='pending',agent_onboarding_state='{}' WHERE id=?",user.id);bank.audit(user.id,'agent.onboarding.reset');});
  return state(user.id);
 }
 return {state,active,stage,apply,advance,end,reset,answerDirectly};
}
