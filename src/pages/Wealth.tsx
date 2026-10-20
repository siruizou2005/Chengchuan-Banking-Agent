import { useEffect, useState } from 'react';
import { Megaphone, ChevronRight } from 'lucide-react';
import { useBank } from '../bank';
import { yuan, formValues, date, tail } from '../api';
import { Card, Row, Empty, Amount, Field, AccountSelect, Notice, Submit, PinField, Tile, CircleIcon, Rate, Promo, Pill } from '../ui';
import { IcoDeposit, IcoWealth, IcoShield, IcoWallet, IcoSnow, IcoBag, IcoRecord, Logo } from '../icons';
import { CATEGORIES, minText, pct, statusText, sourceLine, featuredFund, riskTag } from '../products';
import { NavChart, IndexDetail } from './NavChart';
import type { Product, Holding } from '../types';

const termText = (p: Product) => p.type === 'deposit' ? `${p.days}天整存整取` : p.days ? `持有${p.days}天后可赎` : p.fundType || '每日可申赎';
// Funds open for purchase need no badge; only limits and suspensions are worth flagging.
const badge = (p: Product) => p.type === 'deposit' ? p.tags[1] : p.purchasable === false ? statusText(p) : p.purchaseLimit ? p.tags[1] : undefined;

export type Display = 'rate' | 'nav';
// The list headline is either the return (收益率) or the latest NAV with its daily change; the choice is remembered per browser.
export function useDisplay(): [Display, (d: Display) => void] {
  const [display, setDisplay] = useState<Display>(() => { try { return localStorage.getItem('fund-display') === 'nav' ? 'nav' : 'rate'; } catch { return 'rate'; } });
  return [display, d => { setDisplay(d); try { localStorage.setItem('fund-display', d); } catch { /* storage may be unavailable */ } }];
}
function DisplayToggle({ value, onChange }: { value: Display; onChange: (d: Display) => void }) {
  return <span className="segmented" role="group" aria-label="列表显示">{([['rate', '收益率'], ['nav', '净值']] as const).map(([id, label]) => <button key={id} type="button" className={value === id ? 'active' : ''} aria-pressed={value === id} onClick={e => { e.stopPropagation(); onChange(id); }}>{label}</button>)}</span>;
}
function NavValue({ p }: { p: Product }) {
  const money = p.category === 'money', value = money ? p.perTenThousand : p.nav, date = p.navDate?.slice(5);
  return <span className={`rate nav-value${!money && (p.navChange ?? 0) < 0 ? ' down' : ''}`}><strong>{value == null ? '--' : value.toFixed(4)}{!money && p.navChange != null && <em className="nav-change">{p.navChange > 0 ? '+' : ''}{p.navChange.toFixed(2)}%</em>}</strong><span>{money ? '万份收益（元）' : '单位净值'}{date ? ` · ${date}` : ''}</span></span>;
}

function ProductItem({ p, onClick, display = 'rate' }: { p: Product; onClick: () => void; display?: Display }) {
  const deposit = p.type === 'deposit';
  return <button className="product" onClick={onClick} data-testid={`product-${p.id}`}>
    <span className="product-head"><span className="issuer"><Logo size={16} />{deposit ? '澄川银行' : p.issuer || '澄川理财'}</span><i className="vsep" /><strong>{p.name}</strong>{badge(p) && <em className={`tag ${p.purchasable === false ? 'gray' : 'orange'}`}>{badge(p)}</em>}</span>
    <span className="product-metrics">{display === 'nav' && !deposit ? <NavValue p={p} /> : <Rate value={p.rate} caption={p.rateLabel || '年化'} />}<span className="product-terms"><strong>{termText(p)}</strong><small>{p.risk} | {minText(p)}</small></span></span>
    <span className="product-note"><Megaphone size={14} />{p.subtitle}{p.navDate ? ` · 净值日期 ${p.navDate}` : ''}</span>
  </button>;
}

