import { requireThat } from '../errors.mjs';
import { eventsText } from './router.mjs';

// A frozen account does not break the connection: intake keeps running and each message is refused (see refusal.mjs).
export function bindingFor(bank,row) {
  const binding=bank.get("SELECT * FROM channel_bindings WHERE id=? AND channel='wechat' AND status='active'",row.binding_id||row.id);
  const generation=row.binding_generation,session=row.binding_session_id;
  requireThat(binding&&binding.binding_generation===generation&&binding.binding_session_id===session,'微信绑定已失效',409,'BINDING_FENCED');
  requireThat(binding.auth_state==='valid','请回App重新认证微信连接',403,'CHANNEL_REAUTH_REQUIRED');
  return binding;
}
export function assertLease(bank,table,row,owner,time=Date.now()) {
  requireThat(['wechat_inbox','wechat_deliveries','channel_bindings'].includes(table),'无效任务表',500);
  requireThat(bank.get(`SELECT 1 FROM ${table} WHERE id=? AND lease_owner=? AND lease_epoch=? AND lease_until>?`,row.id,owner,row.lease_epoch,time),'任务已由其他执行者接管',409,'WORKER_FENCED');
}
export const resultLink=(origin,requestId)=>`${origin||''}/#wechat-requests/${requestId}`;

// Amount visibility is applied at send time using the user's WeChat preference.
export function wechatResultText(result,requestId,origin,bank) {
  const actions=(result.events||[]).filter(e=>['action','plan'].includes(e.type));
  if(actions.length>3)return `本次整理了${actions.length}项操作，当前状态及所需确认请在App逐项核对：${resultLink(origin,requestId)}`;
  if(actions.length)return actions.map(({data:a})=>{
    const current=bank.get('SELECT status FROM agent_actions WHERE id=?',a.id);
    if(current?.status==='cancelled')return `操作已取消。编号：${a.id}`;
    if(current?.status!=='proposed')return `操作状态已有更新，请在App查看：${origin||''}/#tasks?action=${a.id}\n编号：${a.id}`;
    return `${a.title}\n已整理好待确认操作，尚未执行。请在App核对后确认：${origin||''}/#tasks?action=${a.id}\n编号：${a.id}\n回复「取消 ${a.id}」可放弃。`;
  }).join('\n\n');
  const text=eventsText(result,{origin});
  if(Buffer.byteLength(text,'utf8')>3200){
    let summary='',bytes=0;for(const character of text){bytes+=Buffer.byteLength(character,'utf8');if(bytes>3000)break;summary+=character;}
    return summary+`…\n完整结果：${resultLink(origin,requestId)}`;
  }
  // The advice card lets the user change horizon and amount and open product details, which text cannot.
  if((result.events||[]).some(e=>e.type==='advice'))return `${text}\n调整期限与金额、查看产品详情请在App操作：${resultLink(origin,requestId)}`;
  return text||`本次结果请在App查看：${resultLink(origin,requestId)}`;
}
