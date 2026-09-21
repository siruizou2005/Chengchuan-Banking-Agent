import { createChannelRouter } from './router.mjs';
import { createWeChat } from './wechat.mjs';
import { startFeishu } from './feishu.mjs';
import { now } from '../db.mjs';
export function createChannels(services,agent,options={}){
 const router=createChannelRouter(services,agent,options),wechat=createWeChat(services,router,options.wechat);let feishu,timer,flushing=false;
 async function flush(){if(flushing)return;flushing=true;try{for(const item of services.bank.all("SELECT * FROM channel_outbox WHERE status='pending' AND next_at<=? LIMIT 20",now())){
  const binding=services.bank.get("SELECT * FROM channel_bindings WHERE id=? AND status='active'",item.binding_id);if(!binding){services.bank.run("UPDATE channel_outbox SET status='cancelled' WHERE id=?",item.id);continue;}
  try{if(binding.channel==='wechat')await wechat.send(binding,item.body);else {if(!feishu)throw new Error('飞书未就绪');await feishu.send(binding,item.body);}services.bank.run("UPDATE channel_outbox SET status='sent' WHERE id=?",item.id);}
  catch{services.bank.run('UPDATE channel_outbox SET attempts=attempts+1,next_at=?,status=? WHERE id=?',new Date(Date.now()+Math.min(60000,1000*2**item.attempts)).toISOString(),item.attempts>=7?'failed':'pending',item.id);}
 }}finally{flushing=false;}}
 return {router,wechat,register(route){router.register(route);wechat.register(route);},async start(){feishu=await startFeishu(router,options.feishu);wechat.start();timer=setInterval(()=>void flush(),5000);timer.unref();},async stop(){clearInterval(timer);await wechat.stop();await feishu?.stop();},flush};
}
