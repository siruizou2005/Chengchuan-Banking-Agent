import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Plus, RotateCcw, Menu, Mic, Square, X, History } from 'lucide-react';
import { ChatError, liveAdapter, initialMessages, type ChatAdapter, type Message } from './adapter';
import { api, date } from '../api';
import { useBank } from '../bank';
import { Avatar, Empty, InlineError, Modal } from '../ui';
import type { AgentSession, AgentSessionDetail } from '../types';
import { AgentMark } from '../AgentMark';
import { Markdown } from './Markdown';
import { ActionCard, EventCards, DecisionTrace, LockedCard } from './cards';
import { startRecording, transcribe, type Recording } from './voice';
import './chat.css';

const money = (cents: number) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function MessageBubble({ message, userName, onAsk }: { message: Message; userName: string; onAsk?: (text: string) => void }) {
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
  return <article className="msg assistant" id={`msg-${message.id}`}>
    <span className="chat-avatar" aria-hidden="true"><AgentMark size={32} /></span>
    <div className="msg-body">
      <span className="msg-name">澄川智能助手</span>
      <div className="bubble">
        <Markdown text={message.text} />
        {message.overview && <div className="overview"><div><small>可用余额</small><strong>¥{money(message.overview.available)}</strong></div><div><small>最近流水</small><strong>{message.overview.recentEntries} 笔</strong></div></div>}
        {message.sources && <p className="data-note">数据来源：{message.sources.join('、')}{message.asOf && `，${new Date(message.asOf).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新`}</p>}
        {message.truncated && <p className="data-note">回复已达长度上限，可以请助手继续说。</p>}
      </div>
      {message.events && <EventCards events={message.events} onAsk={onAsk} />}
      {message.trace && message.trace.length > 0 && <DecisionTrace trace={message.trace} />}
      <button className="copy-button" onClick={copy} aria-label={copied ? '已复制' : '复制回复'}>{copied ? <Check size={12} /> : <Copy size={12} />}<span>{copyError ? '复制失败，请手动选择文本' : copied ? '已复制' : '复制'}</span></button>
    </div>
  </article>;
}

const quickQuestions = ['给陈屿转 200 备注午饭', '分析本月账单', '有哪些订阅扣费', '推荐一个理财', '我爱人 10 月 5 日生日，帮我安排'];
// 每个用户在本浏览器中最后打开的对话；服务端会校验归属，读写失败（隐私模式等）静默忽略。
const sessionKey = (userId: string) => `bank-chat-session:${userId}`;
const readStoredSession = (userId: string) => { try { return localStorage.getItem(sessionKey(userId)) || ''; } catch { return ''; } };
const storeSession = (userId: string, id: string) => { try { if (id) localStorage.setItem(sessionKey(userId), id); else localStorage.removeItem(sessionKey(userId)); } catch { /* 忽略 */ } };
const currentSessionId = (messages: readonly Message[]) => [...messages].reverse().find(m => m.sessionId)?.sessionId || '';

