import { useState } from 'react';
import type { ChannelName, OnboardingField, OnboardingState } from '../types';
import { CHANNEL_NAME, OnboardingBind, OnboardingRisk } from './OnboardingSteps';

export const ONBOARDING_LABEL: Record<OnboardingField, string> = { preferred_name: '称呼', focus_areas: '关注业务', answer_length: '回复详略', investment_goal: '理财目标', channels: '绑定飞书/微信', mask_amounts: '飞书/微信隐藏金额', reports: '账单推送', risk: '风险测评' };
const FOCUS = ['账单分析', '理财', '转账', '信用卡与贷款', '生活缴费'];
const GOALS = ['备用金随用随取', '稳健增值', '长期增值', '暂不考虑理财'];
const REPORTS = ['日报', '周报', '月报'];
// 不经过个性化记忆的项目：个性化关闭时也照常询问。
const PLAIN: OnboardingField[] = ['channels', 'mask_amounts', 'reports', 'risk'];
// 与 server/agent/onboarding.mjs 的 ONBOARDING_OPENING 一致：服务端据此告诉模型用户已看到的开场白。
export const ONBOARDING_OPENING = '开通成功！想先花一分钟了解你，方便以后按你的习惯来服务，每个问题都可以说「跳过」。先问一下，我该怎么称呼你？';
export const ONBOARDING_RESUME = '我们接着设置偏好吧，随时可以说「跳过」。';

// 首次引导的进度与快捷回答：点选项等于发一句话，由助手理解并保存；称呼由用户手动填写；「全部跳过」直接结束引导。
// 绑定渠道和风险测评在卡片里完成，支付密码与测评答案不经过对话。
export function OnboardingCard({ state, busy, configured, onSay, onEnd, onBound, onContinue, onRiskDone }: { state: OnboardingState; busy: boolean; configured: boolean; onSay: (text: string) => void; onEnd: () => void; onBound: (channel: ChannelName) => void; onContinue: () => void; onRiskDone: (level: number) => Promise<void> }) {
  const [areas, setAreas] = useState<string[]>([]), [reports, setReports] = useState<string[]>([]), [nickname, setNickname] = useState('');
  const done = state.answered.length + state.skipped.length, total = Math.max(state.total, done, 1), next = state.next;
  const available = configured && !busy, { available: channels, bound, choice } = state.channels;
  const open = channels.filter(c => !bound.includes(c)), binds = [...open.map(c => `绑定${CHANNEL_NAME[c]}`), ...(open.length > 1 ? ['两个都绑'] : [])];
  const options: Partial<Record<OnboardingField, string[]>> = {
    answer_length: ['回复简短一点', '回复适中就好', '回复详细一点'],
    mask_amounts: ['飞书微信里隐藏金额', '飞书微信里正常显示金额'],
    investment_goal: GOALS.map(goal => `理财目标：${goal}`),
    channels: binds,
  };
  const multi = (list: string[], value: string) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  return <section className="onboarding-card" aria-label="偏好设置引导">
    <div className="onboarding-progress"><span>偏好设置 {done}/{total}</span><span className="onboarding-bar" aria-hidden="true"><i style={{ width: `${done / total * 100}%` }} /></span></div>
    {next && <p className="onboarding-question">{done ? '下一项' : '当前'}：{ONBOARDING_LABEL[next]}{!state.personalization && !PLAIN.includes(next) ? '（个性化已关闭，可跳过）' : ''}</p>}
    {next === 'focus_areas' ? <div className="chat-chips onboarding-chips" role="group" aria-label="关注业务，可多选">
      {FOCUS.map(area => <button key={area} aria-pressed={areas.includes(area)} className={areas.includes(area) ? 'selected' : ''} disabled={!available} onClick={() => setAreas(list => multi(list, area))}>{area}</button>)}
      <button className="primary" disabled={!available || !areas.length} onClick={() => { onSay(`我主要关注${areas.join('、')}`); setAreas([]); }}>就这些</button>
    </div> : next === 'preferred_name' ? <form className="chat-chips onboarding-chips onboarding-name" onSubmit={e => { e.preventDefault(); const value = nickname.trim(); if (!available || !value) return; onSay(`叫我${value}`); setNickname(''); }}>
      <input value={nickname} onChange={e => setNickname(e.target.value)} maxLength={20} placeholder="输入你希望的称呼" aria-label="称呼" disabled={!available} data-testid="onboarding-name" />
      <button type="submit" className="primary" disabled={!available || !nickname.trim()}>确定</button>
    </form> : next === 'channels' && choice.length ? <OnboardingBind channels={state.channels} onBound={onBound} onContinue={onContinue} />
    : next === 'reports' ? <>
      <p className="data-note">日报每天、周报每周一、月报每月1日，上午8:00推送到{bound.map(c => CHANNEL_NAME[c]).join('和')}，可多选。</p>
      <div className="chat-chips onboarding-chips" role="group" aria-label="账单推送，可多选">
        {REPORTS.map(kind => <button key={kind} aria-pressed={reports.includes(kind)} className={reports.includes(kind) ? 'selected' : ''} disabled={!available} onClick={() => setReports(list => multi(list, kind))}>{kind}</button>)}
        <button className="primary" disabled={!available || !reports.length} onClick={() => { onSay(`账单推送要${REPORTS.filter(k => reports.includes(k)).join('、')}`); setReports([]); }}>就这些</button>
      </div>
    </> : next === 'risk' ? <OnboardingRisk disabled={busy} onDone={onRiskDone} />
    : next && options[next] && <div className="chat-chips onboarding-chips" role="group" aria-label={ONBOARDING_LABEL[next]}>
      {options[next]!.map(text => <button key={text} disabled={!available} onClick={() => onSay(text)}>{text}</button>)}
    </div>}
    <div className="onboarding-actions">
      {next && <button disabled={!available} onClick={() => onSay(`${ONBOARDING_LABEL[next]}这个问题跳过`)}>跳过这题</button>}
      <button disabled={busy} onClick={onEnd}>{configured ? '全部跳过' : '跳过引导'}</button>
    </div>
    {!configured && <p className="data-note">聊天服务暂不可用，可以先跳过，之后在「我的 → 个性化与记忆」中设置。</p>}
  </section>;
}
