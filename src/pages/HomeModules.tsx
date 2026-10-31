import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChartNoAxesColumnIncreasing, ChevronRight, ReceiptText, Settings2, ShoppingBag } from 'lucide-react';
import { api, yuan } from '../api';
import { useBank } from '../bank';
import { IcoCard, IcoWealth } from '../icons';
import type { HomeModule } from '../types';
import type { Icon } from '../ui';

const MODULES: { id: HomeModule; label: string; detail: string }[] = [
  { id: 'bill_daily', label: '账单日报', detail: '昨天的支出、收入和笔数' },
  { id: 'spend_tips', label: '消费推荐', detail: '根据本月账单给出的消费提示' },
  { id: 'recommend', label: '为你推荐', detail: '支出、理财和信用卡的常用入口' },
];
type Report = { from: string; label: string; totals: { consumption: number; income: number; count: number; transferOut: number }; categories: { name: string; amount: number; share: number }[]; topMerchants: { name: string; amount: number; count: number }[]; previous?: { change?: number | null } | null };
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

function useReport(preset: string) {
  const { data } = useBank(), latest = data.ledger[0]?.id;
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ report: Report }>(`/ledger/report?preset=${preset}`).then(r => { if (alive) { setReport(r.report); setError(false); } }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [preset, beijingToday(), latest]);
  return { report, error };
}

function BillDaily() {
  const { navigate, hidden } = useBank();
  const { report, error } = useReport('yesterday');
  const mask = (n: number) => hidden ? '****' : yuan(n);
  const day = report?.from.slice(5).replace('-', '月');
  return <section className="cc-home-card" data-testid="module-bill-daily"><header><h2>账单日报{day && <small>{day}日</small>}</h2><button className="icon-button" aria-label="查看账单报告" onClick={() => navigate('bill-report')}><ChevronRight size={17} /></button></header>
    {error ? <p className="cc-module-note">账单暂时读取失败，稍后会自动重试。</p> : !report ? <p className="cc-module-note">正在读取账单…</p> : <button className="cc-daily" onClick={() => navigate('bill-report')}>
      <span><small>支出（元）</small><b>{mask(report.totals.consumption + report.totals.transferOut)}</b></span>
      <span><small>收入（元）</small><b>{mask(report.totals.income)}</b></span>
      <span><small>交易笔数</small><b>{report.totals.count}</b></span>
    </button>}
    {report && report.categories[0] && <p className="cc-module-note">昨天花得最多的是「{report.categories[0].name}」{hidden ? '' : ` ¥${yuan(report.categories[0].amount)}`}</p>}
  </section>;
}

// Plain statistics from this month's statement: opening the home page never calls the model.
function SpendTips() {
  const { askAgent, hidden } = useBank();
  const { report, error } = useReport('this_month');
  const amount = (n: number) => hidden ? '' : ` ¥${yuan(n)}`;
  const tips: { icon: Icon; title: string; detail: string; prompt: string }[] = [];
  const top = report?.categories[0], merchant = report?.topMerchants[0];
  if (top) tips.push({ icon: ShoppingBag, title: `本月「${top.name}」花得最多`, detail: `${amount(top.amount).trim()}${hidden ? '' : '，'}占本月消费 ${Math.round(top.share * 100)}%`, prompt: `请分析我本月在「${top.name}」上的消费，告诉我有哪些可以节省的地方。` });
  if (merchant) tips.push({ icon: ReceiptText, title: `常去「${merchant.name}」`, detail: `本月 ${merchant.count} 笔${amount(merchant.amount)}`, prompt: `请分析我本月在「${merchant.name}」的消费是否合理。` });
  return <section className="cc-home-card" data-testid="module-spend-tips"><header><h2>消费推荐</h2></header>
    {error ? <p className="cc-module-note">账单暂时读取失败，稍后会自动重试。</p> : !report ? <p className="cc-module-note">正在读取账单…</p> : !tips.length ? <p className="cc-module-note">本月还没有消费记录，有消费后这里会给出提示。</p> : tips.map(t => <Recommendation key={t.title} icon={t.icon} tone="gold" title={t.title} detail={t.detail} onClick={() => askAgent(t.prompt)} />)}
  </section>;
}

