import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Home as HomeIcon, ChartNoAxesCombined, CreditCard, Coffee, UserRound, ChevronLeft, Headphones, Check, CircleX, Clock3, LoaderCircle, ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, ApiError, formValues, yuan, date, statusLabel, tail } from './api';
import { BankContext } from './bank';
import { Brand, Field, InlineError, Modal, Notice, PinField } from './ui';
import { Home, ServiceDirectory } from './pages/Home';
import { Accounts, LedgerPage, Payees, Receive, Scan, Transactions, Transfer } from './pages/Accounts';
import { Credit, Loans, Risk, Wealth } from './pages/Wealth';
import { Appointments, Life, Support } from './pages/Life';
import { AgentCenter, Messages, Profile, Security } from './pages/Profile';
import type { Snapshot, Transaction } from './types';

const titles: Record<string, string> = { accounts: '我的账户', transfer: '转账汇款', ledger: '收支明细', transactions: '交易记录', payees: '收款人管理', receive: '收付款', scan: '扫一扫', wealth: '财富', deposit: '定期存款', loan: '澄心贷', credit: '信用卡', risk: '风险测评', life: '生活', appointments: '网点预约', support: '帮助与客服', profile: '我的', security: '安全中心', messages: '消息中心', agent: '开发者中心', search: '搜索服务', services: '全部服务' };
const tabs = [{ id: 'home', title: '首页', icon: HomeIcon }, { id: 'wealth', title: '财富', icon: ChartNoAxesCombined }, { id: 'credit', title: '信用卡', icon: CreditCard }, { id: 'life', title: '生活', icon: Coffee }, { id: 'profile', title: '我的', icon: UserRound }];

