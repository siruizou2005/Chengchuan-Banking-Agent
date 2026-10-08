import { useEffect, useState } from 'react';
import { api } from '../api';
import { InlineError } from '../ui';

type Channel = 'feishu' | 'wechat';
export function ChannelAmountSetting({ channel }: { channel: Channel }) {
  const name = channel === 'feishu' ? '飞书' : '微信';
  const [hidden, setHidden] = useState(false), [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<Record<Channel, { maskAmounts: boolean }>>('/channels/preferences').then(p => {
      if (!cancelled) { setHidden(p[channel].maskAmounts); setLoaded(true); }
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [channel]);
  async function toggle() {
    setSaving(true); setError('');
    try { const result = await api<{ maskAmounts: boolean }>(`/channels/preferences/${channel}`, 'PATCH', { maskAmounts: !hidden }); setHidden(result.maskAmounts); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="channel-amount-setting">
    <div className="channel-amount-row"><div><strong>隐藏金额</strong><p className="data-note" aria-live="polite">{saving ? '正在保存…' : !loaded ? '正在读取设置…' : hidden ? `${name}回复及业务通知中的金额显示为 ****` : `${name}回复及业务通知正常显示金额`}</p></div>
      <button type="button" role="switch" aria-label={`${name}隐藏金额`} aria-checked={hidden} className="channel-amount-switch" disabled={!loaded || saving} onClick={() => void toggle()}><span /></button>
    </div>
    <InlineError message={error} />
  </div>;
}