function Recommend({ onSelectCredit }: { onSelectCredit: () => void }) {
  const { askAgent, navigate } = useBank();
  return <section className="cc-home-card" data-testid="module-recommend"><header><h2>为你推荐</h2><button className="icon-button" aria-label="查看智能助手操作与计划" onClick={() => navigate('tasks')}><ChevronRight size={17} /></button></header>
    <Recommendation icon={ChartNoAxesColumnIncreasing} tone="gold" title="优化本月支出结构" detail="智能分析，帮你更好规划" onClick={() => askAgent('请分析本月支出结构，给出基于实际账单的建议。')} />
    <Recommendation icon={IcoWealth} tone="mint" title="查看我的理财机会" detail="根据你的风险偏好推荐" onClick={() => navigate('advice')} />
    <Recommendation icon={IcoCard} title="管理我的信用卡" detail="账单、还款、额度一站式管理" onClick={onSelectCredit} />
  </section>;
}

function Recommendation({ icon: Icon, title, detail, onClick, tone = 'blue' }: { icon: Icon; title: string; detail: string; onClick: () => void; tone?: string }) {
  return <button className="cc-recommendation" onClick={onClick}><span className={`cc-mini-icon ${tone}`}><Icon size={20} /></span><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={15} /></button>;
}

export function HomeModules({ onSelectCredit }: { onSelectCredit: () => void }) {
  const { data, refresh, toast } = useBank();
  const [editing, setEditing] = useState(false), [modules, setModules] = useState<HomeModule[]>(data.user.homeModules);
  useEffect(() => { setModules(data.user.homeModules); }, [data.user.homeModules.join()]);
  function save(next: HomeModule[]) {
    const previous = modules;
    setModules(next);
    api('/me/home-modules', 'POST', { modules: next }).then(() => refresh()).catch(e => { setModules(previous); toast((e as Error).message, true); });
  }
  const move = (id: HomeModule, delta: number) => { const list = [...modules], at = list.indexOf(id), to = at + delta; if (at < 0 || to < 0 || to >= list.length) return; [list[at], list[to]] = [list[to], list[at]]; save(list); };
  const ordered = [...modules.map(id => MODULES.find(m => m.id === id)!), ...MODULES.filter(m => !modules.includes(m.id))];
  return <div className="cc-custom-zone" data-testid="home-custom-zone">
    <div className="cc-custom-head"><h2>我的关注</h2><button aria-expanded={editing} data-testid="home-customize" onClick={() => setEditing(!editing)}><Settings2 size={15} />{editing ? '完成' : '自定义'}</button></div>
    {editing && <section className="cc-home-card cc-custom-editor" aria-label="选择首页显示的内容">{ordered.map(m => { const on = modules.includes(m.id), at = modules.indexOf(m.id); return <div className="cc-custom-row" key={m.id}>
      <label><input type="checkbox" checked={on} onChange={() => save(on ? modules.filter(x => x !== m.id) : [...modules, m.id])} /><span><strong>{m.label}</strong><small>{m.detail}</small></span></label>
      {on && <span className="cc-custom-order"><button aria-label={`${m.label}上移`} disabled={at === 0} onClick={() => move(m.id, -1)}><ArrowUp size={16} /></button><button aria-label={`${m.label}下移`} disabled={at === modules.length - 1} onClick={() => move(m.id, 1)}><ArrowDown size={16} /></button></span>}
    </div>; })}</section>}
    {!modules.length && !editing && <section className="cc-home-card"><p className="cc-module-note">还没有选择内容，点右上角「自定义」添加账单日报、消费推荐或为你推荐。</p></section>}
    {modules.map(id => id === 'bill_daily' ? <BillDaily key={id} /> : id === 'spend_tips' ? <SpendTips key={id} /> : <Recommend key={id} onSelectCredit={onSelectCredit} />)}
  </div>;
}
