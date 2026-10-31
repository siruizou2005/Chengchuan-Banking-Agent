import test from 'node:test';
import assert from 'node:assert/strict';
import { backup } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { billReport } from '../server/agent/analytics.mjs';
import { businessDate } from '../server/agent/policy.mjs';
import { needsFeishuCard } from '../server/channels/feishu.mjs';
import { maskMoney } from '../server/channels/preferences.mjs';
import { nextSlot,latestSlot,slotRange,reportMessage,reportAnomalies } from '../server/channels/reports.mjs';
import { fixture,feishuContentText } from './helpers.mjs';
import { wechatFixture } from './wechat-helpers.mjs';

const HOUR=3600000,DAY=24*HOUR,shift=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();
const money=cents=>`¥${(cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
// The slot that reports today (Beijing), so rows written now fall inside its period.
const todaySlot=()=>nextSlot('daily',`${businessDate()}T00:00:00.000Z`);
function spend(f,title,amount,at=new Date().toISOString()){
  const account=f.bank.get("SELECT id FROM accounts WHERE user_id=? AND type='debit'",f.user.id).id;
  f.bank.run('INSERT INTO ledger(transaction_id,account_id,amount,balance_after,title,category,created_at) VALUES(?,?,?,?,?,?,?)','report-test',account,-amount,0,title,'merchant',at);
}
async function feishu(t){
  const sent=[];
  const sdk={LoggerLevel:{warn:2},Client:class{im={v1:{message:{create:async arg=>{sent.push({type:arg.data.msg_type,text:feishuContentText(arg.data.content)});return {code:0,data:{message_id:'m'+sent.length}};}}}}},WSClient:class{start(){}close(){}},EventDispatcher:class{register(){return this;}}};
  const f=await fixture(t,{channels:{publicOrigin:'https://bank.test',feishu:{appId:'test',appSecret:'test',sdk},feishuPipeline:{feedback:false}}});await f.channels.start();
  const bind=()=>f.channels.router.bind('feishu','fs-owner',f.channels.router.createCode(f.user,'123456').code);
  const due=(kind,at)=>f.bank.run('UPDATE report_subscriptions SET next_at=? WHERE user_id=? AND kind=? AND enabled=1',at,f.user.id,kind);
  const run=async at=>{f.channels.reports.runDue(at,{budgetMs:Infinity});await f.channels.flush();};
  return {...f,sent,bind,due,run};
}

test('推送时刻与账期按北京时间8:00计算',()=>{
  assert.equal(nextSlot('daily','2026-10-23T23:59:00.000Z'),'2026-10-24T00:00:00.000Z');
  assert.equal(nextSlot('daily','2026-10-24T00:00:00.000Z'),'2026-10-25T00:00:00.000Z');
  assert.equal(latestSlot('daily','2026-10-23T23:59:00.000Z'),'2026-10-23T00:00:00.000Z');
  assert.equal(latestSlot('daily','2026-10-24T00:00:00.000Z'),'2026-10-24T00:00:00.000Z');
  // Sunday 23:30 Beijing is 15:30 UTC; the weekly slot is the next morning, a Monday.
  assert.equal(nextSlot('weekly','2026-10-25T15:30:00.000Z'),'2026-10-26T00:00:00.000Z');
  assert.equal(nextSlot('weekly','2026-10-26T00:00:00.000Z'),'2026-11-02T00:00:00.000Z');
  assert.equal(latestSlot('weekly','2026-10-25T23:59:00.000Z'),'2026-10-19T00:00:00.000Z');
  assert.equal(nextSlot('monthly','2026-12-15T00:00:00.000Z'),'2027-01-01T00:00:00.000Z');
  assert.equal(latestSlot('monthly','2026-10-31T23:59:00.000Z'),'2026-10-01T00:00:00.000Z');
  const period=(kind,slot)=>{const r=slotRange(kind,slot);return `${r.from}~${r.to}`;};
  assert.equal(period('daily','2026-10-24T00:00:00.000Z'),'2026-10-23~2026-10-23');
  assert.equal(period('daily','2027-01-01T00:00:00.000Z'),'2026-12-31~2026-12-31');
  assert.equal(period('weekly','2026-10-26T00:00:00.000Z'),'2026-10-19~2026-10-25');
  assert.equal(period('monthly','2027-01-01T00:00:00.000Z'),'2026-12-01~2026-12-31');
  assert.equal(period('monthly','2028-03-01T00:00:00.000Z'),'2028-02-01~2028-02-29');
});

test('报告正文只用确定性统计：飞书表格转卡片，微信纯文本，隐藏金额后保留日期、占比和链接',()=>{
  const row=(id,created_at,amount,title,category='merchant')=>({id,created_at,amount,title,category});
  const rows=[row('l0','2026-09-01T04:00:00.000Z',-100,'便利店'),row('l1','2026-10-21T04:00:00.000Z',-10000,'美团外卖'),row('l2','2026-10-22T04:00:00.000Z',-12800,'美团外卖'),
    row('l3','2026-10-22T10:00:00.000Z',-4500,'滴滴出行'),row('l4','2026-10-21T18:13:00.000Z',-128000,'陌生商户'),row('l5','2026-10-22T06:00:00.000Z',-20000,'转账给陈屿','transfer'),row('l6','2026-10-22T02:00:00.000Z',500000,'工资','transfer')];
  const range=slotRange('daily','2026-10-23T00:00:00.000Z'),report=billReport(rows,range),anomalies=reportAnomalies(rows,range);
  const options={kind:'daily',origin:'https://bank.test'},fs=reportMessage(report,anomalies,{...options,channel:'feishu'}),wx=reportMessage(report,anomalies,{...options,channel:'wechat'});
  assert.ok(fs.startsWith('**【日报】10月22日（周四）**'));assert.ok(needsFeishuCard(fs));
  for(const text of ['消费 ¥1,453.00（3笔）','收入 ¥5,000.00','转账给他人 ¥200.00','比前一天多消费 ¥1,353.00（+1353%）','| 其他消费 | ¥1,280.00 | 88% |','- 02:13 陌生商户 ¥1,280.00：深夜交易（北京时间）、陌生商户或首次大额支出','https://bank.test/#bill-report?from=2026-10-22&to=2026-10-22','回复「退订日报」停止推送'])assert.ok(fs.includes(text),text);
  assert.ok(!needsFeishuCard(wx));assert.doesNotMatch(wx,/\*\*/);assert.ok(wx.includes('1. 其他消费 ¥1,280.00（88%）'));assert.ok(wx.includes('· 02:13 陌生商户'));
  const masked=maskMoney(wx);
  assert.doesNotMatch(masked,/¥\d|1,453|1,280|5,000/);for(const kept of ['10月22日','88%','+1353%','02:13','https://bank.test/#bill-report?from=2026-10-22&to=2026-10-22'])assert.ok(masked.includes(kept),kept);
  // A monthly rent paid every month is not a first-time merchant: anomalies look back 90 days.
  assert.equal(reportAnomalies([...rows,row('r1','2026-09-22T04:00:00.000Z',-150000,'房租'),row('r2','2026-10-22T05:00:00.000Z',-150000,'房租')],range).filter(a=>a.title==='房租').length,0);
  const weekly=reportMessage(billReport(rows,slotRange('weekly','2026-10-26T00:00:00.000Z')),[],{kind:'weekly',channel:'wechat'});
  assert.ok(weekly.startsWith('【周报】10月19日—10月25日'));assert.ok(weekly.includes('消费最多的商户：陌生商户 ¥1,280.00、美团外卖 ¥228.00、滴滴出行 ¥45.00'));assert.ok(weekly.includes('完整账单请在澄川银行App「交易记录」查看'));
  const monthly=reportMessage(billReport(rows,slotRange('monthly','2026-11-01T00:00:00.000Z')),[],{kind:'monthly',channel:'feishu'});
  assert.ok(monthly.startsWith('**【月报】2026年10月**'));assert.ok(monthly.includes('日均消费 ¥50.10'));assert.match(monthly,/比9月多消费/);
  const empty=reportMessage(billReport(rows,{...range,from:'2026-10-10',to:'2026-10-10'}),[],{...options,channel:'wechat'});
  assert.ok(empty.includes('当天没有收支记录。'));assert.ok(!empty.includes('消费分类'));assert.ok(empty.includes('回复「退订日报」停止推送'));
});

test('飞书日报按时推送一次，数字与App账单一致，重开同一期不重发，隐藏金额生效',async t=>{
  const f=await feishu(t);f.bind();
  let settings=(await f.call('/channels/reports')).data;
  assert.equal(settings.feishu.bound,true);assert.equal(settings.feishu.daily.enabled,false);assert.equal(settings.wechat.bound,false);
  for(const [path,body] of [['/channels/reports/feishu',{daily:'true'}],['/channels/reports/feishu',{}],['/channels/reports/sms',{daily:true}]])assert.equal((await f.call(path,body,'PATCH')).status,400);
  assert.equal((await f.req('/channels/reports/feishu',{daily:true},undefined,'PATCH')).status,401);
  settings=(await f.call('/channels/reports/feishu',{daily:true},'PATCH')).data;assert.equal(settings.daily.enabled,true);assert.equal(settings.daily.nextAt,nextSlot('daily',new Date().toISOString()));
  assert.equal((await f.req('/channels/reports',undefined,f.bob.token)).data.feishu.daily.enabled,false);
  spend(f,'美团外卖',12345);const slot=todaySlot(),range=slotRange('daily',slot);f.due('daily',slot);
  await f.run(shift(slot,-60000));assert.equal(f.sent.length,0);
  await f.run(slot);assert.equal(f.sent.length,1);
  const {report}=(await f.call(`/ledger/report?from=${range.from}&to=${range.to}`)).data;assert.ok(report.totals.consumption>=12345);
  assert.equal(f.sent[0].type,'interactive');
  for(const text of ['【日报】',`消费 ${money(report.totals.consumption)}`,`收入 ${money(report.totals.income)}`,`https://bank.test/#bill-report?from=${range.from}&to=${range.to}`])assert.ok(f.sent[0].text.includes(text),text);
  await f.run(slot);await f.run(shift(slot,HOUR));assert.equal(f.sent.length,1);
  // Switching off and on again within the same slot cannot send that period twice.
  await f.call('/channels/reports/feishu',{daily:false},'PATCH');await f.call('/channels/reports/feishu',{daily:true},'PATCH');f.due('daily',slot);await f.run(shift(slot,2*HOUR));assert.equal(f.sent.length,1);
  assert.equal((await f.call('/channels/reports')).data.feishu.daily.last.state,'sent');
  spend(f,'滴滴出行',4500,shift(new Date().toISOString(),DAY));
  await f.call('/channels/preferences/feishu',{maskAmounts:true},'PATCH');const next=nextSlot('daily',slot);await f.run(next);
  assert.equal(f.sent.length,2);assert.doesNotMatch(f.sent[1].text,/¥\d/);assert.match(f.sent[1].text,/¥\*\*\*\*/);
  // A period without any rows still gets a short note.
  const later=nextSlot('daily','2030-06-15T00:00:00.000Z');f.due('daily',later);await f.run(later);assert.match(f.sent[2].text,/没有收支记录/);
});

