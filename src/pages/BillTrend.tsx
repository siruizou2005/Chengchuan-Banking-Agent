import { useId, useState } from 'react';
import { smoothPath } from './homeData';
import { money, type BillPoint } from './billData';

export function BillTrend({ points, monthly, masked, empty }: { points: BillPoint[]; monthly: boolean; masked: boolean; empty: boolean }) {
  const [index, setIndex] = useState<number | null>(null);
  const id = useId();
  if (masked || empty || !points.length) return <div className="bill-chart-empty">{masked ? '消费走势已隐藏' : '该时段暂无消费记录'}</div>;
  const values = points.map(p => p.consumption);
  const min = Math.min(0, ...values), max = Math.max(100, ...values);
  const x = (i: number) => points.length === 1 ? 185 : 45 + i * 295 / (points.length - 1);
  const y = (n: number) => 150 - (n - min) / (max - min) * 118;
  const path = smoothPath(values.map((n, i) => ({ x: x(i), y: y(n) })));
  const ticks = new Set(Array.from({ length: 6 }, (_, i) => Math.round(i * (points.length - 1) / 5)));
  const point = index === null ? null : points[index];
  const label = (key: string) => monthly ? key.slice(2).replace('-', '/') : key.slice(5).replace('-', '/');
  function select(clientX: number, rect: DOMRect) {
    setIndex(Math.max(0, Math.min(points.length - 1, Math.round(((clientX - rect.left) / rect.width * 348 - 45) / 295 * (points.length - 1)))));
  }
  return <div className="bill-plot">
    <output aria-live="polite">{point ? point.key + '　' + money(point.consumption, false) : monthly ? '近六个月 · 元' : '每日消费 · 元'}</output>
    <svg viewBox="0 0 348 173" preserveAspectRatio="none" role="slider" tabIndex={0} aria-label="消费趋势，使用方向键查看金额" aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={index ?? 0}
      aria-valuetext={point ? point.key + ' ' + money(point.consumption, false) : '选择日期查看金额'}
      onPointerDown={e => select(e.clientX, e.currentTarget.getBoundingClientRect())}
      onPointerMove={e => { if (e.pointerType === 'mouse' || e.buttons) select(e.clientX, e.currentTarget.getBoundingClientRect()); }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setIndex(Math.max(0, Math.min(points.length - 1, (index ?? 0) + (e.key === 'ArrowRight' ? 1 : -1)))); } }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#456be6" stopOpacity=".24" /><stop offset="1" stopColor="#456be6" stopOpacity=".03" /></linearGradient></defs>
      {[0, .25, .5, .75, 1].map(t => { const n = min + (max - min) * t; return <g key={t}><line x1="45" x2="340" y1={y(n)} y2={y(n)} /><text x="40" y={y(n) + 3} textAnchor="end">{+(n / 100).toFixed(1)}</text></g>; })}
      <path d={path + ' L' + x(points.length - 1) + ',' + y(0) + ' L' + x(0) + ',' + y(0) + 'Z'} fill={'url(#' + id + ')'} />
      <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2" />
      {[...ticks].map(i => <text key={i} x={x(i)} y="168" textAnchor={i === points.length - 1 ? 'end' : 'middle'}>{label(points[i].key)}</text>)}
      {(point || points.length === 1) && <circle cx={x(index ?? 0)} cy={y(values[index ?? 0])} r="3.5" fill="white" stroke="var(--brand)" strokeWidth="2" />}
    </svg>
  </div>;
}
