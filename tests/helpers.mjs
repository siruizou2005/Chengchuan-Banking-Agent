import { createApp } from '../server/app.mjs';
export const llm=(calls=[],text='请核对服务端卡片。')=>({choices:[{message:calls.length?{role:'assistant',content:null,tool_calls:calls.map(([name,args],i)=>({id:'call'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{role:'assistant',content:text}}],usage:{total_tokens:12}});
export async function fixture(t,options={}){
 const queue=options.responses||[];const requests=[];
 const instance=createApp(':memory:',{...options,chat:{config:()=>({apiKey:'test',baseUrl:'https://llm.test/v1',model:'test-model'}),fetch:async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json(queue.length?queue.shift():llm());},...options.chat},channels:{secret:'a'.repeat(64),...options.channels}});
 const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await instance.channels.stop();await new Promise(r=>server.close(r));instance.bank.db.close();});
 const url=`http://127.0.0.1:${server.address().port}/api`;
 async function req(path,body,token,method=body===undefined?'GET':'POST',headers={}){const response=await fetch(url+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
 const alice=(await req('/auth/login',{phone:'13800138000',password:'Bank123456'})).data,bob=(await req('/auth/login',{phone:'13900139000',password:'Bank123456'})).data;
 // Existing suites exercise an assistant that is already open; enrollment and onboarding have their own suites.
 if(options.enroll!==false)for(const who of [alice,bob]){const {documents}=(await req('/agent/enrollment',undefined,who.token)).data;await req('/agent/enrollment',{documents:documents.map(d=>({id:d.id,version:d.version}))},who.token);if(!options.onboarding)await req('/agent/onboarding/end',{},who.token);}
 const call=(path,body,method)=>req(path,body,alice.token,method),user=instance.bank.get('SELECT * FROM users WHERE id=?',alice.user.id);
 const recipient=instance.services.resolveRecipients(user,{name:'陈屿'})[0].recipient;
 async function verify(actionId,token=alice.token){const v=await req('/verify/start',{actionId},token);if(v.status!==200)throw new Error(JSON.stringify(v));const current=instance.bank.get('SELECT user_id FROM verifications WHERE id=?',v.data.id),n=instance.bank.get("SELECT body FROM notifications WHERE user_id=? AND title='模拟手机验证码' ORDER BY rowid DESC LIMIT 1",current.user_id);await req('/verify/face',{id:v.data.id,skipped:true,reason:'unavailable'},token);return (await req('/verify/complete',{id:v.data.id,code:n.body.match(/验证码 (\d{6})/)[1]},token)).data.verificationToken;}
 return {...instance,url,requests,queue,req,call,alice,bob,user,recipient,verify,propose:(tool,args)=>call('/agent/actions',{tool,args}),chat:text=>call('/agent/chat',{messages:[{role:'user',content:text}]}),balance:()=>instance.bank.get("SELECT balance,held FROM accounts WHERE user_id=? AND type='debit'",user.id)};
}

// Feishu replies are posts, or cards for tables and code; fallbacks and progress notes are plain text.
export const feishuContentText=content=>{const value=JSON.parse(content);return value.text??value.zh_cn?.content.flat().map(e=>e.text).join('\n')??value.body.elements.map(e=>e.content).join('\n');};
