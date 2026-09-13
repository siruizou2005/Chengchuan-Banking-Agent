import { ArrowUpRight, ArrowDownLeft, ArrowLeftRight, ScanLine, CreditCard, Wallet, ReceiptText, Smartphone, HandCoins, ChartNoAxesCombined, Landmark, LayoutGrid, ChevronRight, Eye, EyeOff, ShieldCheck, Bell, Search, Gift, Headphones, CalendarDays } from 'lucide-react';
import { useBank } from '../bank';
import { yuan, date } from '../api';
import { Section, Tile, Row, Brand, Empty } from '../ui';

export const services = [
  { id: 'accounts', label: '我的账户', icon: Wallet }, { id: 'transfer', label: '转账汇款', icon: ArrowLeftRight },
  { id: 'ledger', label: '收支明细', icon: ReceiptText }, { id: 'deposit', label: '存款', icon: Landmark },
  { id: 'wealth', label: '理财', icon: ChartNoAxesCombined }, { id: 'loan', label: '贷款', icon: HandCoins },
  { id: 'credit', label: '信用卡', icon: CreditCard }, { id: 'life', label: '生活缴费', icon: Smartphone },
  { id: 'receive', label: '收款码', icon: ArrowDownLeft }, { id: 'scan', label: '扫一扫', icon: ScanLine },
  { id: 'payees', label: '收款人', icon: Wallet }, { id: 'appointments', label: '网点预约', icon: CalendarDays },
  { id: 'support', label: '在线客服', icon: Headphones }, { id: 'security', label: '安全中心', icon: ShieldCheck },
  { id: 'messages', label: '消息中心', icon: Bell }, { id: 'agent', label: '开发者中心', icon: LayoutGrid },
];

