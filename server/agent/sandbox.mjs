import { Worker } from 'node:worker_threads';
import { requireThat } from '../errors.mjs';
export async function runAnalysis(code,data) {
  requireThat(typeof code==='string'&&code.length<=12000,'分析代码过长');
  requireThat(Buffer.byteLength(JSON.stringify(data))<=2*1024*1024,'分析数据过大');
  const started=Date.now();
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./sandbox-worker.mjs',import.meta.url),{workerData:{code,data},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('沙箱执行超时'));},2500);
    worker.once('message',m=>{clearTimeout(timer);worker.terminate();if(m.error)reject(new Error(m.error));else resolve({result:m.result,durationMs:Date.now()-started,size:Buffer.byteLength(JSON.stringify(m.result))});});
    worker.once('error',()=>{clearTimeout(timer);reject(new Error('沙箱内存或运行限制'));});
    worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('沙箱已中断'));});
  });
}