export default function App() {
  const [data, setData] = useState<Snapshot | null>(null), [loading, setLoading] = useState(true), [initialError, setInitialError] = useState('');
  const [route, setRoute] = useState(location.hash.slice(1) || 'home');
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [formError, setFormError] = useState<{ message: string; code: string } | null>(null);
  const [modal, setModal] = useState<{ title: string; content: ReactNode } | null>(null), [tx, setTx] = useState<Transaction | null>(null);
  const [toastState, setToastState] = useState<{ message: string; error: boolean } | null>(null), toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hidden, setHidden] = useState(localStorage.getItem('bank-hide-balances') === 'true');
  const page = route.split('?')[0];
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
    const sync = () => { setRoute(location.hash.slice(1) || 'home'); window.scrollTo(0, 0); };
    addEventListener('hashchange', sync);
    refresh().catch(e => { if (!(e instanceof ApiError && e.status === 401)) setInitialError(e.message); }).finally(() => setLoading(false));
    return () => removeEventListener('hashchange', sync);
  }, [refresh]);
  useEffect(() => { if (!data) return; const timer = setInterval(() => { if (!document.hidden && !busyRef.current) refresh().catch(() => {}); }, 30000); return () => clearInterval(timer); }, [Boolean(data), refresh]);
  useEffect(() => { document.title = `${titles[page] || '首页'} · 澄川银行`; }, [page]);
  async function mutate(path: string, body: unknown, success: string, method = 'POST') {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setFormError(null);
    try { await api(path, method, body); await refresh(); toast(success); return true; }
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
  async function confirm(pin: string) {
    if (!tx || busyRef.current) return;
    busyRef.current = true; setBusy(true); setFormError(null);
    try { const result = await api<Transaction>(`/transactions/${tx.id}/confirm`, 'POST', { pin }); setTx(result); await refresh(); }
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
  if (loading) return <div className="app-shell loading-screen"><Brand /><LoaderCircle size={26} className="spin" /><p>正在连接你的模拟银行…</p></div>;
  if (!data) return <><Login initialError={initialError} onLogin={async () => { await refresh(); navigate('home'); }} />{toastElement}</>;
  const pages: Record<string, ReactNode> = { home: <Home />, accounts: <Accounts />, transfer: <Transfer key={route} />, ledger: <LedgerPage />, transactions: <Transactions />, payees: <Payees />, receive: <Receive />, scan: <Scan />, wealth: <Wealth />, deposit: <Wealth deposits />, loan: <Loans />, credit: <Credit />, risk: <Risk />, life: <Life />, appointments: <Appointments />, support: <Support />, profile: <Profile />, security: <Security />, messages: <Messages />, agent: <AgentCenter />, search: <ServiceDirectory search />, services: <ServiceDirectory /> };
  const activeTab = ['deposit', 'risk'].includes(page) ? 'wealth' : ['accounts', 'security', 'messages', 'agent', 'transactions', 'payees'].includes(page) ? 'profile' : ['appointments'].includes(page) ? 'life' : page;
  return <BankContext.Provider value={{ data, busy, route, hidden, formError, clearFormError: () => setFormError(null), navigate, refresh, begin, mutate, openModal: (title, content) => { setFormError(null); setTx(null); setModal({ title, content }); }, closeModal: () => setModal(null), showTransaction: (transaction) => { setFormError(null); setTx(transaction); }, toast, logout, toggleHidden: () => { setHidden(!hidden); localStorage.setItem('bank-hide-balances', String(!hidden)); } }}><div className="app-shell">{page !== 'home' && <header className="page-header"><button className="icon-button" aria-label="返回首页" onClick={() => navigate('home')}><ChevronLeft size={25} /></button><h1>{titles[page] || '页面未找到'}</h1><button className="icon-button" aria-label="帮助与客服" onClick={() => navigate('support')}><Headphones size={21} /></button></header>}{pages[page] || <div className="page-content"><Notice>未找到该页面。</Notice><button className="primary full" onClick={() => navigate('home')}>返回首页</button></div>}<nav className="bottom-nav" aria-label="主导航">{tabs.map(t => <button key={t.id} className={activeTab === t.id ? 'active' : ''} onClick={() => navigate(t.id)} aria-current={activeTab === t.id ? 'page' : undefined} data-testid={`nav-${t.id}`}><t.icon size={23} strokeWidth={activeTab === t.id ? 2.2 : 1.7} /><span>{t.title}</span></button>)}</nav></div>{modal && <Modal title={modal.title} onClose={() => { if (!busy) setModal(null); }}>{modal.content}</Modal>}{tx && <Modal title={tx.status === 'pending' ? '核对交易信息' : '交易详情'} onClose={() => { if (!busy) setTx(null); }}><div className="receipt"><span className={`receipt-icon ${tx.status}`} aria-hidden="true">{tx.status === 'completed' ? <Check size={32} /> : tx.status === 'pending' ? <Clock3 size={30} /> : <CircleX size={30} />}</span><h3>{tx.title}</h3><div className="receipt-amount">¥ {yuan(tx.amount)}</div><span className={`status ${tx.status}`} data-testid="transaction-status">{statusLabel[tx.status]}</span><dl><dt>交易账户</dt><dd>储蓄卡（{tail(data.accounts.find(a => a.id === tx.account_id)?.number || '')}）</dd>{tx.payload.recipientName && <><dt>收款人</dt><dd>{tx.payload.recipientName}</dd><dt>收款账号</dt><dd className="mono">{tx.payload.recipientAccount}</dd><dt>收款银行</dt><dd>{tx.payload.bank}</dd></>}{tx.payload.billNumber && <><dt>缴费户号</dt><dd>{tx.payload.billNumber}</dd></>}{tx.payload.note && <><dt>附言</dt><dd>{tx.payload.note}</dd></>}{tx.payload.months && <><dt>借款期限</dt><dd>{tx.payload.months}个月</dd></>}<dt>交易编号</dt><dd className="mono" data-testid="transaction-id">{tx.id}</dd><dt>创建时间</dt><dd>{date(tx.created_at)}</dd>{tx.status !== 'pending' && <><dt>更新时间</dt><dd>{date(tx.updated_at)}</dd></>}</dl>{tx.error && <div className="inline-error">{tx.error}</div>}{tx.status === 'pending' ? <form className="stack-form" onSubmit={e => { const f = formValues(e); void confirm(f.pin); }}><Notice>请核对交易信息。有效期至 {date(tx.expires_at)}；演示账户初始支付密码为123456。</Notice><PinField /><button className="primary full" disabled={busy} data-testid="confirm-transaction">{busy && <LoaderCircle size={18} className="spin" />}确认{tx.type === 'loan_draw' ? '借款' : tx.type === 'redeem' ? '赎回' : '交易'}</button><button className="text-button full muted" type="button" disabled={busy} onClick={cancel} data-testid="cancel-transaction">取消本次交易</button></form> : <button className="primary full" onClick={() => { setTx(null); navigate('transactions'); }}>完成</button>}</div></Modal>}{toastElement}</BankContext.Provider>;
}

function Login({ onLogin, initialError }: { onLogin: () => Promise<void>; initialError: string }) {
  const [register, setRegister] = useState(false), [phone, setPhone] = useState('13800138000'), [password, setPassword] = useState('Bank123456'), [error, setError] = useState(initialError), [busy, setBusy] = useState(false);
  async function login(e: React.FormEvent<HTMLFormElement>) {
    const body = formValues(e); setError(''); setBusy(true);
    try { await api(register ? '/auth/register' : '/auth/login', 'POST', body); await onLogin(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="app-shell login-page"><header><Brand /><span className="simulation-pill">模拟银行</span></header><main><div className="login-intro"><span className="login-glyph"><ShieldCheck size={47} strokeWidth={1.4} /></span><span className="eyebrow">连接每一天的从容</span><h1>你好，<br />欢迎来到澄川。</h1><p>你的账户、财富与生活，在这里相连。</p></div><div className="login-tabs"><button className={!register ? 'active' : ''} onClick={() => { setRegister(false); setPhone('13800138000'); setPassword('Bank123456'); setError(''); }}>登录</button><button className={register ? 'active' : ''} onClick={() => { setRegister(true); setPhone(''); setPassword(''); setError(''); }}>注册模拟账户</button></div><form className="stack-form login-form" onSubmit={login} data-testid="login-form">{register && <Field label="姓名"><input name="name" placeholder="请填写模拟用户姓名" required minLength={2} maxLength={20} autoComplete="name" /></Field>}<Field label="手机号"><input name="phone" type="tel" autoComplete="username" placeholder="请输入11位手机号" value={phone} onChange={e => setPhone(e.target.value)} required pattern="1[0-9]{10}" /></Field><Field label="登录密码"><input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder="8位以上，包含字母和数字" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} onInvalid={e => { e.preventDefault(); setError('请输入8至72位登录密码'); }} required minLength={8} maxLength={72} /></Field>{register && <PinField label="设置支付密码" />}<InlineError message={error} id="login-error" testId="login-error" /><button className="primary full" disabled={busy} data-testid="login-submit">{busy ? <LoaderCircle size={19} className="spin" /> : null}{register ? '开通模拟账户' : '登录模拟银行'}<ArrowUpRight size={19} /></button></form>{!register && <div className="demo-access"><span>选择演示账户</span><div><button className={phone === '13800138000' ? 'active' : ''} onClick={() => { setPhone('13800138000'); setPassword('Bank123456'); }}>林知夏<span>13800138000</span></button><button className={phone === '13900139000' ? 'active' : ''} onClick={() => { setPhone('13900139000'); setPassword('Bank123456'); }}>陈屿<span>13900139000</span></button></div><p>登录密码 Bank123456 · 支付密码 123456</p></div>}<p className="login-note"><ShieldCheck size={15} />模拟演示环境，所有资金与业务均为虚拟</p>{register && <p className="page-footnote">注册无需短信或真实身份资料，新用户将获得虚拟开户资金。</p>}</main><footer>CHENGCHUAN BANK<span>澄澈于心 · 从容于行</span></footer></div>;
}
