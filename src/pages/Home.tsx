import { useState } from 'react';
import { ScanLine, ChevronRight, Eye, EyeOff, ShieldCheck, Bell, Search, Menu } from 'lucide-react';
import { useBank } from '../bank';
import { yuan, date, tail } from '../api';
import { Card, Tile, Row, Brand, Empty, Avatar, Tabs, Pill, Promo, type Icon, type Tone } from '../ui';
import { featuredFund, riskTag } from '../products';
import type { Product } from '../types';
import { IcoWallet, IcoTransfer, IcoRecord, IcoDeposit, IcoWealth, IcoLoan, IcoCard, IcoHouse, IcoQr, IcoPerson, IcoCalendar, IcoHeadset, IcoShield, IcoBell, IcoCode, IcoGrid, IcoIn, IcoOut, Logo } from '../icons';

/* 功能宫格以蓝色为主，少量橙 / 红 / 金点缀。 */
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
  const deposits = data.holdings.filter(h => h.product.type === 'deposit'), wealth = data.holdings.filter(h => h.product.type !== 'deposit');
  const depositTotal = deposits.reduce((s, h) => s + h.principal, 0), wealthTotal = wealth.reduce((s, h) => s + h.principal, 0);
  const holdings = depositTotal + wealthTotal;
  const outstanding = data.loans.reduce((s, l) => s + l.outstanding, 0), credit = data.creditCard;
  const unread = data.notifications.filter(n => !n.is_read).length;
  const pending = data.transactions.filter(t => t.status === 'pending').length;
  const [cardId, setCardId] = useState(data.accounts[0]?.id ?? '');
  const account = data.accounts.find(a => a.id === cardId) ?? data.accounts[0];
  const [assetTab, setAssetTab] = useState('wealth');
  const bestRate = (test: (p: Product) => boolean) => Math.max(0, ...data.products.filter(test).map(p => p.rate ?? 0));
  const funds = data.products.filter(p => p.type === 'wealth'), featured = featuredFund(funds);
  const mask = (v: string) => hidden ? '****' : v;
  return <>
    <header className="hero">
      <div className="hero-bar"><button className="icon-button" aria-label="全部服务" onClick={() => navigate('services')}><Menu size={24} strokeWidth={1.8} /></button><Brand light mark={false} /><div className="hero-actions"><button className="icon-button" aria-label="消息中心" onClick={() => navigate('messages')}><Bell size={23} strokeWidth={1.8} />{unread > 0 && <i className="dot" />}</button><button className="icon-button" aria-label="扫一扫" onClick={() => navigate('scan')}><ScanLine size={23} strokeWidth={1.8} /></button></div></div>
      <button className="hero-user" onClick={() => navigate('profile')}><Avatar size={48} /><span className="hero-user-text"><span className="hero-name">{data.user.name}<em className="user-tag"><ShieldCheck size={11} />{data.user.riskLevel ? riskTag(data.user.riskLevel) : 'Ⅰ类账户'}</em></span><small>{greeting()}，欢迎回来</small></span></button>
      <div className="hero-quick">
        <Tile variant="header" icon={IcoRecord} label="交易记录" onClick={() => navigate('ledger')} />
        <Tile variant="header" icon={IcoCard} label="银行卡" onClick={() => navigate('accounts')} />
        <Tile variant="header" icon={IcoTransfer} label="转账" onClick={() => navigate('transfer')} id="quick-transfer" />
        <Tile variant="header" icon={IcoQr} tone="orange" label="收款码" onClick={() => navigate('receive')} />
        <Tile variant="header" icon={IcoGrid} label="全部" onClick={() => navigate('services')} />
      </div>
      <div className="hero-dots" aria-hidden="true"><i className="on" /><i /></div>
    </header>
    <main className="home-body">
      <section className="card asset-summary" aria-label="资产总览">
        <div className="asset-row"><span className="asset-label">总资产<button className="eye" aria-label={hidden ? '显示金额' : '隐藏金额'} onClick={toggleHidden}>{hidden ? <EyeOff size={18} /> : <Eye size={18} />}</button></span><button className="asset-total" onClick={() => navigate('accounts')} data-testid="total-assets">{hidden ? '****' : `¥${yuan(balance + holdings)}`}</button></div>
        <div className="asset-row sub"><span>活期余额 <b>{mask(yuan(balance))}</b></span><span>存款理财 <b>{mask(yuan(holdings))}</b></span></div>
      </section>
      {data.agentActions.some(a => ['proposed', 'awaiting_verification'].includes(a.status) && (a.level === 'red' || a.channel !== 'app')) && <button className="card ticker" onClick={() => navigate('tasks')}><em className="tag red">待确认</em><span>有操作等待您在App内确认</span><ChevronRight size={18} /></button>}
      {pending > 0 && <button className="card ticker" onClick={() => navigate('transactions')}><em className="tag orange">待确认</em><span>您有 {pending} 笔交易待确认，请及时处理</span><ChevronRight size={18} className="chevron" /></button>}
      <Card head={<Tabs items={data.accounts.map((a, i) => ({ id: a.id, label: data.accounts.length > 1 ? `储蓄卡${i + 1}` : '储蓄卡' }))} value={account?.id ?? ''} onChange={setCardId} />}>
        {account && <>
          <button className={`debit-card${account.status === 'frozen' ? ' frozen' : ''}`} onClick={() => navigate('accounts')}><span className="debit-head"><span>澄川卡</span><em>尾号 {tail(account.number)}</em>{account.status === 'frozen' && <em>已冻结</em>}</span><strong className="debit-balance">{mask(yuan(account.balance))}</strong><span className="debit-caption">余额{account.held > 0 && !hidden ? `，其中 ${yuan(account.held)} 为待确认预留` : ''}</span><span className="debit-mark" aria-hidden="true"><Logo size={150} watermark /></span></button>
          <div className="pill-row"><Pill onClick={() => navigate('ledger')}>动账明细</Pill><Pill onClick={() => navigate('transfer')}>转出</Pill><Pill primary onClick={() => navigate('receive')}>从他行转入</Pill></div>
        </>}
      </Card>
      <Card head={<Tabs items={[{ id: 'wealth', label: '财富' }, { id: 'loan', label: '贷款' }, { id: 'credit', label: '信用卡' }]} value={assetTab} onChange={setAssetTab} />}>
        {assetTab === 'wealth' && <>
          <Row glyph="存" tone="orange" title="定期存款" subtitle={`整存整取，最高年利率 ${bestRate(p => p.type === 'deposit').toFixed(2)}%`} trailing={<b className="amount">{mask(yuan(depositTotal))}</b>} trailingSub={`${deposits.length} 笔持有`} action={<Pill small primary onClick={() => navigate('deposit')}>转入</Pill>} />
          <Row glyph="基" tone="coral" title="基金理财" subtitle={`${funds.length}只基金，货币基金7日年化最高 ${bestRate(p => p.category === 'money').toFixed(2)}%`} trailing={<b className="amount">{mask(yuan(wealthTotal))}</b>} trailingSub={`${wealth.length} 笔持有`} action={<Pill small primary onClick={() => navigate('wealth')}>转入</Pill>} />
        </>}
        {assetTab === 'loan' && <Row glyph="贷" tone="blue" title="澄心贷" subtitle={`可借额度 ¥${yuan(20000000 - outstanding)}`} trailing={<b className="amount">{mask(yuan(outstanding))}</b>} trailingSub="待还本金" action={<Pill small primary onClick={() => navigate('loan')}>借款</Pill>} />}
        {assetTab === 'credit' && <Row glyph="卡" tone="red" title="澄光白金卡" subtitle={`可用额度 ¥${yuan(credit.credit_limit - credit.used)}`} trailing={<b className="amount">{mask(yuan(credit.used))}</b>} trailingSub="当前待还" action={<Pill small primary onClick={() => navigate('credit')}>还款</Pill>} />}
      </Card>
      {featured && <Promo title={featured.name} subtitle={[featured.risk, ...featured.tags.slice(0, 2)].join(' | ')} rate={featured.rate} caption={featured.rateLabel || '年化'} action="去看看" onClick={() => navigate('wealth')} note={data.productMeta?.stale ? '数据可能不是最新' : undefined} />}
      <Card title="最近交易" action="全部" onAction={() => navigate('ledger')}>
        {data.ledger.length ? data.ledger.slice(0, 4).map(l => <Row key={l.id} icon={l.amount > 0 ? IcoIn : IcoOut} tone={l.amount > 0 ? 'red' : 'blue'} title={l.title} subtitle={date(l.created_at)} trailing={<b className={`amount${l.amount > 0 ? ' income' : ''}`}>{hidden ? '****' : `${l.amount > 0 ? '+' : '-'}${yuan(Math.abs(l.amount))}`}</b>} onClick={() => navigate('ledger')} chevron={false} />) : <Empty />}
      </Card>
      <p className="footnote">澄川银行 · 模拟演示环境</p>
    </main>
  </>;
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
