// Run after build. Uses an in-memory bank and fake Feishu transport; no real bot is created.
import assert from 'node:assert/strict';
import express from 'express';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture,llm } from '../tests/helpers.mjs';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||resolve('node_modules/playwright/package.json'));
const {chromium}=require('playwright');
process.env.FEISHU_PERSONAL_ENABLED='true';process.env.PUBLIC_ORIGIN='https://bank.test';
let approve,replyCode=0;const publishes=[],configs=[],cleanup=[];
const sdk={
 registerApp:options=>new Promise((resolve,reject)=>{approve=resolve;options.signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{code:'abort'})));options.onQRCodeReady({url:'https://accounts.feishu.cn/app/register?user_code=ui-demo',expireIn:600});}),
 Client:class{
  im={v1:{message:{create:async()=>({code:0}),reply:async()=>({code:replyCode})}}};
  auth={tenantAccessToken:{internal:async()=>({code:0})}};
  application={v7:{applicationConfig:{patch:async a=>{configs.push(a);return {code:0};}},applicationPublish:{create:async a=>{publishes.push(a);return {code:0};}}}};
 },
 EventDispatcher:class{register(){return this;}},adaptExpress:()=>async(_req,res)=>res.json({}),
};
const f=await fixture({after:fn=>cleanup.push(fn)},{channels:{feishuPersonal:{enabled:true,publicOrigin:'https://bank.test',sdk}}});
f.app.use(express.static(resolve('dist')));f.app.get('/{*path}',(_,res)=>res.sendFile(resolve('dist/index.html')));
const base=f.url.replace(/\/api$/,'');await mkdir('test-results',{recursive:true});let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:430,height:932}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.request.post(base+'/api/auth/login',{data:{phone:'13800138000',password:'Bank123456'}});await page.goto(base+'/#channels');
 const card=page.locator('section.card').filter({has:page.getByRole('heading',{name:'飞书机器人',exact:true})});
 await card.locator('input[name="pin"]').fill('123456');await card.getByRole('button',{name:'一键创建我的飞书机器人'}).click();
 await page.getByAltText('飞书专属机器人创建二维码').waitFor();await page.screenshot({path:'test-results/feishu-qr-mobile.png'});
 approve({client_id:'cli_ui',client_secret:'ui-private',user_info:{open_id:'ou_ui'}});
 await card.getByText('已绑定你的飞书专属机器人，可在飞书与它私聊。',{exact:true}).waitFor();
 assert.equal(configs.length,1);assert.equal(publishes.length,1);assert.equal(configs[0].data.event.subscription_type,'webhook');
 const binding=f.bank.get("SELECT * FROM channel_bindings WHERE external_id='ou_ui'");assert.equal(binding.status,'active');
 replyCode=230002;f.queue.push(llm([],'本次查询余额为 ¥123.45。'));
 f.channels.feishuPipeline.ingest({binding,externalId:binding.external_id,messageId:'ui-result',text:'查余额'});await f.channels.feishuPipeline.drain();
 const recent=page.locator('section.card').filter({has:page.getByRole('heading',{name:'最近的飞书请求',exact:true})});
 await recent.getByRole('button',{name:/查看结果/}).click();
 await page.getByRole('heading',{name:'飞书请求结果',exact:true,level:2}).waitFor();
 await page.getByText('结果保存在 App，飞书送达暂未确认。无需重复提交业务。').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'test-results/feishu-result-mobile.png'});
 const resultUrl=page.url();await page.request.post(base+'/api/auth/logout',{data:{}});await page.reload();
 await page.getByTestId('login-submit').waitFor();await page.locator('input[name="phone"]').fill('13800138000');await page.locator('input[name="password"]').fill('Bank123456');await page.getByTestId('login-submit').click();
 await page.getByRole('heading',{name:'飞书请求结果',exact:true,level:2}).waitFor();assert.equal(page.url(),resultUrl);assert.deepEqual(errors,[]);
 console.log('UI PASS: scan-to-create flow, automatic webhook configuration and publication, recent requests, failed delivery fallback, login deep link; no page errors or mobile overflow.');
}finally{await browser?.close();for(const fn of cleanup.reverse())await fn();}
