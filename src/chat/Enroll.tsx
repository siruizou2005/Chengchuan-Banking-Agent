import { useEffect, useState } from 'react';
import { LoaderCircle, Menu } from 'lucide-react';
import { api } from '../api';
import { useBank } from '../bank';
import { Logo, IcoRecord, IcoLock, IcoHelp, IcoDoc, IcoShield } from '../icons';
import { Card, CircleIcon, InlineError, Modal, Notice } from '../ui';
import { Markdown } from './Markdown';
import type { Agreement, Enrollment } from '../types';

const points = [
  { icon: IcoRecord, tone: 'blue', title: '能帮你做什么', text: '查账户与流水、分析账单、理财建议，提议转账和缴费' },
  { icon: IcoDoc, tone: 'gold', title: '会读取的数据', text: '账户、流水、持仓、卡片与订阅，仅用于回答问题，发送给模型前脱敏' },
  { icon: IcoLock, tone: 'coral', title: '资金操作须你在App确认', text: '需输入支付密码，较大金额还需人脸与短信验证' },
  { icon: IcoHelp, tone: 'orange', title: '回答可能有误', text: '以页面和服务端回单为准，理财建议不保证收益' },
  { icon: IcoShield, tone: 'blue', title: '可随时关闭', text: '「我的 → 安全中心」关闭后，App、飞书、微信均停止受理' },
] as const;

// 智能助手开通页：未开通或协议更新后显示，勾选同意当前全部协议才能使用。说明可滚动，勾选与按钮固定在底部，常见手机一屏放下。
export function Enroll() {
  const { refresh, toast, navigate } = useBank();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null), [agreed, setAgreed] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState<Agreement | null>(null);
  useEffect(() => { let alive = true; api<Enrollment>('/agent/enrollment').then(e => { if (alive) setEnrollment(e); }).catch(e => { if (alive) setError((e as Error).message); }); return () => { alive = false; }; }, []);
  const updated = (doc: Agreement) => enrollment?.status === 'reconsent_required' && !enrollment.accepted.some(a => a.id === doc.id && a.version === doc.version);
  async function open(doc: Agreement) {
    setError('');
    try { setReading(await api<Agreement>(`/agent/agreements/${doc.id}`)); } catch (e) { setError((e as Error).message); }
  }
  async function enable() {
    if (!enrollment || !agreed || busy) return;
    setBusy(true); setError('');
    try { await api('/agent/enrollment', 'POST', { documents: enrollment.documents.map(d => ({ id: d.id, version: d.version })) }); await refresh(); toast('智能助手已开通'); }
    catch (e) { setError((e as Error).message); setEnrollment(await api<Enrollment>('/agent/enrollment').catch(() => enrollment)); setAgreed(false); }
    finally { setBusy(false); }
  }
  return <section className="assistant-page enroll-page" aria-label="开通智能助手">
    <header className="chat-header">
      <button className="icon-button" aria-label="全部服务" onClick={() => navigate('services')}><Menu size={24} strokeWidth={1.8} /></button>
      <div className="chat-title"><h1>智能助手</h1><span className="chat-state">{enrollment?.status === 'reconsent_required' ? '协议已更新' : '未开通'}</span></div>
      <span className="enroll-spacer" aria-hidden="true" />
    </header>
    <div className="chat-scroll"><div className="page enroll-body">
      <section className="card enroll-hero"><Logo size={44} /><div><h2>开通澄川智能助手</h2><p>一句话查余额、分析账单、提议转账，获取理财建议</p></div></section>
      {enrollment?.status === 'reconsent_required' && <Notice>服务协议已更新，请阅读标注「已更新」的协议并同意后继续使用，你的记忆和渠道绑定都还在。</Notice>}
      <Card title="开通前请了解" className="enroll-intro"><ul className="enroll-points">{points.map(p => <li key={p.title}><CircleIcon icon={p.icon} tone={p.tone} size={40} glyph={20} /><div><b>{p.title}</b><span>{p.text}</span></div></li>)}</ul></Card>
    </div></div>
    <footer className="enroll-footer">
      <label className="enroll-agree"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} disabled={!enrollment} data-testid="enroll-agree" />
        {enrollment ? <span>我已阅读并同意{enrollment.documents.map(d => <button key={d.id} type="button" className="enroll-doc" onClick={e => { e.preventDefault(); void open(d); }} data-testid={`agreement-${d.id}`}>《{d.title}》{updated(d) && <em className="tag enroll-updated">已更新</em>}</button>)}</span>
          : !error && <span role="status"><LoaderCircle size={14} className="spin" /> 正在加载协议…</span>}
      </label>
      <InlineError message={error} />
      <button className="btn-primary" disabled={!agreed || busy || !enrollment} onClick={() => void enable()} data-testid="enroll-submit">{busy && <LoaderCircle size={19} className="spin" />}同意并开通</button>
      <p className="footnote">演示环境：协议与数据均为模拟，开通不需要支付密码</p>
    </footer>
    {reading && <Modal title={reading.title} onClose={() => setReading(null)}>
      <div className="agreement-text">
        <p className="muted">版本 {reading.version} · {reading.effectiveDate} 生效</p>
        <Markdown text={reading.body || ''} />
      </div>
    </Modal>}
  </section>;
}
