import { useEffect, useState } from 'react';
import { api, formValues, date } from '../api';
import { useBank } from '../bank';
import { Card, Field, InlineError, Notice, PinField } from '../ui';
import { ChannelAmountSetting } from './ChannelAmountSetting';
import { ChannelReportSetting } from './ChannelReportSetting';
import { useWeChatLogin } from './channelConnect';

type RequestRow = { id: string; status: string; received_at: number };
export function WeChatChannel({ enabled, closed = false }: { enabled: boolean; closed?: boolean }) {
  const { data, refresh, navigate } = useBank();
  const wechat = useWeChatLogin(refresh), { login, message } = wechat;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [requests, setRequests] = useState<RequestRow[]>([]);
  const binding = data.bindings.find(b => b.channel === 'wechat' && b.status === 'active');
  const connected = binding?.auth_state === 'valid';
  useEffect(() => { api<RequestRow[]>('/channels/wechat/requests').then(setRequests).catch(() => {}); }, [data.bindings]);
  async function create(pin: string) {
    setBusy(true); setError('');
    try { await wechat.start(pin); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!login) return; setBusy(true);
    try { await wechat.cancel(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Card title="微信助手">
    <p className="body-copy">用微信扫码连接银行助手。收到请求后会先回应，处理较久时会提示进度；查询结果直接回复到微信，业务确认请回 App 完成。</p>
    <ChannelAmountSetting channel="wechat" />
    <ChannelReportSetting channel="wechat" />
    {connected ? <Notice>微信已绑定。{binding?.last_inbound_at ? '已收到你的微信消息。' : '请在微信给助手发送“你好”验证连接。'}</Notice> : <form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void create(f.pin); }}>
      {binding && <Notice>微信需要重新认证，请重新扫码连接。已有业务结果可在 App 查看。</Notice>}
      {!enabled && <Notice>微信渠道尚未开启。</Notice>}
      <PinField /><button className="btn-primary" disabled={busy || !enabled || closed || wechat.waiting}>{binding ? '重新认证微信' : '连接我的微信助手'}</button>
    </form>}
    {login && wechat.waiting && <div className="channel-qr"><img src={login.image} width="260" height="260" alt="微信助手绑定二维码" /><p>请用支持微信助手功能的微信扫码，并在微信中确认。</p><p className="data-note">有效期至 {date(login.expiresAt)}</p><button className="pill" onClick={() => void cancel()} disabled={busy}>取消本次连接</button></div>}
    {login?.status === 'awaiting_code' && <form className="stack-form form-card" onSubmit={async e => {
      const form = e.currentTarget, f = formValues(e); setBusy(true); setError('');
      try { await wechat.verify(f.code); form.reset(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}><Field label="微信扫码验证码"><input name="code" required maxLength={32} autoComplete="one-time-code" /></Field><p className="data-note">填写微信扫码页面显示的验证码，不是银行支付密码或短信验证码。</p><button className="btn-primary" disabled={busy}>提交验证码</button></form>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    {binding?.last_api_accepted_at && <p className="data-note">最近回复已提交给微信：{date(new Date(binding.last_api_accepted_at).toISOString())}。此状态不代表手机已收到。</p>}
    {requests.length > 0 && <details><summary>最近的微信请求与结果</summary>{requests.map(r => <button className="agent-list-row" key={r.id} onClick={() => navigate(`wechat-requests/${r.id}`)}>{date(new Date(r.received_at).toISOString())} · 查看处理结果</button>)}</details>}
    <InlineError message={error || wechat.error} />
  </Card>;
}