function MarketStrip() {
  const { data, openModal } = useBank();
  if (!data.market?.length) return null;
  return <section className="card market-strip">{data.market.map(m => <button type="button" key={m.code} className={(m.changePct ?? 0) < 0 ? 'down' : 'up'} onClick={() => openModal(m.name, <IndexDetail index={m} />)} data-testid={`index-${m.code}`}><span>{m.name}</span><b>{m.price?.toFixed(2) ?? '--'}</b><small>{pct(m.changePct)}</small></button>)}</section>;
}

// Product detail with the purchase form; shared by the wealth overview, the full fund list and deep links.
export function useProductModal() {
  const { data, openModal, closeModal, begin, navigate } = useBank();
  const level = data.user.riskLevel;
  return function productModal(p: Product, prefill?: string) {
    const deposit = p.type === 'deposit', tooRisky = !deposit && level > 0 && (p.riskLevel ?? 0) > level;
    openModal(p.name, <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, productId: p.id, type: deposit ? 'deposit' : 'investment' }); }}>
      <div className="product-modal-head"><Rate value={p.rate} caption={p.rateLabel || '年化'} size="xl" /><div className="tags"><span>{p.risk}</span>{p.tags.map(t => <span key={t}>{t}</span>)}</div></div>
      {p.returns && <dl className="return-grid">{([['近1月', p.returns.m1], ['近3月', p.returns.m3], ['近6月', p.returns.m6], ['近1年', p.returns.y1]] as const).map(([k, v]) => <div key={k} className={(v ?? 0) < 0 ? 'down' : 'up'}><dt>{k}</dt><dd>{pct(v)}</dd></div>)}</dl>}
      {!deposit && p.code && <NavChart product={p} />}
      {!deposit && <dl className="kv">
        {p.perTenThousand != null ? <div><dt>万份收益</dt><dd>{p.perTenThousand.toFixed(4)}元（{p.navDate}）</dd></div> : p.nav != null && <div><dt>单位净值</dt><dd>{p.nav.toFixed(4)}（{p.navDate}）</dd></div>}
        <div><dt>申购状态</dt><dd>{p.purchaseStatus}</dd></div>
        <div><dt>申购费率</dt><dd>{p.fee}</dd></div>
        <div><dt>基金管理人</dt><dd>{p.issuer}</dd></div>
        <div><dt>数据来源</dt><dd>{p.source} · {p.updatedAt ? date(p.updatedAt) : ''}</dd></div>
      </dl>}
      <Notice>{p.description}</Notice>
      {p.purchasable === false ? <Notice>该产品当前{p.purchaseStatus || '不可申购'}，仅供查看。</Notice> : <>
        <AccountSelect /><Amount defaultValue={prefill} min={(p.minimum / 100).toString()} max={p.purchaseLimit ? (p.purchaseLimit / 100).toString() : undefined} label={deposit ? '存入金额（元）' : '申购金额（元）'} />
        <label className="check-field"><input type="checkbox" required />我已阅读产品说明书与风险揭示书</label>
        {!deposit && level === 0 && <button type="button" className="btn-text" onClick={() => { closeModal(); navigate('risk'); }}>请先完成风险测评<ChevronRight size={16} /></button>}
        {tooRisky && <><Notice>该产品为{p.risk}，高于您的风险承受等级 {riskTag(level)}，暂不可申购。</Notice><button type="button" className="btn-text" onClick={() => { closeModal(); navigate('risk'); }}>重新测评<ChevronRight size={16} /></button></>}
        <Submit>下一步</Submit>
      </>}
    </form>);
  };
}

