import { useEffect, useState } from 'react';
import { api } from '../api';
import { useBank } from '../bank';
import { Notice } from '../ui';
import { AdviceCard } from '../chat/AdviceCard';
import type { Advice as AdviceData } from '../types';

export function Advice() {
  const { navigate } = useBank();
  const [advice, setAdvice] = useState<AdviceData | null>(null), [error, setError] = useState('');
  useEffect(() => { api<AdviceData>('/wealth/advice').then(setAdvice).catch(e => setError(e instanceof Error ? e.message : '暂时无法生成配置建议')); }, []);
  return <div className="page advice-page">
    {!advice && !error && <Notice>正在根据账户收支、应急资金和风险测评生成建议…</Notice>}
    {error && <Notice>{error}</Notice>}
    {advice && <AdviceCard initial={advice} />}
    <button className="btn-text" onClick={() => navigate('assistant')}>有疑问？问问智能助手</button>
  </div>;
}
