import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, LoaderCircle, Plus, RotateCcw, Sparkles, Square } from 'lucide-react';
import { ChatError, liveAdapter, initialMessages, type ChatAdapter, type Message } from './adapter';
import { api } from '../api';
import { useBank } from '../bank';
import './chat.css';

function Avatar() {
  return <span className="assistant-avatar" aria-hidden="true"><Sparkles size={18} strokeWidth={2.1} /></span>;
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
    <Avatar />
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

// 智能体页面：嵌入银行应用，使用当前登录用户。App 在切换标签时保持挂载，对话不会丢失。
export default function ChatApp({ adapter = liveAdapter }: { adapter?: ChatAdapter }) {
  const { data, refresh, logout } = useBank();
  const user = data.user;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const shouldScroll = useRef(false);
  const [startedAt, setStartedAt] = useState(() => new Date());
  useEffect(() => {
    let alive = true;
    api<{ configured: boolean }>('/chat/status')
      .then(status => { if (alive) setConfigured(status.configured); })
      .catch(() => { if (alive) { setConfigured(false); setError('无法连接聊天服务，请刷新后重试。'); } });
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
    if (controller.current) return;
    const active = new AbortController(); controller.current = active;
    setBusy(true); setError(''); setNotice(''); shouldScroll.current = true;
    try {
      const response = await adapter.reply(next, active.signal, user.id);
      if (!active.signal.aborted) setMessages([...next, { ...response, id: crypto.randomUUID(), role: 'assistant' }]);
    } catch (failure) {
      if (!active.signal.aborted) {
        setError(failure instanceof Error ? failure.message : '回复暂时未能送达，请重试。');
        // 401：会话过期，回到登录页；409：其他标签页切换了账户，同步银行数据（新用户会得到新的对话）。
        if (failure instanceof ChatError && [401, 409].includes(failure.status)) void refresh().catch(() => logout());
      }
    } finally {
      if (controller.current === active) { controller.current = null; setBusy(false); }
    }
  }
  function send() {
    const text = draft.trim(); if (!text || controller.current || !configured) return;
    const next: Message[] = [...messages, { id: crypto.randomUUID(), role: 'user', text }];
    setMessages(next); setDraft(''); void requestReply(next); input.current?.focus();
  }
  function stop() { controller.current?.abort(); controller.current = null; setBusy(false); setNotice('已停止回复'); }
  function reset() {
    controller.current?.abort(); controller.current = null; shouldScroll.current = false;
    setBusy(false); setError(''); setNotice(''); setDraft(''); setMessages(initialMessages()); setStartedAt(new Date());
    scroller.current?.scrollTo({ top: 0 });
  }
  return <section className="assistant-page" aria-label="智能体">
    <div className="assistant-toolbar">
      <span className="connection-status"><span className={`status-dot${configured ? '' : ' inactive'}`} />{configured === null ? '连接中' : configured ? `AI 对话 · ${user.name}` : '待配置'}</span>
      <button className="new-chat" onClick={reset}><Plus size={15} /><span>新对话</span></button>
    </div>
    <div ref={scroller} className="conversation-scroll" role="log" aria-label="与澄川智能助手的对话">
      <div className="conversation-inner">
        <div className="date-divider">今天 {startedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        <div className="chat-messages">{messages.map(message => <MessageBubble key={message.id} message={message} />)}</div>
        {messages.length === 1 && <div className="suggestions" aria-label="推荐问题">{['看看最近的账户情况', '了解转账流程', '生活缴费怎么操作'].map(text => <button key={text} onClick={() => { setDraft(text); input.current?.focus(); }}>{text}<ArrowRight size={14} /></button>)}</div>}
        {configured === false && !error && <div className="error-message" role="alert">聊天服务尚未配置，请在服务器 .env 中设置 CHAT_API_KEY 后重启。</div>}
        <div role="status" aria-live="polite">{busy && <div className="reply-status"><LoaderCircle size={16} className="spin" />澄川助手正在回复…</div>}{notice && <div className="reply-status">{notice}<button onClick={() => void requestReply(messages)}><RotateCcw size={14} />重新生成</button></div>}</div>
        {error && <div className="error-message" role="alert">{error}{configured && <button onClick={() => void requestReply(messages)}><RotateCcw size={14} />重试</button>}</div>}
        <div ref={bottom} className="scroll-anchor" />
      </div>
    </div>
    <div className="composer-bar">
      <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label="消息" placeholder="和澄川助手聊聊…" value={draft} onChange={event => setDraft(event.target.value)} rows={1} maxLength={4000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        {busy ? <button type="button" className="send-button" onClick={stop} aria-label="停止回复"><Square size={19} fill="currentColor" /></button> : <button type="submit" className="send-button" disabled={!draft.trim() || !configured} aria-label="发送消息"><ArrowRight size={25} strokeWidth={2.4} /></button>}
      </form>
      <p className="footer-note">对话和脱敏的账户资料会发送至 AI 服务 · 模拟演示环境</p>
    </div>
  </section>;
}
