import { useEffect, useState } from 'react';
import { api } from '../api';
import { useBank } from '../bank';
import { InlineError } from '../ui';
import { EventCards } from '../chat/cards';
import type { AgentEvent } from '../types';

// Opened from the scheduled Feishu/WeChat reports; the numbers come from the same statistics as the message.
export function BillReport() {
  const { route, navigate } = useBank();
  const params = new URLSearchParams(route.split('?')[1] || ''), from = params.get('from') || '', to = params.get('to') || '';
  const fromBills = params.get('origin') === 'bills';
  const [events, setEvents] = useState<AgentEvent[] | null>(null), [range, setRange] = useState({ from, to }), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setEvents(null); setError('');
    api<{ report: any; anomalies: any[] }>(`/ledger/report?${new URLSearchParams({ ...(from && to ? { from, to } : { preset: 'yesterday' }), ...(fromBills ? { origin: 'bills' } : {}) })}`).then(r => {
      if (!cancelled) { setRange({ from: r.report.from, to: r.report.to }); setEvents([{ type: 'report', data: r.report }, { type: 'anomalies', data: r.anomalies }]); }
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [from, to, fromBills]);
  return <div className="page">
    {events ? <EventCards events={events} /> : !error && <p role="status">正在读取账单…</p>}
    <InlineError message={error} />
    {events && <button className="pill" onClick={() => navigate(`ledger?from=${range.from}&to=${range.to}`)}>查看交易记录</button>}
  </div>;
}