export function Home() {
  const { data, navigate, hidden, toggleHidden } = useBank();
  const balance = data.accounts.reduce((s, a) => s + a.balance, 0), holdings = data.holdings.reduce((s, h) => s + h.principal, 0);
  const unread = data.notifications.filter(n => !n.is_read).length;
  const pending = data.transactions.filter(t => t.status === 'pending').length;
  return <>
    <header className="home-header"><Brand /><div className="header-actions"><span className="simulation-pill">模拟银行</span><button className="icon-button notification-button" aria-label="消息中心" onClick={() => navigate('messages')}><Bell size={23} />{unread > 0 && <i />}</button></div></header>
    <main className="home-main">
      <button className="search-bar" onClick={() => navigate('search')} data-testid="global-search"><Search size={18} /><span>搜索服务、转账、银行卡</span><span className="search-shortcut">搜索</span></button>
      <div className="greeting"><div><span className="eyebrow">美好的一天，从这里开始</span><h1>你好，{data.user.name}<span className="greeting-dot">。</span></h1></div><button className="text-button" onClick={() => navigate('profile')}>个人中心<ChevronRight size={15} /></button></div>
      <section className="asset-card" aria-label="资产总览"><div className="asset-top"><span>总资产（元）<button aria-label={hidden ? '显示金额' : '隐藏金额'} onClick={toggleHidden}>{hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button></span><span className="asset-tag">人民币账户</span></div><button className="asset-amount" onClick={() => navigate('accounts')} data-testid="total-assets">{hidden ? '••••••' : yuan(balance + holdings)}<ArrowUpRight size={24} /></button><div className="asset-bottom"><div><span>活期余额</span><strong>{hidden ? '••••' : yuan(balance)}</strong></div><div><span>存款与理财</span><strong>{hidden ? '••••' : yuan(holdings)}</strong></div><button onClick={() => navigate('accounts')}>资产详情<ChevronRight size={14} /></button></div></section>
      <div className="quick-actions"><Tile icon={ScanLine} label="扫一扫" onClick={() => navigate('scan')} /><Tile icon={ArrowLeftRight} label="转账" onClick={() => navigate('transfer')} id="quick-transfer" /><Tile icon={ArrowDownLeft} label="收付款" onClick={() => navigate('receive')} /><Tile icon={CreditCard} label="银行卡" onClick={() => navigate('accounts')} /></div>
      <div className="service-grid home-services">{[{ label: '收支明细', icon: ReceiptText, id: 'ledger' }, { label: '存款', icon: Landmark, id: 'deposit' }, { label: '理财', icon: ChartNoAxesCombined, id: 'wealth' }, { label: '贷款', icon: HandCoins, id: 'loan' }, { label: '信用卡还款', icon: CreditCard, id: 'credit' }, { label: '生活缴费', icon: Smartphone, id: 'life' }, { label: '网点预约', icon: CalendarDays, id: 'appointments' }, { label: '全部服务', icon: LayoutGrid, id: 'services' }].map(s => <Tile key={s.id} {...s} tone="plain" onClick={() => navigate(s.id)} />)}</div>
      {pending > 0 && <button className="pending-banner" onClick={() => navigate('transactions')}><ReceiptText size={18} /><span>你有 {pending} 笔交易待确认</span><ChevronRight size={17} /></button>}
      <div className="security-strip"><ShieldCheck size={16} /><span>账户安全守护中</span><span className="dot-divider">·</span><span>安心办理每一笔</span><ChevronRight size={14} /></div>
      <Section title="让每一份积累，都有安排" action="财富精选" onAction={() => navigate('wealth')}><div className="featured-products"><button className="featured-product deposit-feature" onClick={() => navigate('deposit')}><span className="product-kicker">安心存 · 一年期</span><div className="feature-rate">1.65<span>%</span></div><span className="rate-caption">模拟年利率</span><div className="feature-foot"><span>50元起存</span><span className="round-arrow"><ArrowUpRight size={17} /></span></div></button><button className="featured-product wealth-feature" onClick={() => navigate('wealth')}><span className="product-kicker">澄享 · 日日盈</span><div className="feature-rate">2.18<span>%</span></div><span className="rate-caption">模拟收益率示例</span><div className="feature-foot"><span>闲钱灵活安排</span><span className="round-arrow"><ArrowUpRight size={17} /></span></div></button></div></Section>
      <Section title="最近收支" action="查看全部" onAction={() => navigate('ledger')}><div className="surface">{data.ledger.length ? data.ledger.slice(0, 3).map(l => <Row key={l.id} icon={l.amount > 0 ? ArrowDownLeft : ArrowUpRight} tone={l.amount > 0 ? 'teal' : 'blue'} title={l.title} subtitle={date(l.created_at)} trailing={<strong className={`money ${l.amount > 0 ? 'positive' : ''}`}>{hidden ? '••••' : `${l.amount > 0 ? '+' : '−'}${yuan(Math.abs(l.amount))}`}</strong>} onClick={() => navigate('ledger')} />) : <Empty />}</div></Section>
      <button className="help-banner" onClick={() => navigate('support')}><span className="help-avatar"><Headphones size={25} /></span><span><strong>有疑问，我们一直在</strong><small>业务帮助与在线客服</small></span><ChevronRight size={18} /></button>
      <p className="page-footnote">澄川银行 · 模拟演示环境 · 所有资金均为虚拟资金</p>
    </main>
  </>;
}

export function ServiceDirectory({ search = false }: { search?: boolean }) {
  const { navigate } = useBank();
  return <DirectoryContent search={search} navigate={navigate} />;
}
import { useState } from 'react';
function DirectoryContent({ search, navigate }: { search: boolean; navigate: (p: string) => void }) {
  const [q, setQ] = useState('');
  const matches = services.filter(s => s.label.includes(q));
  return <div className="page-content">{search && <div className="search-bar input-search"><Search size={19} /><input aria-label="搜索服务" autoFocus placeholder="输入服务名称，例如：转账" value={q} onChange={e => setQ(e.target.value)} /></div>}<Section title={q ? `找到 ${matches.length} 项服务` : '常用金融服务'}><div className="surface service-grid directory">{matches.map(s => <Tile key={s.id} icon={s.icon} label={s.label} onClick={() => navigate(s.id)} />)}</div>{matches.length === 0 && <Empty title="没有找到相关服务" text="试试“转账”“贷款”或“缴费”。" />}</Section></div>;
}
