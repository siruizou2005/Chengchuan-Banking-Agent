// npm run build first. Uses an isolated in-memory bank, never the user's DB.
// Point PLAYWRIGHT_PACKAGE to an existing Playwright package.json if necessary.
import { createApp } from '../server/app.mjs';
import express from 'express';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || resolve('node_modules/playwright/package.json'));
const { chromium } = require('playwright');
const requests = [];
let nextTool = null;
const instance = createApp(':memory:', { products: { remote: false }, chat: {
  config: () => ({ apiKey: 'test', baseUrl: 'https://llm.test/v1', model: 'test-model' }),
  fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (nextTool) { const args = nextTool; nextTool = null; return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'inline-transfer', type: 'function', function: { name: 'propose_transfer', arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 12 } }); }
    return Response.json({ choices: [{ message: { role: 'assistant', content: '已收到你的账单分析请求。\n\n[查看筛选流水](#ledger?from=2026-01-01&to=2026-12-31&q=内嵌回归)' } }], usage: { total_tokens: 12 } });
  },
} });
instance.app.use(express.static(resolve('dist')));
const server = instance.app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const findings = [];
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } }, configurable: true }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.request.post(`${base}/api/auth/login`, { data: { phone: '13800138000', password: 'Bank123456' } });
  const snapshot = await (await page.request.get(`${base}/api/dashboard`)).json();
  const home = async () => { await page.goto(`${base}/#home`); await page.locator('.cc-feature-grid').waitFor(); };
  const feature = async id => { await page.getByTestId(`feature-${id}`).click(); await page.getByTestId('inline-workspace').waitFor(); };
  const noOverlay = async () => {
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(new URL(page.url()).hash, '#home');
    assert.equal(await page.getByTestId('inline-workspace').count(), 1);
  };
  const noOverflow = async label => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow: ${label}`);
    const overflowing = await page.locator('.cc-home').evaluate(el => [...el.querySelectorAll('*')].filter(n => n instanceof HTMLElement && n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible').map(n => n.className));
    assert.deepEqual(overflowing, [], `inner overflow: ${label}`);
  };
  mkdirSync('test-results/chengchuan', { recursive: true });
  await home();
  assert.equal(await page.locator('.cc-feature-grid button').count(), 8);
  assert.equal(await page.locator('.home-flow-chart').count(), 0);
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 }); await noOverflow(`home ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.cc-opportunities').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.locator('.cc-opportunities').screenshot({ path: `test-results/chengchuan/opportunities-${width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/chengchuan/home.png', fullPage: true });
  await page.screenshot({ path: 'test-results/chengchuan/home-first-screen.png' });
  for (const id of ['accounts', 'wealth', 'transfer', 'credit', 'loan', 'life', 'ledger', 'services']) {
    await feature(id); await noOverlay();
    assert.equal(await page.locator('.cc-feature[aria-expanded="true"]').count(), 1);
    const position = await page.evaluate(() => ({ grid: document.querySelector('.cc-feature-grid').getBoundingClientRect().bottom, workspace: document.querySelector('.cc-workspace').getBoundingClientRect().top }));
    assert.ok(position.workspace >= position.grid, 'workspace follows grid in document flow');
    await page.waitForTimeout(250);
    await noOverflow(id);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `test-results/chengchuan/${id}.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 740 }); await noOverflow(`${id} 320`);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  findings.push('8 features: single selection, same home hash, normal DOM flow, no dialog, no overflow at 320/390px');
  await page.getByTestId('inline-workspace').getByRole('button', { name: /全部服务/ }).click();
  await page.getByRole('textbox', { name: '搜索服务' }).fill('转账');
  await page.getByTestId('inline-workspace').getByRole('button', { name: '转账汇款', exact: true }).waitFor();
  await noOverlay();
  await page.getByRole('button', { name: '收起功能', exact: true }).click();
  await page.getByTestId('inline-workspace').waitFor({ state: 'detached' });
  for (const [label, predicate] of [['稳健优选', p => p.riskLevel != null && p.riskLevel <= 2], ['全球视野', p => p.category === 'qdii'], ['流动性管理', p => p.category === 'money']]) {
    await page.locator('.cc-opportunities').getByRole('button', { name: new RegExp(label) }).click();
    await page.getByTestId('funds-list').waitFor(); await noOverlay();
    const shown = await page.getByTestId('funds-list').locator('[data-testid^="product-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid.slice(8)).sort());
    const expected = snapshot.products.filter(p => p.type === 'wealth' && predicate(p)).map(p => p.id).sort();
    assert.deepEqual(shown, expected, `${label} uses actual product data`);
  }
  findings.push('Supplied image assets load; More service search and all three wealth entry filters use existing services/products');
  await feature('accounts');
  const total = snapshot.accounts.reduce((s, a) => s + a.balance, 0) + snapshot.holdings.reduce((s, h) => s + h.value, 0);
  assert.equal(await page.getByTestId('total-assets').innerText(), (total / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  await page.getByRole('button', { name: '隐藏金额', exact: true }).click();
  assert.equal(await page.getByTestId('total-assets').innerText(), '******');
  await page.getByRole('button', { name: '显示金额', exact: true }).click();
  await page.getByRole('tab', { name: '交易分析', exact: true }).click();
  await page.locator('.home-flow-chart').waitFor(); await noOverlay();
  findings.push('Account totals use server snapshot; balance hiding and preserved cash-flow analysis work');

  await feature('transfer');
  const recipient = snapshot.payees[0];
  await page.locator('input[name="recipientName"]').fill(recipient.name);
  await page.locator('input[name="recipientAccount"]').fill(recipient.number);
  await page.locator('input[name="amount"]').fill('1');
  await page.locator('input[name="note"]').fill('内嵌回归');
  await page.getByTestId('nav-assistant').click();
  await page.getByTestId('nav-home').click();
  assert.equal(await page.locator('input[name="note"]').inputValue(), '内嵌回归');
  await page.getByTestId('create-transfer').click();
  await page.getByTestId('confirm-transaction').waitFor(); await noOverlay();
  const txId = await page.getByTestId('transaction-id').innerText();
  const tx = instance.bank.get('SELECT * FROM transactions WHERE id=?', txId);
  assert.equal(tx.status, 'pending');
  const before = instance.bank.get('SELECT balance FROM accounts WHERE id=?', tx.account_id).balance;
  await page.getByTestId('confirm-transaction').click();
  await page.locator('.inline-surface input[name="pin"]').waitFor(); await noOverlay();
  await page.locator('.inline-surface input[name="pin"]').fill('000000');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await page.getByTestId('confirm-transaction').waitFor();
  assert.equal(instance.bank.get('SELECT status FROM transactions WHERE id=?', txId).status, 'pending');
  assert.equal(instance.bank.get('SELECT balance FROM accounts WHERE id=?', tx.account_id).balance, before);
  await page.getByTestId('confirm-transaction').click();
  await page.locator('.inline-surface input[name="pin"]').fill('123456');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await page.getByTestId('transaction-status').filter({ hasText: '交易成功' }).waitFor(); await noOverlay();
  assert.equal(instance.bank.get('SELECT balance FROM accounts WHERE id=?', tx.account_id).balance, before - 100);
  await page.screenshot({ path: 'test-results/chengchuan/transfer-result.png', fullPage: true });
  findings.push('Transfer draft survives Agent tab; pending reservation, incorrect PIN rejection, correct PIN execution and receipt remain inline');

  await feature('wealth');
  await page.getByTestId('inline-workspace').getByRole('button', { name: '定期存款', exact: true }).click();
  await page.locator('[data-testid^="product-"]').first().click();
  await page.locator('.inline-surface input[name="amount"]').waitFor(); await noOverlay();
  findings.push('Wealth product details and subscription form reuse existing components inline');
  await feature('credit');
  await page.getByTestId('credit-repay').click();
  await page.locator('.inline-surface input[name="amount"]').fill('1');
  await page.locator('.inline-surface').getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByTestId('confirm-transaction').waitFor(); await noOverlay();
  await page.getByTestId('cancel-transaction').click();
  await page.getByTestId('transaction-status').filter({ hasText: '已取消' }).waitFor();
  await feature('loan');
  await page.locator('input[name="amount"]').fill('1000');
  await page.getByRole('checkbox').check();
  await page.getByTestId('apply-loan').click();
  await page.getByTestId('confirm-transaction').waitFor(); await noOverlay();
  await page.getByTestId('confirm-transaction').click();
  await page.getByRole('button', { name: '开始验证并发送模拟手机验证码' }).waitFor(); await noOverlay();
  await page.getByRole('button', { name: '开始验证并发送模拟手机验证码' }).click();
  await page.getByRole('button', { name: '开启摄像头并采集' }).click();
  await page.getByRole('button', { name: '记录降级并继续模拟手机验证码' }).click();
  const verificationNotice = instance.bank.get("SELECT body FROM notifications WHERE title='模拟手机验证码' ORDER BY rowid DESC LIMIT 1");
  await page.locator('.inline-surface input[name="code"]').fill(verificationNotice.body.match(/验证码 (\d{6})/)[1]);
  await page.getByRole('button', { name: '验证并继续输入支付密码' }).click();
  await page.locator('.inline-surface input[name="pin"]').fill('123456');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await page.getByTestId('transaction-status').filter({ hasText: '交易成功' }).waitFor(); await noOverlay();
  assert.equal(instance.bank.get('SELECT COUNT(*) AS count FROM loans').count, 1);
  findings.push('Credit repayment draft/cancellation; loan completes the existing camera fallback, OTP, PIN and execution flow inline');
  await feature('life');
  await page.getByTestId('inline-workspace').getByRole('button', { name: /网点预约/ }).first().click();
  await page.locator('select[name="branch"]').waitFor(); await noOverlay();
  await page.locator('input[name="date"]').fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: '确认预约', exact: true }).click();
  await page.getByText('已预约', { exact: true }).waitFor();
  findings.push('Life appointment reaches existing API and renders server status inline');
  await feature('services');
  await page.getByTestId('inline-workspace').getByRole('button', { name: /消息渠道绑定/ }).click();
  await page.getByRole('button', { name: /飞书 Bot 绑定/ }).click();
  await page.getByText('飞书专属机器人尚未开启。', { exact: true }).waitFor(); await noOverlay();
  assert.equal(await page.getByRole('button', { name: '一键创建我的飞书机器人' }).isDisabled(), true);
  await page.getByRole('button', { name: /微信 Bot 绑定/ }).click();
  await page.getByText('微信渠道尚未开启。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '连接我的微信助手' }).isDisabled(), true);
  findings.push('Unconfigured Bot channels show actual disabled state, not a fabricated binding result');

  await page.getByRole('textbox', { name: '向 Agent 提问' }).fill('帮我分析本月账单');
  await page.getByRole('button', { name: '发送给智能助手' }).click();
  await page.getByText('已收到你的账单分析请求。', { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  await page.getByRole('link', { name: '查看筛选流水' }).click();
  await page.getByRole('textbox', { name: '搜索交易' }).waitFor(); await noOverlay();
  assert.equal(await page.getByRole('textbox', { name: '搜索交易' }).inputValue(), '内嵌回归');
  nextTool = { recipient: instance.services.resolveRecipients(instance.bank.get("SELECT * FROM users WHERE phone='13800138000'"), { name: recipient.name })[0].recipient, amount: '1', note: 'Agent内嵌' };
  await page.getByTestId('nav-home').click();
  await page.getByRole('textbox', { name: '向 Agent 提问' }).fill('给陈屿转1元，生成待确认提议');
  await page.getByRole('button', { name: '发送给智能助手' }).click();
  const actionCard = page.locator('.assistant-slot').getByTestId('agent-action');
  await actionCard.getByRole('button', { name: /^(确认操作|前往验证)$/ }).click();
  await page.getByTestId('inline-workspace').getByTestId('agent-action').waitFor(); await noOverlay();
  assert.equal(await page.getByTestId('feature-transfer').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByTestId('transfer-form').count(), 0);
  const proposal = instance.bank.get("SELECT id FROM agent_actions WHERE tool='propose_transfer'");
  assert.ok(proposal);
  assert.equal(instance.bank.get("SELECT COUNT(*) AS count FROM agent_actions WHERE tool='propose_transfer'").count, 1);
  await page.goto(`${base}/#transfer?action=${proposal.id}`);
  await page.locator('[data-testid="agent-action"]:visible').waitFor();
  findings.push('Home prompts use existing Agent adapter; real tool proposal opens transfer inline once and keeps deep link compatibility');

  for (const route of ['accounts', 'transfer', 'wealth', 'credit', 'loan', 'life', 'channels', 'services', 'security', 'messages', 'personalization']) {
    await page.goto(`${base}/#${route}`); await page.locator('.page-header').waitFor();
    assert.equal(new URL(page.url()).hash, `#${route}`);
  }
  await home();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await feature('accounts');
  assert.equal(await page.locator('.cc-expansion').evaluate(el => getComputedStyle(el).transitionDuration), '1e-05s');
  await page.getByTestId('feature-accounts').click();
  await page.getByTestId('inline-workspace').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  findings.push('Original deep links, repeated selection collapse, reduced motion and browser runtime checks pass');
  writeFileSync('test-results/chengchuan/browser-checks.json', JSON.stringify({ findings, errors }, null, 2));
  console.log(findings.join('\n'));
} catch (error) {
  if (page) { await page.screenshot({ path: 'test-results/chengchuan/failure.png', fullPage: true }); console.error((await page.locator('.cc-workspace').innerText().catch(() => '')).slice(-4000)); }
  throw error;
} finally {
  await browser?.close(); await instance.channels.stop();
  await new Promise(r => server.close(r)); instance.bank.db.close();
}
