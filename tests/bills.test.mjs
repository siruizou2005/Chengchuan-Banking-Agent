import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { billView } from '../server/agent/bill-view.mjs';
import { businessDate } from '../server/agent/policy.mjs';
import { resolvePrincipal } from '../server/agent/principal.mjs';

test('bill view shares report totals, scopes accounts and validates month', async t => {
  const f = await fixture(t, { products: { remote: false } });
  const month = businessDate().slice(0, 7);
  const { data: view, status } = await f.call('/ledger/bills?period=' + month);
  assert.equal(status, 200);
  const { data: report } = await f.call('/ledger/report?period=' + month);
  assert.deepEqual(view.totals, report.report.totals);
  const ids = new Set(f.bank.all('SELECT l.id FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=?', f.user.id).map(r => r.id));
  assert.ok(view.entries.every(r => ids.has(r.id)));
  const evidence = view.hidden.groups.flatMap(g => g.ids);
  assert.equal(evidence.length, new Set(evidence).size);
  assert.equal(view.hidden.total, view.entries.filter(r => evidence.includes(r.id)).reduce((n, r) => n - r.amount, 0));
  assert.equal((await f.call('/ledger/bills?period=2026-13')).status, 400);
  assert.equal((await f.call('/ledger/bills?period=2099-01')).status, 400);
  assert.equal((await f.req('/ledger/bills', undefined)).status, 401);
});

test('small frequent spending keeps evidence and excludes transfers and future history', async t => {
  const f = await fixture(t, { products: { remote: false } });
  const account = f.services.accountFor(f.user).id;
  for (let i = 1; i <= 3; i++) f.bank.post('BILL-SMALL-' + i, account, 'system', 1000, '咖啡 · 单元测试', 'payment', '2020-06-0' + i + 'T10:00:00Z');
  f.bank.post('BILL-XFER', account, 'system', 1000, '转账 · 单元测试', 'transfer', '2020-06-01T10:00:00Z');
  f.bank.post('BILL-FUTURE', account, 'system', 1000, '咖啡 · 单元测试', 'payment', '2020-07-01T10:00:00Z');
  const view = billView(f.bank, f.services, f.user, '2020-06');
  assert.equal(view.hidden.groups[0].amount, 0);
  assert.equal(view.hidden.groups[1].amount, 3000);
  assert.equal(view.hidden.groups[1].ids.length, 3);
  assert.equal(view.totals.consumption, 3000);
  const empty = billView(f.bank, f.services, f.user, '2010-01');
  assert.equal(empty.totals.count, 0);
  assert.equal(empty.hidden.total, 0);
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
