import type { Ledger } from '../types';

export type FlowPoint = { key: string; label: string; income: number; expense: number; count: number };
export const beijingDay = (now = new Date()) => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);

// Calendar months, including the current incomplete month; all API amounts stay in cents.
export function flowRange(months: number, today: string) {
  const [year, month] = today.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - months, 1));
  return { from: start.toISOString().slice(0, 10), to: today };
}

export function aggregateFlow(rows: Ledger[], from: string, to: string, daily: boolean): FlowPoint[] {
  const points: FlowPoint[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= to) {
    const day = cursor.toISOString().slice(0, 10), key = daily ? day : day.slice(0, 7);
    points.push({ key, label: daily ? `${+day.slice(5, 7)}/${+day.slice(8, 10)}` : `${+day.slice(5, 7)}月`, income: 0, expense: 0, count: 0 });
    if (daily) cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const byKey = new Map(points.map(p => [p.key, p]));
  for (const row of rows) {
    if (row.kind === 'opening' || row.category === 'opening' || row.title === '模拟开户资金') continue;
    const day = row.bj_time?.slice(0, 10) || beijingDay(new Date(row.created_at));
    if (day < from || day > to) continue;
    const point = byKey.get(daily ? day : day.slice(0, 7));
    if (!point) continue;
    if (row.amount > 0) point.income += row.amount;
    else point.expense -= row.amount;
    point.count++;
  }
  return points;
}

// Horizontal tangents keep the gentle interpolation inside each pair's actual values.
export function smoothPath(points: { x: number; y: number }[]) {
  return points.map((p, i) => {
    if (!i) return `M${p.x},${p.y}`;
    const previous = points[i - 1], mid = (previous.x + p.x) / 2;
    return `C${mid},${previous.y} ${mid},${p.y} ${p.x},${p.y}`;
  }).join(' ');
}
