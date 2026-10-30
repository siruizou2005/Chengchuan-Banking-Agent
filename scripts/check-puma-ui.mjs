// Uses an isolated database, mock payments and an existing Playwright installation.
import { createApp } from '../server/app.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||resolve('test-results/risk-browser/node_modules/playwright/package.json'));
const {chromium}=require('playwright');
const instance=createApp(':memory:',{products:{remote:false},puma:{policy:{flags:{puma_delegate_approval:'enabled'}}}});
instance.app.use(express.static(resolve('dist')));
const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.request.post(base+'/api/auth/login',{data:{phone:'13800138000',password:'Bank123456'}});
 await page.goto(base+'/#tasks');await page.getByRole('heading',{name:'助手控制与共同保护'}).waitFor();
 mkdirSync('test-results/puma',{recursive:true});
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}`);await page.screenshot({path:`test-results/puma/controls-${width}.png`,fullPage:true});}
 await page.getByRole('button',{name:'停止全部助手动作'}).click();await page.getByText('助手已停止',{exact:true}).waitFor();
 await page.getByLabel('支付密码',{exact:true}).first().fill('123456');await page.getByRole('button',{name:'验证并恢复助手'}).click();
 await page.getByRole('button',{name:'停止全部助手动作'}).waitFor();
 await page.getByText('个性化使用授权',{exact:true}).click();await page.getByRole('button',{name:'关闭个性化',exact:true}).click();await page.getByText('个性化使用已关闭。',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: 320/390/1280 layout; STOP/resume PIN; revoke personalization; no browser errors.');
}finally{await browser?.close();await instance.channels.stop();await new Promise(r=>server.close(r));instance.bank.db.close();}
