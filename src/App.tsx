import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, Menu, Headphones, Check, CircleX, Clock3, LoaderCircle, Flame, Zap, ShieldCheck, Coins } from 'lucide-react';
import { NavAccount, NavWealth, NavAssistant, NavLife, NavProfile } from './icons';
import { api, ApiError, formValues, yuan, date, statusLabel, tail } from './api';
import { BankContext } from './bank';
import { Brand, Field, InlineError, Modal, Notice, PinField, Rate } from './ui';
import { Home, ServiceDirectory } from './pages/Home';
import { Accounts, LedgerPage, Payees, Receive, Scan, Transactions, Transfer } from './pages/Accounts';
import { Credit, Loans, Risk, Wealth } from './pages/Wealth';
import { Appointments, Life, Support } from './pages/Life';
import { AgentCenter, Messages, Profile, Security } from './pages/Profile';
import { Channels } from './pages/Channels';
import { ChannelRequest } from './pages/ChannelRequest';
import { AgentTasks, PayRequest } from './pages/AgentTasks';
import { Approval, type ApprovalProof } from './Approval';
import ChatApp from './chat/ChatApp';
import type { Snapshot, Transaction } from './types';

const titles: Record<string, string> = { 'wechat-requests': '微信请求结果', channels: '消息渠道绑定', tasks: '智能助手操作与计划', home: '账户', accounts: '银行卡', transfer: '转账汇款', ledger: '交易记录', transactions: '交易进度', payees: '收款人管理', receive: '收款码', scan: '扫一扫', wealth: '理财', deposit: '定期存款', loan: '澄心贷', credit: '信用卡', risk: '风险测评', life: '生活', appointments: '网点预约', support: '帮助与客服', profile: '我的', security: '安全中心', messages: '消息中心', agent: '开发者中心', assistant: '智能助手', search: '搜索', services: '全部服务' };
const tabs = [{ id: 'home', title: '账户', icon: NavAccount }, { id: 'wealth', title: '理财', icon: NavWealth }, { id: 'assistant', title: '智能助手', icon: NavAssistant }, { id: 'life', title: '生活', icon: NavLife }, { id: 'profile', title: '我的', icon: NavProfile }];
const tabPages = ['wealth', 'life', 'profile'];