function HoldingsCard({ holdings }: { holdings: Holding[] }) {
  const { openModal, begin, navigate } = useBank();
  function redeem(h: Holding) {
    const deposit = h.product.type === 'deposit';
    openModal(deposit ? '支取定期存款' : '赎回', <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'redeem', holdingId: h.id }); }}><h3 className="modal-subtitle">{h.product.name}</h3><dl className="kv"><div><dt>持有本金</dt><dd>¥{yuan(h.principal)}</dd></div><div><dt>{deposit ? '到期日' : '可赎回日'}</dt><dd>{h.unlock_at.slice(0, 10)}</dd></div></dl><Notice>{deposit ? '支持提前支取，本模拟版本按本金结算，不结算利息。' : '本模拟版本按本金赎回，不计算净值涨跌；固定持有期产品须到期后赎回。'}</Notice><AccountSelect /><Amount defaultValue={(h.principal / 100).toFixed(2)} max={(h.principal / 100).toFixed(2)} label={deposit ? '支取金额（元）' : '赎回金额（元）'} /><Submit>下一步</Submit></form>);
  }
  return <Card title="我的持有" action={holdings.length ? `${holdings.length}笔` : undefined}>
    <div id="my-holdings" />
    {holdings.map(h => <Row key={h.id} glyph={h.product.type === 'deposit' ? '存' : '基'} tone={h.product.type === 'deposit' ? 'orange' : 'coral'} title={h.product.name} subtitle={h.product.type === 'deposit' ? `到期 ${h.unlock_at.slice(0, 10)}` : h.unlock_at <= new Date().toISOString() ? `${h.product.risk} · 可随时赎回` : `可赎回 ${h.unlock_at.slice(0, 10)}`} trailing={<b className="amount">{yuan(h.principal)}</b>} trailingSub="持有本金" action={<Pill small onClick={() => redeem(h)}>{h.product.type === 'deposit' ? '支取' : '赎回'}</Pill>} />)}
    {!holdings.length && <><Empty title="暂无持有产品" /><button className="btn-text center" onClick={() => navigate('advice')}>不知道买什么？生成配置建议<ChevronRight size={16} /></button></>}
  </Card>;
}

// The overview shows three products the user can buy, one per asset class from low to high risk.
const PREVIEW_ORDER = ['money', 'bond', 'mixed', 'index', 'equity', 'qdii'];
function previewPicks(products: Product[], level: number) {
  const ok = products.filter(p => p.purchasable !== false && (p.riskLevel ?? 0) <= (level || 2) && p.rate !== null);
  const byRate = (a: Product, b: Product) => (b.rate ?? 0) - (a.rate ?? 0) || a.id.localeCompare(b.id);
  const picks = PREVIEW_ORDER.map(c => ok.filter(p => p.category === c).sort(byRate)[0]).filter(Boolean).slice(0, 3);
  // Fewer than three asset classes fit the risk level: fill up with the next best of what does.
  return [...picks, ...ok.filter(p => !picks.includes(p)).sort(byRate)].slice(0, 3);
}

