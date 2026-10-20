import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Bell, ChartNoAxesColumnIncreasing, ChevronRight, CreditCard, Eye, EyeOff, Landmark, LayoutGrid, ListChecks, MessageCircle, QrCode, ScanLine, Search, ShieldCheck, Sparkles, Sprout, Wallet } from 'lucide-react';
import { useBank } from '../bank';
import { yuan, date, tail } from '../api';
import { Card, Tile, Empty, type Icon, type Tone } from '../ui';
import { IcoWallet, IcoTransfer, IcoRecord, IcoDeposit, IcoWealth, IcoLoan, IcoCard, IcoHouse, IcoQr, IcoPerson, IcoCalendar, IcoHeadset, IcoShield, IcoBell, IcoCode, Logo } from '../icons';
import { HomeCashFlow } from './HomeCashFlow';
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

const greeting = () => { const h = new Date().getHours(); return h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好'; };

export function Home() {
  const { data, navigate, hidden, toggleHidden } = useBank();
  const balance = data.accounts.reduce((s, a) => s + a.balance, 0);
  const depositTotal = data.holdings.filter(h => h.product.type === 'deposit').reduce((s, h) => s + h.principal, 0);
  const wealthTotal = data.holdings.filter(h => h.product.type !== 'deposit').reduce((s, h) => s + h.principal, 0);
  const total = balance + depositTotal + wealthTotal;
  const unread = data.notifications.filter(n => !n.is_read).length;
  const pending = data.transactions.filter(t => t.status === 'pending').length;
  const pendingActions = data.agentActions.filter(a => ['proposed', 'awaiting_verification'].includes(a.status));
  const outstanding = data.loans.reduce((s, l) => s + l.outstanding, 0);
  const [cardId, setCardId] = useState(data.accounts[0]?.id ?? '');
  const account = data.accounts.find(a => a.id === cardId) ?? data.accounts[0];
  const mask = (n: number) => hidden ? '••••' : yuan(n);
  const assets = [
    { route: 'accounts', label: '活期余额', amount: balance, icon: Wallet, tone: 'blue' },
    { route: 'deposit', label: '定期存款', amount: depositTotal, icon: Sprout, tone: 'sage' },
    { route: 'wealth', label: '基金理财', amount: wealthTotal, icon: ChartNoAxesColumnIncreasing, tone: 'oak' },
  ];
  return <main className="home-dashboard">
    <header className="home-welcome">
      <div className="home-brand-row"><span className="home-brand"><Logo size={23} />澄川银行<span>私人财富空间</span></span><button className="home-icon-button home-notifications" aria-label={unread ? `消息中心，${unread}条未读` : '消息中心'} onClick={() => navigate('messages')}><Bell size={20} />{unread > 0 && <i />}</button></div>
      <div className="home-greeting-row"><div><p className="home-greeting">{greeting()}，{data.user.name}</p><h1>让财富有序，<br />让生活从容。</h1></div><button className="home-profile" aria-label="查看我的资料" onClick={() => navigate('profile')}><span>{data.user.name.slice(-2)}</span><Sprout size={16} aria-hidden="true" /></button></div>
    </header>

    <section className="home-card home-assets" aria-labelledby="assets-title">
      <div className="home-section-head"><span className="home-asset-label" id="assets-title">总资产 <button className="home-icon-button" aria-label={hidden ? '显示金额' : '隐藏金额'} onClick={toggleHidden}>{hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button></span><span className="home-currency">人民币 · CNY</span></div>
      <button className="home-total" onClick={() => navigate('accounts')} data-testid="total-assets">{!hidden && <span>¥</span>}{mask(total)}</button>
      <p className="home-asset-note"><ShieldCheck size={13} />账户余额与持仓本金合计</p>
      <div className={`home-asset-bar${hidden ? ' is-hidden' : ''}`} aria-hidden="true">{total > 0 && !hidden ? assets.filter(a => a.amount > 0).map(a => <span key={a.route} className={a.tone} style={{ flex: a.amount }} />) : <span className="neutral" />}</div>
      <div className="home-asset-breakdown">{assets.map(a => <button key={a.route} onClick={() => navigate(a.route)}><span className={`home-asset-icon ${a.tone}`}><a.icon size={18} strokeWidth={1.6} /></span><span className="home-asset-name">{a.label}<ChevronRight size={12} /></span><strong>{mask(a.amount)}</strong></button>)}</div>
    </section>

    <div className="home-shortcuts" aria-label="常用服务">{[
      { route: 'transfer', label: '转账', icon: ArrowLeftRight }, { route: 'receive', label: '收款码', icon: QrCode },
      { route: 'ledger', label: '交易记录', icon: ListChecks }, { route: 'scan', label: '扫一扫', icon: ScanLine },
      { route: 'services', label: '全部服务', icon: LayoutGrid },
    ].map(s => <button key={s.route} onClick={() => navigate(s.route)} data-testid={s.route === 'transfer' ? 'quick-transfer' : undefined}><span><s.icon size={21} strokeWidth={1.6} /></span>{s.label}</button>)}</div>

    {pending > 0 && <button className="home-attention" onClick={() => navigate('transactions')}><ShieldCheck size={18} /><span>有 {pending} 笔交易等待您确认</span><ChevronRight size={16} /></button>}
    <section className="home-card home-assistant" aria-labelledby="home-assistant-title">
      <svg className="home-landscape" viewBox="0 0 230 160" aria-hidden="true"><path d="M0 130C45 110 60 15 115 28S185 104 230 52V160H0Z" fill="#ede1d2" /><path d="M15 160C58 125 90 64 135 75S188 127 230 94V160Z" fill="#dfcbb7" /><path d="M73 160C130 112 168 107 230 141V160Z" fill="#b5b69c" /><path d="M200 149C197 127 202 107 199 88M200 123C186 123 180 114 180 107C192 108 200 114 200 123M200 111C211 106 214 94 212 88C202 94 199 103 200 111" fill="none" stroke="#7f9479" strokeWidth="2" strokeLinecap="round" /></svg>
      <div className="home-assistant-heading"><span><Sparkles size={19} />私人财富助手</span><button aria-label="查看助手操作与计划" onClick={() => navigate('tasks')}><ListChecks size={19} /></button></div>
      <h2 id="home-assistant-title">每一笔收支，<br />都可以更有章法。</h2><p>聊聊账单、理财，或下一步的安排。</p>
      {pendingActions.length > 0 && <button className="home-agent-pending" onClick={() => navigate('tasks')}>{pendingActions.length} 项助手操作待确认 <ChevronRight size={14} /></button>}
      <div className="home-ai-actions"><button className="primary" onClick={() => navigate('assistant')}><MessageCircle size={17} />问问助手</button><button onClick={() => navigate('advice')}><ChartNoAxesColumnIncreasing size={17} />配置建议</button><button onClick={() => navigate('tasks')}><ListChecks size={17} />操作计划</button></div>
    </section>

    <HomeCashFlow />

    <section className="home-card home-activity" aria-labelledby="activity-title"><div className="home-section-head"><h2 id="activity-title">最近交易</h2><button className="home-text-button" onClick={() => navigate('ledger')}>查看全部 <ChevronRight size={15} /></button></div>
      {data.ledger.length ? data.ledger.slice(0, 4).map(l => <button className="home-transaction" key={l.id} onClick={() => { const day = l.bj_time?.slice(0, 10) || new Date(new Date(l.created_at).getTime() + 8 * 3600000).toISOString().slice(0, 10); navigate(`ledger?from=${day}&to=${day}&q=${encodeURIComponent(l.transaction_id)}`); }}>
        <span className={`home-transaction-icon ${l.amount > 0 ? 'incoming' : 'outgoing'}`}>{l.amount > 0 ? <ArrowDownLeft size={21} /> : <ArrowUpRight size={21} />}</span><span className="home-transaction-description"><strong>{l.title}</strong><small>{l.tag || '账户交易'} · {l.time_precision === 'day' ? l.bj_time?.slice(5, 10) : date(l.created_at)}</small></span><strong className={`home-transaction-amount${l.amount > 0 ? ' incoming' : ''}`}>{hidden ? '••••' : `${l.amount > 0 ? '+' : '−'}${yuan(Math.abs(l.amount))}`}</strong><ChevronRight size={14} /></button>) : <Empty title="还没有交易记录" />}
    </section>

    <section className="home-card home-account" aria-labelledby="account-title"><div className="home-section-head"><h2 id="account-title">我的账户</h2><button className="home-text-button" onClick={() => navigate('accounts')}>管理 <ChevronRight size={15} /></button></div>
      {account ? <><div className="home-account-heading"><span className="home-asset-icon blue"><CreditCard size={21} /></span><div><strong>澄川储蓄卡</strong><span>尾号 {tail(account.number)} · {account.status === 'active' ? '使用中' : account.status === 'lost' ? '已挂失' : '已冻结'}</span></div>{data.accounts.length > 1 && <select aria-label="选择储蓄卡" value={account.id} onChange={e => setCardId(e.target.value)}>{data.accounts.map(a => <option value={a.id} key={a.id}>尾号 {tail(a.number)}</option>)}</select>}</div><div className="home-account-values"><div><span>可用余额</span><strong>{mask(account.available)}</strong></div><div><span>待确认预留</span><strong>{mask(account.held)}</strong></div></div></> : <Empty title="暂无储蓄账户" />}
      <div className="home-liabilities"><button onClick={() => navigate('credit')}><CreditCard size={17} /><span>信用卡待还<strong>{mask(data.creditCard.used)}</strong></span><ChevronRight size={14} /></button><button onClick={() => navigate('loan')}><Landmark size={17} /><span>贷款待还本金<strong>{mask(outstanding)}</strong></span><ChevronRight size={14} /></button></div>
    </section>
    <footer className="home-footnote"><ShieldCheck size={13} /><span>澄川银行 · 模拟演示环境</span></footer>
  </main>;
}
export function ServiceDirectory({ search = false }: { search?: boolean }) {
  const { navigate } = useBank();
  const [q, setQ] = useState('');
  const matches = services.filter(s => s.label.includes(q));
  return <div className="page">
    {search && <div className="search-bar"><Search size={18} /><input aria-label="搜索服务" autoFocus placeholder="搜索服务，如：转账、缴费" value={q} onChange={e => setQ(e.target.value)} /></div>}
    <Card title={q ? `找到 ${matches.length} 项服务` : '全部服务'}>
      <div className="entry-grid four">{matches.map(s => <Tile key={s.id} icon={s.icon} label={s.label} tone={s.tone} onClick={() => navigate(s.id)} />)}</div>
      {matches.length === 0 && <Empty title="没有找到相关服务" />}
    </Card>
  </div>;
}
