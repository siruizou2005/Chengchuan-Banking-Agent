import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { FeishuRequests } from './FeishuRequests';
import { ChannelAmountSetting } from './ChannelAmountSetting';
import { ChannelReportSetting } from './ChannelReportSetting';
import { useFeishuBot, useFeishuCode, useWeChatLogin } from './channelConnect';
import { ServiceArtwork } from '../DesignAssets';
import { api, formValues, date } from '../api';
import { useBank } from '../bank';
import { Card, Field, InlineError, Notice, PinField } from '../ui';
import type { ChannelName, Snapshot } from '../types';

type Enabled = { feishu: boolean; feishuPersonal: boolean; wechat: boolean };
type Binding = Snapshot['bindings'][number];
const NAME: Record<ChannelName, string> = { feishu: '飞书', wechat: '微信' };
const SUBTITLE: Record<ChannelName, string> = { feishu: '账户查询与智能助手服务', wechat: '随时接收账户动态与提醒' };
const isConnected = (channel: ChannelName, b?: Binding) => Boolean(b && (channel === 'feishu' || b.auth_state === 'valid'));
const isAvailable = (channel: ChannelName, enabled: Enabled) => channel === 'feishu' ? enabled.feishu || enabled.feishuPersonal : enabled.wechat;

// 消息渠道绑定：先选渠道。未绑定时依次确认金额是否显示、输入支付密码，再扫码完成；已绑定时管理显示、推送与解绑。
export function Channels() {
  const { data, navigate } = useBank();
  // Binding needs an open assistant; existing bindings stay visible so they can still be unbound.
  const closed = Boolean(data.agent && data.agent.status !== 'enabled');
  const [enabled, setEnabled] = useState<Enabled | null>(null), [error, setError] = useState('');
  const [channel, setChannel] = useState<ChannelName | null>(null);
  useEffect(() => { api('/chat/status').then(s => setEnabled(s.channels)).catch(e => setError(e.message)); }, []);
  const active = (id: ChannelName) => data.bindings.find(b => b.channel === id && b.status === 'active');
  const state = (id: ChannelName) => isConnected(id, active(id)) ? '已绑定' : active(id) ? '需重新认证' : !enabled ? '读取中…' : !isAvailable(id, enabled) ? '未开启' : '去绑定';
  return <div className="page channels-page">
    {closed && <div className="notice channel-closed"><span>智能助手{data.agent?.status === 'reconsent_required' ? '协议已更新，重新同意后' : '尚未开通或已关闭，开通后'}才能绑定和使用飞书、微信。</span><button className="pill small primary" onClick={() => navigate('assistant')}>去开通</button></div>}
    {channel && enabled
      ? <ChannelDetail channel={channel} enabled={enabled} closed={closed} onBack={() => setChannel(null)} />
      : <><div className="cc-channel-list">{(['feishu', 'wechat'] as const).map(id => <button key={id} className="cc-channel-row" onClick={() => setChannel(id)} disabled={!enabled} data-testid={`channel-${id}`}>
          <span className={`cc-channel-icon ${id}`}><ServiceArtwork name={id} size={40} /></span>
          <span><strong>{NAME[id]} Bot 绑定</strong><small>{SUBTITLE[id]}</small></span>
          <span className={`cc-channel-state${state(id) === '已绑定' ? ' connected' : ''}`}>{state(id)}</span>
          <ChevronRight size={16} />
        </button>)}</div>
        <p className="data-note">绑定后可在私聊中查询账户、提议业务。为保障资金安全，所有操作都需回 App 确认，私聊中只能取消；绑定不会自动授权任何操作。</p></>}
    <InlineError message={error} />
  </div>;
}

function ChannelDetail({ channel, enabled, closed, onBack }: { channel: ChannelName; enabled: Enabled; closed: boolean; onBack: () => void }) {
  const { data } = useBank();
  const binding = data.bindings.find(b => b.channel === channel && b.status === 'active');
  return <>
    <button className="btn-text channels-back" onClick={onBack}><ChevronLeft size={16} />返回渠道列表</button>
    {isConnected(channel, binding) ? <BoundChannel channel={channel} /> : <BindChannel channel={channel} enabled={enabled} closed={closed} reauth={Boolean(binding)} />}
  </>;
}

