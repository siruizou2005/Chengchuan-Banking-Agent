// Explicit opt-in live integration check. Reads secrets only from environment.
// Usage: node --env-file=.env scripts/smoke-live.mjs [http://127.0.0.1:5173] [wav-path]
import { readFileSync } from 'node:fs';
const base=(process.argv[2]||'http://127.0.0.1:5173')+'/api';
const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'13800138000',password:'Bank123456'})}).then(r=>r.json());
if(!login.token)throw Error('Demo login failed');
const enrollment=await fetch(base+'/agent/enrollment',{headers:{Authorization:`Bearer ${login.token}`}}).then(r=>r.json());
if(enrollment.status!=='enabled')throw Error('演示用户尚未开通智能助手：请先在App「智能助手」阅读协议并开通，再运行本检查');
async function request(path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result;}
if(process.argv[3]){const r=await fetch(base+'/voice/transcribe',{method:'POST',headers:{Authorization:`Bearer ${login.token}`,'Content-Type':'audio/wav'},body:readFileSync(process.argv[3])});const data=await r.json();console.log(JSON.stringify({check:'voice',status:r.status,text:data.text,error:data.error},null,2));}
for(const text of ['给陈屿转200元，备注午饭','分析本月账单','有哪些订阅扣费','我爱人10月5日生日，请按鲜花200元、蛋糕300元、10月1日锁定1000元至10月31日、10月2日提醒、10月3日订购安排计划']){
 const r=await request('/agent/chat',{messages:[{role:'user',content:text}]});
 console.log(JSON.stringify({check:text,text:r.text,events:r.events.map(e=>({type:e.type,title:e.data?.title,level:e.data?.level})),trace:r.trace.map(t=>({tool:t.tool,ok:t.ok,error:t.ok?undefined:t.result}))},null,2));
 // Live smoke never executes money actions; cancel generated proposals after checking.
 for(const event of r.events)if(['action','plan'].includes(event.type))await request(`/agent/actions/${event.data.id}/cancel`,{});
}
