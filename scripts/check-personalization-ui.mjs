// Optional browser acceptance check, using a separately installed Playwright package.
import { createApp } from '../server/app.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { resolvePrincipal } from '../server/agent/principal.mjs';
import { routeBehavior } from '../server/agent/behavior-router.mjs';

const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||resolve('node_modules/playwright/package.json'));
const {chromium}=require('playwright');
const instance=createApp(':memory:');
instance.app.use(express.static(resolve('dist')));
const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.request.post(base+'/api/auth/login',{data:{phone:'13800138000',password:'Bank123456'}});
  const user=instance.bank.get("SELECT * FROM users WHERE phone='13800138000'");
  instance.services.memory.candidate(resolvePrincipal(instance.bank,user),{key:'sectors',value:'新能源',evidence:'我关注新能源'},{messageId:'ui-candidate',input:'我关注新能源'});
  const principal=resolvePrincipal(instance.bank,user);
  for(let i=0;i<3;i++){
    const sessionId=`ui-session-${i%2}`,input=`用表格比较投资产品${['甲','乙','丙'][i]}的最大回撤`;
    instance.bank.run('INSERT INTO agent_sessions(id,user_id,channel,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at',sessionId,user.id,'app',new Date().toISOString());
    instance.services.memoryEvolution.collect(principal,{input,sessionId,requestId:`ui-observation-${i}`,route:routeBehavior({text:input}),expectedEpoch:instance.services.memory.epoch(principal)});
  }
  await page.goto(base+'/#profile');await page.getByText('个性化与记忆',{exact:true}).click();
  await page.getByRole('button',{name:'确认记忆',exact:true}).click();
  await page.getByText('已确认',{exact:true}).waitFor();
  await page.getByLabel('偏好内容',{exact:true}).selectOption('详细');
  await page.getByRole('button',{name:'保存并确认',exact:true}).click();
  await page.locator('.memory-item').filter({hasText:'回答长度'}).getByText('详细',{exact:true}).waitFor();
  const item=page.locator('.memory-item').filter({hasText:'回答长度'});
  await item.getByRole('button',{name:'修改',exact:true}).click();
  await page.getByLabel('偏好内容',{exact:true}).selectOption('简短');
  await page.getByRole('button',{name:'保存并确认',exact:true}).click();
  await item.getByText('简短',{exact:true}).waitFor();
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/personalization-mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await item.getByRole('button',{name:'删除',exact:true}).click();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.memory-item')).some(e=>e.textContent.includes('回答长度')));
  await page.reload();assert.equal(await page.locator('.memory-item').filter({hasText:'回答长度'}).count(),0);
  await page.locator('.memory-item').filter({hasText:'可能偏好用表格比较方案'}).getByRole('button',{name:'拒绝这个推断',exact:true}).click();
  await page.locator('.memory-item').filter({hasText:'可能偏好先了解下行风险'}).getByRole('button',{name:'确认这个偏好',exact:true}).click();
  await page.locator('.memory-item').filter({hasText:'分析方式'}).getByText('先说明下行风险',{exact:true}).waitFor();
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/personalization-desktop.png',fullPage:true});
  await page.request.post(base+'/api/auth/logout',{data:{}});
  await page.request.post(base+'/api/auth/login',{data:{phone:'13900139000',password:'Bank123456'}});
  await page.reload();await page.getByText('还没有保存的记忆',{exact:true}).waitFor();
  assert.equal(instance.bank.get('SELECT COUNT(*) n FROM inference_calls').n,0);
  assert.deepEqual(errors,[]);console.log('Personalization browser checks passed: candidate and behavior confirmation, behavior rejection, edit, delete, reload, user isolation, mobile/desktop layout, zero inference.');
} finally { await browser?.close();await instance.channels.stop();await new Promise(r=>server.close(r));instance.bank.db.close(); }
