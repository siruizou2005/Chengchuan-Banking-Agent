import { validate, redact, unsafeReminder } from './guard.mjs';
import { READ_TOOLS, LOW_RISK_EFFECTS, businessDate } from './policy.mjs';
import { ledgerFor, enrich, selectLedger, resolveRange, billReport, compactReport, spendingStats, compactStats, detectAnomalies, PRESETS, KIND_LABEL } from './analytics.mjs';
import { runAnalysis } from './sandbox.mjs';
import { id, now } from '../db.mjs';
import { CATEGORY_LABEL } from '../products.mjs';
import { wealthAdvice, compactAdvice } from '../wealth.mjs';
import { requireThat, cents, hash } from '../errors.mjs';
import { assertChannelExecution, commitToolEffect } from './execution.mjs';
import { resolvePrincipal } from './principal.mjs';
import { consentAllowed } from '../puma/consent.mjs';
import { assertAgentControl } from '../puma/control.mjs';
const str=(maxLength=100)=>({type:'string',minLength:1,maxLength});
const money={type:'string',pattern:'^(0|[1-9]\\d{0,8})(\\.\\d{1,2})?$',description:'人民币元字符串，最多2位小数'};
const obj=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const arr=(items,maxItems=20)=>({type:'array',items,minItems:1,maxItems});
const day={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'北京时间日期YYYY-MM-DD'};
const range={preset:{type:'string',enum:Object.keys(PRESETS),description:'相对时段，按北京时间'},period:{type:'string',pattern:'^\\d{4}(-\\d{2}(-\\d{2})?)?$',description:'YYYY年、YYYY-MM月或YYYY-MM-DD日'},from:day,to:day};
const kind={type:'string',enum:Object.keys(KIND_LABEL).filter(k=>k!=='opening')};
const hasRange=a=>Boolean(a.preset||a.period||a.from||a.to);
const fits=(rows,max=3300)=>{while(rows.length&&Buffer.byteLength(JSON.stringify(rows))>max)rows.pop();return rows;}; // tool messages over 4096 bytes are truncated
const productBrief=p=>({id:p.id,name:p.name,category:CATEGORY_LABEL[p.category],risk:p.risk,[p.rateLabel||'收益']:p.rate,minimum:p.minimum,...(p.purchasable?{}:{status:p.purchaseStatus})});
const productDetail=p=>Object.fromEntries(Object.entries({id:p.id,name:p.name,category:CATEGORY_LABEL[p.category],fundType:p.fundType,issuer:p.issuer,risk:p.risk,rate:p.rate,rateLabel:p.rateLabel,returns:p.returns,nav:p.nav,perTenThousand:p.perTenThousand,navDate:p.navDate,minimum:p.minimum,fee:p.fee,purchaseStatus:p.purchaseStatus,purchaseLimit:p.purchaseLimit,redeemStatus:p.redeemStatus,days:p.days}).filter(([,v])=>v!==undefined&&v!==null));
const catalogNote=meta=>({source:meta.source,updatedAt:meta.updatedAt,stale:meta.stale,...(meta.notice?{notice:meta.notice}:{}),units:'收益率为百分比；minimum、purchaseLimit、principal为整数分；过往业绩不代表未来'});
const STATS_BY=['category','merchant','platform','month','week','day','weekday','hour'];
const definitions={
 create_transfer_draft:['用户明确要求转账时优先使用：生成未授权的模拟转账草稿；只返回可信确认页面链接，聊天不能批准或执行支付。收款人必须来自resolve_recipient。amountMinor为整数分。',obj({beneficiaryRef:str(),sourceAccountRef:str(),amountMinor:{type:'integer',minimum:1,maximum:1000000000},currency:{type:'string',enum:['CNY']},memo:str(100)},['beneficiaryRef','amountMinor','currency'])],
 get_finance_risk_summary:['读取本人可申诉的风险提示，不读取生日或内部检测规则',obj()],
 get_overview:['查询本人账户余额与可用资金',obj()],
 get_ledger:['查询本人流水明细，返回{total,shown,rows}；行含bj_time北京时间（只有日期表示原对账单无时间）、amount整数分、title、tag分类、kind类型（consumption消费/refund退款/income收入/transfer_out转账给他人/self本人账户互转/wallet充值提现/investment理财存款/debt信用卡贷款/opening期初余额）、merchant商户、platform支付平台。时段用preset/period/from+to，不传为全部；keyword匹配摘要、对方、商户与附言。只需汇总时用bill_report或spending_stats',obj({...range,direction:{enum:['income','expense'],type:'string'},kind,category:str(20),keyword:str(),limit:{type:'integer',minimum:1,maximum:50}})],
 get_transactions:['查询本人交易状态',obj()],
 get_products_and_holdings:['查询定期存款与基金产品目录（基金净值和业绩来自东方财富公开数据）及本人持仓。产品较多，按category类型、maxRisk最高风险等级、keyword名称或管理人关键词筛选；sort=return按收益率从高到低。返回counts为各类数量，shown为本次列出条数',obj({category:{type:'string',enum:Object.keys(CATEGORY_LABEL)},maxRisk:{type:'integer',minimum:1,maximum:5},keyword:str(40),sort:{type:'string',enum:['return','risk']},limit:{type:'integer',minimum:1,maximum:20}})],
 get_credit_card:['查询本人信用卡',obj()],get_loans:['查询本人贷款',obj()],get_payees:['查询本人收款人簿（脱敏）',obj()],
 resolve_recipient:['按姓名、手机号、账号查找收款人；手机号和账号直接传你看到的遮蔽值（如****8096），服务端按用户本轮原文还原；返回脱敏候选，用recipient字段提议转账；多候选必须询问用户',obj({name:str(40),phone:str(19),account:str(19)})],
 bill_report:['生成账单报告，不传参数为本月。日报用period=YYYY-MM-DD或preset=today/yesterday，周报this_week/last_week，月报YYYY-MM或this_month/last_month，年报YYYY，也可任意from+to。返回消费（已扣退款）、转账给他人、收入、消费分类占比、商户Top5、收入来源、不计入消费的本人互转/充值提现/理财、趋势、环比与数据覆盖范围；本工具金额单位为元',obj(range)],spending_stats:['按维度统计，默认本月消费（已扣退款）。by：category分类/merchant商户/platform支付平台/month按月/week按周/day按日/weekday按星期/hour按小时；category只看某分类（如食品），keyword按商户关键词（如美团），kind可改为income/transfer_out等。时段参数同bill_report；本工具金额单位为元',obj({...range,by:{type:'string',enum:STATS_BY},kind,category:str(20),keyword:str(40),limit:{type:'integer',minimum:1,maximum:31}},['by'])],detect_anomalies:['检测异常支出（大额、深夜、首次大额、24小时同额重复），仅为模拟规则提示；可选时段，不传为全部流水',obj(range)],list_subscriptions:['提议查询本人订阅与周期扣费明细，用户授权确认前只返回查询范围',obj()],
 wealth_advice:['生成本人理财配置建议：服务端按风险测评、活期余额、近3个月收支、应急资金和资金期限确定性筛选排序产品，返回资金体检、引导步骤、分配方案及每款产品的理由。amount为拟投资金额（元，不传按建议可投资金额），horizon为资金期限：short随时可能用、mid 3-12个月、long 1年以上（不传按风险测评或由用户在卡片中选择）。推荐理财必须用本工具',obj({amount:money,horizon:{type:'string',enum:['short','mid','long']}})],
 compare_products:['按产品id对比近1/3/6/12个月收益、净值日期、费率、起购额、申购状态与风险等级（不承诺收益）',obj({ids:arr(str(),8)},['ids'])],get_risk_profile:['查询风险测评结果',obj()],get_scheduled_tasks:['查询计划与定时任务',obj()],get_cards:['查询卡片、虚拟卡、锁定资金',obj()],
 run_analysis:['只读沙箱统计，data含today（北京时间日期）、本人全部ledger（含kind、tag、bj_time及导入明细字段，金额整数分）和transactions。代码需return结果，无网络/文件访问，1秒限时',obj({purpose:str(200),code:str(12000)},['purpose','code'])],
 remember:['记录待本人确认的记忆候选；value必须原样出现在当前用户消息的evidence片段中，不得猜测日期或风险能力。优先在最终回答附memory_candidates以避免额外工具轮次',obj({key:str(60),value:str(300),evidence:str(600)},['key','value','evidence'])],recall:['读取本人已确认且有效的记忆',obj()],
 propose_transfer:['提议转账，必须使用resolve_recipient返回的recipient，确认前不会扣款',obj({recipient:str(),amount:money,note:str(100),scheduleAt:str(40)},['recipient','amount'])],
 propose_payment:['提议缴费或模拟商户消费；billNumber若是遮蔽值（如****8000）直接传入，服务端按用户本轮原文还原',obj({billType:{type:'string',enum:['water','electricity','gas','mobile','broadband','property','scan','merchant']},billNumber:str(30),merchant:str(50),amount:money},['billType','amount'])],
 propose_split:['提议AA收款，people为收款请求接收者的recipient，每人均分total，生成银行内收款链接',obj({total:money,people:arr(str(),20),note:str(100)},['total','people'])],
 propose_subscribe_product:['提议申购理财或定期，需要风险匹配和App加强验证',obj({productId:str(),amount:money},['productId','amount'])],
 propose_redeem:['提议赎回本人持仓',obj({holdingId:str(),amount:money},['holdingId','amount'])],
 propose_loan_draw:['提议贷款提款',obj({amount:money,months:{type:'integer',enum:[3,6,12,24]}},['amount'])],
 propose_loan_repay:['提议归还贷款本金',obj({loanId:str(),amount:money},['loanId','amount'])],propose_credit_repay:['提议信用卡还款',obj({amount:money},['amount'])],
 propose_card_action:['提议卡片冻结/解冻/挂失/解挂，card为卡片ID',obj({card:str(),action:{type:'string',enum:['freeze','unfreeze','report_lost','unlost']}},['card','action'])],
 propose_virtual_card:['提议开通模拟虚拟卡，limit为元',obj({limit:money},['limit'])],propose_set_daily_limit:['提议修改转账日限额',obj({amount:money},['amount'])],
 propose_cancel_subscription:['提议取消已授权订阅代扣',obj({id:str()},['id'])],propose_lock_funds:['提议锁定本人活期资金至until日期',obj({amount:money,purpose:str(100),until:str(40)},['amount','purpose','until'])],
 set_reminder:['自动设置站内提醒（不支付任何费用）',obj({at:str(40),text:str(300)},['at','text'])],
 handover_to_human:['创建模拟人工工单，停止本会话后续自动工具调用',obj({reason:str(1000)},['reason'])],
 decline_off_topic:['用户请求与银行业务无关时调用，服务端回复固定话术并结束本轮',obj({reason:str(100)})],
};
const stepArgs=Object.assign({},...Object.entries(definitions).filter(([k])=>k.startsWith('propose_')||k==='set_reminder').map(([,v])=>v[1].properties));
definitions.create_plan=['建立待一次确认的DAG计划；最多12步，tool只可为propose工具或set_reminder，runAt为ISO时间，dependsOn是步骤ID。生日安排先询问或明确展示花费、日期、商户与依赖。',obj({title:str(100),steps:arr(obj({id:str(40),title:str(100),tool:{type:'string',enum:Object.keys(definitions).filter(k=>k.startsWith('propose_')||k==='set_reminder')},args:obj(stepArgs),dependsOn:{type:'array',items:str(40),maxItems:12},runAt:str(40)},['id','title','tool','args']),12)},['title','steps'])];
export const toolDefinitions=Object.entries(definitions).map(([name,[description,parameters]])=>({type:'function',function:{name,description,parameters}}));
export function validateArgs(name,args) {
 requireThat(typeof name==='string'&&Object.hasOwn(definitions,name),'未知工具',400,'UNKNOWN_TOOL');
 const clean=validate(definitions[name][1],args);
 // A reminder posts as the bank with no confirmation, so its body cannot depend on the model ignoring injected text.
 if(name==='set_reminder')requireThat(!unsafeReminder(clean.text),'提醒内容只写要提醒的事项，不能含链接、电话或引导操作的话',400,'UNSAFE_REMINDER');
 if(name==='create_plan')clean.steps=clean.steps.map(s=>({...s,args:validateArgs(s.tool,s.args),dependsOn:s.dependsOn||[]}));
 return clean;
}
export async function executeTool(services,user,name,raw,context={}) {
 context={...context,controlEpoch:assertAgentControl(services.bank,user.id,context.controlEpoch)};
 services.guard.assertOpen(user.id);
 if(READ_TOOLS.has(name)&&name!=='recall')requireThat(consentAllowed(services.bank,user.id,'data_read'),'助手数据读取授权已撤销或过期',403,'DATA_CONSENT_REQUIRED');
 // Tool call ids come from the model provider in any format; evidence keeps only an opaque reference.
 const ref=context.toolCallId?'tool:'+hash(context.toolCallId):id('TOOL');
 const event=type=>services.puma?.evidence.ingest({user_id:user.id,type,occurred_at:now(),source:'agent',initiated_by:'AGENT',correlation_id:context.requestId||ref,resource_ref:ref,consent_scope:'security',evidence_quality:'SUFFICIENT'});
 event('AGENT_TOOL_REQUESTED');
 const result=await executeToolInternal(services,user,name,raw,context);
 assertChannelExecution(services.bank,context,user.id);
 services.guard.assertOpen(user.id);
 event('AGENT_TOOL_COMPLETED');
 return result;
}
async function executeToolInternal(services,user,name,raw,context={}) {
 services.guard.assertOpen(user.id);
 const args=validateArgs(name,raw),{bank}=services;
 assertChannelExecution(bank,context,user.id);
 if(name==='get_finance_risk_summary')return {ok:true,level:'green',data:{simulation:true,flags:services.risk.flags(user)}};
 if(name==='create_transfer_draft')return commitToolEffect(bank,user.id,name,args,context,()=>{
  const draft=services.riskDrafts.create(user,{...args,sourceAccountRef:args.sourceAccountRef||services.accountFor(user).id});
  return {ok:true,level:'yellow',data:draft,event:{type:'risk_draft',data:draft}};
 });
 if(!READ_TOOLS.has(name)) return commitToolEffect(bank,user.id,name,args,context,()=>{
  if(!LOW_RISK_EFFECTS.has(name)){
   const action=services.propose(user,name,args,context);
   return {ok:true,level:action.level,actionId:action.id,data:action,event:{type:action.tool==='create_plan'?'plan':'action',data:action}};
  }
  let data,event;
  if(name==='remember'){
   requireThat(!/pin|password|token|secret|验证码|密码|密钥/i.test(args.key+' '+args.value),'不能将密码或密钥写入记忆');
   data=services.memory.candidate(context.principal||resolvePrincipal(bank,user,context),args,{messageId:context.requestId||context.runId,input:context.input,epoch:context.memoryEpoch,route:context.route});
  }else if(name==='set_reminder')data=services.reminder(user,args);
  else if(name==='handover_to_human'){data=services.handover(user,args.reason,context.sessionId);event={type:'handover',data};}
  else throw new Error('Unregistered effect');
  const decision=services.policyDecision(user,name,args);bank.audit(user.id,'policy.evaluated',context.sessionId||'',{tool:name,decision});
  return {ok:true,level:'green',decision,data:redact(data),...(event?{event}:{})};
 });
 let data,event;
 switch(name){
 case 'get_overview': data=redact(services.state(user).accounts); break;
 case 'get_ledger':{const rows=selectLedger(ledgerFor(bank,user.id).map(enrich),{...(hasRange(args)?resolveRange(args,businessDate()):{}),direction:args.direction,kind:args.kind,category:args.category,keyword:args.keyword});
  const shown=rows.slice(0,args.limit||20).map(r=>({bj_time:r.bj_time,amount:r.amount,title:r.title,tag:r.tag,kind:r.kind,...(r.merchant?{merchant:r.merchant}:{}),...(r.platform?{platform:r.platform}:{})}));
  fits(shown);
  data={total:rows.length,shown:shown.length,rows:shown};break;}
 case 'get_transactions':data=redact(services.state(user).transactions);break;
 case 'get_products_and_holdings':{await services.catalog.ready();const all=services.catalog.list(),meta=services.catalog.meta(),kw=args.keyword?.toLowerCase();
  let rows=all.filter(p=>(!args.category||p.category===args.category)&&(!args.maxRisk||p.riskLevel<=args.maxRisk)&&(!kw||`${p.name}${p.issuer}${p.code||''}`.toLowerCase().includes(kw)));
  if(args.sort==='return')rows=[...rows].sort((a,b)=>(b.rate??-Infinity)-(a.rate??-Infinity));else if(args.sort==='risk')rows=[...rows].sort((a,b)=>a.riskLevel-b.riskLevel);
  const holdings=services.state(user).holdings.map(h=>({id:h.id,productId:h.product_id,name:h.product.name,risk:h.product.risk,principal:h.principal,earnings:h.earnings,value:h.value,unlock_at:h.unlock_at}));
  const shown=fits(rows.slice(0,args.limit||10).map(productBrief),3300-Buffer.byteLength(JSON.stringify(holdings)));
  const counts=Object.fromEntries(Object.entries(Object.groupBy(all,p=>CATEGORY_LABEL[p.category])).map(([k,v])=>[k,v.length]));
  data={catalog:catalogNote(meta),counts,total:rows.length,shown:shown.length,products:shown,holdings};
  event={type:'products',data:{products:rows.slice(0,shown.length),meta,title:'产品列表'}};break;}
 case 'get_credit_card':data=redact(services.state(user).creditCard);break;
 case 'get_loans':data=services.state(user).loans;break;
 case 'get_payees':data=bank.all('SELECT * FROM payees WHERE user_id=?',user.id).map(p=>({recipient:p.id,name:p.name,account:'****'+p.number.slice(-4),bank:p.bank}));break;
 case 'resolve_recipient':requireThat(args.name||args.phone||args.account,'请提供收款人姓名、手机号或账号');data=services.resolveRecipients(user,args);break;
 case 'bill_report':{const report=billReport(ledgerFor(bank,user.id),resolveRange(args,businessDate()));data=compactReport(report);event={type:'report',data:report};break;}
 case 'spending_stats':{const stats=spendingStats(ledgerFor(bank,user.id),resolveRange(args,businessDate()),{by:args.by,kind:args.kind,category:args.category,keyword:args.keyword,limit:args.limit||10});data=compactStats(stats);event={type:'stats',data:{...stats,buckets:['month','week','day','weekday','hour'].includes(stats.by)?stats.buckets:stats.buckets.slice(0,40)}};break;}
 case 'detect_anomalies':data=detectAnomalies(ledgerFor(bank,user.id),hasRange(args)?resolveRange(args,businessDate()):undefined);event={type:'anomalies',data};break;
 case 'wealth_advice':{await services.catalog.ready();const advice=await wealthAdvice(services,user,{amount:args.amount?cents(args.amount):undefined,horizon:args.horizon});data=compactAdvice(advice);event={type:'advice',data:advice};break;}
 case 'compare_products':{await services.catalog.ready();const found=args.ids.map(i=>services.catalog.get(i)).filter(Boolean),meta=services.catalog.meta();
  const detail=fits(found.map(productDetail),3000);
  data={catalog:catalogNote(meta),products:detail,...(detail.length<found.length?{omitted:found.slice(detail.length).map(p=>p.id)}:{}),missing:args.ids.filter(i=>!services.catalog.get(i))};
  event={type:'products',data:{products:found,meta,title:'产品对比'}};break;}
 case 'get_risk_profile':data={level:bank.get('SELECT risk_level FROM users WHERE id=?',user.id).risk_level};break;
 case 'get_scheduled_tasks':data={tasks:services.snapshot(user).scheduledTasks,plans:services.plans(user)};break;
 case 'get_cards':{const s=services.state(user);data={accounts:redact(s.accounts),creditCard:redact(s.creditCard),virtualCards:s.virtualCards,reservations:s.reservations};break;}
 case 'run_analysis':data=await runAnalysis(args.code,{today:businessDate(),ledger:ledgerFor(bank,user.id).map(enrich),transactions:redact(services.state(user).transactions)});assertChannelExecution(bank,context,user.id);bank.audit(user.id,'sandbox.analysis','',{purpose:args.purpose,code:args.code,durationMs:data.durationMs,size:data.size});break;
 case 'recall':data=services.memory.relevant(context.principal||resolvePrincipal(bank,user,context),context.input||'查看我的记忆');break;
 default:throw new Error('Unhandled tool');
 }
 const decision=services.policyDecision(user,name,args);
 bank.audit(user.id,'policy.evaluated',context.sessionId||'',{tool:name,decision});
 return {ok:true,level:'green',decision,data:redact(data),...(event?{event}: {})};
}
