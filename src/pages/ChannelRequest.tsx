import { useEffect, useState } from 'react';
import { api } from '../api';
import { useBank } from '../bank';
import { Card, InlineError, Notice } from '../ui';
import { EventCards } from '../chat/cards';
import { Markdown } from '../chat/Markdown';
import type { AgentEvent } from '../types';

type RequestResult = { status: string; result: { text: string; events: AgentEvent[] } | null; deliveries: { kind: string; status: string; needs_review: number }[] };
const states: Record<string, string> = { queued: '请求已收到，等待处理', running: '正在处理，请稍等', completed: '结果已生成', failed: '本次处理未完成', interrupted: '处理已中断', cancelled: '请求已停止' };
export function ChannelRequest() {
  const { route, navigate } = useBank();
  const requestId = route.split('/')[1]?.split('?')[0];
  const [result, setResult] = useState<RequestResult | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    setResult(null); setError('');
    async function poll() {
      try { const data = await api<RequestResult>(`/channels/wechat/requests/${encodeURIComponent(requestId || '')}`); if (cancelled) return; setResult(data); if (['queued', 'running'].includes(data.status) || data.deliveries.some(d => ['pending', 'sending', 'retry_wait'].includes(d.status))) timer = setTimeout(poll, 2000); }
      catch (e) { if (!cancelled) setError((e as Error).message); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [requestId]);
  const final = result?.deliveries.filter(d => !['ack', 'progress'].includes(d.kind));
  return <div className="page"><Card title="微信请求结果">
    <p role="status">{result ? states[result.status] || '请查看处理结果' : error ? '无法查看该请求' : '正在读取请求…'}</p>
    {final?.some(d => ['unknown', 'failed', 'expired'].includes(d.status)) && <Notice>结果保存在 App，微信送达暂未确认。无需重复提交业务。</Notice>}
    {final?.some(d => d.status === 'api_accepted') && <p className="data-note">回复已提交给微信；此状态不代表手机已收到。</p>}
    {result?.result && <><Markdown text={result.result.text} /><EventCards events={result.result.events || []} /></>}
    <InlineError message={error} /><button className="pill" onClick={() => navigate('channels')}>返回消息渠道绑定</button>
  </Card></div>;
}
