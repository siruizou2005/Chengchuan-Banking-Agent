import { useState } from 'react';
import type { ChannelName, OnboardingField, OnboardingState } from '../types';
import { CHANNEL_NAME, OnboardingBind, OnboardingRiskEntry } from './OnboardingSteps';

export const ONBOARDING_LABEL: Record<OnboardingField, string> = { preferred_name: '称呼', focus_areas: '关注业务', answer_length: '回复详略', investment_goal: '理财目标', channels: '绑定飞书/微信', mask_amounts: '飞书/微信隐藏金额', reports: '账单推送', risk: '风险测评' };
const FOCUS = ['账单分析', '理财', '转账', '信用卡与贷款', '生活缴费'];
const GOALS = ['备用金随用随取', '稳健增值', '长期增值', '暂不考虑理财'];
const REPORTS = ['日报', '周报', '月报'];
// 不经过个性化记忆的项目：个性化关闭时也照常询问。
const PLAIN: OnboardingField[] = ['channels', 'mask_amounts', 'reports', 'risk'];
// 与 server/agent/onboarding.mjs 的 ONBOARDING_OPENING 一致：服务端据此告诉模型用户已看到的开场白。
export const ONBOARDING_OPENING = '开通成功！想先花一分钟了解你，方便以后按你的习惯来服务，每个问题都可以说「跳过」。先问一下，我该怎么称呼你？';
export const ONBOARDING_RESUME = '我们接着设置偏好吧，随时可以说「跳过」。';

// 首次引导的进度与快捷回答：点选项、提交称呼都直接保存并进入下一题，不等模型；用户自己打字回答仍由助手理解。
// 绑定渠道在卡片里完成，风险测评到专门页面完成，支付密码与测评答案不经过对话。
export type GuideAnswer = (field: OnboardingField, value: string, label: string) => void;
export function OnboardingCard({ state, busy, onAnswer, onSkip, onEnd, onBound, onContinue, onStartRisk }: { state: OnboardingState; busy: boolean; onAnswer: GuideAnswer; onSkip: (field: OnboardingField) => void; onEnd: () => void; onBound: (channel: ChannelName) => void; onContinue: () => void; onStartRisk: () => void }) {
  const [areas, setAreas] = useState<string[]>([]), [reports, setReports] = useState<string[]>([]), [nickname, setNickname] = useState('');
  const done = state.answered.length + state.skipped.length, total = Math.max(state.total, done, 1), next = state.next;
  const available = !busy, { available: channels, bound, choice } = state.channels;
  const open = channels.filter(c => !bound.includes(c));
  const binds: [string, string][] = [...open.map((c): [string, string] => [CHANNEL_NAME[c], `绑定${CHANNEL_NAME[c]}`]), ...(open.length > 1 ? [['都绑', '两个都绑'] as [string, string]] : [])];
  const options: Partial<Record<OnboardingField, [string, string][]>> = {
    answer_length: [['简短', '回复简短一点'], ['适中', '回复适中就好'], ['详细', '回复详细一点']],
    mask_amounts: [['隐藏', '飞书微信里隐藏金额'], ['显示', '飞书微信里正常显示金额']],
    investment_goal: GOALS.map((goal): [string, string] => [goal, `理财目标：${goal}`]),
    channels: binds,
  };
  const multi = (list: string[], value: string) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  return <section className="onboarding-card" aria-label="偏好设置引导">
    <div className="onboarding-progress"><span>偏好设置 {done}/{total}</span><span className="onboarding-bar" aria-hidden="true"><i style={{ width: `${done / total * 100}%` }} /></span></div>
    {next && <p className="onboarding-question">{done ? '下一项' : '当前'}：{ONBOARDING_LABEL[next]}{!state.personalization && !PLAIN.includes(next) ? '（个性化已关闭，可跳过）' : ''}</p>}
    {next === 'focus_areas' ? <div className="chat-chips onboarding-chips" role="group" aria-label="关注业务，可多选">
      {FOCUS.map(area => <button key={area} aria-pressed={areas.includes(area)} className={areas.includes(area) ? 'selected' : ''} disabled={!available} onClick={() => setAreas(list => multi(list, area))}>{area}</button>)}
      <button className="primary" disabled={!available || !areas.length} onClick={() => { onAnswer('focus_areas', areas.join('、'), `我主要关注${areas.join('、')}`); setAreas([]); }}>就这些</button>
    </div> : next === 'preferred_name' ? <form className="chat-chips onboarding-chips onboarding-name" onSubmit={e => { e.preventDefault(); const value = nickname.trim(); if (!available || !value) return; onAnswer('preferred_name', value, `叫我${value}`); setNickname(''); }}>
      <input value={nickname} onChange={e => setNickname(e.target.value)} maxLength={20} placeholder="输入你希望的称呼" aria-label="称呼" disabled={!available} data-testid="onboarding-name" />
      <button type="submit" className="primary" disabled={!available || !nickname.trim()}>确定</button>
    </form> : next === 'channels' && choice.length ? <OnboardingBind channels={state.channels} onBound={onBound} onContinue={onContinue} />
    : next === 'reports' ? <>
      <p className="data-note">日报每天、周报每周一、月报每月1日，上午8:00推送到{bound.map(c => CHANNEL_NAME[c]).join('和')}，可多选。</p>
      <div className="chat-chips onboarding-chips" role="group" aria-label="账单推送，可多选">
        {REPORTS.map(kind => <button key={kind} aria-pressed={reports.includes(kind)} className={reports.includes(kind) ? 'selected' : ''} disabled={!available} onClick={() => setReports(list => multi(list, kind))}>{kind}</button>)}
        <button className="primary" disabled={!available || !reports.length} onClick={() => { const list = REPORTS.filter(k => reports.includes(k)).join('、'); onAnswer('reports', list, `账单推送要${list}`); setReports([]); }}>就这些</button>
      </div>
    </> : next === 'risk' ? <OnboardingRiskEntry onStart={onStartRisk} />
    : next && options[next] && <div className="chat-chips onboarding-chips" role="group" aria-label={ONBOARDING_LABEL[next]}>
      {options[next]!.map(([value, label]) => <button key={value} disabled={!available} onClick={() => onAnswer(next, value, label)}>{label}</button>)}
    </div>}
    <div className="onboarding-actions">
      {next && <button disabled={!available} onClick={() => onSkip(next)}>跳过这题</button>}
      <button disabled={busy} onClick={onEnd}>全部跳过</button>
    </div>
  </section>;
}
