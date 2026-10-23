import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { businessDate } from '../agent/policy.mjs';
import { ledgerFor, resolveRange, billReport, detectAnomalies, utcBounds, addDays, isUnknownTag } from '../agent/analytics.mjs';
import { redactIdentity } from '../privacy.mjs';
import { channelNames } from './preferences.mjs';

export const REPORT_KINDS=['daily','weekly','monthly'];
export const REPORT_DELIVERY_MS=12*3600000;
export const UNSUBSCRIBE=/^退订(日报|周报|月报|账单(?:推送)?)$/;
const NAMES={daily:'日报',weekly:'周报',monthly:'月报'},KIND_OF={日报:'daily',周报:'weekly',月报:'monthly'},CHANNEL_NAMES={feishu:'飞书',wechat:'微信'};
const PRESET={daily:'yesterday',weekly:'last_week',monthly:'last_month'},PREVIOUS={daily:'前一天',weekly:'前一周'};
const DAY=86400000,SEND_HOUR=8,WEEK='一二三四五六日';

// Reports go out at 08:00 Beijing time: daily ones every day, weekly ones on Mondays, monthly ones on the 1st.
const slotOn=date=>new Date(Date.parse(utcBounds({from:date,to:date})[0])+SEND_HOUR*3600000).toISOString();
const sendsOn=(kind,date)=>kind==='daily'||(kind==='weekly'?new Date(date+'T00:00:00Z').getUTCDay()===1:date.endsWith('-01'));
export function nextSlot(kind,after){for(let d=businessDate(after);;d=addDays(d,1))if(sendsOn(kind,d)&&Date.parse(slotOn(d))>Date.parse(after))return slotOn(d);}
export function latestSlot(kind,at){for(let d=businessDate(at);;d=addDays(d,-1))if(sendsOn(kind,d)&&Date.parse(slotOn(d))<=Date.parse(at))return slotOn(d);}
// Each slot reports the period that has just closed: yesterday, last week or last month.
export const slotRange=(kind,slot)=>resolveRange({preset:PRESET[kind]},businessDate(slot));
export const reportLink=(origin,from,to)=>`${origin||''}/#bill-report?from=${from}&to=${to}`;
// A day's anomalies are judged against the preceding 90 days, so a monthly rent is not a first-time merchant.
export const reportAnomalies=(rows,range)=>detectAnomalies(rows,range,{from:addDays(range.from,-90),to:range.to});

