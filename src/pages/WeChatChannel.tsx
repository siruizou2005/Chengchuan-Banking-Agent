import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, formValues, date } from '../api';
import { useBank } from '../bank';
import { Card, Field, InlineError, Notice, PinField } from '../ui';
import { ChannelAmountSetting } from './ChannelAmountSetting';

type Login = { id: string; image: string; status: string; message: string; expiresAt: string };
type RequestRow = { id: string; status: string; received_at: number };
const finished = new Set(['confirmed', 'expired', 'failed', 'cancelled']);
export function WeChatChannel({ enabled, closed = false }: { enabled: boolean; closed?: boolean }) {
  const { data, refresh, navigate } = useBank();
  const [login, setLogin] = useState<Login | null>(null), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [requests, setRequests] = useState<RequestRow[]>([]);
  const binding = data.bindings.find(b => b.channel === 'wechat' && b.status === 'active');
  const connected = binding?.auth_state === 'valid';
  useEffect(() => { api<RequestRow[]>('/channels/wechat/requests').then(setRequests).catch(() => {}); }, [data.bindings]);
  useEffect(() => {
    if (!login || finished.has(login.status)) return;
    let cancelled = false, running = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      timer = undefined; if (cancelled || running || document.hidden) return; running = true;
      try {
        const result = await api<Omit<Login, 'image'>>(`/channels/wechat/qr/${login!.id}`);
        if (cancelled) return;
        setLogin(current => current?.id === login!.id ? { ...current, ...result } : current);
        setMessage(result.message);
        if (result.status === 'confirmed') await refresh();
        if (finished.has(result.status)) return;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setLogin(current => current ? { ...current, status: 'expired' } : current); setMessage('二维码已过期，请重新生成。'); return;
        }
        setError('暂时无法读取连接状态，正在重试。');
      } finally { running = false; }
      if (!cancelled) timer = setTimeout(poll, 1500);
    }
    const resume = () => { if (!document.hidden && !timer) void poll(); };
    document.addEventListener('visibilitychange', resume); void poll();
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [login?.id, login?.status, refresh]);
  async function create(pin: string) {
    setBusy(true); setError('');
    try {
      const result = await api('/channels/wechat/qr', 'POST', { pin });
      setLogin({ ...result, image: await QRCode.toDataURL(result.qrcode_img_content, { width: 260, margin: 2 }) }); setMessage(result.message);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!login) return; setBusy(true);
    try { const result = await api(`/channels/wechat/qr/${login.id}`, 'DELETE', {}); setLogin(current => current ? { ...current, ...result } : current); setMessage('已取消连接。'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Card title="微信助手">
    <p className="body-copy">用微信扫码连接银行助手。收到请求后会先回应，处理较久时会提示进度；查询结果直接回复到微信，业务确认请回 App 完成。</p>
    <ChannelAmountSetting channel="wechat" />
    {connected ? <Notice>微信已绑定。{binding?.last_inbound_at ? '已收到你的微信消息。' : '请在微信给助手发送“你好”验证连接。'}</Notice> : <form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void create(f.pin); }}>
      {binding && <Notice>微信需要重新认证，请重新扫码连接。已有业务结果可在 App 查看。</Notice>}
      {!enabled && <Notice>微信渠道尚未开启。</Notice>}
      <PinField /><button className="btn-primary" disabled={busy || !enabled || closed || Boolean(login && !finished.has(login.status))}>{binding ? '重新认证微信' : '连接我的微信助手'}</button>
    </form>}
    {login && !finished.has(login.status) && <div className="channel-qr"><img src={login.image} width="260" height="260" alt="微信助手绑定二维码" /><p>请用支持微信助手功能的微信扫码，并在微信中确认。</p><p className="data-note">有效期至 {date(login.expiresAt)}</p><button className="pill" onClick={() => void cancel()} disabled={busy}>取消本次连接</button></div>}
    {login?.status === 'awaiting_code' && <form className="stack-form form-card" onSubmit={async e => {
      const form = e.currentTarget, f = formValues(e); setBusy(true); setError('');
      try { await api(`/channels/wechat/qr/${login.id}/verify`, 'POST', { code: f.code }); setMessage('验证码已提交，正在完成连接。'); form.reset(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}><Field label="微信扫码验证码"><input name="code" required maxLength={32} autoComplete="one-time-code" /></Field><p className="data-note">填写微信扫码页面显示的验证码，不是银行支付密码或短信验证码。</p><button className="btn-primary" disabled={busy}>提交验证码</button></form>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    {binding?.last_api_accepted_at && <p className="data-note">最近回复已提交给微信：{date(new Date(binding.last_api_accepted_at).toISOString())}。此状态不代表手机已收到。</p>}
    {requests.length > 0 && <details><summary>最近的微信请求与结果</summary>{requests.map(r => <button className="agent-list-row" key={r.id} onClick={() => navigate(`wechat-requests/${r.id}`)}>{date(new Date(r.received_at).toISOString())} · 查看处理结果</button>)}</details>}
    <InlineError message={error} />
  </Card>;
}
