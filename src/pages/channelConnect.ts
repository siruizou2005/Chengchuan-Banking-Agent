import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '../api';

// 「消息渠道绑定」页和智能助手首次引导共用的扫码绑定流程：页面可见时轮询，切到后台暂停，回来立即恢复。
export type WeChatLogin = { id: string; image: string; status: string; message: string; expiresAt: string };
export const LOGIN_FINISHED = new Set(['confirmed', 'expired', 'failed', 'cancelled']);
export const FEISHU_STATUS: Record<string, string> = { wait: '请用飞书扫码，并在飞书里确认创建', confirmed: '创建成功，已自动绑定。去飞书里和它打个招呼吧', denied: '你已取消创建', expired: '二维码已过期，请重新生成', failed: '创建失败，请稍后重试' };

function visiblePoll(step: () => Promise<boolean>, interval: number) {
  let cancelled = false, running = false; let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    timer = undefined; if (cancelled || running || document.hidden) return; running = true;
    let more = false;
    try { more = await step(); } finally { running = false; }
    if (!cancelled && more) timer = setTimeout(poll, interval);
  }
  const resume = () => { if (!document.hidden && !timer) void poll(); };
  document.addEventListener('visibilitychange', resume); void poll();
  return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
}

export function useWeChatLogin(onConfirmed: () => unknown) {
  const [login, setLogin] = useState<WeChatLogin | null>(null), [message, setMessage] = useState(''), [error, setError] = useState('');
  const confirmed = useRef(onConfirmed); confirmed.current = onConfirmed;
  useEffect(() => {
    if (!login || LOGIN_FINISHED.has(login.status)) return;
    const id = login.id;
    return visiblePoll(async () => {
      try {
        const result = await api<Omit<WeChatLogin, 'image'>>(`/channels/wechat/qr/${id}`);
        setLogin(current => current?.id === id ? { ...current, ...result } : current); setMessage(result.message); setError('');
        if (result.status === 'confirmed') await confirmed.current();
        return !LOGIN_FINISHED.has(result.status);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { setLogin(current => current ? { ...current, status: 'expired' } : current); setMessage('二维码已过期，请重新生成。'); return false; }
        setError('暂时无法读取连接状态，正在重试。'); return true;
      }
    }, 1500);
  }, [login?.id, login?.status]);
  async function start(pin: string) {
    const result = await api('/channels/wechat/qr', 'POST', { pin });
    setLogin({ ...result, image: await QRCode.toDataURL(result.qrcode_img_content, { width: 260, margin: 2 }) }); setMessage(result.message); setError('');
  }
  async function cancel() {
    if (!login) return;
    const result = await api(`/channels/wechat/qr/${login.id}`, 'DELETE', {});
    setLogin(current => current ? { ...current, ...result } : current); setMessage('已取消连接。');
  }
  async function verify(code: string) { await api(`/channels/wechat/qr/${login!.id}/verify`, 'POST', { code }); setMessage('验证码已提交，正在完成连接。'); }
  return { login, message, error, waiting: Boolean(login && !LOGIN_FINISHED.has(login.status)), start, cancel, verify };
}

export function useFeishuBot(onConfirmed: () => unknown) {
  const [bot, setBot] = useState<{ id: string; image: string; url: string } | null>(null), [status, setStatus] = useState('');
  const confirmed = useRef(onConfirmed); confirmed.current = onConfirmed;
  useEffect(() => {
    if (!bot) return;
    return visiblePoll(async () => {
      try {
        const result = await api(`/channels/feishu/register/${bot.id}`);
        setStatus(result.status === 'failed' ? result.error || FEISHU_STATUS.failed : FEISHU_STATUS[result.status] || result.status);
        if (result.status === 'confirmed') await confirmed.current();
        if (result.status !== 'wait') { setBot(null); return false; }
      } catch (e) { if (e instanceof ApiError && e.status === 404) { setStatus(FEISHU_STATUS.expired); setBot(null); return false; } }
      return true;
    }, 3000);
  }, [bot]);
  async function start(pin: string) {
    const result = await api('/channels/feishu/register', 'POST', { pin });
    setBot({ id: result.id, url: result.url, image: await QRCode.toDataURL(result.url, { width: 260, margin: 2 }) }); setStatus(FEISHU_STATUS.wait);
  }
  return { bot, status, start };
}

// 银行飞书机器人的5分钟绑定码：用户在飞书里发送后，这里查到新的飞书绑定即视为完成。
export function useFeishuCode(onBound: () => unknown) {
  const [code, setCode] = useState<{ value: string; known: string[]; until: number } | null>(null);
  const bound = useRef(onBound); bound.current = onBound;
  useEffect(() => {
    if (!code) return;
    return visiblePoll(async () => {
      if (Date.now() > code.until) { setCode(null); return false; }
      const list = await api<{ id: string; channel: string; status: string }[]>('/channels').catch(() => []);
      if (list.some(b => b.channel === 'feishu' && b.status === 'active' && !code.known.includes(b.id))) { setCode(null); await bound.current(); return false; }
      return true;
    }, 3000);
  }, [code]);
  async function create(pin: string) {
    const known = (await api<{ id: string; channel: string; status: string }[]>('/channels')).filter(b => b.channel === 'feishu' && b.status === 'active').map(b => b.id);
    const result = await api('/channels/code', 'POST', { pin });
    setCode({ value: result.code, known, until: Date.now() + result.expiresIn * 1000 });
  }
  return { code: code?.value || '', create };
}
