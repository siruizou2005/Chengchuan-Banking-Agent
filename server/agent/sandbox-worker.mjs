import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
// Never bridge host objects/functions into the WASM VM. Data enters as JSON source only.
let runtime,context;
try {
  const QuickJS=await getQuickJS();runtime=QuickJS.newRuntime();runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(512*1024);
  const deadline=Date.now()+1000;runtime.setInterruptHandler(()=>Date.now()>deadline);context=runtime.newContext();
  const source=`'use strict'; const data=JSON.parse(${JSON.stringify(JSON.stringify(workerData.data))});
    (function freeze(o){Object.freeze(o);for(const v of Object.values(o))if(v&&typeof v==='object')freeze(v)})(data);
    const result=(function(){${workerData.code}\n})();
    const output=JSON.stringify(result===undefined?null:result);
    if(output.length>8192)throw new Error('输出超过8KB');output;`;
  const result=context.evalCode(source);
  if(result.error){const error=context.dump(result.error);result.error.dispose();throw new Error(error.message||'沙箱执行失败');}
  const output=context.getString(result.value);result.value.dispose();
  if(Buffer.byteLength(output)>8192)throw new Error('输出超过8KB');
  parentPort.postMessage({result:JSON.parse(output)});
}catch(error){parentPort.postMessage({error:String(error.message).slice(0,200)});}
finally{context?.dispose();runtime?.dispose();}
