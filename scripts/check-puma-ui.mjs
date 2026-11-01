// Uses an isolated database, mock payments and an existing Playwright installation.
import { createApp } from '../server/app.mjs';
import { hash } from '../server/errors.mjs';
import { familiarTransfers } from '../tests/helpers.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||resolve('test-results/risk-browser/node_modules/playwright/package.json'));
const {chromium}=require('playwright');
let history = [];
const instance=createApp(':memory:',{products:{remote:false},risk:{transactions:()=>history},puma:{policy:{flags:{
  puma_delegate_approval:'enabled',risk_adaptive_auth:'enabled',l0_single_password:'enabled',greeting_personalization_v2:'enabled'
}}}});
instance.app.use(express.static(resolve('dist')));
const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const { user } = await (await page.request.post(base+'/api/auth/login',{data:{phone:'13800138000',password:'Bank123456'}})).json();
 await page.goto(base+'/#tasks');await page.getByRole('heading',{name:'助手控制与共同保护'}).waitFor();
 mkdirSync('test-results/puma',{recursive:true});
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}`);await page.screenshot({path:`test-results/puma/controls-${width}.png`,fullPage:true});}
 await page.getByRole('button',{name:'停止全部助手动作'}).click();await page.getByText('助手已停止',{exact:true}).waitFor();
 await page.getByLabel('支付密码',{exact:true}).first().fill('123456');await page.getByRole('button',{name:'验证并恢复助手'}).click();
 await page.getByRole('button',{name:'停止全部助手动作'}).waitFor();
 await page.getByText('个性化使用授权',{exact:true}).click();await page.getByRole('button',{name:'关闭个性化',exact:true}).click();await page.getByText('个性化使用已关闭。',{exact:true}).waitFor();
 const { documents } = await (await page.request.get(base+'/api/agent/enrollment')).json();
 assert.ok((await page.request.post(base+'/api/agent/enrollment',{data:{documents:documents.map(({id,version})=>({id,version}))}})).ok());
 assert.ok((await page.request.post(base+'/api/agent/onboarding/end',{data:{}})).ok());
 await page.goto(base+'/#assistant'); await page.reload();
 const welcome=page.locator('#msg-welcome .bubble');
 const first=await welcome.innerText(); assert.ok(first.length > 0 && first.length <= 50);
 await page.getByRole('button',{name:'新对话',exact:true}).click();
 const second=await welcome.innerText(); assert.notEqual(second,first);
 await page.reload(); assert.equal(await welcome.innerText(),second);
 const account=instance.services.accountFor(user), payee=instance.bank.get('SELECT * FROM payees WHERE user_id=? ORDER BY id LIMIT 1',user.id);
 history=familiarTransfers(user.id,account.id,hash(payee.number));
 async function openDraft(tier) {
   const r=await page.request.post(base+'/api/v1/transfers/drafts',{data:{sourceAccountRef:account.id,beneficiaryRef:payee.id,amountMinor:100,currency:'CNY'}});
   assert.ok(r.ok()); const d=await r.json(); assert.equal(d.risk.tier,tier);
   await page.goto(base+'/#risk-transfer?id='+d.id);
 }
 await openDraft('L1');
 await page.getByRole('button',{name:'信息无误，开始本人验证'}).click();
 await page.getByRole('button',{name:'开始验证并发送模拟手机验证码'}).click();
 await page.locator('input[autocomplete="one-time-code"]').fill(await page.locator('.demo-code b').innerText());
 await page.getByRole('button',{name:'验证并继续输入支付密码'}).click();
 async function pay() {
   await page.getByLabel('支付密码',{exact:true}).fill('123456');
   await page.getByRole('button',{name:'本人批准此笔模拟转账'}).click();
   await page.getByTestId('risk-transfer-done').waitFor();
 }
 await pay();
 await page.goto(base+'/#transfer');
 await page.locator('.payee').filter({hasText:payee.name}).first().click();
 await page.getByLabel('转账金额（元）',{exact:true}).fill('1.00');
 await page.getByTestId('create-transfer').click();
 await page.getByText('请核对转账信息，输入一次交易密码即可确认。',{exact:true}).waitFor();
 await pay();
 assert.deepEqual(errors,[]);console.log('PASS: layout, STOP/resume, consent, stable greetings, L1 SMS + PIN, L0 single PIN.');
}finally{await browser?.close();await instance.channels.stop();await new Promise(r=>server.close(r));instance.bank.db.close();}
