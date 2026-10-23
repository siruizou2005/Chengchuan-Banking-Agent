import { useState } from 'react';
import { AgentMark } from '../AgentMark';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useBank } from '../bank';
import type { Advice } from '../types';

const HORIZONS = [{ id: 'short', label: '随时可能用' }, { id: 'mid', label: '3–12个月' }, { id: 'long', label: '1年以上' }] as const;
const BUCKET_NAME: Record<string, string> = { liquid: '流动', stable: '稳健', growth: '进取' };
const BUCKET_HINT: Record<string, string> = { liquid: '随时可取，应对日常和突发支出', stable: '债券基金与定期，追求稳定收益', growth: '混合、股票与指数基金，收益和波动都更大' };
const money = (c: number) => `¥${(c / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const metricText = (m: { label: string; value: number | null }) => m.value === null ? `${m.label} --` : `${m.label} ${m.value > 0 && m.label === '近一年收益' ? '+' : ''}${m.value.toFixed(m.label === '7日年化' ? 3 : 2)}%`;

function Steps({ stage }: { stage: Advice['stage'] }) {
  const current = stage === 'plan' || stage === 'emergency' ? 3 : stage === 'horizon' ? 2 : 1;
  return <ol className="advice-steps">{['资金体检', '期限与金额', '配置方案'].map((s, i) => <li key={s} className={i + 1 < current ? 'done' : i + 1 === current ? 'active' : ''}><i>{i + 1}</i>{s}</li>)}</ol>;
}

// Proportional bar of the three parts; segments keep a 2px gap and every part is named in the legend.
function SplitBar({ parts }: { parts: { id: string; amount: number; label?: string }[] }) {
  const total = parts.reduce((n, p) => n + p.amount, 0);
  if (!total) return null;
  return <div className="advice-split">
    <div className="advice-bar" role="img" aria-label={parts.map(p => `${p.label || BUCKET_NAME[p.id]}${Math.round(p.amount / total * 100)}%`).join('，')}>{parts.filter(p => p.amount > 0).map(p => <span key={p.id} className={`seg ${p.id}`} style={{ flexGrow: p.amount }} />)}</div>
    <div className="advice-legend">{parts.filter(p => p.amount > 0).map(p => <span key={p.id}><i className={`seg ${p.id}`} />{p.label || BUCKET_NAME[p.id]} {Math.round(p.amount / total * 100)}% · {money(p.amount)}</span>)}</div>
  </div>;
}

export function AdviceCard({ initial, onAsk }: { initial: Advice; onAsk?: (text: string) => void }) {
  const { navigate } = useBank();
  const [advice, setAdvice] = useState(initial);
  // Only an amount the user typed is sent back; otherwise the server keeps suggesting one.
  const [custom, setCustom] = useState<number | null>(initial.params.amount !== initial.params.suggestedAmount ? initial.params.amount : null);
  const [draft, setDraft] = useState(String(Math.round(initial.params.amount / 100)));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load(next: { horizon?: string | null; amount?: number | null } = {}) {
    const horizon = next.horizon !== undefined ? next.horizon : advice.params.horizonSource === 'emergency' ? null : advice.params.horizon;
    const amount = next.amount !== undefined ? next.amount : custom;
    const qs = new URLSearchParams({ ...(horizon ? { horizon } : {}), ...(amount ? { amount: (amount / 100).toFixed(2) } : {}) });
    setBusy(true); setError('');
    try { const data = await api<Advice>(`/wealth/advice?${qs}`); setAdvice(data); if (amount === null || amount === undefined) setDraft(String(Math.round(data.params.amount / 100))); }
    catch (e) { setError(e instanceof Error ? e.message : '暂时无法生成，请稍后再试'); }
    finally { setBusy(false); }
  }
  function commitAmount(value: number | null) {
    setCustom(value); if (value !== null) setDraft(String(Math.round(value / 100)));
    void load({ amount: value });
  }
  const p = advice.profile, e = p.emergency, plan = advice.plan, choosing = ['horizon', 'plan'].includes(advice.stage);
  const coverage = e.target ? Math.min(1, e.covered / e.target) : 1;
  return <section className={`agent-card advice-card surface-satin finish-sage${busy ? ' busy' : ''}`}>
    <header><span className="agent-brand-label"><AgentMark size={20} />配置建议</span><span>{advice.user.risk}</span></header>
    <h3>理财配置建议</h3>
    <Steps stage={advice.stage} />

    <div className="report-totals three"><div><small>活期可用</small><strong>{money(p.available)}</strong></div><div><small>月均支出</small><strong>{money(p.monthlySpend)}</strong></div><div><small>建议可投资</small><strong>{money(p.investable)}</strong></div></div>
    <div className="advice-meter"><div><span>应急资金</span><b>{e.months === null ? '暂无支出数据' : `可覆盖 ${e.months >= 12 ? '12个月以上' : `${e.months}个月`}`}</b></div><div className="meter" aria-hidden="true"><span className={coverage < 0.5 ? 'low' : coverage < 1 ? 'mid' : ''} style={{ width: `${coverage * 100}%` }} /><i style={{ left: '50%' }} /></div><small>建议留 6 个月支出 {money(e.target)}（最少 3 个月），已有活期与货币基金 {money(e.covered)}</small></div>
    {p.holdings.total > 0 && <div className="advice-holdings"><small>已有持仓 {money(p.holdings.total)}{p.holdings.nextMaturity ? ` · ${p.holdings.nextMaturity.name} ${p.holdings.nextMaturity.date} 到期` : ''}</small><SplitBar parts={['liquid', 'stable', 'growth'].map(id => ({ id, amount: p.holdings[id as 'liquid'] }))} /></div>}
    <p className="data-note">收支口径：{p.basis}{p.commitments.creditCard ? `；已预留信用卡待还 ${money(p.commitments.creditCard)}` : ''}</p>

    {advice.gate && <div className={`advice-gate ${advice.stage}`}><strong>{advice.gate.title}</strong><p>{advice.gate.text}</p>
      {advice.gate.action && <button className="pill primary small" onClick={() => navigate(advice.gate!.action!.route)}>{advice.gate.action.label}<ChevronRight size={14} /></button>}
      {advice.stage === 'risk_assessment' && <button className="btn-text" onClick={() => load()} disabled={busy}><RefreshCw size={14} />已完成测评，重新生成</button>}
    </div>}

    {choosing && <div className="advice-choose">
      <div className="advice-q"><strong>这笔钱多久会用到？</strong>{advice.params.horizonSource === 'assessment' && <small>已按风险测评中的投资期限预选</small>}</div>
      <div className="chip-row">{HORIZONS.map(h => <button key={h.id} type="button" className={`chip${advice.params.horizon === h.id ? ' active' : ''}`} disabled={busy} onClick={() => load({ horizon: h.id })}>{h.label}</button>)}</div>
      <div className="advice-q"><strong>打算投入多少？</strong></div>
      <form className="advice-amount" onSubmit={ev => { ev.preventDefault(); const v = Math.round(Number(draft) * 100); if (v > 0) commitAmount(v); }}>
        <label><span>¥</span><input inputMode="numeric" value={draft} onChange={ev => setDraft(ev.target.value.replace(/[^\d]/g, ''))} onBlur={() => { const v = Math.round(Number(draft) * 100); if (v > 0 && v !== advice.params.amount) commitAmount(v); }} aria-label="投入金额（元）" /></label>
        <div className="chip-row">{[1000000, 5000000].map(v => <button key={v} type="button" className="chip" disabled={busy} onClick={() => commitAmount(v)}>{v / 1000000}万</button>)}<button type="button" className={`chip${custom === null ? ' active' : ''}`} disabled={busy} onClick={() => commitAmount(null)}>按建议 {money(advice.params.suggestedAmount)}</button></div>
      </form>
    </div>}
    {advice.warnings.map(w => <p key={w} className="advice-warning">{w}</p>)}
    {error && <p className="advice-warning">{error}</p>}

    {plan && <div className="advice-plan">
      <div className="advice-q"><strong>{plan.mode === 'emergency' ? '应急资金方案' : '配置方案'}</strong><small>{money(advice.params.amount)}</small></div>
      <SplitBar parts={plan.buckets.map(b => ({ id: b.id, amount: b.amount }))} />
      {plan.buckets.map(b => <div key={b.id} className="advice-bucket">
        <div className="advice-bucket-head"><span><i className={`seg ${b.id}`} />{b.label} {b.share}%</span><small>{BUCKET_HINT[b.id]}</small></div>
        {b.products.map(x => <div key={x.id} className="advice-product">
          <div className="advice-product-main"><strong>{x.name}</strong><span className="tag gray">{x.risk.split(' ')[0]}</span><b>{money(x.amount)}</b></div>
          <small className="advice-metric">{metricText(x.metric)}{x.metrics ? ` · 最大回撤 ${x.metrics.maxDrawdown}%` : ''}</small>
          <p>{x.reason}</p>
          <button className="btn-text" onClick={() => navigate(`wealth?product=${encodeURIComponent(x.id)}&amount=${(x.amount / 100).toFixed(0)}`)}>查看详情并申购<ChevronRight size={14} /></button>
        </div>)}
      </div>)}
      {!plan.buckets.length && <p className="data-note">暂无符合条件的产品。</p>}
      {plan.excluded.total > 0 && <p className="data-note">已排除 {plan.excluded.total} 款：{plan.excluded.reasons.map(r => `${r.reason} ${r.count} 款`).join('、')}。</p>}
      {plan.notes.map(n => <p key={n} className="data-note">{n}。</p>)}
    </div>}

    {onAsk && advice.suggestions.length > 0 && <div className="card-suggestions"><small>接下来可以问</small><div>{advice.suggestions.map(t => <button key={t} onClick={() => onAsk(t)}>{t}</button>)}</div></div>}
    <p className="data-note">产品数据：{advice.source.products}{advice.source.stale ? '（可能不是最新）' : ''}。{advice.disclaimer}</p>
  </section>;
}
