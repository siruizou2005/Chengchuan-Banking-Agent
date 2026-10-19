import express from 'express';
import { BusinessError, requireThat } from './errors.mjs';
import { resolvePrincipal } from './agent/principal.mjs';
import { id } from './db.mjs';
export function validateWav(buffer) {
 requireThat(Buffer.isBuffer(buffer)&&buffer.length>=44&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WAVE','请提交PCM16单声道16kHz WAV录音',415,'INVALID_AUDIO');
 let offset=12,format,dataSize=0;
 while(offset+8<=buffer.length){const tag=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4);requireThat(offset+8+size<=buffer.length,'WAV文件不完整',400,'INVALID_AUDIO');if(tag==='fmt '&&size>=16)format={encoding:buffer.readUInt16LE(offset+8),channels:buffer.readUInt16LE(offset+10),rate:buffer.readUInt32LE(offset+12),bits:buffer.readUInt16LE(offset+22)};if(tag==='data')dataSize+=size;offset+=8+size+(size%2);}
 requireThat(format?.encoding===1&&format.channels===1&&format.rate===16000&&format.bits===16&&dataSize>0&&dataSize<=60*32000,'录音须为16kHz单声道PCM16，最长60秒',400,'INVALID_AUDIO');
 return dataSize/32000;
}
export function registerVoice(route,services,options={}) {
 const providerFetch=options.fetch||fetch;
 route('post','/voice/transcribe','语音转文字（WAV，最长60秒）',async(req,res)=>{
  await new Promise((resolve,reject)=>express.raw({type:['audio/wav','audio/x-wav'],limit:'8mb'})(req,res,error=>error?reject(error):resolve()));
  requireThat(req.is('audio/wav')||req.is('audio/x-wav'),'仅支持audio/wav',415,'UNSUPPORTED_AUDIO');
  const duration=validateWav(req.body),config=options.config?.()||{apiKey:process.env.DASHSCOPE_API_KEY,baseUrl:process.env.ASR_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1',model:process.env.ASR_MODEL||'qwen3-asr-flash'};
  requireThat(config.apiKey,'语音服务尚未配置',503,'VOICE_NOT_CONFIGURED');services.guard.assertOpen(req.user.id);
  services.checkRate(`voice:${req.user.id}`);services.badAttempt(`voice:${req.user.id}`);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),options.timeoutMs||45000);const close=()=>{if(!res.writableEnded)abort.abort();};res.on('close',close);
  try{
   const data=await services.inference.complete({principal:resolvePrincipal(services.bank,req.user),requestId:id('ASR'),step:'asr',trigger:'voice',config,signal:abort.signal,fetch:providerFetch,timeoutMs:options.timeoutMs||45000,assertAuthorized:()=>services.guard.assertOpen(req.user.id),body:{model:config.model,messages:[{role:'system',content:[{type:'text',text:services.bank.all('SELECT name FROM payees WHERE user_id=?',req.user.id).map(p=>p.name).join('、')}]},{role:'user',content:[{type:'input_audio',input_audio:{data:`data:audio/wav;base64,${req.body.toString('base64')}`}}]}],asr_options:{language:'zh',enable_itn:true}}}),text=data.choices?.[0]?.message?.content;
   requireThat(typeof text==='string'&&text.trim()&&text.length<=6000,'未识别到清晰语音，请重试',502,'EMPTY_TRANSCRIPT');
   services.bank.audit(req.user.id,'voice.transcribed','',{duration,model:config.model});res.json({text:text.trim()});
  }catch(error){if(error.code==='CHAT_TIMEOUT')throw new BusinessError('语音识别超时',502,'VOICE_TIMEOUT');if(error instanceof BusinessError)throw error;throw new BusinessError(abort.signal.aborted?'语音识别超时':'语音服务连接失败',502,abort.signal.aborted?'VOICE_TIMEOUT':'PROVIDER_ERROR');}
  finally{clearTimeout(timer);res.off('close',close);}
 });
}
