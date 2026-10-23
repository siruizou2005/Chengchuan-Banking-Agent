import { useEffect, useState } from 'react';
import { AgentMark } from '../AgentMark';
import { api, date } from '../api';
import { Card, Empty, Field, Notice } from '../ui';
import { useBank } from '../bank';

type Memory = { memory_id: string; key: string; value: string; status: string; version: number; source_channel: string; updated_at: string; expires_at: string | null };
type View = { enabled: boolean; profile: Record<string, string>; memories: Memory[] };
type Hypothesis = { hypothesis_id: string; hypothesis: string; status: string; version: number; evidence_count: number; session_count: number };
const labels: Record<string, string> = { language: '回答语言', answer_length: '回答长度', analysis_style: '分析方式', markets: '关注市场', sectors: '关注行业', watchlist: '关注资产或主题', investment_goal: '投资目标', investment_horizon: '投资期限' };
const states: Record<string, string> = { active: '已确认', candidate: '待确认', expired: '已过期' };

export function Personalization() {
  const { data: account, toast } = useBank();
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [key, setKey] = useState('answer_length'), [value, setValue] = useState('简短'), [editing, setEditing] = useState<Memory | null>(null);
  const load = () => Promise.all([api<View>('/agent/memory'), api<Hypothesis[]>('/agent/memory/behavior')]);
  const refresh = () => load().then(([v, h]) => { setView(v); setHypotheses(h); });
  useEffect(() => { let current = true; load().then(([v, h]) => { if (current) { setView(v); setHypotheses(h); } }).catch(e => { if (current) setError(e.message); }); return () => { current = false; }; }, [account.user.id]);
  async function save(path: string, method: string, body: unknown) {
    if (busy) return;
    setBusy(true); setError('');
    try { await api(path, method, body); await refresh(); setEditing(null); toast('记忆已更新'); }
    catch (e) { setError((e as Error).message); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  const selectKey = (next: string) => { setKey(next); setValue(next === 'language' ? '中文' : next === 'answer_length' ? '简短' : ''); };
  const currentKey = editing?.key || key;
  return <div className="page">
    <Notice>已绑定的微信、飞书和App共享你的长期偏好，各渠道的短期对话独立。关注资产不代表持有资产，投资目标不替代风险测评。</Notice>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {!view && !error && <p role="status">正在读取记忆…</p>}
    {view && !view.enabled && <Notice>个性化已关闭，记忆不会用于回答。你仍可查看或删除已保存的信息。</Notice>}
    {view?.enabled && <Card title={editing ? '纠正记忆' : '设置回答偏好'}>
      <form className="stack-form" onSubmit={e => { e.preventDefault(); void save(editing ? `/agent/memory/${editing.memory_id}` : '/agent/memory', editing ? 'PATCH' : 'POST', editing ? { value, version: editing.version } : { key, value }); }}>
        {!editing && <Field label="偏好类别"><select aria-label="偏好类别" value={key} onChange={e => selectKey(e.target.value)}>{Object.entries(labels).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></Field>}
        <Field label={labels[currentKey] || currentKey}>
          {['language', 'answer_length'].includes(currentKey)
            ? <select aria-label="偏好内容" value={value} onChange={e => setValue(e.target.value)}>{(currentKey === 'language' ? ['中文', 'English'] : ['简短', '详细']).map(v => <option key={v}>{v}</option>)}</select>
            : <input aria-label="偏好内容" name="memoryValue" value={value} onChange={e => setValue(e.target.value)} maxLength={300} required />}
        </Field>
        <button className="btn-primary" disabled={busy}>{busy ? '正在保存…' : '保存并确认'}</button>
        {editing && <button type="button" className="pill" onClick={() => { setEditing(null); selectKey(key); }}>取消修改</button>}
      </form>
    </Card>}
    <Card head={<h2 className="card-title memory-brand"><AgentMark size={22} />已保存记忆与候选</h2>}>
      {view?.memories.map(m => <article className="memory-item" key={m.memory_id}>
        <div className="memory-heading"><strong>{labels[m.key] || m.key}</strong><span className="tag gray">{states[m.status] || m.status}</span></div>
        <p>{m.value}</p>
        <small className="muted">来源：{({ app: 'App', wechat: '微信', feishu: '飞书', legacy: '历史记忆' } as Record<string, string>)[m.source_channel] || m.source_channel} · {date(m.updated_at)}{m.expires_at && ` · 有效至 ${date(m.expires_at)}`}</small>
        <div className="memory-actions">
          {view.enabled && m.status === 'candidate' && <button className="pill" disabled={busy} onClick={() => void save(`/agent/memory/${m.memory_id}/confirm`, 'POST', { version: m.version })}>确认记忆</button>}
          {view.enabled && <button className="pill" disabled={busy} onClick={() => { setEditing(m); setValue(m.value); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>修改</button>}
          <button className="pill" disabled={busy} onClick={() => void save(`/agent/memory/${m.memory_id}`, 'DELETE', { version: m.version })}>删除</button>
        </div>
      </article>)}
      {view?.memories.length === 0 && <Empty title="还没有保存的记忆" />}
    </Card>
    <Card title="从互动中发现的偏好">
      <p className="muted">这些是尚未确认的展示建议，仅用于调整讲解方式。你可以确认或拒绝；它们不代表你的风险承受能力。</p>
      {hypotheses.filter(h => ['observing', 'tentative', 'contested'].includes(h.status)).map(h => <article className="memory-item" key={h.hypothesis_id}>
        <div className="memory-heading"><strong>{h.hypothesis}</strong><span className="tag gray">{h.status === 'tentative' ? '待你确认' : h.status === 'contested' ? '存在不同反馈' : '继续观察'}</span></div>
        <p className="muted">来自 {h.session_count} 段对话中的 {h.evidence_count} 次观察。</p>
        <div className="memory-actions">
          {view?.enabled && h.status === 'tentative' && <button className="pill" disabled={busy} onClick={() => void save(`/agent/memory/behavior/${h.hypothesis_id}/feedback`, 'POST', { action: 'confirm', version: h.version })}>确认这个偏好</button>}
          <button className="pill" disabled={busy} onClick={() => void save(`/agent/memory/behavior/${h.hypothesis_id}/feedback`, 'POST', { action: 'reject', version: h.version })}>拒绝这个推断</button>
        </div>
      </article>)}
      {!hypotheses.some(h => ['observing', 'tentative', 'contested'].includes(h.status)) && <Empty title="暂无待确认的行为偏好" />}
    </Card>
    <p className="footnote">删除后立即停止使用该项记忆，并清除相关短期上下文和衍生偏好。历史对话与银行操作审计仍保留。</p>
  </div>;
}