test('解绑、退订、关闭智能助手后不再推送，重新绑定按原选择继续',async t=>{
  const f=await feishu(t);let binding=f.bind();await f.call('/channels/reports/feishu',{daily:true},'PATCH');
  const s0=todaySlot(),s1=nextSlot('daily',s0),s2=nextSlot('daily',s1),s3=nextSlot('daily',s2);f.due('daily',s0);
  await f.call(`/channels/${binding.id}/unbind`,{pin:'123456'});await f.run(s0);assert.equal(f.sent.length,0);
  let settings=(await f.call('/channels/reports')).data.feishu;assert.equal(settings.bound,false);assert.equal(settings.daily.enabled,true);assert.deepEqual([settings.daily.last.state,settings.daily.last.reason],['skipped','binding_unavailable']);
  binding=f.bind();await f.run(s1);assert.equal(f.sent.length,1);
  assert.match(await f.channels.router.receive({channel:'feishu',externalId:'fs-owner',messageId:'unsubscribe',text:'退订日报'}),/已退订飞书日报/);
  assert.equal((await f.call('/channels/reports')).data.feishu.daily.enabled,false);await f.run(s2);assert.equal(f.sent.length,1);
  await f.call('/channels/reports/feishu',{daily:true},'PATCH');f.due('daily',s3);
  assert.equal((await f.call('/agent/enrollment/disable',{})).status,200);await f.run(s3);assert.equal(f.sent.length,1);
  assert.equal((await f.call('/channels/reports')).data.feishu.daily.last.reason,'assistant_unavailable');
  assert.equal((await f.call('/channels/reports/feishu',{weekly:true},'PATCH')).status,403);assert.equal((await f.call('/channels/reports/feishu',{daily:false},'PATCH')).status,200);
});