export function Wealth({ deposits = false }: { deposits?: boolean }) {
  const { data, navigate } = useBank();
  const productModal = useProductModal();
  const [display, setDisplay] = useDisplay();
  const level = data.user.riskLevel;
  const holdings = data.holdings.filter(h => !deposits || h.product.type === 'deposit');
  const principal = holdings.reduce((s, h) => s + h.principal, 0);
  const all = data.products.filter(p => p.type === (deposits ? 'deposit' : 'wealth'));
  // Advice cards link here as #wealth?product=<id>&amount=<元> to open that product with the amount filled in.
  useEffect(() => {
    if (deposits) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || ''), p = data.products.find(x => x.id === q.get('product'));
    if (p) { productModal(p, q.get('amount') || undefined); history.replaceState(null, '', '#wealth'); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const meta = data.productMeta;
  const summary = <section className="card split"><div><CircleIcon icon={IcoWallet} tone="blue" size={30} glyph={16} /><span>{deposits ? '存款本金' : '持有本金'}</span><b>¥{yuan(principal)}</b></div><button onClick={() => navigate('risk')}><CircleIcon icon={IcoShield} tone="orange" size={30} glyph={16} /><span>风险等级</span><b>{level ? `R${level}` : '未测评'}</b></button></section>;
  if (deposits) {
    const top = [...all].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
    return <div className="page">
      {summary}
      {top && <Promo title={`${top.name}，${termText(top)}`} subtitle={`${top.risk} | ${minText(top)}`} rate={top.rate} caption={top.rateLabel || '年化'} action="去看看" onClick={() => productModal(top)} />}
      <Card title="定期存款" action={`${all.length}款`} testId="wealth-list">{all.map(p => <ProductItem key={p.id} p={p} onClick={() => productModal(p)} />)}</Card>
      <HoldingsCard holdings={holdings} />
    </div>;
  }
  const picks = previewPicks(all, level);
  return <div className="page">
    <div className="entry-grid four bare">
      <Tile icon={IcoDeposit} tone="blue" label="定期存款" onClick={() => navigate('deposit')} />
      <Tile icon={IcoWealth} tone="cyan" label="基金理财" onClick={() => navigate('funds')} />
      <Tile icon={IcoShield} tone="coral" label="风险测评" badge={level ? undefined : '未测评'} onClick={() => navigate('risk')} />
      <Tile icon={IcoWallet} tone="red" label="我的持有" onClick={() => scrollTo('my-holdings')} />
    </div>
    {summary}
    <HoldingsCard holdings={holdings} />
    <button className="card advice-entry" onClick={() => navigate('advice')} data-testid="advice-entry"><span><strong>不知道买什么？</strong><small>按收支、应急资金和风险测评，3 步生成配置建议</small></span><span className="pill primary small">生成建议</span></button>
    <MarketStrip />
    <Card title={level ? '适合你的产品' : '稳健之选'} action={`全部${all.length}款`} onAction={() => navigate('funds')} testId="wealth-list">
      <div className="preview-note"><span>{level ? `按你的测评结果 ${riskTag(level)} 筛选，优先各类别收益最高的一款` : '尚未测评，先展示 R1–R2 中各类别收益最高的产品'}</span><DisplayToggle value={display} onChange={setDisplay} /></div>
      {picks.map(p => <ProductItem key={p.id} p={p} display={display} onClick={() => productModal(p)} />)}
      <button className="btn-text center" onClick={() => navigate('funds')} data-testid="all-funds">查看全部 {all.length} 款基金<ChevronRight size={16} /></button>
      {meta && <p className="data-note">{sourceLine(meta)}。业绩与净值仅供参考，过往业绩不代表未来表现。</p>}
      {meta?.stale && <Notice>{meta.notice}</Notice>}
    </Card>
    <p className="footnote">基金有风险，投资须谨慎；本模拟环境不发生真实申购</p>
  </div>;
}

const SORTS = [{ id: 'default', label: '默认' }, { id: 'return', label: '收益从高到低' }, { id: 'risk', label: '风险从低到高' }];
// Full fund list with category, suitability and sort filters.
export function Funds() {
  const { data } = useBank();
  const productModal = useProductModal();
  const [category, setCategory] = useState('all'), [suitable, setSuitable] = useState(false), [sort, setSort] = useState('default');
  const [display, setDisplay] = useDisplay();
  const level = data.user.riskLevel, meta = data.productMeta;
  const filtered = data.products.filter(p => p.type === 'wealth' && (category === 'all' || p.category === category) && (!suitable || (p.riskLevel ?? 0) <= level));
  const list = sort === 'return' ? [...filtered].sort((a, b) => (b.rate ?? -Infinity) - (a.rate ?? -Infinity)) : sort === 'risk' ? [...filtered].sort((a, b) => (a.riskLevel ?? 0) - (b.riskLevel ?? 0)) : filtered;
  return <div className="page">
    <section className="card funds-filter">
      <div className="chip-row product-filter">{CATEGORIES.map(c => <button key={c.id} className={`chip${category === c.id ? ' active' : ''}`} onClick={() => setCategory(c.id)}>{c.label}</button>)}</div>
      <div className="chip-row product-filter">{SORTS.map(s => <button key={s.id} className={`chip${sort === s.id ? ' active' : ''}`} onClick={() => setSort(s.id)}>{s.label}</button>)}{level > 0 && <button className={`chip${suitable ? ' active' : ''}`} onClick={() => setSuitable(!suitable)}>适合我（≤R{level}）</button>}</div>
    </section>
    <Card title={`基金理财 · ${list.length}款`} action={<DisplayToggle value={display} onChange={setDisplay} />} testId="funds-list">
      {list.map(p => <ProductItem key={p.id} p={p} display={display} onClick={() => productModal(p)} />)}
      {!list.length && <Empty title="暂无符合条件的产品" />}
      {meta && <p className="data-note">{sourceLine(meta)}。业绩与净值仅供参考，过往业绩不代表未来表现。</p>}
      {meta?.stale && <Notice>{meta.notice}</Notice>}
    </Card>
    <p className="footnote">基金有风险，投资须谨慎；本模拟环境不发生真实申购</p>
  </div>;
}

const RISK_QUESTIONS = [
  { key: 'a', title: '您的投资经验', options: ['没有投资经验', '只买过存款或货币基金', '买过债券基金或银行理财', '买过股票或偏股基金三年以上'] },
  { key: 'b', title: '您能接受的最大本金亏损', options: ['不能接受亏损', '5%以内', '5%至20%', '20%以上'] },
  { key: 'c', title: '这笔资金的计划投资期限', options: ['3个月以内', '3个月至1年', '1至3年', '3年以上'] },
  { key: 'd', title: '投资资产占家庭总资产的比例', options: ['50%以上', '30%至50%', '10%至30%', '10%以下'] },
  { key: 'e', title: '您的主要投资目标', options: ['保本保息', '略高于存款的稳定收益', '收益与风险兼顾', '追求较高收益，可承受较大波动'] },
];

export function Risk() {
  const { mutate, navigate, data } = useBank();
  return <div className="page">
    <section className="card split"><div><CircleIcon icon={IcoShield} tone="blue" size={30} glyph={16} /><span>当前风险等级</span><b>{riskTag(data.user.riskLevel)}</b></div><div><CircleIcon icon={IcoWealth} tone="orange" size={30} glyph={16} /><span>题目数量</span><b>{RISK_QUESTIONS.length}题</b></div></section>
    <form className="card form-card stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/risk-assessment', { answers: RISK_QUESTIONS.map(q => Number(f[q.key])) }, '风险测评已完成')) navigate('wealth'); }}>
      {RISK_QUESTIONS.map((q, i) => <fieldset className="risk-question" key={q.key}><legend>{i + 1}. {q.title}</legend>{q.options.map((o, j) => <label key={o}><input type="radio" name={q.key} value={j + 1} required />{o}</label>)}</fieldset>)}
      <Submit>提交测评</Submit>
    </form>
    <Notice>测评结果分为R1保守型至R5进取型，用于基金申购时的适当性校验：只能申购风险等级不高于测评结果的产品。测评结果不构成投资建议。</Notice>
  </div>;
}

export function Loans() {
  const { data, begin, openModal } = useBank();
  const outstanding = data.loans.reduce((s, l) => s + l.outstanding, 0), available = 20000000 - outstanding;
  return <div className="page">
    <section className="card loan-card"><span className="loan-label">可借额度（元）</span><strong className="loan-amount">{yuan(available)}</strong><div className="loan-perks"><span>随借随还</span><span>实时审批</span><span>最高20万</span></div><div className="kv inline"><div><dt>待还本金</dt><dd>¥{yuan(outstanding)}</dd></div><div><dt>借款笔数</dt><dd>{data.loans.filter(l => l.outstanding > 0).length}</dd></div></div></section>
    <form className="card form-card stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'loan_draw' }); }}>
      <h2 className="card-title">申请借款</h2>
      <AccountSelect />
      <Amount label="借款金额（元）" min="1000" max={(available / 100).toString()} />
      <Field label="借款期限"><select name="months" defaultValue="12"><option value="3">3个月</option><option value="6">6个月</option><option value="12">12个月</option><option value="24">24个月</option></select></Field>
      <label className="check-field"><input type="checkbox" required />我已阅读并同意《个人借款合同》</label>
      <Submit id="apply-loan">下一步</Submit>
    </form>
    <Card title="我的借款" action={outstanding ? `待还 ¥${yuan(outstanding)}` : undefined}>
      {data.loans.map(l => <Row key={l.id} glyph="贷" tone={l.status === 'paid' ? 'gray' : 'blue'} title={l.status === 'paid' ? '借款已结清' : '澄心贷'} subtitle={`${date(l.created_at)} ${l.months}个月`} trailing={<b className="amount">¥{yuan(l.outstanding)}</b>} trailingSub={l.outstanding > 0 ? '待还本金' : undefined} action={l.outstanding > 0 ? <Pill small primary onClick={() => openModal('归还借款', <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'loan_repay', loanId: l.id }); }}><dl className="kv"><div><dt>剩余待还本金</dt><dd>¥{yuan(l.outstanding)}</dd></div></dl><AccountSelect /><Amount label="还款金额（元）" defaultValue={(l.outstanding / 100).toFixed(2)} max={(l.outstanding / 100).toString()} /><Submit>下一步</Submit></form>)}>还款</Pill> : undefined} />)}
      {!data.loans.length && <Empty title="暂无借款记录" />}
    </Card>
    <Notice>演示环境按额度自动审批，确认后实时到账；仅记录本金借还，不计利息、罚息或征信。</Notice>
  </div>;
}

