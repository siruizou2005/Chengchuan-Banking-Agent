import { randomBytes } from 'node:crypto';
import { BusinessError, requireThat } from '../errors.mjs';

export const WECHAT_ORIGIN='https://ilinkai.weixin.qq.com';
export function safeBaseUrl(value=WECHAT_ORIGIN) {
  let url;try{url=new URL(value||WECHAT_ORIGIN);}catch{throw new BusinessError('微信返回的服务地址无效',502,'INVALID_CHANNEL_HOST');}
  requireThat(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(url.hostname==='ilinkai.weixin.qq.com'||url.hostname.endsWith('.ilinkai.weixin.qq.com')),'微信返回的服务地址无效',502,'INVALID_CHANNEL_HOST');
  return url.origin;
}
export function createWeChatProtocol(options={}) {
  const transport=options.fetch||fetch,version=options.version||process.env.WECHAT_PROTOCOL_VERSION||'2.4.9';
  requireThat(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)&&version.split('.').every(n=>Number(n)<=255),'微信协议版本配置无效',503,'WECHAT_CONFIG');
  const [a,b,c]=version.split('.').map(Number),clientVersion=String((a<<16)|(b<<8)|c);
  async function request(base,path,{token,body,signal,timeoutMs=15000,login=false,send=false}={}) {
    const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const headers={'iLink-App-Id':'bot','iLink-App-ClientVersion':clientVersion};
    if(body!==undefined)Object.assign(headers,{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')});
    if(token)headers.Authorization=`Bearer ${token}`;
    let response;
    try {
      response=await transport(safeBaseUrl(base)+path,{method:body===undefined?'GET':'POST',redirect:'error',headers,signal:controller.signal,
        ...(body===undefined?{}:{body:JSON.stringify(login?body:{...body,base_info:{channel_version:version,bot_agent:'ChengchuanBank/1.0.0'}})})});
      // Node 24 exposes the original JSON primitive: preserve 64-bit message identities before Number rounding.
      let data=null;
      try{data=JSON.parse(await response.text(),(key,value,context)=>
        ['message_id','msg_id'].includes(key)&&typeof value==='number'&&/^-?\d+$/.test(context?.source||'')?context.source:value);
      }catch{}
      if(!data||typeof data!=='object'||Array.isArray(data))throw Object.assign(new BusinessError('微信响应无法确认',502,'WECHAT_RESPONSE_UNKNOWN'),{deliveryState:send?'unknown':undefined});
      const code=data.ret||data.errcode||0;
      if(code===-14)throw Object.assign(new BusinessError('微信连接需要重新认证，请回App重新扫码',403,'WECHAT_REAUTH_REQUIRED'),{deliveryState:'failed',upstreamCode:-14});
      if(!response.ok||code) {
        const retry=response.status===429;
        const error=Object.assign(new BusinessError('微信服务暂时不可用',502,'WECHAT_ERROR'),{httpStatus:response.status,upstreamCode:code,deliveryState:retry?'retry_wait':response.status>=500?'unknown':'failed'});
        const after=Number(response.headers?.get('retry-after'));if(Number.isFinite(after)&&after>0)error.retryAfterMs=Math.min(after*1000,300000);
        throw error;
      }
      return {data,httpStatus:response.status,responseQuality:Object.hasOwn(data,'ret')||Object.hasOwn(data,'errcode')?'explicit_code':'legacy_missing_code'};
    }catch(error){
      if(error instanceof BusinessError)throw error;
      throw Object.assign(new BusinessError('微信连接暂时中断，请稍后重试',502,'WECHAT_NETWORK'),{deliveryState:send?'unknown':undefined,httpStatus:response?.status});
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {request};
}
