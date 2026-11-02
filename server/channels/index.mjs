import { createChannelRouter } from './router.mjs';
import { createWeChat } from './wechat.mjs';
import { startFeishu,createFeishuBots } from './feishu.mjs';
import { createFeishuPipeline } from './feishu-pipeline.mjs';
import { createReportPush } from './reports.mjs';
import { RECORD_RETENTION_MS,pruneChannelRecords,clearChannelRecords } from './records.mjs';
export function createChannels(services,agent,options={}){
 const router=createChannelRouter(services,agent,options),wechat=createWeChat(services,router,{publicOrigin:options.publicOrigin,...options.wechat}),bots=createFeishuBots(services,router,options.feishuPersonal);let feishu,timer,pruned=0;
 const pipeline=createFeishuPipeline(services,router,async(binding,text,sendOptions)=>{
  if(binding.token)return bots.send(binding,text,sendOptions);
  if(!feishu)throw Object.assign(new Error('飞书未就绪'),{code:'FEISHU_NOT_READY',deliveryState:'retry_wait'});
  return feishu.send(binding,text,sendOptions);
 },{publicOrigin:options.publicOrigin,typing:{
  add:(binding,messageId)=>binding.token?bots.typing.add(binding,messageId):feishu?.typing?feishu.typing.add(messageId):Promise.resolve(null),
  remove:(binding,messageId,reactionId)=>binding.token?bots.typing.remove(binding,messageId,reactionId):feishu?.typing?.remove(messageId,reactionId),
 },...options.feishuPipeline});
 router.acceptFeishu=pipeline.ingest;
 router.onRevoke(bots.forget);router.onRevoke(pipeline.cancelBinding);
 // App results and reports are proactive, so WeChat is woken too instead of waiting for its next long-poll to return.
 const wake=()=>{pipeline.kick();try{wechat.delivery.kick();}catch{console.warn('WeChat worker could not claim work');}};
 services.onChannelResult=wake;
 // What a user could bind right now; the first conversation offers only these.
 const sharedFeishu=()=>Boolean((options.feishu?.appId||process.env.FEISHU_APP_ID)&&(options.feishu?.appSecret||process.env.FEISHU_APP_SECRET));
 services.channelAvailability=()=>({wechat:wechat.enabled(),feishu:bots.enabled()?'personal':sharedFeishu()?'shared':null});
 const reports=createReportPush(services,{publicOrigin:options.publicOrigin,...options.reports,channelEnabled:channel=>channel!=='wechat'||wechat.enabled(),kick:wake});
 function prune(at=Date.now()){
  const {bank}=services;
  bank.run('DELETE FROM channel_messages WHERE created_at<?',new Date(at-3*86400000).toISOString());
  bank.atomic(()=>{wechat.delivery.expireOutbox(at);reports.settle(new Date(at-RECORD_RETENTION_MS).toISOString());pruneChannelRecords(bank,at);});
 }
 function maintain(){
  if(Date.now()-pruned>3600000){pruned=Date.now();try{prune();}catch(error){console.warn('Channel record cleanup failed:',error.code||error.message);}}
  pipeline.kick();
 }
 async function flush(){maintain();await Promise.all([wechat.flush(),pipeline.flush()]);}
 return {router,wechat,bots,reports,feishuPipeline:pipeline,revokeAll:router.revokeAll,prune,clearRecords:userId=>clearChannelRecords(services.bank,userId),
  register(route){router.register(route);reports.routes(route);wechat.register(route);bots.routes(route);pipeline.routes(route);},
  async start(){feishu=await startFeishu(router,options.feishu);pipeline.start();wechat.start();timer=setInterval(maintain,1000);timer.unref();},
  async stop(){clearInterval(timer);reports.stop();services.onChannelResult=undefined;await Promise.all([pipeline.stop(),wechat.stop(),feishu?.stop(),bots.stop()]);},flush};
}