export function Credit() {
  const { data, openModal, closeModal, mutate, begin, navigate } = useBank();
  const c = data.creditCard;
  const recent = data.transactions.filter(t => ['credit_repay', 'credit_spend'].includes(t.type) && t.status === 'completed');
  return <div className="page">
    <section className="card">
      <div className={`debit-card credit${c.status === 'active' ? '' : ' frozen'}`}><span className="debit-head"><span>澄光白金卡</span><em>尾号 {tail(c.number)}</em>{c.status !== 'active' && <em>已冻结</em>}</span><strong className="debit-balance">{yuan(c.used)}</strong><span className="debit-caption">当前待还</span><span className="debit-mark" aria-hidden="true"><Logo size={150} watermark /></span><span className="debit-brand">PLATINUM</span></div>
      <dl className="kv inline"><div><dt>可用额度</dt><dd>¥{yuan(c.credit_limit - c.used)}</dd></div><div><dt>信用总额度</dt><dd>¥{yuan(c.credit_limit)}</dd></div></dl>
      <p className="body-copy muted">账单日每月10日，还款日每月28日</p>
      <div className="pill-row"><Pill onClick={() => openModal('刷卡消费', <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'credit_spend' }); }}><Field label="商户名称"><input name="merchant" placeholder="例如：澄川生活超市" required minLength={2} maxLength={50} /></Field><Amount label="消费金额（元）" /><Submit>下一步</Submit></form>)}>模拟消费</Pill><Pill primary disabled={c.used === 0} id="credit-repay" onClick={() => openModal('信用卡还款', <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'credit_repay' }); }}><Notice>尾号 {tail(c.number)}，当前待还 ¥{yuan(c.used)}。支持部分还款，确认后实时恢复额度。</Notice><AccountSelect /><Amount label="还款金额（元）" defaultValue={(c.used / 100).toFixed(2)} max={(c.used / 100).toString()} /><Submit>下一步</Submit></form>)}>{c.used > 0 ? '立即还款' : '已全部还清'}</Pill></div>
    </section>
    <Card>
      <Row icon={IcoSnow} tone="coral" title={c.status === 'active' ? '冻结信用卡' : '解冻信用卡'} subtitle="暂停或恢复刷卡消费" onClick={() => openModal('信用卡安全管理', <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/credit-card', { pin: f.pin, status: c.status === 'active' ? 'frozen' : 'active' }, '信用卡状态已更新', 'PATCH')) closeModal(); }}><p className="body-copy">确认{c.status === 'active' ? '冻结' : '解冻'}尾号 {tail(c.number)} 的信用卡？</p><Notice>下一步验证支付密码；解冻需加强验证。</Notice><Submit>确认</Submit></form>)} />
      <Row icon={IcoRecord} tone="blue" title="交易进度" onClick={() => navigate('transactions')} />
    </Card>
    <Card title="最近交易">
      {recent.slice(0, 5).map(t => <Row key={t.id} icon={t.type === 'credit_spend' ? IcoBag : IcoRecord} tone={t.type === 'credit_spend' ? 'orange' : 'blue'} title={t.title} subtitle={date(t.created_at)} trailing={<b className="amount">{t.type === 'credit_spend' ? '-' : '+'}{yuan(t.amount)}</b>} />)}
      {!recent.length && <Empty title="暂无交易记录" />}
    </Card>
  </div>;
}
