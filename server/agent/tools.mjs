import { validate, redact } from './guard.mjs';
import { READ_TOOLS, LOW_RISK_EFFECTS, businessDate } from './policy.mjs';
import { ledgerFor, enrich, selectLedger, resolveRange, billReport, compactReport, spendingStats, compactStats, detectAnomalies, PRESETS, KIND_LABEL } from './analytics.mjs';
import { runAnalysis } from './sandbox.mjs';
import { id, now, products } from '../db.mjs';
import { requireThat } from '../errors.mjs';
const str=(maxLength=100)=>({type:'string',minLength:1,maxLength});
const money={type:'string',pattern:'^(0|[1-9]\\d{0,8})(\\.\\d{1,2})?$',description:'人民币元字符串，最多2位小数'};
const obj=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const arr=(items,maxItems=20)=>({type:'array',items,minItems:1,maxItems});
const day={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'北京时间日期YYYY-MM-DD'};
const range={preset:{type:'string',enum:Object.keys(PRESETS),description:'相对时段，按北京时间'},period:{type:'string',pattern:'^\\d{4}(-\\d{2}(-\\d{2})?)?$',description:'YYYY年、YYYY-MM月或YYYY-MM-DD日'},from:day,to:day};
const kind={type:'string',enum:Object.keys(KIND_LABEL).filter(k=>k!=='opening')};
const hasRange=a=>Boolean(a.preset||a.period||a.from||a.to);
const STATS_BY=['category','merchant','platform','month','week','day','weekday','hour'];
const definitions={
 get_overview:['查询本人账户余额与可用资金',obj()],
 get_ledger:['查询本人流水明细，返回{total,shown,rows}；行含bj_time北京时间（只有日期表示原对账单无时间）、amount整数分、title、tag分类、kind类型（consumption消费/refund退款/income收入/transfer_out转账给他人/self本人账户互转/wallet充值提现/investment理财存款/debt信用卡贷款/opening期初余额）、merchant商户、platform支付平台。时段用preset/period/from+to，不传为全部；keyword匹配摘要、对方、商户与附言。只需汇总时用bill_report或spending_stats',obj({...range,direction:{enum:['income','expense'],type:'string'},kind,category:str(20),keyword:str(),limit:{type:'integer',minimum:1,maximum:50}})],
 get_transactions:['查询本人交易状态',obj()],
 get_products_and_holdings:['查询产品目录、风险说明与本人持仓',obj()],
 get_credit_card:['查询本人信用卡',obj()],get_loans:['查询本人贷款',obj()],get_payees:['查询本人收款人簿（脱敏）',obj()],
 resolve_recipient:['按姓名、手机号、账号查找收款人；返回脱敏候选，用recipient字段提议转账；多候选必须询问用户',obj({name:str(40),phone:str(19),account:str(19)})],
 bill_report:['生成账单报告，不传参数为本月。日报用period=YYYY-MM-DD或preset=today/yesterday，周报this_week/last_week，月报YYYY-MM或this_month/last_month，年报YYYY，也可任意from+to。返回消费（已扣退款）、转账给他人、收入、消费分类占比、商户Top5、收入来源、不计入消费的本人互转/充值提现/理财、趋势、环比与数据覆盖范围；本工具金额单位为元',obj(range)],spending_stats:['按维度统计，默认本月消费（已扣退款）。by：category分类/merchant商户/platform支付平台/month按月/week按周/day按日/weekday按星期/hour按小时；category只看某分类（如餐饮美食），keyword按商户关键词（如美团），kind可改为income/transfer_out等。时段参数同bill_report；本工具金额单位为元',obj({...range,by:{type:'string',enum:STATS_BY},kind,category:str(20),keyword:str(40),limit:{type:'integer',minimum:1,maximum:31}},['by'])],detect_anomalies:['检测异常支出（大额、深夜、首次大额、24小时同额重复），仅为模拟规则提示；可选时段，不传为全部流水',obj(range)],list_subscriptions:['提议查询本人订阅与周期扣费明细，黄色确认前只返回查询范围',obj()],
 compare_products:['对比产品（不承诺收益）',obj({ids:arr(str(),8)},['ids'])],get_risk_profile:['查询风险测评结果',obj()],get_scheduled_tasks:['查询计划与定时任务',obj()],get_cards:['查询卡片、虚拟卡、锁定资金',obj()],
 run_analysis:['只读沙箱统计，data含today（北京时间日期）、本人全部ledger（含kind、tag、bj_time及导入明细字段，金额整数分）和transactions。代码需return结果，无网络/文件访问，1秒限时',obj({purpose:str(200),code:str(12000)},['purpose','code'])],
 remember:['用户明确要求记住的偏好或日期，不保存任何密码/验证码/密钥',obj({key:str(60),value:str(300)},['key','value'])],recall:['读取本人主动保存的记忆',obj()],
 propose_transfer:['提议转账，必须使用resolve_recipient返回的recipient，确认前不会扣款',obj({recipient:str(),amount:money,note:str(100),scheduleAt:str(40)},['recipient','amount'])],
 propose_payment:['提议缴费或模拟商户消费',obj({billType:{type:'string',enum:['water','electricity','gas','mobile','broadband','property','scan','merchant']},billNumber:str(30),merchant:str(50),amount:money},['billType','amount'])],
 propose_split:['提议AA收款，people为收款请求接收者的recipient，每人均分total，生成银行内收款链接',obj({total:money,people:arr(str(),20),note:str(100)},['total','people'])],
 propose_subscribe_product:['提议申购理财或定期，需要风险匹配和App强验证',obj({productId:str(),amount:money},['productId','amount'])],
 propose_redeem:['提议赎回本人持仓',obj({holdingId:str(),amount:money},['holdingId','amount'])],
 propose_loan_draw:['提议贷款提款',obj({amount:money,months:{type:'integer',enum:[3,6,12,24]}},['amount'])],
 propose_loan_repay:['提议归还贷款本金',obj({loanId:str(),amount:money},['loanId','amount'])],propose_credit_repay:['提议信用卡还款',obj({amount:money},['amount'])],
 propose_card_action:['提议卡片冻结/解冻/挂失/解挂，card为卡片ID',obj({card:str(),action:{type:'string',enum:['freeze','unfreeze','report_lost','unlost']}},['card','action'])],
 propose_virtual_card:['提议开通模拟虚拟卡，limit为元',obj({limit:money},['limit'])],propose_set_daily_limit:['提议修改转账日限额',obj({amount:money},['amount'])],
 propose_cancel_subscription:['提议取消已授权订阅代扣',obj({id:str()},['id'])],propose_lock_funds:['提议锁定本人活期资金至until日期',obj({amount:money,purpose:str(100),until:str(40)},['amount','purpose','until'])],
 set_reminder:['自动设置站内提醒（不支付任何费用）',obj({at:str(40),text:str(300)},['at','text'])],
 handover_to_human:['创建模拟人工工单，停止本会话后续自动工具调用',obj({reason:str(1000)},['reason'])],
};
const stepArgs=Object.assign({},...Object.entries(definitions).filter(([k])=>k.startsWith('propose_')||k==='set_reminder').map(([,v])=>v[1].properties));
definitions.create_plan=['建立待一次确认的DAG计划；最多12步，tool只可为propose工具或set_reminder，runAt为ISO时间，dependsOn是步骤ID。生日安排先询问或明确展示花费、日期、商户与依赖。',obj({title:str(100),steps:arr(obj({id:str(40),title:str(100),tool:{type:'string',enum:Object.keys(definitions).filter(k=>k.startsWith('propose_')||k==='set_reminder')},args:obj(stepArgs),dependsOn:{type:'array',items:str(40),maxItems:12},runAt:str(40)},['id','title','tool','args']),12)},['title','steps'])];
export const toolDefinitions=Object.entries(definitions).map(([name,[description,parameters]])=>({type:'function',function:{name,description,parameters}}));
export function validateArgs(name,args) {
 requireThat(definitions[name],'未知工具',400,'UNKNOWN_TOOL');
 const clean=validate(definitions[name][1],args);
 if(name==='create_plan')clean.steps=clean.steps.map(s=>({...s,args:validateArgs(s.tool,s.args),dependsOn:s.dependsOn||[]}));
 return clean;
}
export async function executeTool(services,user,name,raw,context={}) {
 services.guard.assertOpen(user.id);
 const args=validateArgs(name,raw),{bank}=services;
 if(!READ_TOOLS.has(name) && !LOW_RISK_EFFECTS.has(name)){
  const action=services.propose(user,name,args,context);
  return {ok:true,level:action.level,actionId:action.id,data:action,event:{type:action.tool==='create_plan'?'plan':'action',data:action}};
 }
 let data,event;
 switch(name){
 case 'get_overview': data=redact(services.state(user).accounts); break;
 case 'get_ledger':{const rows=selectLedger(ledgerFor(bank,user.id).map(enrich),{...(hasRange(args)?resolveRange(args,businessDate()):{}),direction:args.direction,kind:args.kind,category:args.category,keyword:args.keyword});
  const shown=rows.slice(0,args.limit||20).map(r=>({bj_time:r.bj_time,amount:r.amount,title:r.title,tag:r.tag,kind:r.kind,...(r.merchant?{merchant:r.merchant}:{}),...(r.platform?{platform:r.platform}:{})}));
  while(shown.length&&Buffer.byteLength(JSON.stringify(shown))>3300)shown.pop(); // tool messages over 4096 bytes are truncated
  data={total:rows.length,shown:shown.length,rows:shown};break;}
 case 'get_transactions':data=redact(services.state(user).transactions);break;
 case 'get_products_and_holdings':data={products,holdings:services.state(user).holdings};event={type:'products',data};break;
 case 'get_credit_card':data=redact(services.state(user).creditCard);break;
 case 'get_loans':data=services.state(user).loans;break;
 case 'get_payees':data=bank.all('SELECT * FROM payees WHERE user_id=?',user.id).map(p=>({recipient:p.id,name:p.name,account:'****'+p.number.slice(-4),bank:p.bank}));break;
 case 'resolve_recipient':requireThat(args.name||args.phone||args.account,'请提供收款人姓名、手机号或账号');data=services.resolveRecipients(user,args);break;
 case 'bill_report':{const report=billReport(ledgerFor(bank,user.id),resolveRange(args,businessDate()));data=compactReport(report);event={type:'report',data:report};break;}
 case 'spending_stats':{const stats=spendingStats(ledgerFor(bank,user.id),resolveRange(args,businessDate()),{by:args.by,kind:args.kind,category:args.category,keyword:args.keyword,limit:args.limit||10});data=compactStats(stats);event={type:'stats',data:{...stats,buckets:['month','week','day','weekday','hour'].includes(stats.by)?stats.buckets:stats.buckets.slice(0,40)}};break;}
 case 'detect_anomalies':data=detectAnomalies(ledgerFor(bank,user.id),hasRange(args)?resolveRange(args,businessDate()):undefined);event={type:'anomalies',data};break;
 case 'compare_products':data={products:products.filter(p=>args.ids.includes(p.id)),holdings:[]};event={type:'products',data};break;
 case 'get_risk_profile':data={level:bank.get('SELECT risk_level FROM users WHERE id=?',user.id).risk_level};break;
 case 'get_scheduled_tasks':data={tasks:services.snapshot(user).scheduledTasks,plans:services.plans(user)};break;
 case 'get_cards':{const s=services.state(user);data={accounts:redact(s.accounts),creditCard:redact(s.creditCard),virtualCards:s.virtualCards,reservations:s.reservations};break;}
 case 'run_analysis':data=await runAnalysis(args.code,{today:businessDate(),ledger:ledgerFor(bank,user.id).map(enrich),transactions:redact(services.state(user).transactions)});bank.audit(user.id,'sandbox.analysis','',{purpose:args.purpose,code:args.code,durationMs:data.durationMs,size:data.size});break;
 case 'remember':requireThat(!/pin|password|token|secret|验证码|密码|密钥/i.test(args.key+' '+args.value),'不能将密码或密钥写入记忆');bank.run('INSERT INTO agent_memory VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',user.id,args.key,args.value,now());bank.audit(user.id,'agent.memory_saved','',{key:args.key});data={saved:true,key:args.key};break;
 case 'recall':data=bank.all('SELECT key,value FROM agent_memory WHERE user_id=?',user.id);break;
 case 'set_reminder':data=services.reminder(user,args);break;
 case 'handover_to_human':data=services.handover(user,args.reason,context.sessionId);event={type:'handover',data};break;
 default:throw new Error('Unhandled tool');
 }
 const decision=services.policyDecision(user,name,args);
 bank.audit(user.id,'policy.evaluated',context.sessionId||'',{tool:name,decision});
 return {ok:true,level:'green',decision,data:redact(data),...(event?{event}: {})};
}