const money=cents=>`${cents<0?'-':''}¥${(Math.abs(cents)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const percent=share=>share>0&&share<0.01?'<1%':`${Math.round(share*100)}%`;
const monthDay=date=>`${+date.slice(5,7)}月${+date.slice(8,10)}日`;
function title(kind,range){
  if(kind==='daily')return `【日报】${monthDay(range.from)}（周${WEEK[(new Date(range.from+'T00:00:00Z').getUTCDay()+6)%7]}）`;
  return kind==='weekly'?`【周报】${monthDay(range.from)}—${monthDay(range.to)}`:`【月报】${range.from.slice(0,4)}年${+range.from.slice(5,7)}月`;
}
// Amounts are written as ¥1,234.56 so the channel's hide-amounts setting can mask them when the message is sent.
export function reportMessage(report,anomalies,{kind,channel,origin=''}){
  const t=report.totals,plain=channel==='wechat',lines=[plain?title(kind,report):`**${title(kind,report)}**`];
  if(!t.count)lines.push(`${kind==='daily'?'当天':'本期'}没有收支记录。`);
  else {
    lines.push(`消费 ${money(t.consumption)}（${t.consumptionCount}笔${t.refunds?`，已扣退款 ${money(t.refunds)}`:''}）`,`收入 ${money(t.income)}`);
    if(t.transferOut)lines.push(`转账给他人 ${money(t.transferOut)}`);
    if(kind==='monthly')lines.push(`日均消费 ${money(t.dailyAverage)}`);
    const previous=report.previous;
    if(previous&&previous.change!==null){const diff=t.consumption-previous.consumption;lines.push(`比${PREVIOUS[kind]||`${+previous.from.slice(5,7)}月`}${diff>=0?'多':'少'}消费 ${money(Math.abs(diff))}（${diff>=0?'+':'-'}${percent(Math.abs(previous.change))}）`);}
    const top=report.categories.filter(c=>c.amount>0).slice(0,5);
    if(top.length)lines.push(plain?['消费分类：',...top.map((c,i)=>`${i+1}. ${c.name} ${money(c.amount)}（${percent(c.share)}）`)].join('\n'):['','| 消费分类 | 金额 | 占比 |','| --- | --- | --- |',...top.map(c=>`| ${c.name} | ${money(c.amount)} | ${percent(c.share)} |`),''].join('\n'));
    const unknown=top.filter(c=>isUnknownTag(c.name)).map(c=>c.name);
    if(unknown.length)lines.push(`${unknown.join('、')}只显示支付平台，看不到具体商户`);
    if(kind!=='daily'&&report.topMerchants.length)lines.push(`消费最多的商户：${report.topMerchants.slice(0,3).map(m=>`${m.name} ${money(m.amount)}`).join('、')}`);
    const outside=report.excluded.filter(e=>e.out).map(e=>`${e.name} ${money(e.out)}`);
    if(outside.length)lines.push(`不计入消费：${outside.join('、')}`);
    if(anomalies.length)lines.push(['异常支出提醒：',...anomalies.slice(0,3).map(a=>`${plain?'·':'-'} ${kind==='daily'?a.bj_time.slice(11)||'当天':`${monthDay(a.bj_time)}${a.bj_time.slice(10)}`} ${a.title} ${money(-a.amount)}：${a.reasons.join('、')}`)].join('\n'));
  }
  if(report.coverage.partial&&report.coverage.last)lines.push(`流水只到${monthDay(report.coverage.last)}`);
  lines.push('',origin?`查看完整账单图表：${reportLink(origin,report.from,report.to)}`:'完整账单请在澄川银行App「交易记录」查看',`回复「退订${NAMES[kind]}」停止推送`);
  return redactIdentity(lines.join('\n'));
}
// IM command: turns off this channel's reports at once, without the model and even while the assistant is closed.
export function unsubscribeCommand(bank,binding,text){
  const match=String(text).trim().match(UNSUBSCRIBE);if(!match)return null;
  const kinds=KIND_OF[match[1]]?[KIND_OF[match[1]]]:REPORT_KINDS;
  bank.atomic(()=>{
    for(const kind of kinds)bank.run('UPDATE report_subscriptions SET enabled=0,next_at=NULL,updated_at=? WHERE user_id=? AND channel=? AND kind=?',now(),binding.user_id,binding.channel,kind);
    bank.audit(binding.user_id,'channel.report_updated',binding.channel,{...Object.fromEntries(kinds.map(kind=>[kind,false])),source:binding.channel});
  });
  return `已退订${CHANNEL_NAMES[binding.channel]}${kinds.length>1?'全部账单推送':NAMES[kinds[0]]}，可在澄川银行App「消息渠道绑定」重新开通。`;
}
export function reportDeliveryNotice(bank,origin,outboxId,channel){
  const push=outboxId&&bank.get('SELECT kind,period_from,period_to FROM report_pushes WHERE outbox_id=?',outboxId);
  return push?{title:'账单推送未确认送达',body:`${CHANNEL_NAMES[channel]}${NAMES[push.kind]}暂时无法确认送达，可在App查看：${reportLink(origin,push.period_from,push.period_to)}`}:null;
}

// Due subscriptions are found through one index and generated in short slices; nothing is scheduled per user.
export function createReportPush(services,options={}){
  const {bank}=services,{get,all,run,atomic,audit,notify}=bank;
  const origin=()=>options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
  let resume=null,pruned=0;
  const binding=(userId,channel)=>get("SELECT * FROM channel_bindings WHERE user_id=? AND channel=? AND status='active' AND auth_state='valid' ORDER BY created_at DESC LIMIT 1",userId,channel);
  function blocked(sub,b){
    if(!services.enrollment.available(sub.user_id))return 'assistant_unavailable';
    if(services.guard.locked(sub.user_id))return 'assistant_locked';
    if(!b)return 'binding_unavailable';
    // WeChat can only push with the context of the user's latest message.
    return sub.channel==='wechat'&&!b.context_token?'no_context':null;
  }
  function contextNotice(userId,b){
    const resource=`${b.id}:${b.binding_generation}`;
    if(get("SELECT 1 FROM audit WHERE action='report.context_notice' AND resource_id=?",resource))return;
    notify(userId,'微信账单推送未发送','微信需要先收到你的一条消息，才能向你推送账单。请在微信里给助手发一句“你好”，之后会按时推送。');audit(userId,'report.context_notice',resource);
  }
  // Only the latest slot is sent, and only within a day of it; older slots are not made up later.
  function push(sub,at,ledgers,reports){
    const slot=latestSlot(sub.kind,at),range=slotRange(sub.kind,slot),period=`${range.from}~${range.to}`,b=binding(sub.user_id,sub.channel);
    const reason=Date.parse(at)-Date.parse(slot)>DAY?'late':blocked(sub,b);
    let body=null;
    if(!reason){
      const key=`${sub.user_id}:${period}`;
      if(!reports.has(key)){if(!ledgers.has(sub.user_id))ledgers.set(sub.user_id,ledgerFor(bank,sub.user_id));const rows=ledgers.get(sub.user_id);reports.set(key,{report:billReport(rows,range),anomalies:reportAnomalies(rows,range)});}
      const {report,anomalies}=reports.get(key);body=reportMessage(report,anomalies,{kind:sub.kind,channel:sub.channel,origin:origin()});
    }
    return atomic(()=>{
      if(!get('SELECT 1 FROM report_subscriptions WHERE user_id=? AND channel=? AND kind=? AND enabled=1 AND next_at=?',sub.user_id,sub.channel,sub.kind,sub.next_at))return false;
      run('UPDATE report_subscriptions SET next_at=? WHERE user_id=? AND channel=? AND kind=?',nextSlot(sub.kind,at),sub.user_id,sub.channel,sub.kind);
      const pushId=id('RPT'),outboxId=body?id('OUT'):null,status=reason==='late'?'missed':reason?'skipped':'queued';
      // One row per channel, report and period: a restart or a changed schedule cannot send the same period twice.
      if(!run('INSERT OR IGNORE INTO report_pushes(id,user_id,channel,kind,period_key,period_from,period_to,slot_at,status,reason,binding_id,outbox_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',pushId,sub.user_id,sub.channel,sub.kind,period,range.from,range.to,slot,status,reason,b?.id||null,outboxId,now()).changes)return false;
      if(body)run("INSERT INTO channel_outbox(id,binding_id,body,next_at,binding_generation,binding_session_id,kind) VALUES(?,?,?,?,?,?,'report')",outboxId,b.id,body,now(),b.binding_generation,b.binding_session_id);
      if(reason==='no_context')contextNotice(sub.user_id,b);
      audit(sub.user_id,body?'report.queued':'report.skipped',pushId,{channel:sub.channel,kind:sub.kind,period,...(reason?{reason}:{})});
      return Boolean(body);
    });
  }
  function runDue(at=now(),{budgetMs=options.budgetMs??200}={}){
    at=new Date(at).toISOString();
    const started=Date.now(),ledgers=new Map(),reports=new Map(),seen=new Set();let queued=0;
    if(Date.now()-pruned>DAY){pruned=Date.now();run('DELETE FROM report_pushes WHERE created_at<?',new Date(pruned-400*DAY).toISOString());}
    try{
      for(;;){
        const rows=all('SELECT * FROM report_subscriptions WHERE enabled=1 AND next_at<=? ORDER BY next_at,user_id LIMIT 100',at).filter(s=>!seen.has(`${s.user_id}:${s.channel}:${s.kind}`));
        if(!rows.length)return;
        for(const sub of rows){
          seen.add(`${sub.user_id}:${sub.channel}:${sub.kind}`);
          try{if(push(sub,at,ledgers,reports))queued++;}
          catch(error){
            console.warn('Bill report could not be generated:',error.code||error.message);
            run('UPDATE report_subscriptions SET next_at=? WHERE user_id=? AND channel=? AND kind=? AND next_at=?',nextSlot(sub.kind,at),sub.user_id,sub.channel,sub.kind,sub.next_at);
          }
          // Yield after each slice so requests are not held up; the rest continues right after.
          if(Date.now()-started>=budgetMs){resume??=setImmediate(()=>{resume=null;try{runDue();}catch(error){console.warn('Bill report push stopped:',error.message);}});return;}
        }
      }
    }finally{if(queued)options.kick?.();}
  }
  function lastPush(userId,channel,kind){
    const row=get('SELECT * FROM report_pushes WHERE user_id=? AND channel=? AND kind=? ORDER BY slot_at DESC,created_at DESC LIMIT 1',userId,channel,kind);
    if(!row)return null;
    const delivery=row.outbox_id&&(get(`SELECT status FROM ${channel==='feishu'?'feishu_deliveries':'wechat_deliveries'} WHERE source_outbox_id=?`,row.outbox_id)?.status||get('SELECT status FROM channel_outbox WHERE id=?',row.outbox_id)?.status);
    const state=row.status!=='queued'?row.status:delivery==='api_accepted'?'sent':delivery==='unknown'?'unknown':['failed','expired','cancelled'].includes(delivery)?'failed':'sending';
    return {from:row.period_from,to:row.period_to,slotAt:row.slot_at,state,reason:row.reason};
  }
  function settings(userId){
    const rows=all('SELECT * FROM report_subscriptions WHERE user_id=?',userId);
    return Object.fromEntries(channelNames.map(channel=>{
      const b=binding(userId,channel);
      return [channel,{bound:Boolean(b),ready:Boolean(b)&&(channel!=='wechat'||Boolean(b.context_token)),...Object.fromEntries(REPORT_KINDS.map(kind=>{
        const s=rows.find(r=>r.channel===channel&&r.kind===kind);
        return [kind,{enabled:Boolean(s?.enabled),nextAt:s?.enabled?s.next_at:null,last:lastPush(userId,channel,kind)}];
      }))}];
    }));
  }
  // Choices are kept per user and channel like hide-amounts; turning one on needs the assistant, turning off never does.
  function update(user,channel,body){
    requireThat(channelNames.includes(channel),'不支持的消息渠道',400,'INVALID_CHANNEL');
    const input=body&&typeof body==='object'?body:{},changes=REPORT_KINDS.filter(kind=>input[kind]!==undefined);
    requireThat(changes.length&&changes.every(kind=>typeof input[kind]==='boolean'),'账单推送设置必须为布尔值',400,'INVALID_CHANNEL_SETTING');
    if(changes.some(kind=>input[kind]))services.enrollment.assertEnabled(user.id);
    atomic(()=>{
      for(const kind of changes)run(`INSERT INTO report_subscriptions(user_id,channel,kind,enabled,next_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,channel,kind) DO UPDATE SET
        next_at=CASE WHEN report_subscriptions.enabled=1 AND excluded.enabled=1 THEN report_subscriptions.next_at ELSE excluded.next_at END,enabled=excluded.enabled,updated_at=excluded.updated_at`,user.id,channel,kind,input[kind]?1:0,input[kind]?nextSlot(kind,now()):null,now());
      audit(user.id,'channel.report_updated',channel,Object.fromEntries(changes.map(kind=>[kind,input[kind]])));
    });
    return settings(user.id)[channel];
  }
  function routes(route){
    route('get','/channels/reports','本人各渠道账单推送设置',(req,res)=>res.json(settings(req.user.id)));
    route('patch','/channels/reports/:channel','开关本人单个渠道的日报、周报、月报推送',(req,res)=>res.json(update(req.user,req.params.channel,req.body)));
  }
  return {runDue,settings,update,routes,stop(){clearImmediate(resume);resume=null;}};
}
