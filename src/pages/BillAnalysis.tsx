import { useEffect, useState } from 'react';
import { CalendarDays, CarFront, ChevronRight, House, CircleEllipsis, Cloud, Eye, GraduationCap, HeartPulse, Info, Lightbulb, MonitorPlay, Music, Shirt, Sofa, Utensils, Wallet } from 'lucide-react';
import { api, ApiError } from '../api';
import { useBank } from '../bank';
import { Field, InlineError } from '../ui';
import { change, money, percent, SPEND_CATEGORIES, type BillData, type BillEntry, type HiddenFinding, type HiddenSpend } from './billData';
import { comparisonLabel } from './billMonth';

const tagNote = { user: '（手动修改）', model: '（智能识别）' } as Record<string, string>;

function CategoryEditor({ row }: { row: BillEntry }) {
  const { refresh, closeModal } = useBank();
  const [category, setCategory] = useState(SPEND_CATEGORIES.includes(row.tag) ? row.tag : '');
  const [applyToMerchant, setApplyToMerchant] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(method: 'PUT' | 'DELETE') {
    setBusy(true); setError('');
    try {
      await api(`/ledger/${row.id}/category`, method, method === 'PUT' ? { category, applyToMerchant } : {});
      await refresh(); closeModal();
    } catch (e) { setError(e instanceof Error ? e.message : '分类暂时无法修改'); setBusy(false); }
  }
  return <form className="stack-form bill-category-editor" onSubmit={e => { e.preventDefault(); void submit('PUT'); }}>
    <Field label="修改分类"><select aria-label="修改分类" required value={category} onChange={e => setCategory(e.target.value)}>
      {!category && <option value="">请选择分类</option>}
      {SPEND_CATEGORIES.map(name => <option key={name}>{name}</option>)}
    </select></Field>
    {row.has_merchant && <label className="check-option"><input type="checkbox" checked={applyToMerchant} onChange={e => setApplyToMerchant(e.target.checked)} /><span>以后这个商户都用此分类</span></label>}
    <InlineError message={error} />
    <button className="btn-primary" disabled={busy || !category}>保存分类</button>
    {row.tag_source === 'user' && <button type="button" className="btn-text" disabled={busy} onClick={() => void submit('DELETE')}>恢复自动分类</button>}
  </form>;
}

export function EntryDetail({ row, masked, editable = false }: { row: BillEntry; masked: boolean; editable?: boolean }) {
  return <div className="bill-detail"><strong>{money(row.amount, masked)}</strong><p>{row.title}</p><dl>
    <dt>交易日期（北京时间）</dt><dd>{row.bj_time}</dd><dt>收支分类</dt><dd>{row.tag}{row.tag_source && tagNote[row.tag_source]}</dd>
    {row.merchant && <><dt>商户</dt><dd>{row.merchant}</dd></>}<dt>流水编号</dt><dd>{row.transaction_id}</dd>
  </dl>{editable && (row.kind === 'consumption' || row.kind === 'refund') && <CategoryEditor row={row} />}</div>;
}

function Bar({ share }: { share: number }) {
  return <span className="bill-bar"><i style={{ width: percent(Math.max(0, Math.min(1, share))) }} /></span>;
}

