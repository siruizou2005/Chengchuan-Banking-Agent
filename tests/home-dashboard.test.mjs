import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Match the frontend's TypeScript build without adding a test runner dependency.
const source = readFileSync(new URL('../src/pages/homeData.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { beijingDay, flowRange, aggregateFlow, smoothPath } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const row = (amount, created_at, extra = {}) => ({ amount, created_at, ...extra });

test('home cash flow: Beijing date and calendar ranges cross years and leap days', () => {
  assert.equal(beijingDay(new Date('2026-09-30T16:00:00Z')), '2026-10-01');
  assert.deepEqual(flowRange(6, '2026-01-20'), { from: '2025-08-01', to: '2026-01-20' });
  assert.equal(aggregateFlow([], '2024-02-01', '2024-02-29', true).length, 29);
  assert.deepEqual(aggregateFlow([], '2026-10-01', '2026-10-01', true), [{ key: '2026-10-01', label: '10/1', income: 0, expense: 0, count: 0 }]);
});

test('home cash flow: cents, refunds, transfers, investments and opening balances match ledger direction totals', () => {
  const points = aggregateFlow([
    row(50000, '2026-10-01T00:00:00Z', { kind: 'income' }),
    row(-12345, '2026-10-01T00:00:00Z', { kind: 'consumption' }),
    row(345, '2026-10-01T00:00:00Z', { kind: 'refund' }),
    row(-2000, '2026-10-01T00:00:00Z', { kind: 'investment' }),
    row(-3000, '2026-10-01T00:00:00Z', { kind: 'transfer_out' }),
    row(999999, '2026-10-01T00:00:00Z', { kind: 'opening' }),
    row(999999, '2026-10-01T00:00:00Z', { category: 'opening' }),
    row(999999, '2026-10-01T00:00:00Z', { title: '模拟开户资金' }),
    row(999999, '2026-11-01T00:00:00Z'),
  ], '2026-09-01', '2026-10-20', false);
  assert.deepEqual(points.map(({ income, expense, count }) => ({ income, expense, count })), [
    { income: 0, expense: 0, count: 0 }, { income: 50345, expense: 17345, count: 5 },
  ]);
});

test('home cash flow: Beijing midnight attribution, current cutoff and updated values', () => {
  const rows = [row(101, '2026-09-30T15:59:59Z'), row(-202, '2026-09-30T16:00:00Z'), row(303, '2026-10-01T16:00:00Z')];
  assert.deepEqual(aggregateFlow(rows, '2026-10-01', '2026-10-01', true).map(p => [p.income, p.expense]), [[0, 202]]);
  rows[1].amount = -404;
  assert.equal(aggregateFlow(rows, '2026-10-01', '2026-10-01', true)[0].expense, 404);
  assert.equal(aggregateFlow([row(123, '2026-09-30T12:00:00Z', { bj_time: '2026-10-01' })], '2026-10-01', '2026-10-01', true)[0].income, 123);
});

test('home chart: interpolation preserves endpoints and stays within adjacent values', () => {
  const points = [{ x: 0, y: 100 }, { x: 30, y: 0 }, { x: 60, y: 90 }];
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([points[0]]), 'M0,100');
  assert.equal(smoothPath(points), 'M0,100 C15,100 15,0 30,0 C45,0 45,90 60,90');
});
