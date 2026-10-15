import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { InlineError, Notice } from '../ui';
import { useBank } from '../bank';

export function FaceReturn() {
  const { route, navigate } = useBank();
  const query = new URLSearchParams(route.split('?')[1] || '');
  const sessionId = query.get('sessionId') || '', state = query.get('state') || '';
  const [status, setStatus] = useState('checking'), [error, setError] = useState('');
  const request = useRef<{ key: string; promise: Promise<string> } | null>(null);
  async function check() {
    if (!sessionId || !state) throw new Error('核身返回信息不完整，请返回原页面重新开始验证。');
    const current = await api<{ status: string }>(`/verify/face/sessions/${encodeURIComponent(sessionId)}`);
    if (current.status !== 'pending') return current.status;
    return (await api<{ status: string }>('/verify/face/result', 'POST', { sessionId, state })).status;
  }
  useEffect(() => {
    let active = true;
    const key = sessionId + ':' + state;
    if (request.current?.key !== key) request.current = { key, promise: check() };
    request.current.promise.then(value => { if (active) setStatus(value); }).catch(e => { if (active) { setError((e as Error).message); setStatus('failed'); } });
    return () => { active = false; };
  }, [sessionId, state]);
  return <div className="page stack-form">
    <Notice>{status === 'passed' ? '人脸核身已通过。请返回原来的验证页面，继续输入验证码和支付密码。' : status === 'pending' ? '核身结果尚未就绪，请稍后再次查询。' : status === 'checking' ? '正在由服务器核对核身结果…' : '本次核身未完成，请返回原页面重新开始验证。'}</Notice>
    {status === 'pending' && <button className="btn-primary" onClick={async () => { setStatus('checking'); setError(''); try { setStatus(await check()); } catch (e) { setError((e as Error).message); setStatus('failed'); } }}>再次查询</button>}
    {status === 'passed' && <button className="btn-primary" onClick={() => window.close()}>关闭此页，返回原验证页面</button>}
    <button className="btn-text" onClick={() => navigate('tasks')}>查看操作与计划</button>
    <InlineError message={error} />
  </div>;
}
