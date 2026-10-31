import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { api, yuan } from '../api';
import { useBank } from '../bank';
import { Empty, InlineError } from '../ui';
import type { EarningsReport } from '../types';

const VIEWS = [{ id: 'day', label: '日收益' }, { id: 'month', label: '月收益' }, { id: 'year', label: '年收益' }, { id: 'all', label: '累计收益' }] as const;
type View = typeof VIEWS[number]['id'];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const shiftMonth = (period: string, delta: number) => { const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + delta, 1)); return d.toISOString().slice(0, 7); };
const daysIn = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
const firstWeekday = (period: string) => new Date(`${period}-01T00:00:00Z`).getUTCDay();
const heading = (view: View, key: string) => view === 'day' ? key : view === 'month' ? key : view === 'year' ? `${key}年` : '全部';

export function Earnings() {
  const { hidden, toggleHidden } = useBank();
  const [view, setView] = useState<View>('day'), [period, setPeriod] = useState(''), [key, setKey] = useState('');
  const [report, setReport] = useState<EarningsReport | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams({ view, ...(period ? { period } : {}), ...(key ? { key } : {}) });
    api<EarningsReport>(`/wealth/earnings?${query}`).then(r => { if (alive) { setReport(r); setError(''); } }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [view, period, key]);
  const signed = (n: number) => hidden ? '****' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${yuan(Math.abs(n))}`;
  // Calendar cells are narrow: large amounts drop the cents so a number never breaks across lines.
  const cell = (n: number) => hidden ? '**' : `${n > 0 ? '+' : '-'}${Math.abs(n) >= 100000 ? Math.round(Math.abs(n) / 100) : (Math.abs(n) / 100).toFixed(2)}`;
  const tone = (n: number) => n < 0 ? 'down' : n > 0 ? 'up' : '';
  const choose = (next: View) => { setView(next); setPeriod(''); setKey(''); setReport(null); };
  const shown = report?.view === view ? report : null, selected = shown?.selected;
  const amounts = new Map(shown?.series.map(s => [s.key, s.amount]));
  const label = VIEWS.find(v => v.id === view)!.label, largest = Math.max(1, ...(selected?.composition.map(c => Math.abs(c.amount)) || []));
  return <div className="page earnings-page">
    <div className="earnings-tabs" role="tablist" aria-label="收益周期">{VIEWS.map(v => <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'active' : ''} onClick={() => choose(v.id)}>{v.label}</button>)}<button className="earnings-eye" aria-label={hidden ? '显示金额' : '隐藏金额'} onClick={toggleHidden}>{hidden ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
    <InlineError message={error} />
    {!shown && !error && <p className="footnote" role="status">正在读取收益…</p>}
    {shown && selected && <>
      <section className="card earnings-summary">
        <header><h2>{label}</h2><strong className={tone(selected.total)} data-testid="earnings-total">{signed(selected.total)}</strong></header>
        {view === 'day' && <>
          <div className="earnings-nav"><button aria-label="上个月" onClick={() => { setPeriod(shiftMonth(shown.period, -1)); setKey(''); }}><ChevronLeft size={18} /></button><span>{shown.period.slice(0, 4)}年{Number(shown.period.slice(5))}月</span><button aria-label="下个月" disabled={shown.period >= shown.asOf.slice(0, 7)} onClick={() => { setPeriod(shiftMonth(shown.period, 1)); setKey(''); }}><ChevronRight size={18} /></button></div>
          <div className="earnings-week" aria-hidden="true">{WEEK.map(w => <span key={w}>{w}</span>)}</div>
          <div className="earnings-calendar" data-testid="earnings-calendar">
            {Array.from({ length: firstWeekday(shown.period) }, (_, i) => <span key={`blank-${i}`} />)}
            {Array.from({ length: daysIn(shown.period) }, (_, i) => { const date = `${shown.period}-${String(i + 1).padStart(2, '0')}`, amount = amounts.get(date), future = date > shown.asOf; return <button key={date} disabled={future} aria-pressed={selected.key === date} className={`${amount ? tone(amount) : ''}${selected.key === date ? ' selected' : ''}`} onClick={() => setKey(date)}><b>{i + 1}</b>{amount ? <small>{cell(amount)}</small> : null}</button>; })}
          </div>
        </>}
        {view === 'month' && <>
          <div className="earnings-nav"><button aria-label="上一年" onClick={() => { setPeriod(String(Number(shown.period) - 1)); setKey(''); }}><ChevronLeft size={18} /></button><span>{shown.period}年</span><button aria-label="下一年" disabled={shown.period >= shown.asOf.slice(0, 4)} onClick={() => { setPeriod(String(Number(shown.period) + 1)); setKey(''); }}><ChevronRight size={18} /></button></div>
          <div className="earnings-months">{Array.from({ length: 12 }, (_, i) => { const month = `${shown.period}-${String(i + 1).padStart(2, '0')}`, amount = amounts.get(month), future = month > shown.asOf.slice(0, 7); return <button key={month} disabled={future} aria-pressed={selected.key === month} className={`${amount ? tone(amount) : ''}${selected.key === month ? ' selected' : ''}`} onClick={() => setKey(month)}><b>{i + 1}月</b><small>{amount ? signed(amount) : '--'}</small></button>; })}</div>
        </>}
        {view === 'year' && (shown.series.length ? <div className="earnings-months">{shown.series.map(s => <button key={s.key} aria-pressed={selected.key === s.key} className={`${tone(s.amount)}${selected.key === s.key ? ' selected' : ''}`} onClick={() => setKey(s.key)}><b>{s.key}年</b><small>{signed(s.amount)}</small></button>)}</div> : null)}
        {view === 'all' && <p className="earnings-caption">自首次持有以来的全部收益，包含已赎回的产品。</p>}
      </section>
      <section className="card earnings-section"><header><h2>收益构成</h2><span>{heading(view, selected.key)}</span></header>
        {selected.composition.length ? selected.composition.map(c => <div className="earnings-bar" key={c.label}><span>{c.label}</span><i><em className={c.amount < 0 ? 'down' : ''} style={{ width: `${Math.abs(c.amount) / largest * 100}%` }} /></i><b className={tone(c.amount)}>{signed(c.amount)}</b></div>) : <Empty title="这一时段没有收益" />}
      </section>
      {selected.items.length > 0 && <section className="card earnings-section"><header><h2>收益明细</h2><span>{heading(view, selected.key)}</span></header>
        {selected.items.map(item => <div className="earnings-item" key={item.holdingId}><span><strong>{item.name}</strong><small>{item.label}</small></span><b className={tone(item.amount)}>{signed(item.amount)}</b></div>)}
      </section>}
      <p className="footnote">定期存款按年利率逐日计息；基金按每日净值变动计算，非交易日没有收益。全部为模拟数据，收益在赎回或支取时随本金到账。</p>
    </>}
  </div>;
}
