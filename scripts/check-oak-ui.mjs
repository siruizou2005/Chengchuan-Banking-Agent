// UI regression with an isolated in-memory bank and a deterministic chat provider.
// Run after npm run build; PLAYWRIGHT_PACKAGE may point to an existing installation.
import { createApp } from '../server/app.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || resolve('node_modules/playwright/package.json'));
const { chromium } = require('playwright');
const instance = createApp(':memory:', { products: { remote: false }, chat: {
  config: () => ({ apiKey: 'test', baseUrl: 'https://llm.test/v1', model: 'test-model' }),
  fetch: async () => Response.json({ choices: [{ message: { role: 'assistant', content: '可以为你解释网点预约流程。' } }], usage: { total_tokens: 12 } }),
} });
instance.app.use(express.static(resolve('dist')));
const server = instance.app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], layoutIssues = []; page.on('pageerror', e => { errors.push(e.message); console.error('Page error:', page.url(), e.message); });
  await page.request.post(`${base}/api/auth/login`, { data: { phone: '13800138000', password: 'Bank123456' } });
  const snapshot = await (await page.request.get(`${base}/api/dashboard`)).json();
  const go = async route => { await page.goto(`${base}/#${route}`); await page.locator('.bottom-nav').waitFor(); };
  mkdirSync('test-results', { recursive: true });
  for (const route of ['wealth', 'assistant', 'life', 'profile']) {
    await go(route);
    for (const width of [320, 375, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflow at ${width}`);
      const overflow = await page.locator(route === 'assistant' ? '.assistant-page' : '.oak-page').evaluate(el => [...el.querySelectorAll('*')].filter(n => n instanceof HTMLElement && n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible').map(n => n.className));
      if (overflow.length) layoutIssues.push({ route, width, overflow });
      if (width === 320) await page.screenshot({ path: `test-results/oak-${route}-320.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `test-results/oak-${route}.png`, fullPage: true });
    await page.screenshot({ path: `test-results/oak-${route}-first-screen.png` });
    assert.equal(await page.locator('[data-testid="nav-assistant"] .agent-mark').count(), 1);
    assert.equal(await page.locator(`.botanical-${route}`).count(), 1);
    assert.equal(await page.locator('.surface-signature').count(), route === 'wealth' ? 1 : 0, 'one financial focal point, no repeated signature finish');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const moving = await page.locator(route === 'assistant' ? '.assistant-page' : '.oak-page').evaluate(el => [...el.querySelectorAll('*')].filter(n => {
      const style = getComputedStyle(n);
      return style.transitionDuration.split(',').some(v => parseFloat(v) > 0) || style.animationName !== 'none';
    }).map(n => n.className));
    assert.deepEqual(moving, [], `${route} respects reduced motion`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  // Directly loaded business routes must inherit the correct theme and navigation.
  const groups = {
    home: ['transfer', 'ledger', 'receive', 'scan', 'services', 'search'],
    wealth: ['deposit', 'funds', 'risk', 'advice', 'loan', 'credit'],
    life: ['appointments', 'support'],
    profile: ['accounts', 'security', 'messages', 'agent', 'transactions', 'payees', 'personalization', 'channels'],
    assistant: ['tasks', 'feishu-requests', 'wechat-requests'],
  };
  for (const [theme, routes] of Object.entries(groups)) for (const route of routes) {
    await go(route);
    assert.equal(await page.locator('.bank-theme').getAttribute('data-theme'), theme, `${route} theme`);
    assert.equal(await page.getByTestId(`nav-${theme}`).getAttribute('aria-current'), 'page', `${route} navigation`);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflow at ${width}`);
      const overflow = await page.locator('.app-shell > .page').evaluate(el => [...el.querySelectorAll('*')].filter(n => n instanceof HTMLElement && n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible').map(n => n.className));
      if (overflow.length) layoutIssues.push({ route, width, overflow });
    }
    if (['deposit', 'risk', 'advice', 'accounts', 'security', 'personalization', 'appointments', 'tasks', 'transfer', 'channels'].includes(route)) {
      await page.screenshot({ path: `test-results/oak-${route}.png` });
    }
  }
  assert.deepEqual(layoutIssues, [], 'all routes fit narrow screens');
  await go('wealth');
  const principal = snapshot.holdings.reduce((sum, h) => sum + h.principal, 0);
  assert.equal(await page.getByTestId('wealth-principal').textContent(), `¥${(principal / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  await page.locator('.wealth-overview button').click(); await page.waitForURL('**/#risk');
  await go('wealth');
  // Explicit test fixture: a rise followed by a loss must remain a falling line.
  await page.route('**/api/market/*/history?*', route => route.fulfill({ json: {
    metric: '收盘', unit: '点', source: 'UI test fixture', updatedAt: null, stale: false, notice: null,
    points: [{ date: '2026-10-19', value: 100 }, { date: '2026-10-20', value: 105 }, { date: '2026-10-21', value: 95 }],
  } }));
  await page.locator('.market-strip button').first().click();
  await page.locator('.nav-chart .series').waitFor();
  assert.equal(await page.getByRole('dialog').evaluate(el => getComputedStyle(el).getPropertyValue('--accent').trim()), '#416c53', 'wealth dialog inherits theme');
  await page.screenshot({ path: 'test-results/oak-wealth-dialog.png' });
  const chartPath = await page.locator('.nav-chart .series').getAttribute('d');
  const coordinates = chartPath.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(coordinates[3] < coordinates[1] && coordinates[5] > coordinates[1], 'chart must preserve both rise and loss');
  assert.deepEqual(await page.locator('.nav-chart tbody td:nth-child(2)').allTextContents(), ['100.00', '105.00', '95.00']);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute('**/api/market/*/history?*');
  await page.getByTestId('advice-entry').click(); await page.waitForURL('**/#advice');
  await go('life');
  await page.getByRole('button', { name: '水费', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('dialog').evaluate(el => getComputedStyle(el).getPropertyValue('--accent').trim()), '#94664e', 'payment dialog inherits life theme');
  assert.equal(await page.getByRole('dialog').locator('.surface-satin, .surface-signature').count(), 0, 'payment form remains matte');
  await page.screenshot({ path: 'test-results/oak-life-dialog.png' });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '网点预约', exact: true }).click(); await page.waitForURL('**/#appointments');
  await go('life'); await page.getByTestId('life-assistant').click(); await page.waitForURL('**/#assistant');
  await page.getByRole('textbox', { name: '消息', exact: true }).focus();
  assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).evaluate(el => document.activeElement === el && getComputedStyle(el).outlineStyle !== 'none'), true, 'composer has visible keyboard focus');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('如何预约网点？');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('可以为你解释网点预约流程。', { exact: true }).waitFor();
  assert.equal(await page.locator('.agent-welcome').count(), 0);
  for (const [name, route] of [['安全中心', 'security'], ['个性化与记忆', 'personalization'], ['消息渠道绑定', 'channels'], ['智能助手操作与计划', 'tasks']]) {
    await go('profile'); await page.getByRole('button', { name, exact: false }).click(); await page.waitForURL(`**/#${route}`);
  }
  await go('home'); assert.equal(await page.locator('.home-mode.oak-mode').count(), 0);
  await page.locator('.home-dashboard').waitFor();
  await page.screenshot({ path: 'test-results/oak-home-baseline.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: four primary pages, 25 business routes, six widths, material hierarchy, reduced motion, keyboard focus, botanical art, themed dialogs, shared Agent identity, principal, falling chart, chat and settings.');
} finally {
  await browser?.close();
  await instance.channels.stop();
  await new Promise(r => server.close(r));
  instance.bank.db.close();
}
