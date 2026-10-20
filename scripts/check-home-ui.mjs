// Run after npm run build. PLAYWRIGHT_PACKAGE points to an existing Playwright installation.
import { createApp } from '../server/app.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || resolve('node_modules/playwright/package.json'));
const { chromium } = require('playwright');
const requests = [];
const instance = createApp(':memory:', {
  products: { remote: false },
  chat: {
    config: () => ({ apiKey: 'test', baseUrl: 'https://llm.test/v1', model: 'test-model' }),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { role: 'assistant', content: '已收到您的问题，请继续描述您希望了解的账单范围。' } }], usage: { total_tokens: 12 } });
    },
  },
});
instance.app.use(express.static(resolve('dist')));
const server = instance.app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.request.post(`${base}/api/auth/login`, { data: { phone: '13800138000', password: 'Bank123456' } });
  const snapshot = await (await page.request.get(`${base}/api/dashboard`)).json();
  const home = async () => { await page.goto(`${base}/#home`); await page.locator('.home-flow-chart').waitFor(); };
  await home();
  const total = snapshot.accounts.reduce((s, a) => s + a.balance, 0) + snapshot.holdings.reduce((s, h) => s + h.principal, 0);
  assert.equal(await page.getByTestId('total-assets').textContent(), `¥${money(total)}`);
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
    const overflowing = await page.locator('.home-dashboard').evaluate(el => [...el.querySelectorAll('*')].filter(n => {
      if (!(n instanceof HTMLElement) || n.classList.contains('sr-only')) return false;
      return n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible';
    }).map(n => n.className));
    assert.deepEqual(overflowing, [], `inner overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
  await page.screenshot({ path: 'test-results/home-first-screen.png' });
  const chart = page.getByRole('slider');
  await chart.focus(); await chart.press('Home');
  assert.equal(await chart.getAttribute('aria-valuenow'), '0');
  await chart.press('ArrowRight');
  assert.equal(await chart.getAttribute('aria-valuenow'), '1');
  await chart.press('Escape');
  await page.getByRole('button', { name: '隐藏金额', exact: true }).click();
  assert.equal(await page.locator('.home-flow-chart, .flow-card table').count(), 0);
  assert.equal(await page.getByTestId('total-assets').innerText(), '••••');
  assert.ok(!(await page.locator('.home-dashboard').innerText()).includes(money(total)));
  await page.reload(); await page.getByRole('button', { name: '显示金额', exact: true }).click();
  await page.locator('.home-flow-chart').waitFor();
  const rangeResponse = page.waitForResponse(r => r.url().includes('/api/ledger?'));
  await page.getByRole('button', { name: '本月', exact: true }).click();
  const rows = await (await rangeResponse).json();
  const counted = rows.filter(r => r.kind !== 'opening');
  const income = counted.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  await page.waitForFunction(expected => document.querySelector('[data-testid="flow-income"]')?.textContent === expected, `¥${money(income)}`);

  // A real server-side ledger change must update totals through the existing dashboard polling.
  const user = instance.bank.get("SELECT * FROM users WHERE phone='13800138000'");
  const account = instance.bank.get('SELECT * FROM accounts WHERE user_id=?', user.id);
  instance.bank.post('home-ui-refresh', 'system', account.id, 12345, '首页刷新验证', 'income');
  await page.waitForFunction(expected => document.querySelector('[data-testid="flow-income"]')?.textContent === expected, `¥${money(income + 12345)}`, { timeout: 40000 });
  assert.equal(await page.getByTestId('total-assets').textContent(), `¥${money(total + 12345)}`);

  // Existing routes remain reachable, including all sixteen original services.
  for (const [name, route] of [['转账', 'transfer'], ['收款码', 'receive'], ['交易记录', 'ledger'], ['扫一扫', 'scan'], ['全部服务', 'services']]) {
    await home(); await page.getByRole('button', { name, exact: true }).click();
    await page.waitForURL(`**/#${route}`);
  }
  assert.equal(await page.locator('.entry-grid .tile').count(), 16);
  for (const [name, route] of [['配置建议', 'advice'], ['操作计划', 'tasks'], ['管理', 'accounts'], ['信用卡待还', 'credit'], ['贷款待还本金', 'loan']]) {
    await home(); await page.getByRole('button', { name, exact: name === '管理' || name === '配置建议' || name === '操作计划' }).click();
    await page.waitForURL(`**/#${route}`);
  }
  await home(); await page.locator('.home-transaction').first().click();
  await page.waitForURL('**/#ledger?**');
  assert.ok(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('q'));
  await page.locator('.row').filter({ hasText: '首页刷新验证' }).first().waitFor();
  for (const route of ['home', 'wealth', 'assistant', 'life', 'profile']) {
    await page.getByTestId(`nav-${route}`).click(); await page.waitForURL(`**/#${route}`);
  }
  await home(); await page.getByRole('button', { name: '问问助手', exact: true }).click();
  await page.locator('textarea').fill('帮我分析本月账单');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('已收到您的问题，请继续描述您希望了解的账单范围。').waitFor();
  assert.equal(requests.length, 1);

  // Direct transfer still creates a pending transaction and requires the existing confirmation screen.
  await home(); await page.getByTestId('quick-transfer').click();
  await page.locator('input[name="recipientName"]').fill('陈屿');
  await page.locator('input[name="recipientAccount"]').fill('6218808888000088096');
  await page.locator('input[name="amount"]').fill('1');
  await page.getByTestId('create-transfer').click();
  await page.getByTestId('confirm-transaction').waitFor();
  assert.equal(instance.bank.get('SELECT balance FROM accounts WHERE id=?', account.id).balance, account.balance + 12345);
  await page.getByTestId('cancel-transaction').click();
  await page.getByTestId('transaction-status').filter({ hasText: '已取消' }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  // Loading, empty, error/retry and truncated responses must not leave misleading totals.
  let mode = 'empty';
  await page.route('**/api/ledger?**', route => mode === 'error'
    ? route.fulfill({ status: 503, json: { error: { message: '测试：暂时无法连接' } } })
    : route.fulfill({ json: mode === 'limit' ? Array.from({ length: 2000 }, () => rows[0]) : [] }));
  await page.goto(`${base}/#home`); await page.getByText('这段时间暂无收支记录', { exact: true }).waitFor();
  mode = 'error'; await page.getByRole('button', { name: '3月', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '测试：暂时无法连接' }).waitFor();
  mode = 'limit'; await page.getByRole('button', { name: '重新加载', exact: false }).click();
  await page.getByText('该时段流水较多，请缩短时段或前往交易记录查看。', { exact: true }).waitFor();
  await page.unroute('**/api/ledger?**');
  await page.getByRole('button', { name: '重新加载', exact: false }).click();
  await page.locator('.home-flow-chart').waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Home browser checks passed: six viewport widths, server totals and live refresh, range and keyboard chart interaction, privacy, routes, Agent adapter, pending transfer/cancellation, empty/error/retry/truncation.');
} finally {
  await browser?.close();
  await instance.channels.stop();
  await new Promise(r => server.close(r));
  instance.bank.db.close();
}
