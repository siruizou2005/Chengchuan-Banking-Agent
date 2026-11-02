import './cash-flow.css';
import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, ChevronRight, RefreshCw } from 'lucide-react';
import { api, yuan } from '../api';
import { useBank } from '../bank';
import type { Ledger } from '../types';
import { aggregateFlow, beijingDay, flowRange, smoothPath } from './homeData';

export function HomeCashFlow() {
  const { data, hidden, navigate } = useBank(), latest = data.ledger[0]?.id;
  const [months, setMonths] = useState(6), [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ rows: Ledger[]; loading: boolean; error: string }>({ rows: [], loading: true, error: '' });
  const [selected, setSelected] = useState<number | null>(null);
  const id = useId().replace(/:/g, '');
  const today = beijingDay(), { from, to } = flowRange(months, today);
  // Reload when the range changes or a new ledger row lands; the 30s snapshot refresh alone must not reset the chart.
  useEffect(() => {
    let live = true;
    setState({ rows: [], loading: true, error: '' }); setSelected(null);
    api<Ledger[]>(`/ledger?from=${from}&to=${to}`).then(rows => {
      if (!live) return;
      // The existing endpoint caps results at 2,000. Do not chart truncated totals.
      setState(rows.length >= 2000
        ? { rows: [], loading: false, error: '该时段流水较多，请缩短时段或前往交易记录查看。' }
        : { rows, loading: false, error: '' });
    }).catch(e => live && setState({ rows: [], loading: false, error: (e as Error).message || '收支数据暂时无法加载' }));
    return () => { live = false; };
  }, [latest, from, to, retry]);
  const points = aggregateFlow(state.rows, from, to, months === 1);
  const hasData = points.some(p => p.count > 0);
  const totals = points.reduce((sum, p) => ({ income: sum.income + p.income, expense: sum.expense + p.expense }), { income: 0, expense: 0 });
  const active = selected === null ? null : points[selected];
  const shown = active || totals;
  const top = Math.max(...points.flatMap(p => [p.income, p.expense]), 100);
  const magnitude = 10 ** Math.floor(Math.log10(top));
  const max = Math.ceil(top / magnitude) * magnitude;
  const W = 336, left = 44, right = 324, bottom = 164;
  const x = (i: number) => points.length === 1 ? (left + right) / 2 : left + i / (points.length - 1) * (right - left);
  const y = (value: number) => bottom - value / max * 136;
  const tick = (value: number) => value >= 1000000 ? `${+(value / 1000000).toFixed(1)}万` : value >= 100000 ? `${+(value / 100000).toFixed(1)}千` : `${+(value / 100).toFixed(2)}`;
  const labels = [...new Set([0, Math.round((points.length - 1) / 3), Math.round(2 * (points.length - 1) / 3), points.length - 1])];
  const fmt = (value: number) => hidden ? '••••' : `¥${yuan(value)}`;
  const focus = (clientX: number, rect: DOMRect) => setSelected(Math.max(0, Math.min(points.length - 1, Math.round(((clientX - rect.left) / rect.width * W - left) / (right - left) * (points.length - 1)))));

  return <section className="home-card flow-card" aria-labelledby="flow-title">
    <div className="home-section-head"><div><h2 id="flow-title">收支流动</h2><p>{months === 1 ? '本月每日' : `近${months}个月每月`}资金往来</p></div>
      <div className="home-periods" role="group" aria-label="收支时段">{[1, 3, 6].map(n => <button key={n} aria-pressed={months === n} onClick={() => setMonths(n)}>{n === 1 ? '本月' : `${n}月`}</button>)}</div>
    </div>
    {state.loading ? <div className="home-chart-state" role="status"><RefreshCw size={20} className="spin" /><span>正在读取收支记录</span></div>
      : state.error ? <div className="home-chart-state" role="alert"><span>{state.error}</span><button className="home-text-button" onClick={() => setRetry(r => r + 1)}>重新加载 <RefreshCw size={14} /></button></div>
      : !hasData ? <div className="home-chart-state"><ArrowUpRight size={24} /><span>这段时间暂无收支记录</span><button className="home-text-button" onClick={() => navigate('ledger')}>查看其他时段 <ChevronRight size={14} /></button></div>
      : <>
        <div className="flow-summary" aria-live="polite"><div><span><i className="flow-dot in" />流入</span><strong data-testid="flow-income">{fmt(shown.income)}</strong></div><div><span><i className="flow-dot out" />流出</span><strong data-testid="flow-expense">{fmt(shown.expense)}</strong></div></div>
        <div className="flow-selection">{active ? `${active.key} · ${active.count} 笔记录` : `${from.replaceAll('-', '.')} — ${to.replaceAll('-', '.')} · 合计`}</div>
        {hidden ? <div className="home-chart-state privacy-chart">金额与收支走势已隐藏</div> : <svg className="home-flow-chart" viewBox={`0 0 ${W} 194`} role="slider" tabIndex={0} aria-label="收支图表，使用左右方向键查看各期金额" aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={selected ?? points.length - 1}
          aria-valuetext={`${(active || points.at(-1))?.key}，流入${yuan((active || points.at(-1))!.income)}元，流出${yuan((active || points.at(-1))!.expense)}元`}
          onPointerMove={e => focus(e.clientX, e.currentTarget.getBoundingClientRect())} onPointerDown={e => focus(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={e => { if (e.pointerType === 'mouse') setSelected(null); }} onBlur={() => setSelected(null)}
          onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) { e.preventDefault(); setSelected(i => e.key === 'Escape' ? null : e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (i ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }}>
          <defs>{['income', 'expense'].map(field => <linearGradient key={field} id={`${id}-${field}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={field === 'income' ? '#A8B59A' : '#8CA8B8'} stopOpacity=".38" /><stop offset="100%" stopColor={field === 'income' ? '#A8B59A' : '#8CA8B8'} stopOpacity=".02" /></linearGradient>)}</defs>
          {[0, .5, 1].map(r => <g key={r}><line x1={left} x2={right} y1={y(max * r)} y2={y(max * r)} className="flow-grid" /><text x={left - 8} y={y(max * r) + 4} textAnchor="end">{tick(max * r)}</text></g>)}
          <text x={left} y={12}>元</text>
          {(['income', 'expense'] as const).map(field => {
            const path = smoothPath(points.map((p, i) => ({ x: x(i), y: y(p[field]) })));
            return <g key={field}><path d={`${path} L${x(points.length - 1)},${bottom} L${x(0)},${bottom} Z`} fill={`url(#${id}-${field})`} /><path d={path} className={`flow-line ${field}`} />{points.length === 1 && <circle cx={x(0)} cy={y(points[0][field])} r={4} className={`flow-point ${field}`} />}</g>;
          })}
          {labels.map(i => <text key={i} x={x(i)} y={187} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>{points[i].label}</text>)}
          {active && <g><line className="flow-crosshair" x1={x(selected!)} x2={x(selected!)} y1={22} y2={bottom} />{(['income', 'expense'] as const).map(field => <circle key={field} cx={x(selected!)} cy={y(active[field])} r={5} className={`flow-point ${field}`} />)}</g>}
        </svg>}
        {!hidden && <table className="sr-only"><caption>收支流动，单位元</caption><thead><tr><th>日期</th><th>流入</th><th>流出</th></tr></thead><tbody>{points.map(p => <tr key={p.key}><td>{p.key}</td><td>{yuan(p.income)}</td><td>{yuan(p.expense)}</td></tr>)}</tbody></table>}
      </>}
    <div className="flow-footer"><p>含转账、理财等资金往来，不含期初余额。<br />按北京时间统计，本月截至 {+to.slice(5, 7)} 月 {+to.slice(8)} 日。</p><button aria-label="查看收支明细" onClick={() => navigate(`ledger?from=${from}&to=${to}`)}><ChevronRight size={18} /></button></div>
  </section>;
}
