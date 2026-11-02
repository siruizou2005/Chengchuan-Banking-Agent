import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bell, Bot, ChevronRight, Eye, EyeOff, LoaderCircle, Search, Send, ShieldCheck, X } from 'lucide-react';
import { useBank } from '../bank';
import { api, date, yuan } from '../api';
import { compressAvatar } from '../avatar';
import { categoryMedian } from '../products';
import { Card, Tile, Empty, InlineError, UserAvatar, type Icon, type Tone } from '../ui';
import { IcoWallet, IcoTransfer, IcoRecord, IcoDeposit, IcoWealth, IcoLoan, IcoCard, IcoHouse, IcoQr, IcoPerson, IcoCalendar, IcoHeadset, IcoShield, IcoBell, IcoCode, IcoSwap, IcoGrid, BrandTexture } from '../icons';
import { AgentMark } from '../AgentMark';
import { ServiceArtwork, hasServiceArtwork } from '../DesignAssets';
import type { Feature } from '../workspace';
import { Accounts } from './Accounts';
import { HomeCashFlow } from './HomeCashFlow';
import { HomeModules } from './HomeModules';
import './home.css';
export const services: { id: string; label: string; icon: Icon; tone: Tone }[] = [
  { id: 'accounts', label: '银行卡', icon: IcoWallet, tone: 'blue' }, { id: 'transfer', label: '转账汇款', icon: IcoTransfer, tone: 'blue' },
  { id: 'ledger', label: '交易记录', icon: IcoRecord, tone: 'blue' }, { id: 'deposit', label: '定期存款', icon: IcoDeposit, tone: 'gold' },
  { id: 'wealth', label: '理财', icon: IcoWealth, tone: 'red' }, { id: 'loan', label: '贷款', icon: IcoLoan, tone: 'orange' },
  { id: 'credit', label: '信用卡', icon: IcoCard, tone: 'blue' }, { id: 'life', label: '生活缴费', icon: IcoHouse, tone: 'orange' },
  { id: 'receive', label: '收款码', icon: IcoQr, tone: 'blue' }, { id: 'scan', label: '扫一扫', icon: IcoQr, tone: 'blue' },
  { id: 'payees', label: '收款人', icon: IcoPerson, tone: 'blue' }, { id: 'appointments', label: '网点预约', icon: IcoCalendar, tone: 'blue' },
  { id: 'support', label: '在线客服', icon: IcoHeadset, tone: 'blue' }, { id: 'security', label: '安全中心', icon: IcoShield, tone: 'blue' },
  { id: 'messages', label: '消息中心', icon: IcoBell, tone: 'orange' }, { id: 'agent', label: '开发者中心', icon: IcoCode, tone: 'blue' },
];


const features: { id: Feature; label: string; icon: Icon; tone?: string }[] = [
  { id: 'accounts', label: '账户', icon: IcoWallet },
  { id: 'wealth', label: '理财', icon: IcoWealth },
  { id: 'transfer', label: '转账', icon: IcoSwap },
  { id: 'credit', label: '信用卡', icon: IcoCard },
  { id: 'loan', label: '贷款', icon: IcoLoan },
  { id: 'life', label: '生活', icon: IcoHouse },
  { id: 'ledger', label: '账单', icon: IcoRecord },
  { id: 'services', label: '更多', icon: IcoGrid },
];
const help: Record<Feature, [string, string]> = {
  accounts: ['让 Agent 帮我查询账户明细', '请查询我的账户、可用余额和最近交易，说明数据来源。'],
  wealth: ['让 Agent 帮我分析理财产品', '请根据我的风险测评和持仓分析现有理财产品。'],
  transfer: ['让 Agent 帮我填写', '我想转账，请先帮我核对收款人和金额，生成待我确认的操作，不要直接执行。'],
  credit: ['让 Agent 帮我分析账单', '请分析我的信用卡账单和待还金额。'],
  loan: ['让 Agent 帮我解释贷款条款', '请解释澄心贷的现有条款、费用和模拟环境限制。'],
  life: ['需要帮你查找附近的网点，或解答其他问题吗？', '请介绍现有网点预约服务和办理步骤，不要假设我的位置。'],
  ledger: ['让 Agent 帮我分析账单', '请分析我最近的收支账单，指出主要支出类别和异常交易，说明数据来源。'],
  services: ['需要了解某个功能的使用方法吗？', '请介绍当前银行实际支持的服务和使用方法。'],
};
export function AgentEntry({ feature }: { feature: Feature }) {
  const { askAgent } = useBank();
  return <button className="cc-agent-entry" onClick={() => askAgent(help[feature][1])}><AgentMark size={36} /><span>{help[feature][0]}</span><ChevronRight size={18} /></button>;
}

