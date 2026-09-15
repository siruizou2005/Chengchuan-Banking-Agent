import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Landmark, LoaderCircle, Plus, RotateCcw, Square } from 'lucide-react';
import { ChatError, liveAdapter, initialMessages, type ChatAdapter, type Message } from './adapter';
import { api } from '../api';
import type { User } from '../types';
import { AccountSession } from './AccountSession';

function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? ' small' : ''}`}><Landmark aria-hidden="true" strokeWidth={2.3} /></span>;
}

function MessageBubble({ message }: { message: Message }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); } }, [copied]);
  async function copy() {
    try {
      const overview = message.overview ? `\n账户可用余额：¥ ${(message.overview.available / 100).toFixed(2)}\n最近流水：${message.overview.recentEntries} 笔（最多30笔）` : '';
      await navigator.clipboard.writeText(message.text + overview); setCopied(true); setCopyError(false);
    }
    catch { setCopyError(true); }
  }
  if (message.role === 'user') return <article className="message user-message"><span className="user-label">你</span><div className="bubble user-bubble">{message.text}</div></article>;
  return <article className="message assistant-message">
    <Mark small />
    <div className="assistant-content">
      <div className="assistant-heading"><strong>澄川智能助手</strong>{message.welcome && <span>你的模拟银行 Agent</span>}</div>
      <div className="bubble assistant-bubble">
        <p>{message.text}</p>
        {message.welcome && <p className="welcome-topics">账户 · 转账 · 财富 · 生活服务</p>}
        {message.overview && <div className="account-overview"><div><h3>账户概览</h3><span className="metric-label">可用余额</span><strong>¥ {(message.overview.available / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div><div><span className="metric-label">最近流水（最多30笔）</span><strong>{message.overview.recentEntries} 笔</strong></div></div>}
        {message.sources && <p className="data-note">参考：{message.sources.join(' · ')}{message.asOf && ` · ${new Date(message.asOf).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</p>}
        {message.truncated && <p className="data-note">回复达到长度上限，可以请助手继续。</p>}
      </div>
      <button className="copy-button" onClick={copy} aria-label={copied ? '已复制' : '复制回复'}>{copied ? <Check size={13} /> : <Copy size={13} />}<span>{copyError ? '复制失败，请手动选择文本' : copied ? '已复制' : '复制'}</span></button>
    </div>
  </article>;
}

export default function ChatApp({ adapter = liveAdapter }: { adapter?: ChatAdapter }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const shouldScroll = useRef(false);
  const [startedAt, setStartedAt] = useState(() => new Date());
  useEffect(() => {
    let alive = true;
    Promise.all([api<User>('/me').catch(() => null), api<{ configured: boolean }>('/chat/status')])
      .then(([profile, status]) => { if (alive) { setUser(profile); setConfigured(status.configured); } })
      .catch(() => { if (alive) setError('无法连接银行服务，请刷新后重试。'); })
      .finally(() => { if (alive) setSessionLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (shouldScroll.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, error, notice]);
  useEffect(() => {
    if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 132)}px`; }
  }, [draft]);

  async function requestReply(next: Message[]) {
    if (controller.current || !user) return;
    const active = new AbortController(); controller.current = active;
    setBusy(true); setError(''); setNotice(''); shouldScroll.current = true;
    try {
      const response = await adapter.reply(next, active.signal, user.id);
      if (!active.signal.aborted) setMessages([...next, { ...response, id: crypto.randomUUID(), role: 'assistant' }]);
    } catch (failure) {
      if (!active.signal.aborted) {
        if (failure instanceof ChatError && [401, 409].includes(failure.status)) { setUser(null); reset(); }
        setError(failure instanceof Error ? failure.message : '回复暂时未能送达，请重试。');
      }
    } finally {
      if (controller.current === active) { controller.current = null; setBusy(false); }
    }
  }
  function send() {
    const text = draft.trim(); if (!text || controller.current || !user || !configured) return;
    const next: Message[] = [...messages, { id: crypto.randomUUID(), role: 'user', text }];
    setMessages(next); setDraft(''); void requestReply(next); input.current?.focus();
  }
  function stop() { controller.current?.abort(); controller.current = null; setBusy(false); setNotice('已停止回复'); }
  function reset() {
    controller.current?.abort(); controller.current = null; shouldScroll.current = false;
    setBusy(false); setError(''); setNotice(''); setDraft(''); setMessages(initialMessages().slice(0, 1)); setStartedAt(new Date());
    input.current?.focus(); document.querySelector('.conversation-scroll')?.scrollTo({ top: 0 });
  }
  return <div className="chat-shell">
    <header className="chat-header"><div className="header-inner">
      <div className="brand-row"><div className="brand"><Mark /><div><strong>澄川银行</strong><span>CHENGCHUAN BANK</span></div></div><span className="simulation-pill">模拟银行</span></div>
      <div className="title-row"><h1>澄川 Agent</h1><div className="header-controls"><button className="new-chat" onClick={reset} title="新对话" aria-label="新对话"><Plus size={17} /><span>新对话</span></button><span className="connection-status"><span className={`status-dot${!user || !configured ? ' inactive' : ''}`} />{sessionLoading ? '连接中' : !configured ? '待配置' : user ? 'AI 对话' : '待登录'}</span></div></div>
    </div></header>
    <main className="conversation-scroll" aria-label="与澄川智能助手的对话">
      <div className="conversation-inner">
        <AccountSession user={user} loading={sessionLoading} onChange={profile => { reset(); setUser(profile); void api<{ configured: boolean }>('/chat/status').then(status => setConfigured(status.configured)).catch(() => setConfigured(false)); }} />
        <div className="date-divider">今天 {startedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        <div className="message-list">{messages.map(message => <MessageBubble key={message.id} message={message} />)}</div>
        {messages.length === 1 && <div className="suggestions" aria-label="推荐问题">{['看看最近的账户情况', '了解转账流程', '生活缴费怎么操作'].map(text => <button key={text} onClick={() => { setDraft(text); input.current?.focus(); }}>{text}<ArrowRight size={14} /></button>)}</div>}
        <div role="status" aria-live="polite">{busy && <div className="reply-status"><LoaderCircle size={16} className="spin" />澄川助手正在回复…</div>}{notice && <div className="reply-status">{notice}<button onClick={() => void requestReply(messages)}><RotateCcw size={14} />重新生成</button></div>}</div>
        {error && <div className="error-message" role="alert">{error}<button onClick={() => void requestReply(messages)}><RotateCcw size={14} />重试</button></div>}
        <div ref={bottom} className="scroll-anchor" />
      </div>
    </main>
    <footer className="chat-footer"><div className="footer-inner">
      <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label="消息" placeholder={user ? '和澄川助手聊聊…' : '请先登录模拟账户'} disabled={!user || sessionLoading} value={draft} onChange={event => setDraft(event.target.value)} rows={1} maxLength={4000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        {busy ? <button type="button" className="send-button" onClick={stop} aria-label="停止回复"><Square size={21} fill="currentColor" /></button> : <button type="submit" className="send-button" disabled={!draft.trim() || !user || !configured} aria-label="发送消息"><ArrowRight size={29} strokeWidth={2.4} /></button>}
      </form>
      <p className="footer-note">模拟演示环境 · 所有资金与业务均为虚拟</p><span className="footer-brand">CHENGCHUAN BANK</span>
    </div></footer>
  </div>;
}
