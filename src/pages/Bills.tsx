import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, ChartNoAxesColumnIncreasing, ChevronDown, ChevronLeft, ChevronRight, Filter, Search, Wallet } from 'lucide-react';
import { api } from '../api';
import { useBank } from '../bank';
import { NavAssistant } from '../icons';
import { BillReport } from './BillReport';
import { beijingDay } from './homeData';
import { change, money, type BillData, type Topic } from './billData';
import { comparisonLabel, monthGrid, monthLabel, resolveMonth, yearBounds } from './billMonth';
import { EntryDetail, HiddenAnalysis, PersonalizedAnalysis } from './BillAnalysis';
import { BillTrend } from './BillTrend';
import './bills.css';

export const billTitles: Record<string, string> = { bills: '账单', hidden_consumption: '隐形消费分析', personalized_bill: '个性化账单分析' };
const defaultLabels: Record<Topic, string> = { hidden_consumption: '看看你的隐形消费？', personalized_bill: '你的个性化账单？' };

function MonthPicker({ month, firstMonth, currentMonth, onSelect }: { month: string; firstMonth: string | null; currentMonth: string; onSelect: (month: string) => void }) {
  const [year, setYear] = useState(Number(month.slice(0, 4))), { min, max } = yearBounds(firstMonth, currentMonth);
  return <div className="bill-month-picker">
    <div className="bill-spread">
      <button aria-label="上一年" disabled={year <= min} onClick={() => setYear(year - 1)}><ChevronLeft size={20} /></button>
      <b aria-live="polite">{year}年</b>
      <button aria-label="下一年" disabled={year >= max} onClick={() => setYear(year + 1)}><ChevronRight size={20} /></button>
    </div>
    <div className="bill-month-grid">{monthGrid(year, firstMonth, currentMonth).map(m =>
      <button key={m.value} aria-label={monthLabel(m.value)} aria-pressed={m.value === month} disabled={!m.enabled} onClick={() => onSelect(m.value)}>{m.label}</button>)}</div>
  </div>;
}

