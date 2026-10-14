import { createChannelRouter } from './router.mjs';
import { createWeChat } from './wechat.mjs';
import { startFeishu,createFeishuBots } from './feishu.mjs';
import { createFeishuPipeline } from './feishu-pipeline.mjs';
export function createChannels(services,agent,options={}){
 const router=createChannelRouter(services,agent,options),wechat=createWeChat(services,router,{publicOrigin:options.publicOrigin,...options.wechat}),bots=createFeishuBots(services,router,options.feishuPersonal);let feishu,timer,pruned=0;
 const pipeline=createFeishuPipeline(services,router,async(binding,text,sendOptions)=>{
  if(binding.token)return bots.send(binding,text,sendOptions);
  if(!feishu)throw Object.assign(new Error('飞书未就绪'),{code:'FEISHU_NOT_READY',deliveryState:'retry_wait'});
  return feishu.send(binding,text,sendOptions);
 },{publicOrigin:options.publicOrigin,...options.feishuPipeline});
 router.acceptFeishu=pipeline.ingest;
 router.onRevoke(bots.forget);router.onRevoke(pipeline.cancelBinding);
 services.onChannelResult=()=>pipeline.kick();
 function maintain(){
  if(Date.now()-pruned>3600000){pruned=Date.now();services.bank.run('DELETE FROM channel_messages WHERE created_at<?',new Date(pruned-3*86400000).toISOString());}
  pipeline.kick();
 }
 async function flush(){maintain();await Promise.all([wechat.flush(),pipeline.flush()]);}
 return {router,wechat,bots,feishuPipeline:pipeline,
  register(route){router.register(route);wechat.register(route);bots.routes(route);pipeline.routes(route);},
  async start(){feishu=await startFeishu(router,options.feishu);pipeline.start();wechat.start();timer=setInterval(maintain,1000);timer.unref();},
  async stop(){clearInterval(timer);services.onChannelResult=undefined;await Promise.all([pipeline.stop(),wechat.stop(),feishu?.stop(),bots.stop()]);},flush};
}
