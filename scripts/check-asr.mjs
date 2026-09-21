// Send only a supplied demonstration WAV to the configured ASR provider via curl.
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';import { spawnSync } from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'bank-asr-'));
try{
 const content=[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,'+readFileSync(process.argv[2]).toString('base64')}}];
 const messages=[...(process.argv.includes('--context')?[{role:'system',content:[{type:'text',text:'陈屿'}]}]:[]),{role:'user',content}];
 const payload=join(dir,'request.json');writeFileSync(payload,JSON.stringify({model:process.env.ASR_MODEL||'qwen3-asr-flash',messages,asr_options:{language:'zh',enable_itn:true}}));
 const config=`url = "${process.env.ASR_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1'}/chat/completions"\nheader = "Authorization: Bearer ${process.env.DASHSCOPE_API_KEY}"\nheader = "Content-Type: application/json"\ndata-binary = "@${payload}"\nmax-time = 45\n`;
 const response=spawnSync('curl',['-sS','--config','-'],{input:config,encoding:'utf8'});if(response.status)throw Error('curl failed: '+response.status);
 const r=JSON.parse(response.stdout);console.log(JSON.stringify({model:r.model,text:r.choices?.[0]?.message?.content,error:r.error?{code:r.error.code,message:r.error.message}:undefined,usage:r.usage},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