export function Bills({ page }: { page: string }) {
  const { route, data, navigatePage, openModal, closeModal, hidden } = useBank();
  const params = new URLSearchParams(route.split('?')[1]);
  const currentMonth = beijingDay().slice(0, 7);
  const month = resolveMonth(params.get('month'), currentMonth);
  const [result, setResult] = useState<{ month: string; bill?: BillData; error?: string }>();
  // Kept across months so the picker stays usable while the next month loads.
  const [firstMonth, setFirstMonth] = useState<string | null>();
  const [retry, setRetry] = useState(0);
  const [monthly, setMonthly] = useState(false), [query, setQuery] = useState(''), [direction, setDirection] = useState('all');
  const [filters, setFilters] = useState(false), [limit, setLimit] = useState(30);
  const search = useRef<HTMLInputElement>(null), scroll = useRef(0), enteredFromOverview = useRef(false);
  const overview = page === 'bills', bill = result?.month === month ? result.bill : undefined;
  const error = result?.month === month ? result.error : '';
  useEffect(() => {
    let active = true;
    api<BillData>('/ledger/bills?period=' + encodeURIComponent(month)).then(bill => {
      if (active) { setResult({ month, bill }); setFirstMonth(bill.first_month); }
    // A failed background refetch keeps the bill on screen; the next snapshot tries again.
    }).catch(e => { if (active) setResult(current => current?.month === month && current.bill ? current : { month, error: e.message || '账单暂时无法读取' }); });
    return () => { active = false; };
  }, [month, data, retry, page]);
  useLayoutEffect(() => {
    if (overview && bill && scroll.current) window.scrollTo(0, scroll.current);
  }, [overview, month, !!bill]);
  function open(target: string) {
    scroll.current = window.scrollY;
    enteredFromOverview.current = true;
    navigatePage(target);
  }
  function back() {
    if (enteredFromOverview.current) history.back();
    else navigatePage('bills?month=' + encodeURIComponent(month));
  }
  function selectMonth(value: string) {
    closeModal();
    scroll.current = 0; setLimit(30);
    navigatePage('bills?month=' + value);
  }
  function pickMonth() {
    openModal('选择账单月份', <MonthPicker month={month} firstMonth={firstMonth ?? null} currentMonth={currentMonth} onSelect={selectMonth} />);
  }
  function report(daily: boolean) {
    if (!bill) return;
    const from = daily ? bill.to : bill.from;
    open('bill-report?' + new URLSearchParams({ origin: 'bills', month, from, to: bill.to, mode: daily ? 'day' : 'month' }));
  }
  const filtered = bill?.entries.filter(r => (direction === 'all' || (direction === 'in' ? r.amount > 0 : r.amount < 0))
    && [r.merchant, r.tag, r.title, r.transaction_id].some(value => value?.toLowerCase().includes(query.trim().toLowerCase()))) || [];
  return <main className="bill-page">
    <header className={overview ? 'bill-header overview' : 'bill-header'}>
      {overview ? <><div className="bill-spread"><h1>账单</h1><div className="bill-tools"><button aria-label="搜索账单" onClick={() => { search.current?.focus(); search.current?.scrollIntoView({ block: 'center' }); }}><Search /></button>
        <button aria-label="筛选账单" aria-expanded={filters} onClick={() => { setFilters(v => !v); search.current?.scrollIntoView({ block: 'center' }); }}><Filter /></button></div></div>
        <button className="bill-month" aria-haspopup="dialog" aria-label={`账单月份：${monthLabel(month)}，点击切换`} disabled={firstMonth === undefined} onClick={pickMonth}>{monthLabel(month)} <ChevronDown size={15} /></button>
      </> : <><button aria-label="返回账单" onClick={back}><ChevronLeft /></button><h1>{billTitles[page] || (params.get('mode') === 'day' ? '日报分析' : '月报分析')}</h1></>}
    </header>
    <div className={'bill-body' + (overview ? ' overview' : '')}>
      {error ? <section className="bill-panel bill-status" role="alert"><p>{error}</p><button className="bill-outline" onClick={() => setRetry(n => n + 1)}>重新读取</button></section>
        : !bill ? <section className="bill-panel bill-status" role="status">正在读取账单…</section>
        : overview ? <>
          <section className="bill-panel bill-summary">{([['本月支出', bill.totals.consumption, bill.previous?.totals.consumption], ['本月收入', bill.totals.income, bill.previous?.totals.income]] as const)
            .map(([name, amount, prior]) => <div key={name}><span>{name}</span><strong>{money(amount, hidden)}</strong><small>{comparisonLabel(bill.to)} {change(amount, prior)}</small></div>)}</section>
          <section className="bill-panel bill-links">{[true, false].map(daily => <button key={String(daily)} onClick={() => report(daily)}>{daily ? <ChartNoAxesColumnIncreasing /> : <CalendarDays />}
            <span><b>{daily ? '日报分析' : '月报分析'}</b><small>{daily ? '查看每日收支变化，掌握消费节奏' : '汇总本月收支与分类情况'}</small></span><ChevronRight /></button>)}</section>
          <section className="bill-panel bill-trend"><div className="bill-spread"><h2>消费趋势</h2><div className="bill-toggle" role="group" aria-label="消费趋势周期">
            {[false, true].map(m => <button key={String(m)} aria-pressed={m === monthly} onClick={() => setMonthly(m)}>{m ? '按月' : '按日'}</button>)}</div></div>
            <BillTrend key={month + monthly} points={monthly ? bill.monthly : bill.daily} monthly={monthly} masked={hidden}
              empty={monthly ? !bill.monthly.some(p => p.consumption !== 0) : !bill.totals.consumptionCount && !bill.categories.length} /></section>
          <section className="bill-panel bill-links bill-assistant-links" aria-label="智能助手账单分析">
            {(Object.keys(defaultLabels) as Topic[]).map(topic => <button key={topic} onClick={() => open(topic + '?month=' + month)}>
              <NavAssistant active={false} /><span>{bill.labels[topic] || defaultLabels[topic]}</span><ChevronRight /></button>)}</section>
          <section className="bill-panel bill-ledger"><h2>账单明细</h2><label className="bill-search"><Search size={17} /><input ref={search} aria-label="搜索账单明细" placeholder="搜索商户、分类或关键词" value={query} onChange={e => { setQuery(e.target.value); setLimit(30); }} /></label>
            {filters && <div className="bill-toggle" role="group" aria-label="收支方向">{[['all','全部'],['in','收入'],['out','支出']].map(([id, label]) => <button key={id} aria-pressed={direction === id} onClick={() => { setDirection(id); setLimit(30); }}>{label}</button>)}</div>}
            {!filtered.length && <p className="bill-muted">{bill.entries.length ? '没有符合条件的流水' : '该月暂无已入账流水'}</p>}
            {filtered.slice(0, limit).map((r, i) => <div key={r.id}>
              {(i === 0 || r.bj_time.slice(0, 10) !== filtered[i - 1].bj_time.slice(0, 10)) && <small className="bill-date">{r.bj_time.slice(0, 10)}</small>}
              <button className="bill-row" onClick={() => openModal('流水详情', <EntryDetail row={r} masked={hidden} editable />)}><Wallet size={20} /><span><b>{r.tag}</b><small>{r.merchant || r.title}</small></span><b>{r.amount < 0 ? '−' : '+'}{money(Math.abs(r.amount), hidden)}</b><ChevronRight size={14} /></button></div>)}
            {filtered.length > limit && <button className="bill-more" onClick={() => setLimit(n => n + 30)}>加载更多明细</button>}</section>
        </> : page === 'hidden_consumption' ? <HiddenAnalysis bill={bill} /> : page === 'personalized_bill' ? (bill.personalized ? <PersonalizedAnalysis bill={bill} /> : <section className="bill-panel bill-status">个性化使用授权已关闭，暂无个性化账单分析。</section>)
          : hidden ? <section className="bill-panel">当前已隐藏金额</section> : <>
            {params.get('mode') === 'day' && <label className="bill-panel bill-spread">日报日期<input type="date" aria-label="日报日期" value={params.get('from') || bill.to} min={bill.from} max={bill.to}
              onChange={e => { const day = e.target.value; if (day >= bill.from && day <= bill.to) { params.set('from', day); params.set('to', day); location.replace('#bill-report?' + params); } }} /></label>}
            <BillReport /></>}
    </div>
  </main>;
}
