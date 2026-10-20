import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { pct } from '../products';
import type { MarketIndex, Product } from '../types';

type Point = { date: string; value: number; nav?: number | null; perTenThousand?: number | null; open?: number | null; high?: number | null; low?: number | null };
type History = { metric: string; unit: string; points: Point[]; source: string; updatedAt: string | null; stale: boolean; notice: string | null };
// return: cumulative % from 0; yield: money-fund 7-day %; level: index points; nav: unit NAV or per-10k income.
type Kind = 'return' | 'yield' | 'level' | 'nav';
const RANGES = [{ id: '1m', label: '近1月' }, { id: '3m', label: '近3月' }, { id: '6m', label: '近6月' }, { id: '1y', label: '近1年' }];
const H = 168, PAD = { top: 12, right: 10, bottom: 24, left: 46 };

// Up to five round-number ticks covering [min, max].
function ticks(min: number, max: number) {
  const span = max - min || Math.abs(max) || 1, raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
const tone = (v: number) => v < 0 ? ' down' : v > 0 ? ' up' : '';

function TrendChart({ path, kind, title, label, note, field, extra }: { path: string; kind: Kind; title: string; label: string; note: string; field?: 'nav' | 'perTenThousand'; extra?: ReactNode }) {
  const [range, setRange] = useState('3m');
  const [state, setState] = useState<{ data?: History; error?: string; loading: boolean }>({ loading: true });
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(320);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true; setState(s => ({ ...s, loading: true })); setHover(null);
    api<History>(`${path}?range=${range}`).then(data => live && setState({ data, loading: false })).catch(e => live && setState({ error: e.message, loading: false }));
    return () => { live = false; };
  }, [path, range]);

  // With `field`, the same cached history is drawn from another column (unit NAV, per-10k income).
  const points = (state.data?.points ?? []).flatMap(p => !field ? [p] : p[field] != null ? [{ ...p, value: p[field] as number }] : []);
  const values = points.map(p => p.value), withZero = kind === 'return' ? [0] : [];
  const yt = points.length ? ticks(Math.min(...values, ...withZero), Math.max(...values, ...withZero)) : [];
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const x = (i: number) => PAD.left + (points.length > 1 ? i / (points.length - 1) : 0) * (width - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PAD.top - PAD.bottom);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = points.length ? `${line}L${x(points.length - 1).toFixed(1)},${H - PAD.bottom}L${x(0).toFixed(1)},${H - PAD.bottom}Z` : '';
  const fmt = (v: number) => kind === 'yield' ? `${v.toFixed(3)}%` : kind === 'level' ? v.toFixed(2) : kind === 'nav' ? v.toFixed(4) : pct(v);
  const tickText = (v: number) => kind === 'yield' ? `${v.toFixed(2)}%` : kind === 'nav' ? v.toFixed(y1 - y0 < 0.05 ? 4 : 3) : kind === 'level' ? v.toFixed(y1 - y0 < 20 ? 1 : 0) : `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(y1 - y0) < 5 ? 1 : 0)}%`;
  const first = points[0], last = points[points.length - 1], active = hover === null ? null : points[hover];
  // Index ranges have one unambiguous change (first to last close), so it can headline the chart.
  // Only index charts headline a range change: a fund's NAV change would sit beside the different 近N月 return above.
  const priced = kind === 'level' || field === 'nav';
  const rangeChange = kind === 'level' && first && last ? (last.value / first.value - 1) * 100 : null;
  const dayChange = priced && hover ? (points[hover].value / points[hover - 1].value - 1) * 100 : null;
  const dateIdx = points.length ? [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])] : [];
  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect(), rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  }
  const rangeLabel = RANGES.find(r => r.id === range)?.label;

  return <section className="nav-chart">
    <header className="nav-chart-head">
      <div><strong>{title}{extra}</strong>
        {kind === 'yield' && last && <span className="nav-chart-headline">最新 {fmt(last.value)}</span>}
        {rangeChange !== null && <span className={`nav-chart-headline${tone(rangeChange)}`}>{rangeLabel}涨跌 {pct(rangeChange)}</span>}
      </div>
      <div className="chip-row" role="tablist" aria-label="走势区间">{RANGES.map(r => <button type="button" role="tab" aria-selected={range === r.id} key={r.id} className={`chip small${range === r.id ? ' active' : ''}`} onClick={() => setRange(r.id)}>{r.label}</button>)}</div>
    </header>
    <div className="nav-chart-plot" ref={box}>
      {state.loading && !points.length && <p className="nav-chart-empty">走势加载中…</p>}
      {!state.loading && !points.length && <p className="nav-chart-empty">{state.error || state.data?.notice || '暂无走势数据'}</p>}
      {points.length > 1 && <svg width={width} height={H} role="img" aria-label={`${label}${rangeLabel}${state.data?.metric}走势，最新${fmt(last.value)}`} onPointerLeave={() => setHover(null)}>
        {yt.map(v => <g key={v}><line className={v === 0 && kind === 'return' ? 'zero' : 'grid'} x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} /><text className="axis" x={PAD.left - 6} y={y(v)} dy="0.35em" textAnchor="end">{tickText(v)}</text></g>)}
        {dateIdx.map((i, k) => <text key={i} className="axis" x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === dateIdx.length - 1 ? 'end' : 'middle'}>{points[i].date.slice(5)}</text>)}
        <path className="wash" d={area} />
        <path className="series" d={line} />
        {active ? <g><line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={H - PAD.bottom} /><circle className="dot" cx={x(hover!)} cy={y(active.value)} r={4} /></g>
          : <circle className="dot" cx={x(points.length - 1)} cy={y(last.value)} r={4} />}
        <rect className="hit" x={PAD.left} y={0} width={width - PAD.left - PAD.right} height={H} onPointerMove={onMove} onPointerDown={onMove} />
      </svg>}
      {active && <div className="nav-chart-tip" style={{ left: Math.min(Math.max(x(hover!), 70), width - 70) }}>
        <span>{active.date}</span>
        <b className={kind === 'return' ? tone(active.value) : ''}>{kind === 'level' ? `收盘 ${fmt(active.value)}` : field === 'nav' ? `单位净值 ${fmt(active.value)}` : field === 'perTenThousand' ? `万份收益 ${fmt(active.value)}元` : fmt(active.value)}</b>
        {dayChange !== null && <span className={`tip-change${tone(dayChange)}`}>当日 {pct(dayChange)}</span>}
        {kind === 'level' && active.high != null && <span>最高 {active.high.toFixed(2)} · 最低 {active.low?.toFixed(2)}</span>}
        {!field && active.nav != null && <span>单位净值 {active.nav.toFixed(4)}</span>}
        {!field && active.perTenThousand != null && <span>万份收益 {active.perTenThousand.toFixed(4)}</span>}
      </div>}
    </div>
    {points.length > 0 && <p className="nav-chart-note">{note} · {state.data?.source}{state.data?.stale ? ' · 数据可能不是最新' : ''}</p>}
    {points.length > 0 && <table className="sr-only"><caption>{label}{state.data?.metric}走势数据</caption><thead><tr><th>日期</th><th>{state.data?.metric}</th></tr></thead><tbody>{points.map(p => <tr key={p.date}><td>{p.date}</td><td>{fmt(p.value)}</td></tr>)}</tbody></table>}
  </section>;
}

