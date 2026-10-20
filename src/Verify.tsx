import { useEffect, useRef, useState } from 'react';
import { Camera, ShieldCheck } from 'lucide-react';
import { api, formValues } from './api';
import { Field, InlineError, Modal, Notice } from './ui';
import { useBank } from './bank';

type IdentityProfile = { enrolled: boolean; required: boolean; channel: string; maskedName?: string; maskedIdNumber?: string };

export type Delivery = { simulated: boolean; channel: string; target?: string; demoCode?: string; reason?: string };
export const deliveryText = (d: Delivery | null) => !d ? '开始验证后将提示验证码接收方式。' : d.demoCode ? '演示账户的验证码直接显示在下一步。' : d.channel === 'resend_email' ? `验证码已发送至邮箱 ${d.target}，请查收（可能在垃圾邮件中）。` : d.simulated ? '验证码已投递至本站消息中心。' : '验证码已发送至您的注册手机号。';
// Demo accounts have reserved example.com addresses, so the code is shown here instead of being mailed.
export function DemoCode({ delivery }: { delivery: Delivery | null }) {
  if (!delivery?.demoCode) return null;
  return <div className="demo-code"><small>演示验证码</small><b>{delivery.demoCode}</b><p>{delivery.reason === 'demo_email' ? '这只是演示：example.com 等演示邮箱收不到邮件，验证码直接显示在这里。登记真实邮箱的账户会收到真实的邮件验证码。' : '当前未接入邮件发送服务，验证码直接显示在这里，仅供演示。'}</p></div>;
}

export function Verify({ actionId, onVerified, onCancel }: { actionId: string; onVerified: (token: string) => void; onCancel: () => void }) {
  const { refresh } = useBank();
  const [id, setId] = useState(''), [step, setStep] = useState<'start' | 'face' | 'sms'>('start');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0);
  const [fallback, setFallback] = useState('');
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [identity, setIdentity] = useState<IdentityProfile | null>(null);
  const [faceChannel, setFaceChannel] = useState('simulated_face');
  const [faceLink, setFaceLink] = useState<{ sessionId: string; url: string } | null>(null);
  const stream = useRef<MediaStream | null>(null), video = useRef<HTMLVideoElement>(null), alive = useRef(true), timer = useRef<number>(0);
  const stopCamera = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; cancelAnimationFrame(timer.current); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopCamera(); }; }, []);
  useEffect(() => {
    let active = true;
    api<IdentityProfile>('/verify/identity').then(value => { if (active) { setIdentity(value); setFaceChannel(value.channel); } }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, []);
  async function start() {
    setBusy(true); setError('');
    try { const result = await api<Delivery & { id: string; faceChannel: string }>('/verify/start', 'POST', { actionId }); if (!alive.current) return; setId(result.id); setDelivery(result); setFaceChannel(result.faceChannel); setStep('face'); await refresh(); }
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
  async function startFace() {
    setBusy(true); setError('');
    try { const value = await api<{ sessionId: string; url: string }>('/verify/face/start', 'POST', { id }); if (alive.current) setFaceLink(value); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function checkFace() {
    if (!faceLink) return;
    setBusy(true); setError('');
    try {
      const value = await api<{ status: string }>(`/verify/face/sessions/${encodeURIComponent(faceLink.sessionId)}`);
      if (!alive.current) return;
      if (value.status === 'passed') setStep('sms');
      else setError(['pending', 'checking'].includes(value.status) ? '请先在核身页面完成刷脸，并等待返回页面确认结果。' : '核身未通过或已结束，请关闭后重新开始验证。');
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Modal title="App 加强验证" onClose={onCancel}><div className="stack-form verify-flow">
    <div className="verify-steps"><span className={step !== 'sms' ? 'active' : ''}>1 {faceChannel === 'tencent_face' ? '人脸核身' : '人脸演示'}</span><span className={step === 'sms' ? 'active' : ''}>2 {delivery?.channel === 'resend_email' ? '邮箱验证码' : '验证码'}</span><span>3 支付密码</span></div>
    <Notice>{faceChannel === 'tencent_face' ? '人脸核身将通过专用页面完成，本站不保存人脸照片。' : '摄像头仅采集本地画面摘要，不进行真实生物识别。'}{deliveryText(delivery)}</Notice>
    {step === 'start' && identity?.required && <form className="stack-form" autoComplete="off" onSubmit={async e => {
      const form = e.currentTarget, fields = formValues(e); setBusy(true); setError('');
      try { const value = await api<IdentityProfile>('/verify/identity', 'POST', { realName: fields.realName, idNumber: fields.idNumber }); form.reset(); if (alive.current) setIdentity(value); }
      catch (e) { if (alive.current) setError((e as Error).message); }
      finally { form.reset(); if (alive.current) setBusy(false); }
    }}>
      <Notice>首次核身需录入本人真实姓名与身份证号，用于核对本次刷脸结果。提交后仅显示脱敏信息，暂不支持自行修改。</Notice>
      <Field label="真实姓名"><input name="realName" required maxLength={50} autoComplete="off" /></Field>
      <Field label="身份证号" hint="仅用于身份核验，加密保存"><input name="idNumber" type="password" required minLength={18} maxLength={18} pattern="[0-9]{17}[0-9Xx]" autoComplete="off" /></Field>
      <button className="btn-primary" disabled={busy}>保存实名资料</button>
    </form>}
    {step === 'start' && identity && !identity.required && <>{faceChannel === 'tencent_face' && identity.enrolled && <Notice>{identity.maskedName} · {identity.maskedIdNumber}</Notice>}<button className="btn-primary" disabled={busy} onClick={start}><ShieldCheck size={18} />开始验证并发送验证码</button></>}
    {step === 'face' && faceChannel === 'tencent_face' && <><Notice>请在新打开的核身页面完成刷脸。返回后由服务器核对结果，再回到此页继续。验证码仍为5分钟有效。</Notice>{faceLink ? <><a className="btn-primary" href={faceLink.url} target="_blank" rel="noopener noreferrer">前往人脸核身</a><button className="btn-primary" disabled={busy} onClick={checkFace}>已返回，继续验证</button></> : <button className="btn-primary" disabled={busy} onClick={startFace}>准备人脸核身</button>}</>}
    {step === 'face' && faceChannel === 'simulated_face' && <><div className="face-preview" style={{ '--progress': `${progress * 360}deg` } as React.CSSProperties}><video ref={video} muted playsInline aria-label="摄像头预览" /><span>{progress ? `${Math.round(progress * 100)}%` : '人脸模拟 · 2秒'}</span></div><p className="footnote">请面向摄像头，缓慢眨眼。此步骤仅演示验证流程。</p>{fallback ? <><Notice>摄像头不可用或未获授权，可以降级为短信验证；系统将记录此情况。</Notice><button className="btn-primary" disabled={busy} onClick={skip}>记录降级并继续短信验证</button></> : <button className="btn-primary" disabled={busy} onClick={camera}><Camera size={18} />{busy ? '正在采集…' : '开启摄像头并采集'}</button>}</>}
    {step === 'sms' && <form className="stack-form" onSubmit={async e => { const { code } = formValues(e); setBusy(true); setError(''); try { const result = await api<{ verificationToken: string }>('/verify/complete', 'POST', { id, code }); onVerified(result.verificationToken); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><DemoCode delivery={delivery} /><Field label={delivery?.channel === 'resend_email' ? '邮箱验证码' : '验证码'} hint="6位数字，5分钟有效"><input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" /></Field><button className="btn-primary" disabled={busy}>验证并继续输入支付密码</button></form>}
    <InlineError message={error} />
  </div></Modal>;
}
