import { id, now } from '../db.mjs';
import { BusinessError, requireThat } from '../errors.mjs';
import { assertPrincipal } from './principal.mjs';

const positive = (value, fallback) => Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):fallback;
export function createInferenceManager(bank, options={}) {
  const maxInput=positive(options.maxInputTokens??process.env.INFERENCE_MAX_INPUT_TOKENS,64000);
  const maxOutput=positive(options.maxOutputTokens??process.env.INFERENCE_MAX_OUTPUT_TOKENS,2200);
  const concurrency=positive(options.concurrency??process.env.INFERENCE_CONCURRENCY,4);
  const quota=positive(options.dailyQuota??process.env.INFERENCE_DAILY_QUOTA,120);
  async function complete({principal,requestId,step,trigger,config,body,signal,fetch:providerFetch=fetch,timeoutMs=45000,assertAuthorized=()=>{}}) {
    assertPrincipal(bank,principal);assertAuthorized();
    requireThat(['app','wechat','feishu','voice'].includes(trigger)&&typeof requestId==='string'&&requestId&&typeof step==='string','缺少用户请求来源',403,'INFERENCE_TRIGGER_REQUIRED');
    signal?.throwIfAborted();
    // UTF-8 byte count is a conservative tokenizer-independent upper bound for text inputs.
    // ASR audio has its own validated 60-second bound; never count base64 audio as text tokens.
    const inputText=trigger==='voice'?JSON.stringify(body.messages[0]):JSON.stringify({messages:body.messages,tools:body.tools});
    requireThat(Buffer.byteLength(inputText)<=maxInput,'本轮上下文超过额度，请开始新对话',413,'INFERENCE_INPUT_LIMIT');
    const payload={...body,max_tokens:Math.min(positive(body.max_tokens,maxOutput),maxOutput)},callId=id('LLM');
    bank.atomic(()=>{
      const time=Date.now();
      bank.run("UPDATE inference_calls SET status='unknown',error_code='WORKER_INTERRUPTED',finished_at=? WHERE status='running' AND lease_until<=?",now(),time);
      requireThat(!bank.get('SELECT 1 FROM inference_calls WHERE tenant_id=? AND user_id=? AND request_id=? AND step=?',principal.tenant_id,principal.user_id,requestId,step),'该模型请求已处理或结果待核查',409,'INFERENCE_DUPLICATE');
      requireThat(bank.get("SELECT COUNT(*) n FROM inference_calls WHERE tenant_id=? AND user_id=? AND created_at>=?",principal.tenant_id,principal.user_id,now().slice(0,10)+'T00:00:00.000Z').n<quota,'今日模型请求额度已用完',429,'INFERENCE_QUOTA');
      requireThat(bank.get("SELECT COUNT(*) n FROM inference_calls WHERE status='running'").n<concurrency,'模型服务繁忙，请稍后重试',429,'INFERENCE_BUSY');
      bank.run("INSERT INTO inference_calls(id,tenant_id,user_id,request_id,step,trigger_source,model,status,created_at,lease_until) VALUES(?,?,?,?,?,?,?,'running',?,?)",callId,principal.tenant_id,principal.user_id,requestId,step,trigger,config.model,now(),time+timeoutMs+5000);
    });
    const controller=new AbortController();let timer,abortListener;
    try {
      const cancelled=new Promise((_,reject)=>{
        abortListener=()=>{controller.abort();reject(new BusinessError('模型请求已停止或超时',504,'CHAT_TIMEOUT'));};
        signal?.addEventListener('abort',abortListener,{once:true});
        timer=setTimeout(abortListener,timeoutMs);
        if(signal?.aborted)abortListener();
      });
      const data=await Promise.race([(async()=>{
        controller.signal.throwIfAborted();assertAuthorized();
        const response=await providerFetch(`${config.baseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`},body:JSON.stringify(payload)});
        if(!response.ok){
          const detail=await response.json().catch(()=>null);
          if(detail?.error?.code==='model_not_found')throw new BusinessError('当前聊天模型不可用',502,'MODEL_UNAVAILABLE');
          const [code,message]=({401:['PROVIDER_AUTH','模型服务认证失败'],402:['PROVIDER_BALANCE','模型服务余额不足'],429:['PROVIDER_RATE_LIMIT','模型服务请求繁忙']})[response.status]||['PROVIDER_ERROR','模型服务暂时不可用'];
          throw new BusinessError(message,502,code);
        }
        return response.json();
      })(),cancelled]);
      assertAuthorized();
      requireThat(data?.choices?.[0]?.message&&(typeof data.choices[0].message.content==='string'||Array.isArray(data.choices[0].message.tool_calls)),'模型服务返回为空，请重试',502,'EMPTY_RESPONSE');
      const usage=data.usage||{},count=n=>Number.isInteger(n)&&n>=0?n:null;
      const input=count(usage.prompt_tokens),output=count(usage.completion_tokens);
      const inputRate=Number(process.env.INFERENCE_INPUT_PRICE_PER_MILLION),outputRate=Number(process.env.INFERENCE_OUTPUT_PRICE_PER_MILLION);
      const cost=trigger!=='voice'&&input!==null&&output!==null&&process.env.INFERENCE_INPUT_PRICE_PER_MILLION?.trim()&&process.env.INFERENCE_OUTPUT_PRICE_PER_MILLION?.trim()&&Number.isFinite(inputRate)&&Number.isFinite(outputRate)&&inputRate>=0&&outputRate>=0?(input*inputRate+output*outputRate)/1e6:null;
      bank.run("UPDATE inference_calls SET status='succeeded',input_tokens=?,output_tokens=?,cost=?,finished_at=? WHERE id=? AND status='running'",input,output,cost,now(),callId);
      return data;
    } catch(error) {
      const safe=error instanceof BusinessError?error:new BusinessError('模型服务连接失败，请稍后重试',502,'PROVIDER_ERROR');
      bank.run("UPDATE inference_calls SET status=?,error_code=?,finished_at=? WHERE id=? AND status='running'",controller.signal.aborted?'unknown':'failed',safe.code,now(),callId);
      throw safe;
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',abortListener); }
  }
  return {complete};
}
