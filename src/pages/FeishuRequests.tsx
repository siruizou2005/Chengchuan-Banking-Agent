import { useEffect, useState } from 'react';
import { api } from '../api';
import { useBank } from '../bank';
import { Card, InlineError } from '../ui';

type RequestRow = { id: string; status: string; received_at: number };
const states: Record<string, string> = { queued: '等待处理', running: '正在处理', completed: '查看结果', failed: '处理未完成', interrupted: '处理中断', cancelled: '已停止' };
export function FeishuRequests() {
  const { navigate } = useBank();
  const [rows, setRows] = useState<RequestRow[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!document.hidden) {
        try { const data = await api<RequestRow[]>('/channels/feishu/requests'); if (!cancelled) { setRows(data); setError(''); } }
        catch (e) { if (!cancelled) setError((e as Error).message); }
      }
      if (!cancelled) timer = setTimeout(refresh, 5000);
    }
    void refresh(); return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  if (!rows.length && !error) return null;
  return <Card title="最近的飞书请求"><p className="data-note">飞书回复暂未收到时，可在这里查看结果，无需重复提交业务。</p>{rows.slice(0, 10).map(row => <button className="pill" key={row.id} onClick={() => navigate(`feishu-requests/${row.id}`)}>{new Date(row.received_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {states[row.status] || '查看请求'}</button>)}<InlineError message={error} /></Card>;
}