test('重启后不重复推送；宕机后一天内补发最近一期，更早的记为错过',async t=>{
  const f=await feishu(t);f.bind();await f.call('/channels/reports/feishu',{daily:true,weekly:true},'PATCH');
  // On a Sunday today's slot is tomorrow's Monday morning, when the weekly report is due too; keep it out of this count.
  const slot=todaySlot();f.due('daily',slot);f.due('weekly',nextSlot('weekly',slot));
  const dir=await mkdtemp(join(tmpdir(),'report-push-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const reopen=async(source,name)=>{const path=join(dir,name);await backup(source.bank.db,path);return createApp(path,{channels:{secret:'a'.repeat(64)}});};
  const reports=app=>app.bank.all("SELECT * FROM channel_outbox WHERE kind='report'");
  const first=await reopen(f,'first.sqlite');
  try{first.channels.reports.runDue(shift(slot,2*HOUR),{budgetMs:Infinity});assert.equal(reports(first).length,1);first.channels.reports.runDue(shift(slot,2*HOUR),{budgetMs:Infinity});assert.equal(reports(first).length,1);}
  finally{await first.channels.stop();}
  const second=await reopen(first,'second.sqlite');first.bank.db.close();
  try{
    second.channels.reports.runDue(shift(slot,3*HOUR),{budgetMs:Infinity});assert.equal(reports(second).length,1);
    const monday=nextSlot('weekly',slot);second.bank.run("UPDATE report_subscriptions SET next_at=? WHERE kind='weekly'",monday);
    second.channels.reports.runDue(shift(monday,2*DAY),{budgetMs:Infinity});
    const weekly=second.bank.get("SELECT status,reason,outbox_id FROM report_pushes WHERE kind='weekly'");assert.deepEqual({...weekly},{status:'missed',reason:'late',outbox_id:null});
    assert.equal(second.bank.get("SELECT next_at FROM report_subscriptions WHERE kind='weekly'").next_at,nextSlot('weekly',shift(monday,2*DAY)));
  }finally{await second.channels.stop();second.bank.db.close();}
});

test('微信没有会话上下文时跳过并只提醒一次；收到消息后推送账单页链接，可在微信退订',async t=>{
  const f=await wechatFixture(t,{wechat:{feedback:false}});await f.bind();await f.call('/channels/reports/wechat',{daily:true,monthly:true},'PATCH');
  let settings=(await f.call('/channels/reports')).data.wechat;assert.equal(settings.bound,true);assert.equal(settings.ready,false);
  const s0=todaySlot(),s1=nextSlot('daily',s0),s2=nextSlot('daily',s1);
  const run=async at=>{f.bank.run("UPDATE report_subscriptions SET next_at=? WHERE user_id=? AND kind='daily'",at,f.user.id);f.channels.reports.runDue(at,{budgetMs:Infinity});await f.channels.wechat.delivery.drain();};
  const notices=()=>f.bank.get("SELECT count(*) n FROM notifications WHERE user_id=? AND title='微信账单推送未发送'",f.user.id).n;
  await run(s0);await run(s1);assert.equal(f.state.sent.length,0);assert.equal(notices(),1);
  await f.receive('你好','hello');await f.channels.wechat.drain();assert.equal((await f.call('/channels/reports')).data.wechat.ready,true);
  const before=f.state.sent.length;await run(s2);assert.equal(f.state.sent.length,before+1);
  const text=f.state.sent.at(-1).msg.item_list[0].text_item.text,range=slotRange('daily',s2);
  assert.ok(text.startsWith('【日报】'));assert.ok(text.includes(`https://bank.test/#bill-report?from=${range.from}&to=${range.to}`));assert.doesNotMatch(text,/#tasks|\*\*/);
  assert.equal((await f.call('/channels/reports')).data.wechat.daily.last.state,'sent');
  await f.receive('退订账单推送','unsubscribe');await f.channels.wechat.drain();assert.match(f.state.sent.at(-1).msg.item_list[0].text_item.text,/已退订微信全部账单推送/);
  settings=(await f.call('/channels/reports')).data.wechat;assert.equal(settings.daily.enabled,false);assert.equal(settings.monthly.enabled,false);
});