export function NavChart({ product }: { product: Product }) {
  const money = product.category === 'money';
  const [mode, setMode] = useState<'return' | 'nav'>('return');
  const options = money ? [['return', '7日年化'], ['nav', '万份收益']] as const : [['return', '收益率'], ['nav', '单位净值']] as const;
  const toggle = <span className="segmented small" role="group" aria-label="走势指标">{options.map(([id, label]) => <button key={id} type="button" className={mode === id ? 'active' : ''} aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}</span>;
  const note = mode === 'nav' ? (money ? '纵轴为每万份基金单位当日收益（元）' : '纵轴为单位净值，分红日净值会相应下调；含分红的表现请看收益率') : money ? '纵轴为7日年化收益率' : '纵轴为累计收益率，以区间首个交易日为基准、按累计净值计算（含分红），与上方阶段收益的统计口径不同';
  return <TrendChart path={`/products/${product.id}/history`} kind={mode === 'nav' ? 'nav' : money ? 'yield' : 'return'} field={mode === 'nav' ? (money ? 'perTenThousand' : 'nav') : undefined}
    title={mode === 'nav' ? (money ? '万份收益' : '净值走势') : money ? '7日年化走势' : '业绩走势'} label={product.name} note={note} extra={toggle} />;
}

const fixed = (v: number | null | undefined) => v == null ? '--' : v.toFixed(2);
const yi = (v: number | null | undefined) => v == null ? '--' : `${(v / 1e8).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}亿`;
export function IndexDetail({ index }: { index: MarketIndex }) {
  return <div className="stack-form">
    <div className={`index-quote${tone(index.changePct ?? 0)}`}><strong>{fixed(index.price)}</strong><span>{index.change != null && index.change > 0 ? '+' : ''}{fixed(index.change)}　{pct(index.changePct)}</span></div>
    <dl className="index-stats"><div><dt>今开</dt><dd>{fixed(index.open)}</dd></div><div><dt>昨收</dt><dd>{fixed(index.prevClose)}</dd></div><div><dt>最高</dt><dd>{fixed(index.high)}</dd></div><div><dt>最低</dt><dd>{fixed(index.low)}</dd></div><div><dt>成交额</dt><dd>{yi(index.amount)}</dd></div><div><dt>更新</dt><dd>{new Date(index.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })}</dd></div></dl>
    <TrendChart path={`/market/${index.code}/history`} kind="level" title="走势" label={index.name} note="日线收盘点位，交易时段内最后一天为盘中最新点位" />
  </div>;
}
