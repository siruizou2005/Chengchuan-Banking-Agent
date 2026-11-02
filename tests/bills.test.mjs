import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { billView } from '../server/agent/bill-view.mjs';
import { businessDate } from '../server/agent/policy.mjs';
import { resolvePrincipal } from '../server/agent/principal.mjs';
import { comparisonLabel, monthGrid, monthLabel, resolveMonth, yearBounds } from '../src/pages/billMonth.ts';

test('bill view shares report totals, scopes accounts and validates month', async t => {
  const f = await fixture(t, { products: { remote: false } });
  const month = businessDate().slice(0, 7);
  const { data: view, status } = await f.call('/ledger/bills?period=' + month);
  assert.equal(status, 200);
  const { data: report } = await f.call('/ledger/report?period=' + month);
  assert.deepEqual(view.totals, report.report.totals);
  const ids = new Set(f.bank.all('SELECT l.id FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=?', f.user.id).map(r => r.id));
  assert.ok(view.entries.every(r => ids.has(r.id)));
  assert.equal((await f.call('/ledger/bills?period=2026-13')).status, 400);
  assert.equal((await f.call('/ledger/bills?period=2099-01')).status, 400);
  assert.equal((await f.req('/ledger/bills', undefined)).status, 401);
});

test('monthly bill excludes transfers and future history', async t => {
  const f = await fixture(t, { products: { remote: false } });
  const account = f.services.accountFor(f.user).id;
  for (let i = 1; i <= 3; i++) f.bank.post('BILL-SMALL-' + i, account, 'system', 1000, '咖啡 · 单元测试', 'payment', '2020-06-0' + i + 'T10:00:00Z');
  f.bank.post('BILL-XFER', account, 'system', 1000, '转账 · 单元测试', 'transfer', '2020-06-01T10:00:00Z');
  f.bank.post('BILL-FUTURE', account, 'system', 1000, '咖啡 · 单元测试', 'payment', '2020-07-01T10:00:00Z');
  const view = billView(f.bank, f.services, f.user, '2020-06');
  assert.equal(view.totals.consumption, 3000);
  const empty = billView(f.bank, f.services, f.user, '2010-01');
  assert.equal(empty.totals.count, 0);
  assert.equal(empty.entries.length, 0);
});

test('confirmed memory labels honor personalization revocation and data read consent', async t => {
  const f = await fixture(t, { products: { remote: false } });
  f.services.memory.update(resolvePrincipal(f.bank, f.user), { key: 'preferred_name', value: '小川' }, { type: 'explicit' });
  const month = businessDate().slice(0, 7);
  let view = billView(f.bank, f.services, f.user, month);
  assert.match(view.labels.hidden_consumption, /小川/);
  f.services.puma.consents.update(f.user, { scope: 'personalization', granted: false });
  view = billView(f.bank, f.services, f.user, month);
  assert.deepEqual(view.labels, {});
  assert.equal(view.personalized, false);
  f.services.puma.consents.update(f.user, { scope: 'data_read', granted: false });
  assert.equal((await f.call('/ledger/bills?period=' + month)).status, 403);
  assert.equal((await f.call('/ledger/report?origin=bills&period=' + month)).status, 403);
});

test('账单月份：链接里的非法月份回到当前月，只能选有账单的月份', async t => {
  for (const bad of [null, '', 'abc', '2026-13', '2026-1', '2026-00', '2099-01', '2026-12']) assert.equal(resolveMonth(bad, '2026-11'), '2026-11', String(bad));
  assert.equal(resolveMonth('2026-10', '2026-11'), '2026-10');
  assert.equal(monthLabel('2026-09'), '2026年9月');
  const enabled = (year, first) => monthGrid(year, first, '2026-11').filter(m => m.enabled).map(m => m.value);
  assert.deepEqual(enabled(2025, '2025-11'), ['2025-11', '2025-12']);
  assert.equal(enabled(2026, '2025-11').length, 11);
  assert.ok(!enabled(2026, '2025-11').includes('2026-12'));
  assert.deepEqual(enabled(2026, null), ['2026-11']);
  assert.deepEqual(yearBounds('2025-11', '2026-11'), { min: 2025, max: 2026 });
  assert.deepEqual(yearBounds(null, '2026-11'), { min: 2026, max: 2026 });
  const f = await fixture(t, { products: { remote: false } });
  const account = f.services.accountFor(f.user).id;
  f.bank.post('BILL-FIRST', account, 'system', 100, '消费 · 最早流水', 'payment', '2020-06-01T10:00:00Z');
  const { data } = await f.call('/ledger/bills?period=' + businessDate().slice(0, 7));
  assert.equal(data.first_month, '2020-06');
});

test('未结束的月份按同期比较，已结束的月份按整月比较', () => {
  assert.equal(comparisonLabel('2026-11-01'), '较上月同期');
  assert.equal(comparisonLabel('2026-10-31'), '较上月');
  assert.equal(comparisonLabel('2026-09-30'), '较上月');
  assert.equal(comparisonLabel('2024-02-29'), '较上月');
  assert.equal(comparisonLabel('2026-02-28'), '较上月');
  assert.equal(comparisonLabel('2024-02-28'), '较上月同期');
});
