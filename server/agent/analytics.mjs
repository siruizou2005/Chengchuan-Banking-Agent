import { requireThat } from '../errors.mjs';
export function category(row) {
  if(row.amount>0) return /赎回/.test(row.title)?'理财':'收入';
  for(const [name,re] of [['订阅',/订阅|会员|音乐|云盘|健身/],['居住',/房租|水电|水费|电费|物业|燃气/],['餐饮',/餐饮|餐厅|午饭|咖啡|蛋糕/],['交通',/交通|地铁|公交|打车|加油/],['通讯',/通讯|话费|宽带/],['理财',/理财|存款|安心存|澄享/],['转账',/转账/]]) if(re.test(row.title)) return name;
  return '购物';
}
export function ledgerFor(bank,userId) {return bank.all('SELECT l.* FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT 10000',userId);}
export function billReport(rows,period=new Date().toISOString().slice(0,7)) {
  requireThat(/^\d{4}(-(?:0[1-9]|1[0-2]))?$/.test(period),'账单期间须为YYYY-MM或YYYY');
  const subset=rows.filter(r=>r.created_at.startsWith(period)), categories={},merchants={};
  let income=0,expense=0;
  for(const r of subset){if(r.amount>0) income+=r.amount; else {expense-=r.amount;categories[category(r)]=(categories[category(r)]||0)-r.amount;merchants[r.title]=(merchants[r.title]||0)-r.amount;}}
  const d=new Date(`${period.length===4?period+'-01':period}-01T00:00:00Z`);if(period.length===4)d.setUTCFullYear(d.getUTCFullYear()-1);else d.setUTCMonth(d.getUTCMonth()-1);
  const previousPeriod=d.toISOString().slice(0,period.length),previousExpense=rows.filter(r=>r.created_at.startsWith(previousPeriod)&&r.amount<0).reduce((n,r)=>n-r.amount,0);
  return {period,income,expense,net:income-expense,count:subset.length,categories:Object.entries(categories).map(([name,amount])=>({name,amount,share:expense?amount/expense:0})).sort((a,b)=>b.amount-a.amount),topMerchants:Object.entries(merchants).map(([name,amount])=>({name,amount})).sort((a,b)=>b.amount-a.amount).slice(0,5),previousPeriod,previousExpense,change:previousExpense?(expense-previousExpense)/previousExpense:null,scope:'本人最多10,000条已入账流水；时间按数据库UTC归属期间'};
}
export function detectAnomalies(rows) {
  const expenses=rows.filter(r=>r.amount<0), amounts=expenses.map(r=>-r.amount).sort((a,b)=>a-b), median=amounts[Math.floor(amounts.length/2)]||0;
  const counts=new Map();for(const r of expenses)counts.set(r.title,(counts.get(r.title)||0)+1);
  return expenses.flatMap(r=>{
    const reasons=[],hour=new Date(Date.parse(r.created_at)+8*3600000).getUTCHours();
    if(-r.amount>Math.max(500000,median*5))reasons.push('金额明显高于常见支出');
    if(hour<6)reasons.push('深夜交易（北京时间）');
    if(counts.get(r.title)===1&&-r.amount>=100000)reasons.push('陌生商户或首次大额支出');
    if(expenses.some(x=>x.id!==r.id&&x.title===r.title&&x.amount===r.amount&&Math.abs(Date.parse(x.created_at)-Date.parse(r.created_at))<86400000))reasons.push('24小时内同额重复扣费');
    return reasons.length?[{...r,reasons}]:[];
  });
}
export function recognizeSubscriptions(rows) {
  const groups=new Map();for(const r of rows.filter(x=>x.amount<0)){const key=r.title+':'+r.amount;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  return [...groups.values()].filter(g=>g.length>=2&&g.some((r,i)=>g.slice(i+1).some(s=>{const days=Math.abs(Date.parse(r.created_at)-Date.parse(s.created_at))/86400000;return days>=26&&days<=33;}))).map(g=>({merchant:g[0].title.replace(/^订阅 · /,''),amount:-g[0].amount,occurrences:g.length,detected:true}));
}
