import { useEffect, useState } from 'react';
import { api, date } from '../api';
import { useBank } from '../bank';
import { InlineError } from '../ui';

type Channel = 'feishu' | 'wechat';
type Kind = 'daily' | 'weekly' | 'monthly';
type Last = { from: string; to: string; state: string; reason: string | null } | null;
type Setting = Record<Kind, { enabled: boolean; nextAt: string | null; last: Last }> & { bound: boolean; ready: boolean };
const KINDS: { kind: Kind; title: string; note: string }[] = [
  { kind: 'daily', title: '日报', note: '每天推送昨日收支' },
  { kind: 'weekly', title: '周报', note: '每周一推送上周收支' },
  { kind: 'monthly', title: '月报', note: '每月1日推送上月收支' },
];
const STATES: Record<string, string> = { sent: '已发送', sending: '发送中', unknown: '未确认送达', failed: '未送达', missed: '已错过' };
const REASONS: Record<string, string> = { no_context: '需先在微信给助手发一条消息', binding_unavailable: '当时未绑定', assistant_unavailable: '智能助手未开通', assistant_locked: '智能助手已锁定', channel_disabled: '微信渠道已关闭', account_unavailable: '银行卡已冻结或挂失' };
// Choices are kept per channel like hide-amounts; reports only go out while the channel is bound.
export function ChannelReportSetting({ channel }: { channel: Channel }) {
  const { data } = useBank();
  const name = channel === 'feishu' ? '飞书' : '微信', closed = Boolean(data.agent && data.agent.status !== 'enabled');
  const [setting, setSetting] = useState<Setting | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<Record<Channel, Setting>>('/channels/reports').then(s => { if (!cancelled) setSetting(s[channel]); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [channel, data.bindings]);
  async function toggle(kind: Kind) {
    if (!setting) return;
    setSaving(true); setError('');
    try { setSetting(await api<Setting>(`/channels/reports/${channel}`, 'PATCH', { [kind]: !setting[kind].enabled })); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  function note(kind: Kind, text: string) {
    const item = setting![kind];
    if (!item.enabled) return text;
    if (!setting!.bound) return `${text} · 绑定后开始推送`;
    const last = item.last && (item.last.state === 'skipped' ? `上次未发送（${REASONS[item.last.reason || ''] || '条件不满足'}）` : `上次${STATES[item.last.state] || '已处理'}`);
    return [item.nextAt ? `下次 ${date(item.nextAt)}` : text, last].filter(Boolean).join(' · ');
  }
  return <div className="channel-amount-setting channel-report-setting">
    <div className="channel-report-head"><strong>账单推送</strong><span>上午8:00推送到{name}</span></div>
    {KINDS.map(k => <div className="channel-amount-row" key={k.kind}>
      <div><strong>{k.title}</strong><p className="data-note" aria-live="polite">{setting ? note(k.kind, k.note) : '正在读取设置…'}</p></div>
      <button type="button" role="switch" aria-label={`${name}${k.title}推送`} aria-checked={Boolean(setting?.[k.kind].enabled)} className="channel-amount-switch" disabled={!setting || saving || (closed && !setting[k.kind].enabled)} onClick={() => void toggle(k.kind)}><span /></button>
    </div>)}
    {setting?.bound && !setting.ready && <p className="data-note">请先在微信给助手发一条消息，之后才能收到推送。</p>}
    <InlineError message={error} />
  </div>;
}
