import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Plus, RotateCcw, Menu } from 'lucide-react';
import { ChatError, liveAdapter, initialMessages, type ChatAdapter, type Message } from './adapter';
import { api } from '../api';
import { useBank } from '../bank';
import { Avatar } from '../ui';
import { Logo } from '../icons';
import './chat.css';

const money = (cents: number) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function MessageBubble({ message, userName }: { message: Message; userName: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); } }, [copied]);
  async function copy() {
    try {
      const overview = message.overview ? `\n账户可用余额：¥${money(message.overview.available)}\n最近流水：${message.overview.recentEntries} 笔（最多30笔）` : '';
      await navigator.clipboard.writeText(message.text + overview); setCopied(true); setCopyError(false);
    }
    catch { setCopyError(true); }
  }
  if (message.role === 'user') return <article className="msg user"><div className="bubble">{message.text}</div><Avatar size={34} /></article>;
  return <article className="msg assistant">
    <span className="chat-avatar" aria-hidden="true"><Logo size={34} /></span>
    <div className="msg-body">
      <span className="msg-name">澄川智能助手</span>
      <div className="bubble">
        <p>{message.text}</p>
        {message.overview && <div className="overview"><div><small>可用余额</small><strong>¥{money(message.overview.available)}</strong></div><div><small>最近流水</small><strong>{message.overview.recentEntries} 笔</strong></div></div>}
        {message.sources && <p className="data-note">数据来源：{message.sources.join('、')}{message.asOf && `，${new Date(message.asOf).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新`}</p>}
        {message.truncated && <p className="data-note">回复已达长度上限，可以请助手继续说。</p>}
      </div>
      <button className="copy-button" onClick={copy} aria-label={copied ? '已复制' : '复制回复'}>{copied ? <Check size={12} /> : <Copy size={12} />}<span>{copyError ? '复制失败，请手动选择文本' : copied ? '已复制' : '复制'}</span></button>
    </div>
  </article>;
}

const quickQuestions = ['查询余额', '最近交易', '转账怎么操作', '有哪些理财产品'];

// 智能助手页面：嵌入银行应用，使用当前登录用户。App 在切换标签时保持挂载，对话不会丢失。
export default function ChatApp({ adapter = liveAdapter }: { adapter?: ChatAdapter }) {
  const { data, refresh, logout, navigate } = useBank();
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
    if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 120)}px`; }
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
  function send(text = draft) {
    const content = text.trim(); if (!content || controller.current || !configured) return;
    const next: Message[] = [...messages, { id: crypto.randomUUID(), role: 'user', text: content }];
    setMessages(next); setDraft(''); void requestReply(next); input.current?.focus();
  }
  function stop() { controller.current?.abort(); controller.current = null; setBusy(false); setNotice('已停止回复'); }
  function reset() {
    controller.current?.abort(); controller.current = null; shouldScroll.current = false;
    setBusy(false); setError(''); setNotice(''); setDraft(''); setMessages(initialMessages()); setStartedAt(new Date());
    scroller.current?.scrollTo({ top: 0 });
  }
  return <section className="assistant-page" aria-label="智能助手">
    <header className="chat-header">
      <button className="icon-button" aria-label="全部服务" onClick={() => navigate('services')}><Menu size={24} strokeWidth={1.8} /></button>
      <div className="chat-title"><h1>智能助手</h1><span className={`chat-state${configured ? ' on' : ''}`}>{configured === null ? '连接中…' : configured ? '在线，7×24小时服务' : '服务暂不可用'}</span></div>
      <button className="btn-text" onClick={reset}><Plus size={15} />新对话</button>
    </header>
    <div ref={scroller} className="chat-scroll" role="log" aria-label="对话记录">
      <div className="chat-inner">
        <div className="chat-time">{startedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        <div className="chat-messages">{messages.map(message => <MessageBubble key={message.id} message={message} userName={user.name} />)}</div>
        {messages.length === 1 && <div className="chat-chips" aria-label="常见问题">{quickQuestions.map(text => <button key={text} disabled={!configured} onClick={() => send(text)}>{text}</button>)}</div>}
        {configured === false && !error && <div className="chat-error" role="alert">聊天服务尚未配置，请在服务器 .env 中设置 CHAT_API_KEY 后重启。</div>}
        <div role="status" aria-live="polite">{busy && <div className="chat-hint"><LoaderCircle size={15} className="spin" />正在为您查询…</div>}{notice && <div className="chat-hint">{notice}<button onClick={() => void requestReply(messages)}><RotateCcw size={13} />重新生成</button></div>}</div>
        {error && <div className="chat-error" role="alert">{error}{configured && <button onClick={() => void requestReply(messages)}><RotateCcw size={13} />重试</button>}</div>}
        <div ref={bottom} className="scroll-anchor" />
      </div>
    </div>
    <div className="chat-composer">
      <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label="消息" placeholder="请输入您的问题" value={draft} onChange={event => setDraft(event.target.value)} rows={1} maxLength={4000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        {busy ? <button type="button" className="pill small" onClick={stop} aria-label="停止回复">停止</button> : <button type="submit" className="pill primary small" disabled={!draft.trim() || !configured} aria-label="发送消息">发送</button>}
      </form>
      <p className="chat-note">智能助手基于您的账户信息作答，回复仅供参考</p>
    </div>
  </section>;
}