// 绑定向导：①金额是否显示 ②支付密码确认 ③扫码（飞书专属机器人、银行飞书绑定码或微信二维码）。
function BindChannel({ channel, enabled, closed, reauth }: { channel: ChannelName; enabled: Enabled; closed: boolean; reauth: boolean }) {
  const { refresh } = useBank();
  const name = NAME[channel], personal = channel === 'feishu' && enabled.feishuPersonal, available = isAvailable(channel, enabled);
  const feishu = useFeishuBot(refresh), code = useFeishuCode(refresh), wechat = useWeChatLogin(refresh);
  const [step, setStep] = useState<'display' | 'confirm' | 'scan'>('display'), [mask, setMask] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { api<Record<ChannelName, { maskAmounts: boolean }>>('/channels/preferences').then(p => setMask(p[channel].maskAmounts)).catch(() => setMask(false)); }, [channel]);
  async function confirm(pin: string) {
    setBusy(true); setError('');
    try {
      await api(`/channels/preferences/${channel}`, 'PATCH', { maskAmounts: Boolean(mask) });
      if (channel === 'wechat') await wechat.start(pin); else if (personal) await feishu.start(pin); else await code.create(pin);
      setStep('scan');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const action = channel === 'wechat' ? (reauth ? '重新认证微信' : '连接我的微信助手') : personal ? '一键创建我的飞书机器人' : '生成5分钟绑定码';
  return <Card title={reauth ? `重新认证${name}` : `绑定${name}`} className="channel-bind">
    <ol className="channel-steps" aria-label="绑定步骤">{['显示设置', '密码确认', '扫码绑定'].map((label, i) => <li key={label} className={i === ['display', 'confirm', 'scan'].indexOf(step) ? 'current' : i < ['display', 'confirm', 'scan'].indexOf(step) ? 'done' : ''}>{label}</li>)}</ol>
    {!available && <Notice>{channel === 'feishu' ? '飞书专属机器人尚未开启。' : '微信渠道尚未开启。'}</Notice>}
    {reauth && channel === 'wechat' && <Notice>微信需要重新认证，请重新扫码连接。已有业务结果可在 App 查看。</Notice>}
    {step === 'display' && <div className="stack-form">
      <p className="body-copy">在{name}里查询和接收通知时，是否显示金额？</p>
      <div className="channel-choices" role="radiogroup" aria-label="金额显示方式">
        {[false, true].map(hide => <button key={String(hide)} type="button" role="radio" aria-checked={mask === hide} className={`channel-choice${mask === hide ? ' active' : ''}`} onClick={() => setMask(hide)} disabled={mask === null}>
          <strong>{hide ? '隐藏金额' : '显示金额'}</strong><small>{hide ? `${name}回复和通知中的金额显示为 ****` : `${name}回复和通知正常显示金额`}</small>
        </button>)}
      </div>
      <p className="data-note">绑定后可随时在这里修改，App 内始终显示完整金额。</p>
      <button className="btn-primary" disabled={mask === null || !available || closed} onClick={() => setStep('confirm')}>下一步</button>
    </div>}
    {step === 'confirm' && <form className="stack-form" onSubmit={e => { const f = formValues(e); void confirm(f.pin); }}>
      <div className="channel-summary"><span>金额显示</span><strong>{mask ? '隐藏为 ****' : '正常显示'}</strong><button type="button" className="btn-text" onClick={() => setStep('display')}>修改</button></div>
      <p className="body-copy">{channel === 'wechat' ? '确认后生成二维码，用支持微信助手功能的微信扫码连接。' : personal ? '确认后在你的飞书里创建一个只属于你的银行助手，扫码确认后自动绑定。' : '确认后生成一次性绑定码，在飞书私聊银行机器人发送即可绑定。'}</p>
      <PinField />
      <button className="btn-primary" disabled={busy || !available || closed}>{action}</button>
    </form>}
    {step === 'scan' && <div className="stack-form">
      {channel === 'feishu' && personal && feishu.bot && <div className="channel-qr"><img src={feishu.bot.image} width="220" height="220" alt="飞书专属机器人创建二维码" /><p role="status">{feishu.status}</p><a className="btn-text" href={feishu.bot.url} target="_blank" rel="noreferrer">在飞书中打开</a></div>}
      {channel === 'feishu' && personal && !feishu.bot && feishu.status && <p className="body-copy" role="status">{feishu.status}</p>}
      {channel === 'feishu' && !personal && code.code && <div className="binding-code"><strong>{code.code}</strong><span>在飞书私聊银行机器人，发送：绑定 {code.code}</span></div>}
      {channel === 'wechat' && wechat.login && wechat.waiting && <div className="channel-qr"><img src={wechat.login.image} width="220" height="220" alt="微信助手绑定二维码" /><p>请用支持微信助手功能的微信扫码，并在微信中确认。</p><p className="data-note">有效期至 {date(wechat.login.expiresAt)}</p></div>}
      {channel === 'wechat' && wechat.login?.status === 'awaiting_code' && <form className="stack-form form-card" onSubmit={async e => {
        const form = e.currentTarget, f = formValues(e); setBusy(true); setError('');
        try { await wechat.verify(f.code); form.reset(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}><Field label="微信扫码验证码"><input name="code" required maxLength={32} autoComplete="one-time-code" /></Field><p className="data-note">填写微信扫码页面显示的验证码，不是银行支付密码或短信验证码。</p><button className="btn-primary" disabled={busy}>提交验证码</button></form>}
      {channel === 'wechat' && wechat.message && <p role="status" aria-live="polite">{wechat.message}</p>}
      {(channel === 'wechat' ? !wechat.waiting : personal ? !feishu.bot : !code.code) && <button className="pill" onClick={() => setStep('confirm')}>重新生成</button>}
      {channel === 'wechat' && wechat.waiting && <button className="pill" disabled={busy} onClick={() => void wechat.cancel().catch(e => setError(e.message))}>取消本次连接</button>}
      {personal && <p className="data-note">机器人建在你自己的飞书里，只响应你本人的消息；银行只加密保存它的收发凭据。解绑后可在飞书开发者后台删除该应用。</p>}
    </div>}
    <InlineError message={error || wechat.error} />
  </Card>;
}

// 已绑定：显示与推送设置、最近请求，以及解绑（需支付密码，同时撤销未执行操作）。
function BoundChannel({ channel }: { channel: ChannelName }) {
  const { data, refresh, navigate } = useBank();
  const bindings = data.bindings.filter(b => b.channel === channel && b.status !== 'revoked');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [requests, setRequests] = useState<{ id: string; received_at: number }[]>([]);
  useEffect(() => { if (channel === 'wechat') api('/channels/wechat/requests').then(setRequests).catch(() => {}); }, [channel, data.bindings]);
  async function unbind(id: string, f: Record<string, string>) {
    setBusy(true); setError('');
    try { await api(`/channels/${id}/unbind`, 'POST', f); await refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const wechatBinding = bindings.find(b => b.status === 'active');
  return <>
    <Card title={`${NAME[channel]} Bot`} className="channel-bound">
      {channel === 'wechat' && <Notice>微信已绑定。{wechatBinding?.last_inbound_at ? '已收到你的微信消息。' : '请在微信给助手发送“你好”验证连接。'}</Notice>}
      <ChannelAmountSetting channel={channel} />
      <ChannelReportSetting channel={channel} />
      {channel === 'wechat' && wechatBinding?.last_api_accepted_at && <p className="data-note">最近回复已提交给微信：{date(new Date(wechatBinding.last_api_accepted_at).toISOString())}。此状态不代表手机已收到。</p>}
      {channel === 'wechat' && requests.length > 0 && <details><summary>最近的微信请求与结果</summary>{requests.map(r => <button className="agent-list-row" key={r.id} onClick={() => navigate(`wechat-requests/${r.id}`)}>{date(new Date(r.received_at).toISOString())} · 查看处理结果</button>)}</details>}
    </Card>
    {channel === 'feishu' && <FeishuRequests />}
    <Card title="绑定管理">{bindings.map(b => <div className="form-card" key={b.id}>
      <p><strong>{b.channel === 'feishu' ? (b.personal ? '飞书 · 专属机器人' : '飞书') : '微信'}</strong> · {({ active: b.personal && !b.live ? '已绑定 · 等待飞书生效' : '已绑定', expired: '登录已失效' } as Record<string, string>)[b.status] || b.status} · {date(b.created_at)}</p>
      {b.personal && b.status === 'active' && !b.live && <p className="data-note">在飞书给机器人发一句话即可完成生效。长时间没有回复，可能是公司飞书需要管理员审批该应用的新版本，请联系管理员审批，或解绑后改用个人飞书账号重新创建。</p>}
      <form className="stack-form" onSubmit={e => { const f = formValues(e); void unbind(b.id, f); }}><PinField /><button className="pill" disabled={busy}>解绑并撤销未执行操作</button></form>
    </div>)}</Card>
    <InlineError message={error} />
  </>;
}