type HomeProps = { feature?: Feature; workspaceRoute?: string; title: string; onSelect: (feature: Feature) => void; onClose: () => void; onBack: () => void; canBack: boolean; children: ReactNode; operations: ReactNode; hasOperation: boolean };
export function Home({ feature, workspaceRoute, title, onSelect, onClose, onBack, canBack, children, operations, hasOperation }: HomeProps) {
  const { data, navigate, askAgent, busy, formError, hidden, toggleHidden, refresh, toast } = useBank();
  const [draft, setDraft] = useState(''), [uploading, setUploading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), panel = useRef<HTMLElement>(null);
  const [rendered, setRendered] = useState(Boolean(feature)), [expanded, setExpanded] = useState(false);
  const lastContent = useRef<ReactNode>(null);
  // CSS grid interpolates to intrinsic height; no measured/fixed business height.
  useEffect(() => {
    if (feature) {
      setRendered(true);
      const frame = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setRendered(false), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
    return () => clearTimeout(timer);
  }, [feature]);
  useEffect(() => {
    if (!feature) return;
    const timer = setTimeout(() => {
      const rect = heading.current?.getBoundingClientRect();
      if (rect && (rect.top < 0 || rect.bottom > innerHeight - 90)) heading.current?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, 230);
    return () => clearTimeout(timer);
  }, [workspaceRoute, feature]);
  const content = feature && <section ref={panel} className="cc-workspace" aria-labelledby="workspace-title" data-testid="inline-workspace">
    <header className="cc-workspace-head">{canBack && <button className="icon-button" aria-label="返回上一步" onClick={onBack} disabled={busy}><ArrowLeft size={18} /></button>}<h2 id="workspace-title" ref={heading} tabIndex={-1}>{workspaceRoute === 'channels' ? 'Bot 绑定管理' : workspaceRoute === 'accounts' ? '账户' : workspaceRoute === 'services' ? '更多功能' : title}</h2><button className="icon-button" aria-label="收起功能" disabled={busy} onClick={() => { onClose(); document.querySelector<HTMLButtonElement>(`[data-feature="${feature}"]`)?.focus({ preventScroll: true }); }}><X size={19} /></button></header>
    <div hidden={hasOperation}>{children}</div>
    {operations}
    {!hasOperation && <InlineError message={formError?.message || ''} />}
    <AgentEntry feature={feature} />
  </section>;
  if (content) lastContent.current = content;
  const unread = data.notifications.filter(n => !n.is_read).length;
  const total = data.accounts.reduce((s, a) => s + a.balance, 0) + data.holdings.reduce((s, h) => s + h.value, 0);
  const earned = data.earningsSummary;
  const signed = (n: number) => hidden ? '****' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${yuan(Math.abs(n))}`;
  const hour = new Date(Date.now() + 8 * 3600000).getUTCHours();
  const greeting = hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  // Verification codes stay in the message center: the home page is on screen too often to show them.
  const latest = data.notifications.filter(n => !n.title.includes('验证码')).slice(0, 3);
  async function pickAvatar(file?: File) {
    if (!file) return;
    setUploading(true);
    try { await api('/me/avatar', 'POST', { image: await compressAvatar(file) }); await refresh(); toast('头像已更新'); }
    catch (e) { toast((e as Error).message, true); }
    finally { setUploading(false); }
  }
  return <main className="cc-home">
    <div className="cc-brand-zone"><BrandTexture className="cc-brand-texture" /><header className="cc-brand-header"><div className="cc-brand-top"><span aria-hidden="true" /><h1>澄川银行</h1><div><button className="icon-button" aria-label="搜索" onClick={() => navigate('search')}><Search size={22} /></button><button className="icon-button" aria-label={unread ? `消息中心，${unread}条未读` : '消息中心'} onClick={() => navigate('messages')}><Bell size={21} />{unread > 0 && <i className="dot" />}</button></div></div></header>
    <div className="cc-user-row"><label className="cc-user-avatar" aria-label="更换头像"><input type="file" accept="image/*" data-testid="avatar-input" disabled={uploading} onChange={e => { void pickAvatar(e.target.files?.[0]); e.target.value = ''; }} /><UserAvatar size={54} />{uploading && <i><LoaderCircle size={20} className="spin" /></i>}</label><div><strong data-testid="home-nickname">{data.user.nickname}</strong><small>{greeting}，欢迎回到澄川银行</small></div></div>
    <div className="cc-feature-grid" aria-label="常用服务">{features.map(f => <button key={f.id} data-feature={f.id} data-testid={`feature-${f.id}`} aria-expanded={feature === f.id} aria-controls="home-workspace" className={`cc-feature ${feature === f.id ? 'selected' : ''}`} disabled={busy} onClick={() => onSelect(f.id)}><span className={`cc-feature-icon ${f.tone || 'blue'}`}><f.icon size={26} className="cc-feature-art" /></span><span>{f.label}</span></button>)}</div>
    </div>
    <div id="home-workspace" className={`cc-expansion${expanded ? ' expanded' : ''}`} inert={!feature} aria-hidden={!feature}><div>{rendered && (content || lastContent.current)}</div></div>
    <form className="cc-agent-input" onSubmit={e => { e.preventDefault(); if (draft.trim()) { askAgent(draft.trim()); setDraft(''); } }}><AgentMark size={30} /><input aria-label="向 Agent 提问" placeholder="和我聊聊你的任何金融需求…" value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} /><button type="submit" aria-label="发送给智能助手" disabled={!draft.trim() || busy}><Send size={19} /></button></form>
    <section className="cc-asset-card" aria-label="资产情况"><div className="cc-asset-top"><span className="cc-asset-title"><h2>总资产</h2><button className="icon-button" aria-label={hidden ? '显示金额' : '隐藏金额'} onClick={toggleHidden}>{hidden ? <EyeOff size={18} /> : <Eye size={18} />}</button></span><button className="cc-asset-amount" data-testid="home-total-assets" onClick={() => onSelect('accounts')}>{hidden ? '******' : `¥${yuan(total)}`}</button></div><div className="cc-asset-stats"><span>累计收益<b className={earned.total < 0 ? 'down' : ''}>{signed(earned.total)}</b></span><span>昨日收益<b className={earned.yesterday < 0 ? 'down' : ''}>{signed(earned.yesterday)}</b></span></div></section>
    <HomeModules onSelectCredit={() => onSelect('credit')} />
    {latest.length > 0 && <section className="cc-home-card cc-home-messages" data-testid="home-messages"><header><h2>消息</h2><button className="cc-card-link" onClick={() => navigate('messages')}>全部{unread > 0 ? `（${unread}条未读）` : ''}<ChevronRight size={15} /></button></header>{latest.map(n => <button className={`cc-home-message${n.is_read ? ' read' : ''}`} key={n.id} onClick={() => navigate(`messages?id=${encodeURIComponent(n.id)}`)}>{!n.is_read && <i className="dot" aria-label="未读" />}<span><strong>{n.title}</strong>{!hidden && <small>{n.body}</small>}</span><time>{date(n.created_at)}</time></button>)}</section>}
    <section className="cc-home-card"><header><h2>财富机会</h2><button className="icon-button" aria-label="查看理财服务" onClick={() => onSelect('wealth')}><ChevronRight size={17} /></button></header>
      <div className="cc-opportunities">{[
        { name: '稳健优选', route: 'funds?maxRisk=2', caption: '近一年中位数', stat: categoryMedian(data.products, p => p.riskLevel != null && p.riskLevel <= 2, p => p.returns?.y1) },
        { name: '全球视野', route: 'funds?category=qdii', caption: '近一年中位数', stat: categoryMedian(data.products, p => p.category === 'qdii', p => p.returns?.y1) },
        { name: '流动性管理', route: 'funds?category=money', caption: '7日年化中位数', stat: categoryMedian(data.products, p => p.category === 'money', p => p.rate) },
      ].map(({ name, route, caption, stat }) => <button className="cc-opportunity" key={route} onClick={() => navigate(route)}>
        <strong>{name}</strong>
        <b className={(stat?.value ?? 0) < 0 ? 'down' : undefined}>{stat ? `${stat.value.toFixed(2)}%` : '--'}</b>
        <small>{caption}</small>
        {stat && <span className="cc-opportunity-tag">{stat.minRisk === stat.maxRisk ? `R${stat.minRisk}` : `R${stat.minRisk}–R${stat.maxRisk}`} · {stat.count}只</span>}
      </button>)}</div>
      <p className="cc-opportunity-note">基金过往业绩不预示未来表现，市场有风险，投资需谨慎</p>
    </section>
    <footer className="cc-footnote"><ShieldCheck size={12} />澄川银行 · 模拟演示环境</footer>
  </main>;
}
export function AccountWorkspace() {
  const { data, hidden, toggleHidden, navigate } = useBank();
  const [tab, setTab] = useState('overview');
  const total = data.accounts.reduce((s, a) => s + a.balance, 0) + data.holdings.reduce((s, h) => s + h.value, 0);
  const mask = (n: number) => hidden ? '******' : yuan(n);
  return <><div className="tabs grow" role="tablist" aria-label="账户视图">{[['overview', '总览'], ['cards', '账户管理'], ['analysis', '交易分析']].map(([id, label]) => <button className={`tab${tab === id ? ' active' : ''}`} role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{label}</button>)}<button className="tab" onClick={() => navigate('ledger')}>交易记录</button></div>
    {tab === 'cards' ? <Accounts /> : tab === 'analysis' ? <HomeCashFlow /> : <div className="cc-account-overview"><section className="cc-assets"><span>总资产（元）<button className="icon-button" aria-label={hidden ? '显示金额' : '隐藏金额'} onClick={toggleHidden}>{hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button></span><strong data-testid="total-assets">{mask(total)}</strong><small>账户余额与持有金额合计</small></section><div className="cc-account-stats"><div><small>可用余额</small><strong>{mask(data.accounts.reduce((s, a) => s + a.available, 0))}</strong></div><div><small>待确认预留</small><strong>{mask(data.accounts.reduce((s, a) => s + a.held, 0))}</strong></div></div>{[
      { icon: IcoWallet, label: '储蓄账户', count: `${data.accounts.length} 张`, amount: data.accounts.reduce((s, a) => s + a.balance, 0), action: () => setTab('cards') },
      { icon: IcoWealth, label: '理财账户', count: `${data.holdings.length} 笔持有`, amount: data.holdings.reduce((s, h) => s + h.value, 0), action: () => navigate('wealth') },
      { icon: IcoCard, label: '信用卡待还', count: `尾号 ${data.creditCard.number.slice(-4)}`, amount: data.creditCard.used, action: () => navigate('credit') },
      { icon: IcoLoan, label: '贷款待还本金', count: `${data.loans.length} 笔`, amount: data.loans.reduce((s, l) => s + l.outstanding, 0), action: () => navigate('loan') },
    ].map(x => <button className="cc-account-row" key={x.label} onClick={x.action}><x.icon size={24} /><strong>{x.label}<small>{x.count}</small></strong><span>{mask(x.amount)}</span><ChevronRight size={15} /></button>)}</div>}
  </>;
}
export function ServiceDirectory({ search = false }: { search?: boolean }) {
  const { navigate } = useBank();
  const [q, setQ] = useState(''), [expanded, setExpanded] = useState(search);
  const all = [...services, { id: 'channels', label: 'Bot 绑定管理', icon: Bot, tone: 'blue' as Tone }, { id: 'personalization', label: '个性化与记忆', icon: IcoPerson, tone: 'blue' as Tone }, { id: 'tasks', label: '助手操作与计划', icon: IcoRecord, tone: 'blue' as Tone }];
  const groups = [ ['账户与交易', ['accounts', 'transfer', 'ledger', 'receive', 'scan', 'payees']], ['财富与信贷', ['wealth', 'deposit', 'credit', 'loan']], ['生活服务', ['life', 'appointments', 'support']], ['设置与安全', ['security', 'messages', 'channels', 'personalization']], ['开发与工具', ['agent', 'tasks']] ] as const;
  const shortcuts = [{ id: 'services', label: '全部服务', detail: '查看所有功能' }, { id: 'search', label: '搜索', detail: '快速查找功能' }, { id: 'agent', label: '开发者中心', detail: '开放能力与文档' }, { id: 'security', label: '安全中心', detail: '账户安全与授权' }, { id: 'messages', label: '消息中心', detail: '通知与消息管理' }, { id: 'personalization', label: '个性化与记忆', detail: '定制你的体验' }] as const;
  if (!expanded) return <div className="cc-more-shortcuts"><div>{shortcuts.map(s => <button key={s.id} onClick={() => s.id === 'services' || s.id === 'search' ? setExpanded(true) : navigate(s.id)}><ServiceArtwork name={s.id} size={35} /><span><strong>{s.label}</strong><small>{s.detail}</small></span></button>)}</div><button className="cc-more-binding" onClick={() => navigate('channels')}><ServiceArtwork name="channels" size={35} /><span><strong>消息渠道绑定</strong><small>飞书、微信与渠道设置</small></span></button></div>;
  return <div className="page cc-directory"><div className="search-bar"><Search size={18} /><input aria-label="搜索服务" autoFocus placeholder="搜索服务，如：转账、缴费" value={q} onChange={e => setQ(e.target.value)} /></div>{groups.map(([label, ids]) => { const matches = all.filter(s => (ids as readonly string[]).includes(s.id) && s.label.includes(q.trim())); return matches.length > 0 && <Card key={label} title={label}><div className="entry-grid four">{matches.map(s => <Tile key={s.id} icon={hasServiceArtwork(s.id) ? ({ size }) => <ServiceArtwork name={s.id as import('../DesignAssets').ServiceAsset} size={size} /> : s.icon} label={s.label} tone={s.tone} onClick={() => navigate(s.id)} />)}</div></Card>; })}{!all.some(s => s.label.includes(q.trim())) && <Empty title="没有找到相关服务" />}</div>;
}
