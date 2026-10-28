// npm run build first. Uses an isolated in-memory bank and an existing Playwright install.
import { createApp } from '../server/app.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || resolve('test-results/risk-browser/node_modules/playwright/package.json'));
const { chromium } = require('playwright');
const instance = createApp(':memory:', { products: { remote: false } });
instance.app.use(express.static(resolve('dist')));
const server = instance.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.request.post(base + '/api/auth/login', { data: { phone: '13800138000', password: 'Bank123456' } });
  const user = instance.bank.get('SELECT * FROM users WHERE phone=?', '13800138000');
  const recipient = instance.services.resolveRecipients(user, { name: '陈屿' })[0].recipient;
  const d = instance.services.riskDrafts.create(user, { sourceAccountRef: instance.services.accountFor(user).id, beneficiaryRef: recipient, amountMinor: 10000, currency: 'CNY', memo: '页面验证' });
  await page.goto(`${base}/#risk-transfer?id=${d.id}`);
  await page.getByRole('heading', { name: '尚未授权' }).waitFor();
  assert.ok(await page.getByText(d.beneficiaryMasked, { exact: true }).count());
  mkdirSync('test-results/risk-mvp', { recursive: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${width}`);
    await page.screenshot({ path: `test-results/risk-mvp/confirm-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('checkbox', { name: '大字与高对比显示' }).check();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/risk-mvp/accessible.png', fullPage: true });
  await page.getByRole('button', { name: '信息无误，开始本人验证' }).click();
  await page.locator('input[name="pin"]').fill('123456');
  await page.getByRole('button', { name: '本人批准此笔模拟转账' }).click();
  await page.getByRole('heading', { name: '模拟支付已完成' }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test-results/risk-mvp/settled.png', fullPage: true });
  console.log('PASS: masked trusted confirmation, 320/390/1280 layouts, accessibility mode, authenticated mock settlement; no browser errors.');
} finally { await browser?.close(); await instance.channels.stop(); await new Promise(r => server.close(r)); instance.bank.db.close(); }