export default function App() {
  const [data, setData] = useState<Snapshot | null>(null), [loading, setLoading] = useState(true), [initialError, setInitialError] = useState('');
  const [route, setRoute] = useState(location.hash.slice(1) || 'home');
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [formError, setFormError] = useState<{ message: string; code: string } | null>(null);
  const [approval, setApproval] = useState<{ actionId?: string; title: string; resolve: (proof: ApprovalProof | null) => void } | null>(null);
  const [modal, setModal] = useState<{ title: string; content: ReactNode } | null>(null), [tx, setTx] = useState<Transaction | null>(null);
  const [toastState, setToastState] = useState<{ message: string; error: boolean } | null>(null), toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hidden, setHidden] = useState(localStorage.getItem('bank-hide-balances') === 'true');
  const page = route.startsWith('wechat-requests/') ? 'wechat-requests' : route.split('?')[0];
  // 智能助手页首次打开后保持挂载，切换标签不丢失对话；退出登录时随整个应用卸载。
  const [assistantOpened, setAssistantOpened] = useState(page === 'assistant');
  const navigated = useRef(false); // 应用内是否发生过路由跳转，决定返回按钮用 history.back 还是回账户页
  useEffect(() => { if (page === 'assistant') setAssistantOpened(true); }, [page]);
  const navigate = useCallback((r: string) => { location.hash = r; }, []);
  const refresh = useCallback(async () => { const snapshot = await api<Snapshot>('/dashboard'); setData(snapshot); }, []);
  const toast = useCallback((message: string, error = false) => { if (toastTimer.current) clearTimeout(toastTimer.current); setToastState({ message, error }); toastTimer.current = setTimeout(() => setToastState(null), error ? 6500 : 3500); }, []);
  function handleError(e: unknown) {
    const message = (e as Error).message || '网络连接失败，请重试';
    setFormError({ message, code: e instanceof ApiError ? e.code : 'NETWORK_ERROR' });
    if (e instanceof ApiError && e.status === 401 && e.code === 'UNAUTHENTICATED') { setData(null); setModal(null); setTx(null); }
    if (!modal && !tx) toast(message, true);
  }
  useEffect(() => {
    const sync = () => { navigated.current = true; setRoute(location.hash.slice(1) || 'home'); window.scrollTo(0, 0); };
    addEventListener('hashchange', sync);
    refresh().catch(e => { if (!(e instanceof ApiError && e.status === 401)) setInitialError(e.message); }).finally(() => setLoading(false));
    return () => removeEventListener('hashchange', sync);
  }, [refresh]);
  useEffect(() => { if (!data) return; const timer = setInterval(() => { if (!document.hidden && !busyRef.current) refresh().catch(() => {}); }, 30000); return () => clearInterval(timer); }, [Boolean(data), refresh]);
  useEffect(() => { document.title = `${titles[page] || '账户'} · 澄川银行`; }, [page]);
  async function mutate(path: string, body: unknown, success: string, method = 'POST') {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setFormError(null);
    try {
      if (path === '/settings' || path === '/credit-card' || /^\/accounts\/[A-Za-z0-9]+$/.test(path)) {
        const intent = await api('/verify/intent', 'POST', { path, body });
        const proof = await new Promise<ApprovalProof | null>(resolve => setApproval({ actionId: intent.actionId, title: intent.required ? '身份验证已完成，请输入支付密码确认本次修改。' : '请核对设置并输入支付密码确认。', resolve }));
        if (!proof) return false;
        body = { ...(body as Record<string, unknown>), ...proof };
      }
      await api(path, method, body); await refresh(); toast(success); return true;
    }
    catch (e) { handleError(e); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function begin(body: Record<string, unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setFormError(null);
    try { const result = await api<Transaction>('/transactions', 'POST', body, { 'Idempotency-Key': crypto.randomUUID() }); setModal(null); setTx(result); await refresh(); }
    catch (e) { handleError(e); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function confirm() {
    if (!tx || busyRef.current) return;
    busyRef.current = true; setBusy(true); setFormError(null);
    try {
      const path = `/transactions/${tx.id}/confirm`;
      const intent = await api('/verify/intent', 'POST', { path, body: {} });
      const proof = await new Promise<ApprovalProof | null>(resolve => setApproval({ actionId: intent.actionId, title: `${tx.title} ¥${yuan(tx.amount)}`, resolve }));
      if (!proof) return;
      const result = await api<Transaction>(path, 'POST', proof); setTx(result); await refresh();
    }
    catch (e) { handleError(e); if (tx) { const current = await api<Transaction>(`/transactions/${tx.id}`).catch(() => null); if (current) setTx(current); } }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function cancel() {
    if (!tx || busyRef.current) return;
    busyRef.current = true; setBusy(true); setFormError(null);
    try { setTx(await api<Transaction>(`/transactions/${tx.id}/cancel`, 'POST', {})); await refresh(); }
    catch (e) { handleError(e); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function logout() { try { await api('/auth/logout', 'POST', {}); setData(null); setTx(null); setModal(null); navigate('home'); } catch (e) { handleError(e); } }
  const toastElement = toastState && <div className={`toast ${toastState.error ? 'error' : ''}`} role={toastState.error ? 'alert' : 'status'}>{toastState.error ? <CircleX size={18} /> : <Check size={18} />}<span>{toastState.message}</span></div>;
  if (loading) return <div className="app-shell loading-screen"><Brand /><LoaderCircle size={26} className="spin" /><p>正在加载…</p></div>;
  if (!data) return <><Login initialError={initialError} onLogin={async () => { await refresh(); if (!location.hash.slice(1)) navigate('home'); }} />{toastElement}</>;
  const pages: Record<string, ReactNode> = { 'wechat-requests': <ChannelRequest />, channels: <Channels />, tasks: <AgentTasks />, home: <Home />, accounts: <Accounts />, transfer: <Transfer key={route} />, ledger: <LedgerPage />, transactions: <Transactions />, payees: <Payees />, receive: <Receive />, scan: <Scan />, wealth: <Wealth />, deposit: <Wealth deposits />, loan: <Loans />, credit: <Credit />, risk: <Risk />, life: <Life />, appointments: <Appointments />, support: <Support />, profile: <Profile />, security: <Security />, messages: <Messages />, agent: <AgentCenter />, search: <ServiceDirectory search />, services: <ServiceDirectory /> };
  const activeTab = ['deposit', 'risk', 'loan'].includes(page) ? 'wealth' : ['accounts', 'security', 'messages', 'agent', 'transactions', 'payees', 'credit'].includes(page) ? 'profile' : ['appointments', 'support'].includes(page) ? 'life' : page;
  const isTabPage = tabPages.includes(page);
  return <BankContext.Provider value={{ data, busy, route, hidden, formError, clearFormError: () => setFormError(null), navigate, refresh, begin, mutate, openModal: (title, content) => { setFormError(null); setTx(null); setModal({ title, content }); }, closeModal: () => setModal(null), showTransaction: (transaction) => { setFormError(null); setTx(transaction); }, toast, logout, toggleHidden: () => { setHidden(!hidden); localStorage.setItem('bank-hide-balances', String(!hidden)); } }}><div className={`app-shell${page === 'assistant' ? ' assistant-mode' : ''}`}>
    {page !== 'home' && page !== 'assistant' && <header className="page-header">{isTabPage ? <button className="icon-button" aria-label="全部服务" onClick={() => navigate('services')}><Menu size={24} strokeWidth={1.8} /></button> : <button className="icon-button" aria-label="返回" onClick={() => navigated.current ? history.back() : navigate('home')}><ChevronLeft size={26} /></button>}<h1>{titles[page] || '页面未找到'}</h1><button className="icon-button" aria-label="帮助与客服" onClick={() => navigate('support')}><Headphones size={22} strokeWidth={1.8} /></button></header>}
    {assistantOpened && <div className="assistant-slot" hidden={page !== 'assistant'}><ChatApp key={data.user.id} /></div>}
    {page !== 'assistant' && (page.startsWith('pay-request/') ? <PayRequest path={page} /> : pages[page] || <div className="page"><Notice>未找到该页面。</Notice><button className="btn-primary" onClick={() => navigate('home')}>返回账户</button></div>)}
    <nav className="bottom-nav" aria-label="主导航">{tabs.map(t => <button key={t.id} className={activeTab === t.id ? 'active' : ''} onClick={() => navigate(t.id)} aria-current={activeTab === t.id ? 'page' : undefined} data-testid={`nav-${t.id}`}><span className="nav-icon"><t.icon active={activeTab === t.id} /></span><span>{t.title}</span></button>)}</nav>
  </div>
    {modal && <Modal title={modal.title} onClose={() => { if (!busy) setModal(null); }}>{modal.content}</Modal>}
    {tx && <Modal title={tx.status === 'pending' ? '确认交易' : '交易详情'} onClose={() => { if (!busy) setTx(null); }}><div className="receipt"><span className={`receipt-icon ${tx.status}`} aria-hidden="true">{tx.status === 'completed' ? <Check size={30} /> : tx.status === 'pending' ? <Clock3 size={28} /> : <CircleX size={28} />}</span><h3>{tx.title}</h3><div className="receipt-amount">¥{yuan(tx.amount)}</div><span className={`status ${tx.status}`} data-testid="transaction-status">{statusLabel[tx.status]}</span><dl><dt>付款账户</dt><dd>储蓄卡（{tail(data.accounts.find(a => a.id === tx.account_id)?.number || '')}）</dd>{tx.payload.recipientName && <><dt>收款人</dt><dd>{tx.payload.recipientName}</dd><dt>收款账号</dt><dd className="mono">{tx.payload.recipientAccount}</dd><dt>收款银行</dt><dd>{tx.payload.bank}</dd></>}{tx.payload.billNumber && <><dt>缴费户号</dt><dd>{tx.payload.billNumber}</dd></>}{tx.payload.note && <><dt>附言</dt><dd>{tx.payload.note}</dd></>}{tx.payload.months && <><dt>借款期限</dt><dd>{tx.payload.months}个月</dd></>}<dt>交易编号</dt><dd className="mono" data-testid="transaction-id">{tx.id}</dd><dt>创建时间</dt><dd>{date(tx.created_at)}</dd>{tx.status !== 'pending' && <><dt>更新时间</dt><dd>{date(tx.updated_at)}</dd></>}</dl>{tx.error && <div className="inline-error">{tx.error}</div>}{tx.status === 'pending' ? <form className="stack-form" onSubmit={e => { e.preventDefault(); void confirm(); }}><Notice>请核对交易信息并输入支付密码，本次交易有效期至 {date(tx.expires_at)}。</Notice><button className="btn-primary" disabled={busy} data-testid="confirm-transaction">{busy && <LoaderCircle size={18} className="spin" />}确认{tx.type === 'loan_draw' ? '借款' : tx.type === 'redeem' ? '赎回' : '支付'}</button><button className="btn-text" type="button" disabled={busy} onClick={cancel} data-testid="cancel-transaction">取消交易</button></form> : <button className="btn-primary" onClick={() => { setTx(null); navigate('transactions'); }}>完成</button>}</div></Modal>}
    {approval && <Approval actionId={approval.actionId} title={approval.title} onComplete={proof => { approval.resolve(proof); setApproval(null); }} onCancel={() => { approval.resolve(null); setApproval(null); }} />}
    {toastElement}
  </BankContext.Provider>;
}

function Login({ onLogin, initialError }: { onLogin: () => Promise<void>; initialError: string }) {
  const [register, setRegister] = useState(false), [phone, setPhone] = useState('13800138000'), [password, setPassword] = useState('Bank123456'), [error, setError] = useState(initialError), [busy, setBusy] = useState(false);
  async function login(e: React.FormEvent<HTMLFormElement>) {
    const body = formValues(e); setError(''); setBusy(true);
    try { await api(register ? '/auth/register' : '/auth/login', 'POST', body); await onLogin(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const demos = [{ name: '林知夏', phone: '13800138000' }, { name: '陈屿', phone: '13900139000' }];
  return <div className="app-shell login-page">
    <header className="login-hero"><Brand light sub="手机银行" size={40} /><p className="login-slogan">存款 · 理财 · 贷款 · 生活缴费</p></header>
    <main className="login-body">
      <section className="card login-card">
        <div className="tabs grow"><button role="tab" className={`tab${!register ? ' active' : ''}`} aria-selected={!register} onClick={() => { setRegister(false); setPhone('13800138000'); setPassword('Bank123456'); setError(''); }}>登录</button><button role="tab" className={`tab${register ? ' active' : ''}`} aria-selected={register} onClick={() => { setRegister(true); setPhone(''); setPassword(''); setError(''); }}>注册</button></div>
        <form className="stack-form" onSubmit={login} data-testid="login-form">
          {register && <Field label="姓名"><input name="name" placeholder="请输入姓名" required minLength={2} maxLength={20} autoComplete="name" /></Field>}
          <Field label="手机号"><input name="phone" type="tel" autoComplete="username" placeholder="请输入11位手机号" value={phone} onChange={e => setPhone(e.target.value)} required pattern="1[0-9]{10}" /></Field>
          <Field label="登录密码"><input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder="8位以上，包含字母和数字" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} onInvalid={e => { e.preventDefault(); setError('请输入8至72位登录密码'); }} required minLength={8} maxLength={72} /></Field>
          {register && <PinField label="设置支付密码" />}
          <InlineError message={error} id="login-error" testId="login-error" />
          <button className="btn-primary" disabled={busy} data-testid="login-submit">{busy ? <LoaderCircle size={19} className="spin" /> : null}{register ? '注册并登录' : '登录'}</button>
        </form>
        {!register && <div className="demo-access"><span>演示账户</span><div>{demos.map(d => <button key={d.phone} className={`pill small${phone === d.phone ? ' primary' : ''}`} onClick={() => { setPhone(d.phone); setPassword('Bank123456'); }}>{d.name} {d.phone.slice(0, 3)}****{d.phone.slice(-4)}</button>)}</div><p>登录密码 Bank123456，支付密码 123456</p></div>}
        {register && <p className="footnote">注册无需短信验证，新用户自动获得开户体验金。</p>}
      </section>
      <section className="card login-promo"><header className="card-head"><h2 className="card-title">热销产品</h2><span className="card-action"><Flame size={14} />近7天热销</span></header><div className="promo-center"><strong>澄享日日盈</strong><span className="promo-perks"><i><Coins size={13} />1元起购</i><i><Zap size={13} />快速到账</i><i><ShieldCheck size={13} />低风险</i></span><Rate value={2.18} caption="成立以来年化" size="xl" /><button className="pill primary" onClick={() => document.querySelector<HTMLInputElement>('input[name=phone]')?.focus()}>登录后查看</button></div></section>
      <p className="footnote login-note"><ShieldCheck size={14} />演示环境，所有资金与业务均为虚拟数据</p>
    </main>
  </div>;
}
