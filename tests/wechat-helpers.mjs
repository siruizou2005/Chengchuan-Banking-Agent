import { fixture, llm } from './helpers.mjs';
export { llm };
export const until=async(fn)=>{for(let i=0;i<400;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error('Condition not reached');};
export async function wechatFixture(t,options={}) {
  const state={messages:[],sent:[],requests:[],status:{status:'confirmed',bot_token:'private-token',ilink_user_id:'wx-owner',ilink_bot_id:'wx-bot',baseurl:'https://ilinkai.weixin.qq.com'},cursor:0};
  const f=await fixture(t,{...options,channels:{publicOrigin:'https://bank.test',wechat:{enabled:true,autoStart:false,...options.wechat,fetch:async(url,init)=>{
    state.requests.push({url,init});
    if(url.includes('get_bot_qrcode'))return Response.json({ret:0,qrcode:'private-qr',qrcode_img_content:'https://weixin.qq.com/x/demo'});
    if(url.includes('get_qrcode_status'))return Response.json(state.status);
    if(url.includes('getupdates')){const msgs=state.messages.splice(0);return Response.json({ret:0,msgs,get_updates_buf:String(++state.cursor)});}
    if(url.includes('sendmessage')){const body=JSON.parse(init.body);state.sent.push(body);if(state.sendOverride)return state.sendOverride(body);return Response.json({ret:0,message_id:String(state.sent.length)});}
    throw Error('Unexpected endpoint');
  }}}});
  async function bind(){const qr=await f.channels.wechat.qr(f.user,'123456');const result=await f.channels.wechat.qrStatus(f.user,qr.id);return f.bank.get('SELECT * FROM channel_bindings WHERE id=?',result.bindingId);}
  const binding=()=>f.bank.get("SELECT * FROM channel_bindings WHERE channel='wechat' AND external_id='wx-owner'");
  function message(text,messageId='m'+(state.cursor+1),extra={}){return {message_type:1,from_user_id:'wx-owner',message_id:messageId,context_token:'ctx-'+messageId,item_list:[{type:1,text_item:{text}}],...extra};}
  async function receive(text,messageId,extra){state.messages.push(message(text,messageId,extra));await f.channels.wechat.pollOnce(binding());}
  return {...f,state,bind,binding,message,receive};
}
