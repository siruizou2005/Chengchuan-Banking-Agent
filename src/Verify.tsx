import { useEffect, useRef, useState } from 'react';
import { Camera, ShieldCheck } from 'lucide-react';
import { api, formValues } from './api';
import { Field, InlineError, Modal, Notice } from './ui';
import { useBank } from './bank';

export function Verify({ actionId, onVerified, onCancel }: { actionId: string; onVerified: (token: string) => void; onCancel: () => void }) {
  const { refresh } = useBank();
  const [id, setId] = useState(''), [step, setStep] = useState<'start' | 'face' | 'sms'>('start');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0);
  const [fallback, setFallback] = useState(''), [inbox, setInbox] = useState<{ id: string; body: string }[]>([]);
  const stream = useRef<MediaStream | null>(null), video = useRef<HTMLVideoElement>(null), alive = useRef(true), timer = useRef<number>(0);
  const stopCamera = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; cancelAnimationFrame(timer.current); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopCamera(); }; }, []);
  async function start() {
    setBusy(true); setError('');
    try { const result = await api<{ id: string }>('/verify/start', 'POST', { actionId }); if (!alive.current) return; setId(result.id); setStep('face'); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { if (alive.current) setBusy(false); }
  }
  async function camera() {
    setBusy(true); setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) { setFallback('unsupported'); return; }
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 320 }, audio: false });
      if (!alive.current) { media.getTracks().forEach(t => t.stop()); return; }
      stream.current = media; video.current!.srcObject = media; await video.current!.play();
      await new Promise<void>(resolve => { const start = performance.now(); const tick = () => { if (!alive.current) return; const n = Math.min(1, (performance.now() - start) / 2000); setProgress(n); if (n === 1) resolve(); else timer.current = requestAnimationFrame(tick); }; tick(); });
      if (!alive.current) return;
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 160;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(video.current!, 0, 0, 160, 160);
      const hash = await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, 160, 160).data);
      await api('/verify/face', 'POST', { id, frameHash: Array.from(new Uint8Array(hash)).map(x => x.toString(16).padStart(2, '0')).join('') });
      if (alive.current) setStep('sms');
    } catch (e) { if (e instanceof DOMException) setFallback(e.name === 'NotAllowedError' ? 'denied' : 'unavailable'); else setError((e as Error).message); }
    finally { stopCamera(); if (alive.current) setBusy(false); }
  }
  async function skip() { setBusy(true); try { await api('/verify/face', 'POST', { id, skipped: true, reason: fallback }); setStep('sms'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Modal title="App 加强验证" onClose={onCancel}><div className="stack-form verify-flow">
    <div className="verify-steps"><span className={step !== 'sms' ? 'active' : ''}>1 人脸演示</span><span className={step === 'sms' ? 'active' : ''}>2 短信验证码</span><span>3 支付密码</span></div>
    <Notice>演示模拟：摄像头仅采集本地画面摘要，不进行真实生物识别。短信验证码投递至本站消息中心。</Notice>
    {step === 'start' && <button className="btn-primary" disabled={busy} onClick={start}><ShieldCheck size={18} />开始验证并发送模拟短信</button>}
    {step === 'face' && <><div className="face-preview" style={{ '--progress': `${progress * 360}deg` } as React.CSSProperties}><video ref={video} muted playsInline aria-label="摄像头预览" /><span>{progress ? `${Math.round(progress * 100)}%` : '人脸模拟 · 2秒'}</span></div><p className="footnote">请面向摄像头，缓慢眨眼。此步骤仅演示验证流程。</p>{fallback ? <><Notice>摄像头不可用或未获授权，可以降级为短信验证；系统将记录此情况。</Notice><button className="btn-primary" disabled={busy} onClick={skip}>记录降级并继续短信验证</button></> : <button className="btn-primary" disabled={busy} onClick={camera}><Camera size={18} />{busy ? '正在采集…' : '开启摄像头并采集'}</button>}</>}
    {step === 'sms' && <form className="stack-form" onSubmit={async e => { const { code } = formValues(e); setBusy(true); setError(''); try { const result = await api<{ verificationToken: string }>('/verify/complete', 'POST', { id, code }); onVerified(result.verificationToken); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><Field label="短信验证码" hint="6位数字，5分钟有效"><input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" /></Field><button type="button" className="btn-text" onClick={async () => { try { setInbox((await api<{ id: string; title: string; body: string }[]>('/notifications')).filter(n => n.title === '模拟短信验证码').slice(0, 3)); } catch (e) { setError((e as Error).message); } }}>打开模拟短信收件箱</button>{inbox.map(n => <Notice key={n.id}>{n.body}</Notice>)}<button className="btn-primary" disabled={busy}>验证短信，继续支付密码</button></form>}
    <InlineError message={error} />
  </div></Modal>;
}