export function HiddenAnalysis({ bill }: { bill: BillData }) {
  const { hidden: masked, data, openModal, navigatePage } = useBank();
  const { totals } = bill;
  const subscriptions = data.subscriptions;
  const [result, setResult] = useState<HiddenSpend>(), [failure, setFailure] = useState<{ message: string; needsAssistant: boolean } | null>(null), [retry, setRetry] = useState(0);
  // Each post can be a paid model call, and polling replaces the bill object every 30s: only a new period or an explicit retry may send one.
  const period = bill.from.slice(0, 7);
  useEffect(() => {
    let active = true;
    setFailure(null);
    setResult(current => current?.period === period ? current : undefined);
    api<HiddenSpend>('/ledger/bills/hidden', 'POST', { period }).then(value => { if (active) setResult(value); }).catch(e => {
      if (active) setFailure({ message: e.message || '隐形消费暂时无法分析', needsAssistant: e instanceof ApiError && e.code === 'AGENT_NOT_ENABLED' });
    });
    return () => { active = false; };
  }, [period, retry]);
  function evidence(finding: HiddenFinding) {
    const ids = new Set(finding.ids);
    openModal(finding.title, <div className="bill-evidence">{finding.reason && <p>{finding.reason}</p>}{bill.entries.filter(r => ids.has(r.id)).map(r =>
      <details key={r.id}><summary>{r.bj_time.slice(0, 10)} · {r.title}　{money(-r.amount, masked)}</summary><EntryDetail row={r} masked={masked} /></details>)}</div>);
  }
  const count = result?.groups.reduce((n, g) => n + g.findings.reduce((m, f) => m + f.ids.length, 0), 0);
  return <>
    <section className="bill-panel bill-summary hidden-summary"><div><Eye /><span>本月隐形消费</span><strong>{result ? money(result.total, masked) : '—'}</strong><small>{result ? `共 ${count} 笔` : failure ? '暂未分析' : '分析中'}</small></div>
      <div><span>占本月支出</span><strong>{result && totals.consumptionGross > 0 ? percent(result.total / totals.consumptionGross) : '—'}</strong></div></section>
    {failure ? <section className="bill-panel bill-status" role="alert"><p>{failure.message}</p>
        {failure.needsAssistant ? <button className="bill-outline" onClick={() => navigatePage('assistant')}>去开通智能助手</button> : <button className="bill-outline" onClick={() => setRetry(n => n + 1)}>重新分析</button>}</section>
      : !result ? <section className="bill-panel bill-status" role="status">正在结合近半年流水分析…</section>
      : <>
        {result.summary && <section className="bill-panel"><div className="bill-insight"><i>AI</i><span><b>AI 账单助手 · 本月解读</b><small>{result.summary}</small></span></div></section>}
        <section className="bill-panel"><h2>隐形消费构成</h2>
          {!result.groups.length && <p className="bill-muted">{bill.entries.length ? '本月未发现明显的隐形消费。' : '该月暂无已入账流水。'}</p>}
          {result.groups.map(group => <div className="bill-group" key={group.type}>
            <span className="bill-spread"><b>{group.name}</b><span>{money(group.amount, masked)}　<small>{percent(group.amount / result.total)}</small></span></span>
            <Bar share={group.amount / result.total} />
            {group.findings.map(f => <button className="bill-row bill-finding" key={f.ids[0]} onClick={() => evidence(f)}><span><b>{f.title}</b><small>{f.ids.length} 笔{f.reason && ` · ${f.reason}`}</small></span><b>{money(f.amount, masked)}</b><ChevronRight size={14} /></button>)}
          </div>)}</section>
        {result.tips.length > 0 && <section className="bill-panel"><h2>可调整建议 <small>（供参考）</small></h2><div className="bill-notes"><Lightbulb /><ul>{result.tips.map(tip => <li key={tip}>{tip}</li>)}</ul></div></section>}
      </>}
    <section className="bill-panel"><h2>我的订阅与自动续费 <small>（当前 {subscriptions.length} 项）</small></h2>
      {!subscriptions.length && <p className="bill-muted">暂无已登记的订阅服务</p>}
      {subscriptions.map(s => { const Icon = /音乐/.test(s.merchant) ? Music : /云/.test(s.merchant) ? Cloud : MonitorPlay;
        const status = s.status === 'active' ? '生效中' : s.status === 'payment_failed' ? '扣款失败' : '已停止';
        return <div key={s.id} className="bill-row"><Icon /><span><b>{s.merchant}</b><small>{money(s.amount, masked)} / 月 · {status}</small></span>
          <button className="bill-outline" onClick={() => openModal('订阅详情', <div className="bill-evidence"><p>{s.merchant} · {status}</p><p>每月费用 {money(s.amount, masked)}</p>
            {s.status === 'active' && <p>下次计划扣费　{new Date(s.next_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>}<p>本页仅查看订阅信息。</p></div>)}>详情</button></div>; })}
    </section>
    <aside className="bill-note"><Info size={16} /><span>由智能助手根据已入账流水判断，可能有误，点开可逐笔核对。金额按流水计算，同一笔支出只计一次。暂无服务使用记录，无法判断订阅是否闲置。</span></aside>
  </>;
}

export function PersonalizedAnalysis({ bill }: { bill: BillData }) {
  const { hidden, openModal } = useBank();
  const { categories, totals, previous } = bill;
  const top = categories.find(c => c.amount > 0);
  const weekday = bill.weekdays.slice(0, 5).reduce((n, b) => n + b.amount, 0);
  const peakHour = [...bill.hours].filter(b => b.amount > 0).sort((a, b) => b.amount - a.amount)[0];
  const frequent = [...categories].sort((a, b) => b.count - a.count)[0];
  const sharesValid = totals.consumption > 0;
  const insight = !totals.count ? '该月暂无已入账流水。' : !top ? '本期暂无可分析的正向分类支出。' :
    `本期消费以${top.name}为主${sharesValid ? '，占净消费的 ' + percent(top.share) : ''}。${previous?.totals.consumption ? '消费较上月同期 ' + change(totals.consumption, previous.totals.consumption) + '。' : '暂无可比的上月消费基数。'}`;
  return <>
    <section className="bill-panel"><button className="bill-insight" onClick={() => openModal('本月洞察依据', <p>{bill.from} 至 {bill.to}，共 {totals.count} 笔流水。消费按支出扣除退款计算，转账及本人账户互转不计入消费。</p>)}>
      <i>AI</i><span><b>AI 账单助手 · 本月洞察</b><small>{insight}</small></span><ChevronRight size={16} /></button></section>
    <section className="bill-panel"><h2>本月分类支出 <small>（{comparisonLabel(bill.to) === '较上月' ? '对比上月' : '对比上月同期'}）</small></h2>
      {!categories.length && <p className="bill-muted">暂无分类支出</p>}
      {categories.map(c => { const Icon = ({ 食品: Utensils, 衣着: Shirt, 居住: House, 家庭设备及服务: Sofa, 交通通信: CarFront, 教育文娱: GraduationCap, 医疗保健: HeartPulse, 其他消费: CircleEllipsis } as Record<string, typeof Wallet>)[c.name] || Wallet;
        return <div key={c.name} className="bill-category"><Icon size={21} /><div><b>{c.name}</b><Bar share={c.share} /></div>
          <span>{money(c.amount, hidden)}<small>{sharesValid ? percent(c.share) : '—'}</small></span><small>{change(c.amount, previous?.categories.find(p => p.name === c.name)?.amount)}</small></div>; })}
    </section>
    <section className="bill-panel"><h2>我的消费习惯</h2><div className="bill-notes"><CalendarDays /><ul>
      {sharesValid && <li>工作日净消费占 {percent(weekday / totals.consumption)}，周末占 {percent(1 - weekday / totals.consumption)}。</li>}
      {frequent && <li>{frequent.name}的消费与退款记录最频繁，共 {frequent.count} 笔。</li>}
      {peakHour && <li>有明确交易时刻的流水中，{peakHour.key}的净消费最高。</li>}
      {!frequent && !peakHour && <li>当前流水不足以判断消费习惯。</li>}
    </ul></div></section>
    <section className="bill-panel"><h2>可调整建议 <small>（供参考）</small></h2><div className="bill-notes"><Lightbulb /><ul>
      {top && <li>可从金额最高的「{top.name}」开始复核，为下月设定预算。</li>}
      {top && <li>可在隐形消费分析中逐笔核对持续性支出，再决定是否调整。</li>}
      {!top && <li>该月数据不足，暂无针对性建议。</li>}
    </ul></div></section>
  </>;
}
