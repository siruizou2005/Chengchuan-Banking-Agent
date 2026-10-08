import { bindingFor } from './wechat-state.mjs';

// "正在输入" replaces the text acknowledgement, so nothing is left in the chat once the reply arrives.
// Indicator state lives in memory only: after a restart WeChat lets it lapse and text progress takes over.
export function createWeChatTyping(services,request,options={}) {
  const {bank}=services,tickets=new Map(),shown=new Map();
  const keepaliveMs=options.typingKeepaliveMs||5000,maxMs=options.typingMaxMs||120000;
  const enabled=()=>options.typing??process.env.WECHAT_TYPING_ENABLED!=='false';
  // Same policy as the official client: refresh at a random point within 24h, back off up to 1h on failure.
  async function ticket(binding,context) {
    const key=`${binding.id}:${binding.binding_generation}`,entry=tickets.get(key),time=Date.now();
    if(entry&&time<entry.nextAt)return entry.ticket;
    try{
      const {data}=await request(binding,'/ilink/bot/getconfig',{timeoutMs:3000,body:{ilink_user_id:binding.external_id,...(context?{context_token:context}:{})}});
      const value=typeof data.typing_ticket==='string'?data.typing_ticket:'';
      tickets.set(key,{ticket:value,nextAt:time+Math.random()*86400000,retryMs:2000});return value;
    }catch{
      const retryMs=Math.min((entry?.retryMs||1000)*2,3600000);
      tickets.set(key,{ticket:entry?.ticket||'',nextAt:time+retryMs,retryMs});return entry?.ticket||'';
    }
  }
  const send=(binding,value,status)=>request(binding,'/ilink/bot/sendtyping',{timeoutMs:3000,body:{ilink_user_id:binding.external_id,typing_ticket:value,status}});
  // The indicator stays while a request is waiting, running, or its reply is still being sent.
  const busy=bindingId=>Boolean(bank.get(`SELECT 1 FROM wechat_inbox WHERE binding_id=? AND is_command=0 AND status IN ('queued','running')
    UNION ALL SELECT 1 FROM wechat_deliveries WHERE binding_id=? AND request_id IS NOT NULL AND kind NOT IN ('ack','progress') AND status IN ('pending','retry_wait','sending') LIMIT 1`,bindingId,bindingId));
  function end(bindingId){const entry=shown.get(bindingId);if(!entry)return;clearInterval(entry.timer);shown.delete(bindingId);return entry;}
  async function stop(bindingId){const entry=end(bindingId);if(entry)await send(entry.binding,entry.ticket,2).catch(()=>{});}
  async function tick(bindingId) {
    const entry=shown.get(bindingId);if(!entry||entry.sending)return;
    if(!busy(bindingId)||Date.now()-entry.started>maxMs)return stop(bindingId);
    entry.sending=true;
    // A failed keepalive drops the indicator, which lets the text progress notice take over.
    try{entry.binding=bindingFor(bank,entry.binding);await send(entry.binding,entry.ticket,1);}catch{end(bindingId);options.onDrop?.();}
    finally{entry.sending=false;}
  }
  // Resolves true once WeChat accepted the indicator; false means the caller should acknowledge with text.
  async function start(binding,context) {
    if(!enabled())return false;
    const current=shown.get(binding.id);
    if(current?.binding.binding_generation===binding.binding_generation)return true;
    end(binding.id);
    let value;
    try{value=await ticket(binding,context);if(!value)return false;await send(binding,value,1);}catch{return false;}
    if(!shown.has(binding.id)){
      const timer=setInterval(()=>void tick(binding.id),keepaliveMs);timer.unref?.();
      shown.set(binding.id,{binding,ticket:value,started:Date.now(),timer});
    }
    // The reply may already have gone out while the indicator was being set up.
    if(!busy(binding.id))void stop(binding.id);
    return true;
  }
  function settle(bindingId){if(shown.has(bindingId)&&!busy(bindingId))void stop(bindingId);}
  return {start,settle,end,showing:bindingId=>shown.has(bindingId),clear(){for(const id of [...shown.keys()])end(id);}};
}
