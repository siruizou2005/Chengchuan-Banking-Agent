import { useEffect, useState } from 'react';
import { AgentMark } from '../AgentMark';
import { Check, ShieldCheck } from 'lucide-react';
import { api, date, formValues, yuan } from '../api';
import { useBank } from '../bank';
import { Verify } from '../Verify';
import { InlineError, Modal, Notice, PinField } from '../ui';
import type { AgentAction, AgentEvent, AgentPlan, AgentTrace, Ledger, Product, ProductMeta, Subscription } from '../types';
import { pct as signedPct, sourceLine, statusText } from '../products';
import { AdviceCard } from './AdviceCard';
const status: Record<string, string> = { proposed: '待确认', confirmed: '已授权 · 待执行', awaiting_verification: '已暂停 · 待补充验证', executing: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', expired: '已过期', active: '进行中', pending: '待执行' };
export function DecisionTrace({ trace }: { trace: AgentTrace[] }) { return <details className="decision-trace"><summary>决策链路 · {trace.length} 步</summary><ol>{trace.map((t, i) => <li key={i}><strong>{t.tool}</strong><span>{t.ok ? '成功' : '未完成'}{t.level ? ` · ${t.level}` : ''}{t.durationMs !== undefined ? ` · ${t.durationMs}ms` : ''}</span><pre>{JSON.stringify(t.args, null, 2)}</pre>{t.result && <pre>{t.result}</pre>}</li>)}</ol></details>; }
export function ActionCard({ action: initial }: { action: AgentAction }) {
  const { data, refresh, navigate, showTransaction } = useBank();
  const action = data.agentActions.find(a => a.id === initial.id) || initial;
  const [verify, setVerify] = useState(false), [pinOpen, setPinOpen] = useState(false), [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const args = action.args;
  async function cancel() { setBusy(true); try { await api(`/agent/actions/${action.id}/cancel`, 'POST', {}); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  function start() { setError(''); if (action.tool === 'direct_operation') { const tx = data.transactions.find(t => t.id === args.resource); if (tx) showTransaction(tx); else navigate(args.path === '/settings' ? 'security' : 'accounts'); return; } action.level === 'red' ? setVerify(true) : setPinOpen(true); }
  return <section className="agent-card" aria-label={action.title} data-testid="agent-action">
    <header><span className={`agent-level ${action.level}`}><AgentMark size={17} />{action.level === 'red' ? '需加强验证' : '需授权确认'}</span><span>{status[action.status] || action.status}</span></header>
    <h3>{action.title}</h3>
    <p className="data-note">操作编号：{action.id}{action.accountTail ? ` · 账户尾号 ${action.accountTail}` : ''}{action.amount > 0 ? ` · 金额 ¥${yuan(action.amount)}` : ''}</p>
    {action.decision?.reasons.map(r => <p className="data-note" key={r.code}>{r.message}</p>)}
    {action.decision?.amounts && <p className="data-note">{action.decision.businessDate}（北京时间）：已完成 ¥{yuan(action.decision.amounts.completed)} · 已授权待执行 ¥{yuan(action.decision.amounts.committed)} · 其他待确认 ¥{yuan(action.decision.amounts.proposed)} · 本笔 ¥{yuan(action.decision.amounts.current)}</p>}
    {action.decision?.amountsByDate?.map(g=><p className="data-note" key={g.businessDate}>{g.businessDate}（北京时间）：本计划对外支出 ¥{yuan(g.current)} · 当日计入后累计 ¥{yuan(g.total)}</p>)}
    {args.scope && <Notice>查询授权范围：{args.scope}</Notice>}
    {action.authorization_until && <p className="data-note">授权执行期限：{date(action.authorization_until)}</p>}
    {action.status === 'awaiting_verification' && <Notice>{action.pause_reason}。请于 {date(action.verification_until || '')} 前完成模拟加强验证；等待期间保留剩余预留。</Notice>}
    <dl className="agent-details">{Object.entries({ 收款人: args.recipientLabel, 卡片: args.cardLabel, 订阅对象: args.subscriptionLabel, 持仓编号: args.holdingId, 贷款编号: args.loanId, 附言: args.note, 商户: args.merchant, 缴费户号: args.billNumber, 产品: args.productName, 计划时间: args.scheduleAt && date(args.scheduleAt), 锁定用途: args.purpose, 锁定至: args.until && date(args.until), 卡片操作: args.action && ({ freeze: '冻结', unfreeze: '解冻', report_lost: '挂失', unlost: '解挂' } as Record<string, string>)[args.action], 虚拟卡限额: args.limit && `¥${args.limit}` }).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v as string}</dd></div>)}</dl>
    {action.plan && <PlanCard plan={data.agentPlans.find(p => p.id === action.plan!.id) || action.plan} />}
    {action.channel !== 'app' && <p className="data-note">来自{action.channel === 'feishu' ? '飞书' : '微信'}私聊，请核对后在此确认。</p>}
    {['proposed', 'awaiting_verification'].includes(action.status) && <><p className="data-note">{action.status === 'proposed' ? `确认前不执行，有效期至 ${date(action.expires_at)}。` : '补充验证后将重新复核，并继续未完成步骤。'}</p><div className="agent-buttons"><button className="pill primary" disabled={busy} onClick={start}>{action.level === 'red' ? <ShieldCheck size={15} /> : null}{action.status === 'awaiting_verification' ? '补充验证并恢复' : action.level === 'red' ? '前往验证' : '确认操作'}</button><button className="pill" disabled={busy} onClick={cancel}>取消</button></div></>}
    {action.status === 'confirmed' && !action.plan && <button className="pill" onClick={cancel} disabled={busy}>取消定时操作</button>}
    {action.status === 'completed' && (action.tool === 'list_subscriptions' ? <SubscriptionsCard subscriptions={action.result?.subscriptions || []} /> : <ReceiptCard action={action} />)}
    <InlineError message={error || action.error || ''} />
    {verify && <Verify actionId={action.id} onCancel={() => setVerify(false)} onVerified={t => { setToken(t); setVerify(false); setPinOpen(true); }} />}
    {pinOpen && <Modal title="确认操作" onClose={() => { if (!busy) { setPinOpen(false); setToken(''); } }}><form className="stack-form" onSubmit={async e => { const f = formValues(e); setBusy(true); setError(''); try { const result = await api<AgentAction>(`/agent/actions/${action.id}/confirm`, 'POST', { pin: f.pin, verificationToken: token || undefined }); await refresh(); setPinOpen(false); setToken(''); if (result.status === 'failed') setError(result.error || '操作未完成'); } catch (e) { setError((e as Error).message); await refresh(); if ((e as { code?: string }).code?.includes('VERIFICATION')) { setPinOpen(false); setVerify(true); } } finally { setBusy(false); } }}><Notice>{action.title}{action.plan ? '。确认后计划金额将预授权并预留，到期自动执行，可随时中断未执行步骤。' : ''}</Notice><PinField /><InlineError message={error} /><button className="btn-primary" disabled={busy}>确认{action.plan ? '整个计划' : '执行'}</button></form></Modal>}
  </section>;
}
export function ReceiptCard({ action }: { action: AgentAction }) { return <div className="agent-receipt receipt"><Check size={18} /><strong>{action.tool === 'propose_split' ? 'AA请求已生成，等待成员付款' : '操作完成'}</strong><small>{action.result?.id ? '回单编号' : '操作编号'}：{action.result?.id || action.id}</small>{action.result?.requests?.map((r: { url: string; to: string; amount: number }) => <a key={r.url} href={r.url}>{r.to} · ¥{yuan(r.amount)} · AA收款链接</a>)}</div>; }
export function PlanCard({ plan }: { plan: AgentPlan }) {
  const { refresh, toast } = useBank();
  async function act(handover = false) { try { await api(`/agent/plans/${plan.id}/${handover ? 'handover' : 'abort'}`, 'POST', {}); await refresh(); toast(handover ? '计划已中断并创建人工工单' : '计划已中断，未使用资金已释放'); } catch (e) { toast((e as Error).message, true); } }
  return <div className="agent-plan"><p className="data-note">计划资金范围 ¥{yuan(plan.budget || 0)}{plan.authorization_until ? ` · 授权至 ${date(plan.authorization_until)}` : ''}</p>{plan.pause_reason && <Notice>{plan.pause_reason}</Notice>}<ol>{plan.steps.map(s => <li key={s.id} className={s.status}><i aria-hidden="true" /><div><strong>{s.title}</strong><small>{status[s.status]}{s.runAt || s.args.scheduleAt ? ` · ${date(s.runAt || s.args.scheduleAt)}` : ''}</small>{s.dependsOn.length > 0 && <small>依赖：{s.dependsOn.join('、')}</small>}{s.args.amount && <small>¥{s.args.amount}{s.args.merchant ? ` · ${s.args.merchant}` : ''}{s.args.recipientLabel ? ` · ${s.args.recipientLabel}` : ''}</small>}{s.args.cardLabel && <small>卡片：{s.args.cardLabel} · {s.args.action}</small>}{s.args.subscriptionLabel && <small>订阅：{s.args.subscriptionLabel}</small>}{s.args.productName && <small>产品：{s.args.productName}</small>}{s.args.purpose && <small>锁定用途：{s.args.purpose} · 截止 {date(s.args.until)}</small>}</div></li>)}</ol>{['active', 'completed', 'awaiting_verification'].includes(plan.status) && <div className="agent-buttons"><button className="pill" onClick={() => act()}>中断并释放锁定</button><button className="btn-text" onClick={() => act(true)}>转人工</button></div>}</div>;
}
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const span = (r: { from: string; to: string }) => r.from === r.to ? r.from : `${r.from} 至 ${r.to}`;
const STATS_LABEL: Record<string, string> = { category: '按分类', merchant: '按商户', platform: '按支付平台', month: '按月', week: '按周', day: '按日', weekday: '按星期', hour: '按小时' };
const KIND_TEXT: Record<string, string> = { consumption: '消费', income: '收入', transfer_out: '转账给他人', self: '本人账户互转', wallet: '充值提现', investment: '理财存款', debt: '信用卡/贷款', refund: '退款' };
// Reference categorical slots in fixed order; the folded tail is neutral gray.
const SLOTS = ['#8ca8b8', '#a47551', '#849b75', '#c4ac75', '#ba8c80'], OTHER = '#b8b1a5';
const isUnknownTag = (tag: string) => tag === '未识别商户' || /^(支付宝|微信支付|京东支付|抖音支付)支出$/.test(tag);
const dayText = (d: string) => `${+d.slice(5, 7)}月${+d.slice(8, 10)}日`;
type Bucket = { key: string; amount: number; count: number; share: number };
type Part = { name: string; amount: number; count?: number; share: number };
type Query = Record<string, string | undefined> | null;
type Ask = (text: string) => void;

function Suggestions({ items, onAsk }: { items?: string[]; onAsk?: Ask }) {
  if (!items?.length || !onAsk) return null;
  return <div className="card-suggestions"><small>接下来可以看</small><div>{items.map(text => <button key={text} onClick={() => onAsk(text)}>{text}</button>)}</div></div>;
}
// Expands one slice or bar into its transactions, using the same filters as the ledger page.
function Drill({ title, query, onClose }: { title: string; query: Record<string, string | undefined>; onClose: () => void }) {
  const { navigate } = useBank();
  const [rows, setRows] = useState<Ledger[] | null>(null), [error, setError] = useState('');
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]).toString();
  useEffect(() => { let live = true; setRows(null); setError(''); api<Ledger[]>(`/ledger?${qs}`).then(r => { if (live) setRows(r); }).catch(e => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [qs]);
  return <div className="drill">
    <div className="drill-head"><strong>{title}</strong><button className="btn-text" onClick={onClose}>收起</button></div>
    {rows?.slice(0, 8).map(r => <div className="report-line" key={r.id}><span title={r.title}>{(r.bj_time || '').slice(5)} {r.merchant || r.title}</span><span className={r.amount > 0 ? 'income' : undefined}>{r.amount > 0 ? '+' : '-'}¥{yuan(Math.abs(r.amount))}</span></div>)}
    {rows && !rows.length && <p className="data-note">没有找到对应流水。</p>}
    {rows && rows.length > 8 && <button className="btn-text" onClick={() => navigate(`ledger?${qs}`)}>在交易记录中查看全部 {rows.length} 笔</button>}
    {!rows && !error && <p className="data-note">正在加载明细…</p>}
    {error && <p className="data-note">{error}</p>}
  </div>;
}
function Donut({ slices, center, value, selected, onSelect }: { slices: (Part & { color: string })[]; center: string; value: number; selected: string; onSelect: (name: string) => void }) {
  const r = 50, c = 2 * Math.PI * r, total = slices.reduce((n, s) => n + s.amount, 0) || 1;
  let offset = 0;
  return <svg className="donut" viewBox="0 0 140 140" role="img" aria-label={`${center}占比`}>
    {slices.map(s => { const len = s.amount / total * c, arc = <circle key={s.name} cx="70" cy="70" r={r} fill="none" stroke={s.color} strokeWidth={selected === s.name ? 24 : 18} strokeDasharray={`${Math.max(0.5, len - 2)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)" onClick={() => onSelect(s.name)}><title>{s.name} ¥{yuan(s.amount)}</title></circle>; offset += len; return arc; })}
    <text x="70" y="64" textAnchor="middle" className="donut-caption">{center}</text>
    <text x="70" y="84" textAnchor="middle" className="donut-value">¥{yuan(value)}</text>
  </svg>;
}
// Part-to-whole at a glance: at most five colored slices plus a folded 其他; every row opens its transactions.
function PartChart({ parts, center, value, drill, title }: { parts: Part[]; center: string; value: number; drill: (name: string) => Query; title: (name: string) => string }) {
  const [selected, setSelected] = useState(''), [rest, setRest] = useState(false);
  const positive = parts.filter(p => p.amount > 0), head = positive.slice(0, positive.length > 6 ? 5 : 6), tail = positive.slice(head.length);
  const slices = [...head.map((p, i) => ({ ...p, color: SLOTS[i] || OTHER })), ...(tail.length ? [{ name: '其他', amount: tail.reduce((n, p) => n + p.amount, 0), share: tail.reduce((n, p) => n + p.share, 0), count: tail.reduce((n, p) => n + (p.count || 0), 0), color: OTHER }] : [])];
  const pick = (name: string) => { if (name === '其他') { setRest(!rest); return; } setSelected(selected === name ? '' : name); };
  const row = (p: Part, color: string) => <li key={p.name}><button className={selected === p.name || (p.name === '其他' && rest) ? 'active' : ''} onClick={() => pick(p.name)}><i style={{ background: color }} /><span title={p.name}>{p.name}</span><b>¥{yuan(p.amount)}</b><small>{pct(p.share)}</small></button></li>;
  const query = selected ? drill(selected) : null;
  if (!positive.length) return <p className="data-note">该时段没有符合条件的流水。</p>;
  return <>
    <div className="part-chart"><Donut slices={slices} center={center} value={value} selected={selected} onSelect={pick} /><ul className="legend">{slices.map(s => row(s, s.color))}{rest && tail.map(p => row(p, OTHER))}</ul></div>
    {query && <Drill title={title(selected)} query={query} onClose={() => setSelected('')} />}
    {!selected && <p className="data-note chart-hint">点击色块或分类查看具体花费</p>}
  </>;
}
function Columns({ buckets, label, drill, title }: { buckets: Bucket[]; label: (key: string) => string; drill?: (key: string) => Query; title: (key: string) => string }) {
  const [selected, setSelected] = useState(''), max = Math.max(1, ...buckets.map(b => b.amount)), peak = [...buckets].sort((a, b) => b.amount - a.amount)[0];
  const labelled = buckets.length <= 12, query = selected && drill ? drill(selected) : null;
  return <>
    <div className="columns" role="img" aria-label="金额分布">{buckets.map(b => <button key={b.key} className={selected === b.key ? 'active' : ''} title={`${label(b.key)} ¥${yuan(b.amount)}`} disabled={!drill || !b.count} onClick={() => setSelected(selected === b.key ? '' : b.key)}><i style={{ height: `${b.amount > 0 ? Math.max(4, b.amount / max * 100) : 0}%` }} /></button>)}</div>
    <div className={`report-axis${labelled ? ' labelled' : ''}`}>{(labelled ? buckets : [buckets[0], buckets.at(-1)!]).map(b => <span key={b.key}>{label(b.key)}</span>)}</div>
    {peak?.amount > 0 && <p className="data-note">最高：{label(peak.key)} ¥{yuan(peak.amount)}（{peak.count}笔）{drill ? '；点柱子查看明细' : ''}</p>}
    {query && <Drill title={title(selected)} query={query} onClose={() => setSelected('')} />}
  </>;
}
function RankList({ buckets, drill, title }: { buckets: Bucket[]; drill: (key: string) => Query; title: (key: string) => string }) {
  const [selected, setSelected] = useState(''), max = Math.max(1, ...buckets.map(b => b.amount)), query = selected ? drill(selected) : null;
  return <>
    <ol className="rank-list">{buckets.filter(b => b.count).slice(0, 10).map(b => <li key={b.key}><button className={selected === b.key ? 'active' : ''} onClick={() => setSelected(selected === b.key ? '' : b.key)}><span title={b.key}>{b.key}</span><b>¥{yuan(b.amount)}</b><i style={{ width: `${Math.max(2, b.amount / max * 100)}%` }} /><small>{b.count}笔 · {pct(b.share)}</small></button></li>)}</ol>
    {query && <Drill title={title(selected)} query={query} onClose={() => setSelected('')} />}
  </>;
}
// Reports saved before the analytics rewrite have no totals; keep rendering them as they were.
function LegacyReportCard({ report }: { report: { period: string; income: number; expense: number; net: number; count: number; categories: { name: string; amount: number; share: number }[]; change: number | null; scope: string } }) {
 return <section className="agent-card report-card"><header><span className="agent-level green">账单分析</span><span>{report.period}</span></header><h3>收支账单</h3><div className="report-totals"><div><small>收入</small><strong>¥{yuan(report.income)}</strong></div><div><small>支出</small><strong>¥{yuan(report.expense)}</strong></div></div><div className="report-bars" role="img" aria-label={`支出分类，共${report.count}笔流水`}>{report.categories.map(c => <div className="report-bar" key={c.name}><span>{c.name}</span><div><i style={{ width: `${Math.max(0, c.share * 100)}%` }} /></div><span>¥{yuan(c.amount)}<small>{pct(c.share)}</small></span></div>)}</div><p className="data-note">结余 ¥{yuan(report.net)} · {report.change === null ? '暂无上期可比数据' : `支出环比 ${report.change >= 0 ? '+' : ''}${pct(report.change)}`}</p><p className="data-note">{report.scope}</p></section>;
}
export function ReportCard({ report, onAsk }: { report: any; onAsk?: Ask }) { return report.totals ? <BillReport report={report} onAsk={onAsk} /> : <LegacyReportCard report={report} />; }
function BillReport({ report, onAsk }: { report: any; onAsk?: Ask }) {
  const t = report.totals, single = report.from === report.to, previous = report.previous, scope = report.label === report.period ? span(report) : `${report.label} · ${span(report)}`;
  const title = /^\d{4}-\d{2}-\d{2}$/.test(report.period) ? '日账单' : /^\d{4}-\d{2}$/.test(report.period) ? '月度账单' : /^\d{4}$/.test(report.period) ? '年度账单' : ['本周', '上周'].includes(report.label) ? '周账单' : '账单报告';
  const unknown = (report.categories as Part[]).filter(c => isUnknownTag(c.name) && c.amount > 0);
  const outside = [t.transferOut ? `转账给他人 ¥${yuan(t.transferOut)}` : '', ...report.excluded.filter((e: { out: number }) => e.out).map((e: { name: string; out: number }) => `${e.name} ¥${yuan(e.out)}`)].filter(Boolean);
  const notes = [
    outside.length ? `不计入消费：${outside.join('、')}` : '',
    previous && previous.change !== null ? `比上期${previous.change >= 0 ? '多' : '少'} ${pct(Math.abs(previous.change))}` : '',
    unknown.length ? `${unknown.map(c => c.name).join('、')}只显示支付平台，看不到具体商户` : '',
    report.coverage.partial && report.coverage.last ? `流水只到 ${report.coverage.last}` : '',
  ].filter(Boolean);
  return <section className="agent-card report-card">
    <header><span className="agent-level green">账单分析</span><span>{scope}</span></header>
    <h3>{title}</h3>
    <div className="report-totals three"><div><small>消费</small><strong>¥{yuan(t.consumption)}</strong></div><div><small>收入</small><strong>¥{yuan(t.income)}</strong></div><div><small>{single ? '消费笔数' : '日均消费'}</small><strong>{single ? t.consumptionCount : `¥${yuan(t.dailyAverage)}`}</strong></div></div>
    <PartChart parts={report.categories} center="消费" value={t.consumption} title={name => `${name} · ${span(report)}`} drill={name => ({ from: report.from, to: report.to, category: name, kind: 'spend' })} />
    {notes.length > 0 && <p className="data-note">{notes.join('；')}。</p>}
    <Suggestions items={report.suggestions} onAsk={onAsk} />
  </section>;
}
export function StatsCard({ stats, onAsk }: { stats: any; onAsk?: Ask }) {
  const buckets: Bucket[] = stats.buckets, kind = stats.kind === 'consumption' ? 'spend' : stats.kind, scope = stats.label === stats.period ? span(stats) : `${stats.label} · ${span(stats)}`;
  const base = { from: stats.from, to: stats.to, kind, category: stats.category || undefined, q: stats.keyword || undefined };
  const monthEnd = (ym: string) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
  const clamp = (from: string, to: string) => ({ ...base, from: from < stats.from ? stats.from : from, to: to > stats.to ? stats.to : to });
  const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const label = (key: string) => stats.by === 'day' ? key.slice(5) : stats.by === 'week' ? `${key.slice(5)}起` : stats.by === 'month' ? `${+key.slice(5)}月` : stats.by === 'hour' ? key.replace('时', '') : key;
  const drillTime = (key: string): Query => stats.by === 'day' ? clamp(key, key) : stats.by === 'week' ? clamp(key, addDays(key, 6)) : stats.by === 'month' ? clamp(`${key}-01`, monthEnd(key)) : null;
  const drillPart = (key: string): Query => stats.by === 'category' ? { ...base, category: key } : stats.by === 'platform' ? { ...base, platform: key } : isUnknownTag(key) ? { ...base, category: key } : { ...base, q: key };
  const timeTitle = (key: string) => stats.by === 'day' ? dayText(key) : stats.by === 'week' ? `${dayText(key)}起一周` : `${+key.slice(5)}月`;
  return <section className="agent-card report-card">
    <header><span className="agent-level green">账单统计</span><span>{scope}</span></header>
    <h3>{KIND_TEXT[stats.kind] || stats.kind}{STATS_LABEL[stats.by]}{stats.category ? ` · ${stats.category}` : ''}{stats.keyword ? ` · “${stats.keyword}”` : ''}</h3>
    <div className="report-totals"><div><small>合计</small><strong>¥{yuan(stats.total)}</strong></div><div><small>笔数</small><strong>{stats.count}</strong></div></div>
    {!stats.count ? <p className="data-note">该时段没有符合条件的流水。</p>
      : ['category', 'platform'].includes(stats.by) ? <PartChart parts={buckets.map(b => ({ name: b.key, amount: b.amount, count: b.count, share: b.share }))} center={KIND_TEXT[stats.kind] || '合计'} value={stats.total} title={key => `${key} · ${span(stats)}`} drill={drillPart} />
      : stats.by === 'merchant' ? <RankList buckets={buckets} title={key => `${key} · ${span(stats)}`} drill={drillPart} />
      : <Columns buckets={buckets} label={label} title={timeTitle} drill={['day', 'week', 'month'].includes(stats.by) ? drillTime : undefined} />}
    {stats.skipped > 0 && <p className="data-note">{stats.skipped} 笔原对账单只有日期，未计入按小时统计。</p>}
    <Suggestions items={stats.suggestions} onAsk={onAsk} />
  </section>;
}
export function SubscriptionsCard({ subscriptions }: { subscriptions: Subscription[] }) {
 const { refresh, toast, data } = useBank(); const [actions, setActions] = useState<AgentAction[]>([]);
 return <section className="agent-card"><h3>订阅代扣</h3>{subscriptions.map(initial => { const s = data.subscriptions.find(x => x.id === initial.id) || initial; return <div className="agent-list-row" key={s.id}><div><strong>{s.merchant}</strong><small>¥{yuan(s.amount)}/月 · {s.status === 'active' ? `续费 ${date(s.next_at)}` : '已停止'}</small></div>{s.status === 'active' && <button className="pill small" onClick={async () => { try { const a = await api<AgentAction>('/agent/actions', 'POST', { tool: 'propose_cancel_subscription', args: { id: s.id } }); setActions(old => [...old, a]); await refresh(); } catch (e) { toast((e as Error).message, true); } }}>取消订阅</button>}</div>; })}{actions.map(a => <ActionCard key={a.id} action={a} />)}</section>;
}
export function ProductsCard({ products, meta, title = '产品对比' }: { products: Product[]; meta?: ProductMeta; title?: string }) { const { navigate } = useBank(); return <section className="agent-card"><h3>{title}</h3>{products.map(p => <div className="agent-list-row" key={p.id}><div><strong>{p.name}</strong><small>{p.risk} · ¥{yuan(p.minimum)}起 · {p.type === 'deposit' ? `${p.days}天` : statusText(p) || '灵活申赎'}</small></div><b>{p.rateLabel ? <small>{p.rateLabel} </small> : null}{p.type === 'deposit' ? `${p.rate?.toFixed(2)}%` : signedPct(p.rate)}</b></div>)}{meta && <p className="data-note">{sourceLine(meta)}{meta.stale ? '，数据可能不是最新' : ''}。</p>}<p className="data-note">过往业绩不代表未来表现，不构成收益承诺；本环境为模拟申购，须完成风险匹配与加强验证。</p><button className="btn-text" onClick={() => navigate('risk')}>查看 / 完成风险测评</button></section>; }
export function LockedCard({ message }: { message: string }) { const { navigate } = useBank(); return <section className="agent-card locked-card"><h3>智能助手安全锁定</h3><p>{message}</p><button className="pill" onClick={() => navigate('security')}>前往安全中心</button></section>; }
export function VerifyRequiredCard({ action }: { action: AgentAction }) { return <ActionCard action={action} />; }
export function EventCards({ events, onAsk }: { events: AgentEvent[]; onAsk?: Ask }) { return <>{events.map((e, i) => ['action', 'plan'].includes(e.type) ? <ActionCard key={e.data.id} action={e.data} /> : e.type === 'report' ? <ReportCard key={i} report={e.data} onAsk={onAsk} /> : e.type === 'stats' ? <StatsCard key={i} stats={e.data} onAsk={onAsk} /> : e.type === 'subscriptions' ? <SubscriptionsCard key={i} subscriptions={e.data.subscriptions} /> : e.type === 'advice' ? <AdviceCard key={i} initial={e.data} onAsk={onAsk} /> : e.type === 'products' ? <ProductsCard key={i} products={e.data.products} meta={e.data.meta} title={e.data.title} /> : e.type === 'locked' ? <LockedCard key={i} message={e.data.message} /> : e.type === 'anomalies' ? <section className="agent-card" key={i}><h3>异常支出提示</h3>{e.data.map((r: any) => <div className="agent-list-row" key={r.id}><div><strong>{r.title} · ¥{yuan(-r.amount)}</strong><small>{r.bj_time || date(r.created_at)}{r.tag ? ` · ${r.tag}` : ''}</small><small>{r.reasons.join('；')}</small></div></div>)}{!e.data.length && <p>当前数据范围内未命中规则。</p>}<p className="data-note">仅为规则提示，请核实实际交易用途。</p></section> : e.type === 'handover' ? <Notice key={i}>模拟人工工单：{e.data.id}</Notice> : null)}</>; }