// 智能助手页面：嵌入银行应用，使用当前登录用户。App 在切换标签时保持挂载，对话不会丢失。
export default function ChatApp({ adapter = liveAdapter, request }: { adapter?: ChatAdapter; request?: { id: number; text: string } | null }) {
  const { data, refresh, logout, navigate } = useBank();
  const user = data.user;
  const [voiceEnabled, setVoiceEnabled] = useState(false), [recording, setRecording] = useState(false), [voiceBusy, setVoiceBusy] = useState(false), [transcribing, setTranscribing] = useState(false), [seconds, setSeconds] = useState(0), [level, setLevel] = useState(0);
  const recorder = useRef<Recording | null>(null), voiceAbort = useRef<AbortController | null>(null), voiceGeneration = useRef(0);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const receivedRequest = useRef(0);
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
  const replyAnchor = useRef(''), started = useRef(false);
  const [startedAt, setStartedAt] = useState(() => new Date());
  const [historyOpen, setHistoryOpen] = useState(false), [sessions, setSessions] = useState<AgentSession[] | null>(null), [historyError, setHistoryError] = useState(''), [historyBusy, setHistoryBusy] = useState(false), [pendingDelete, setPendingDelete] = useState('');
  const sessionId = currentSessionId(messages);
  useEffect(() => {
    let alive = true;
    api<{ configured: boolean; voice: boolean }>('/chat/status')
      .then(status => { if (alive) { setConfigured(status.configured); setVoiceEnabled(status.voice); } })
      .catch(() => { if (alive) { setConfigured(false); setError('无法连接聊天服务，请刷新后重试。'); } });
    // 恢复本浏览器上次打开的对话；对话已删除或不属于当前用户时静默开始新对话。
    const stored = readStoredSession(user.id);
    if (stored) restore(stored, false, true).catch(() => storeSession(user.id, ''));
    return () => { alive = false; };
  }, []);
  async function restore(id: string, scroll = true, onLoad = false) {
    const detail = await api<AgentSessionDetail>(`/agent/sessions/${id}`);
    if (onLoad && started.current) return; // the user already asked something; don't cancel it to reopen the old chat
    controller.current?.abort(); controller.current = null; cancelVoice();
    const restored: Message[] = detail.messages.map(m => ({ id: crypto.randomUUID(), role: m.role, text: m.text, sessionId: id, ...(m.role === 'assistant' ? { events: m.events, trace: m.trace, runId: m.runId, asOf: m.at, sources: ['澄川银行服务端工具结果'] } : {}) }));
    shouldScroll.current = scroll;
    setBusy(false); setError(''); setNotice(detail.handover ? '本对话已转人工客服，如需继续办理请开始新对话' : ''); setDraft('');
    setMessages([...initialMessages(), ...restored]); setStartedAt(new Date(detail.messages[0]?.at || Date.now()));
    storeSession(user.id, id); setHistoryOpen(false);
  }
  async function openHistory() {
    setHistoryOpen(true); setHistoryError(''); setPendingDelete(''); setHistoryBusy(true);
    try { setSessions(await api<AgentSession[]>('/agent/sessions')); } catch (e) { setHistoryError((e as Error).message); } finally { setHistoryBusy(false); }
  }
  async function removeSession(id: string) {
    if (pendingDelete !== id) { setPendingDelete(id); return; }
    setHistoryBusy(true); setHistoryError('');
    try { await api(`/agent/sessions/${id}`, 'DELETE', {}); setSessions(list => (list || []).filter(s => s.id !== id)); setPendingDelete(''); if (id === sessionId) reset(); }
    catch (e) { setHistoryError((e as Error).message); } finally { setHistoryBusy(false); }
  }
  useEffect(() => () => { controller.current?.abort(); recorder.current?.cancel(); voiceAbort.current?.abort(); voiceGeneration.current++; }, []);
  // A new reply is read from its first line, so stop at its top instead of the bottom of the cards.
  // Jump instantly: smooth scrolling never runs while the tab is in the background.
  useEffect(() => {
    if (replyAnchor.current) { document.getElementById(`msg-${replyAnchor.current}`)?.scrollIntoView({ block: 'start' }); replyAnchor.current = ''; shouldScroll.current = false; return; }
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
      if (!active.signal.aborted) { const reply: Message = { ...response, id: crypto.randomUUID(), role: 'assistant' }; replyAnchor.current = reply.id; setMessages([...next, reply]); if (response.sessionId) storeSession(user.id, response.sessionId); await refresh(); }
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
    started.current = true;
    const next: Message[] = [...messages, { id: crypto.randomUUID(), role: 'user', text: content }];
    setMessages(next); setDraft(''); void requestReply(next); input.current?.focus();
  }
  useEffect(() => {
    if (!request || request.id === receivedRequest.current || configured === null || busy) return;
    receivedRequest.current = request.id;
    started.current = true; // Do not let a late session restoration overwrite this request.
    if (configured) send(request.text);
    else { setDraft(request.text); setError('智能助手暂未配置，已保留你的问题。请稍后重试。'); }
  }, [request, configured, busy]);
  function stop() { controller.current?.abort(); controller.current = null; setBusy(false); setNotice('已停止回复'); }
  function reset() {
    cancelVoice();
    controller.current?.abort(); controller.current = null; shouldScroll.current = false;
    setBusy(false); setError(''); setNotice(''); setDraft(''); setMessages(initialMessages()); setStartedAt(new Date());
    storeSession(user.id, '');
    scroller.current?.scrollTo({ top: 0 });
  }
  function cancelVoice() { voiceGeneration.current++; recorder.current?.cancel(); recorder.current = null; voiceAbort.current?.abort(); voiceAbort.current = null; setRecording(false); setVoiceBusy(false); setTranscribing(false); setLevel(0); }
  async function endVoice() {
    const active = recorder.current; if (!active) return; recorder.current = null; setRecording(false); setLevel(0); setTranscribing(true);
    const abort = new AbortController(); voiceAbort.current = abort;
    try { const audio = await active.stop(); const text = await transcribe(audio, abort.signal); if (!abort.signal.aborted) { setDraft(current => current.trim() ? `${current.trimEnd()} ${text}` : text); input.current?.focus(); } }
    catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (voiceAbort.current === abort) { voiceAbort.current = null; setTranscribing(false); } }
  }
  async function beginVoice() {
    setError(''); setSeconds(0); setVoiceBusy(true); const generation = ++voiceGeneration.current;
    try { const r = await startRecording(setSeconds, () => void endVoice(), setLevel); if (generation !== voiceGeneration.current) { r.cancel(); return; } recorder.current = r; setRecording(true); }
    catch (e) { if (generation === voiceGeneration.current) setError((e as Error).message); }
    finally { if (generation === voiceGeneration.current) setVoiceBusy(false); }
  }
  return <section className="assistant-page satin-assistant" aria-label="智能助手">
    <header className="chat-header">
      <button className="icon-button" aria-label="全部服务" onClick={() => navigate('services')}><Menu size={24} strokeWidth={1.8} /></button>
      <div className="chat-title"><h1><AgentMark size={22} />智能助手</h1><span className={`chat-state${configured ? ' on' : ''}`}>{configured === null ? '连接中…' : configured ? '已连接' : '服务暂不可用'}</span></div>
      <div className="chat-header-actions"><button className="icon-button" aria-label="对话历史" onClick={() => void openHistory()}><History size={21} strokeWidth={1.8} /></button><button className="btn-text" onClick={reset}><Plus size={15} />新对话</button></div>
    </header>
    {historyOpen && <Modal title="对话历史" onClose={() => setHistoryOpen(false)}>
      <div className="session-list" role="list" aria-label="历史对话">
        {historyBusy && !sessions && <div className="chat-hint"><LoaderCircle size={15} className="spin" />正在加载…</div>}
        {sessions?.map(s => <div key={s.id} className={`session-row${s.id === sessionId ? ' current' : ''}`} role="listitem">
          <button className="session-main" onClick={() => restore(s.id).catch(e => setHistoryError((e as Error).message))} disabled={historyBusy}><strong>{s.title}</strong><small>{date(s.updated_at)} · {s.turns} 轮{s.id === sessionId ? ' · 当前对话' : ''}{s.handover ? ' · 已转人工' : ''}</small></button>
          <button className={`btn-text${pendingDelete === s.id ? ' danger' : ''}`} onClick={() => void removeSession(s.id)} disabled={historyBusy}>{pendingDelete === s.id ? '确认删除' : '删除'}</button>
        </div>)}
        {sessions && sessions.length === 0 && <Empty title="暂无历史对话" text="发送第一条消息后，对话会自动保存在这里。" />}
        <InlineError message={historyError} />
        <p className="data-note">对话按账户保存在银行服务端；删除后聊天记录不再显示，但操作审计与决策链路仍可在开发者中心查看。</p>
      </div>
    </Modal>}
    <div ref={scroller} className="chat-scroll" role="log" aria-label="对话记录">
      <div className="chat-inner">
        {data.agentLockedUntil && data.agentLockedUntil > new Date().toISOString() && <LockedCard message={`锁定至 ${new Date(data.agentLockedUntil).toLocaleTimeString('zh-CN')}`} />}
        {data.agentActions.filter(a => ['proposed', 'confirmed', 'awaiting_verification'].includes(a.status) && !messages.some(m => m.events?.some(e => e.data?.id === a.id))).map(a => <ActionCard key={a.id} action={a} />)}
        <div className="chat-time">{startedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        <div className="chat-messages">{messages.map(message => <MessageBubble key={message.id} message={message} userName={user.name} onAsk={text => send(text)} />)}</div>
        {messages.length === 1 && <div className="chat-chips" aria-label="常见问题">{quickQuestions.map(text => <button key={text} disabled={!configured} onClick={() => send(text)}>{text}</button>)}</div>}
        {configured === false && !error && <div className="chat-error" role="alert">智能助手暂不可用，请稍后再试。你仍可通过底部导航办理业务。</div>}
        <div role="status" aria-live="polite">{busy && <div className="chat-hint"><LoaderCircle size={15} className="spin" />正在为您查询…</div>}{notice && <div className="chat-hint">{notice}<button onClick={() => void requestReply(messages)}><RotateCcw size={13} />重新生成</button></div>}</div>
        {error && <div className="chat-error" role="alert">{error}{configured && <button onClick={() => void requestReply(messages)}><RotateCcw size={13} />重试</button>}</div>}
        <div ref={bottom} className="scroll-anchor" />
      </div>
    </div>
    <div className="chat-composer">
      <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
        {recording || transcribing ? <div className="voice-field" role="status" aria-live="polite">
          <button type="button" className="voice-cancel" aria-label="取消录音" onClick={cancelVoice}><X size={18} /></button>
          {recording ? <><span className="voice-level" aria-hidden="true">{[0.45, 0.75, 1, 0.75, 0.45].map((k, i) => <i key={i} style={{ height: `${4 + Math.round(level * k * 14)}px` }} />)}</span><span className="voice-time" aria-label={`已录音${seconds}秒`}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span></> : <span className="voice-label">正在识别…</span>}
        </div>
        : <textarea ref={input} aria-label="消息" placeholder="请输入您的问题" value={draft} onChange={event => setDraft(event.target.value)} rows={1} maxLength={4000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />}
        {busy ? <button type="button" className="pill small" onClick={stop} aria-label="停止回复">停止</button>
          : recording ? <button type="button" className="pill primary small voice-button" onClick={() => void endVoice()} aria-label="结束录音并识别"><Square size={16} fill="currentColor" /></button>
          : voiceEnabled && !draft.trim() ? <button type="button" className="pill primary small voice-button" disabled={voiceBusy || transcribing || !configured} onClick={() => void beginVoice()} aria-label="开始语音输入">{voiceBusy || transcribing ? <LoaderCircle size={20} className="spin" /> : <Mic size={20} />}</button>
          : <button type="submit" className="pill primary small" disabled={!draft.trim() || !configured || voiceBusy || transcribing} aria-label="发送消息">发送</button>}
      </form>
    </div>
  </section>;
}
