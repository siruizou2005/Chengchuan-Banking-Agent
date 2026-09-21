export function createFeishuHandler(router,client,onError=()=>{}) {
 return data=>{
  const message=data.message,sender=data.sender?.sender_id?.open_id;
  if(!message||message.chat_type!=='p2p'||message.message_type!=='text'||data.sender?.sender_type==='app'||!sender)return {};
  let text;try{text=JSON.parse(message.content).text;}catch{return {};}
  // The SDK dispatcher must acknowledge immediately; model processing is asynchronous.
  void router.receive({channel:'feishu',externalId:sender,messageId:message.message_id,text}).then(async reply=>{
   if(reply)await client.im.v1.message.reply({path:{message_id:message.message_id},data:{msg_type:'text',content:JSON.stringify({text:reply})}});
  }).catch(onError);
  return {};
 };
}
export async function startFeishu(router,options={}) {
 const appId=options.appId||process.env.FEISHU_APP_ID,appSecret=options.appSecret||process.env.FEISHU_APP_SECRET;
 if(!appId||!appSecret)return {stop:async()=>{},send:async()=>{throw new Error('飞书未配置');}};
 const sdk=options.sdk||await import('@larksuiteoapi/node-sdk');
 const client=new sdk.Client({appId,appSecret}),ws=new sdk.WSClient({appId,appSecret,loggerLevel:sdk.LoggerLevel.warn});
 ws.start({eventDispatcher:new sdk.EventDispatcher({}).register({'im.message.receive_v1':createFeishuHandler(router,client,()=>console.warn('Feishu message failed'))})});
 return {stop:async()=>{ws.close({force:true});},send:async(binding,text)=>{
  const result=await client.im.v1.message.create({params:{receive_id_type:'open_id'},data:{receive_id:binding.external_id,msg_type:'text',content:JSON.stringify({text})}});if(result.code)throw new Error('飞书推送失败');
 }};
}
