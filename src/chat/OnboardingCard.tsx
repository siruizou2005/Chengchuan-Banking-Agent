import { useState } from 'react';
import type { OnboardingField, OnboardingState } from '../types';

const LABEL: Record<OnboardingField, string> = { preferred_name: '称呼', focus_areas: '关注业务', answer_length: '回复详略', mask_amounts: '飞书/微信隐藏金额', investment_goal: '理财目标' };
const FOCUS = ['账单分析', '理财', '转账', '信用卡与贷款', '生活缴费'];
const GOALS = ['备用金随用随取', '稳健增值', '长期增值', '暂不考虑理财'];
// 与 server/agent/onboarding.mjs 的 ONBOARDING_OPENING 一致：服务端据此告诉模型用户已看到的开场白。
export const ONBOARDING_OPENING = '开通成功！想先花一分钟了解你，方便以后按你的习惯来服务，每个问题都可以说「跳过」。先问一下，我该怎么称呼你？';
export const ONBOARDING_RESUME = '我们接着设置偏好吧，随时可以说「跳过」。';

// 首次引导的进度与快捷回答：点选项等于发一句话，由助手理解并保存；「全部跳过」直接结束引导。
export function OnboardingCard({ state, name, busy, configured, onSay, onEnd, onRisk }: { state: OnboardingState; name: string; busy: boolean; configured: boolean; onSay: (text: string) => void; onEnd: () => void; onRisk: () => void }) {
  const [areas, setAreas] = useState<string[]>([]);
  const done = state.answered.length + state.skipped.length, next = state.next;
  const available = configured && !busy;
  const options: Record<OnboardingField, string[]> = {
    preferred_name: [...new Set([`叫我${name}`, name.length >= 3 ? `叫我${name.slice(1)}` : ''])].filter(Boolean),
    focus_areas: [],
    answer_length: ['回复简短一点', '回复详细一点'],
    mask_amounts: ['飞书微信里隐藏金额', '飞书微信里正常显示金额'],
    investment_goal: GOALS.map(goal => `理财目标：${goal}`),
  };
  return <section className="onboarding-card" aria-label="偏好设置引导">
    <div className="onboarding-progress"><span>偏好设置 {done}/5</span><span className="onboarding-bar" aria-hidden="true"><i style={{ width: `${done * 20}%` }} /></span></div>
    {next && <p className="onboarding-question">{done ? '下一项' : '当前'}：{LABEL[next]}{!state.personalization && next !== 'mask_amounts' ? '（个性化已关闭，可跳过）' : ''}</p>}
    {next === 'focus_areas' ? <div className="chat-chips onboarding-chips" role="group" aria-label="关注业务，可多选">
      {FOCUS.map(area => <button key={area} aria-pressed={areas.includes(area)} className={areas.includes(area) ? 'selected' : ''} disabled={!available} onClick={() => setAreas(list => list.includes(area) ? list.filter(a => a !== area) : [...list, area])}>{area}</button>)}
      <button className="primary" disabled={!available || !areas.length} onClick={() => { onSay(`我主要关注${areas.join('、')}`); setAreas([]); }}>就这些</button>
    </div> : next && <div className="chat-chips onboarding-chips" role="group" aria-label={LABEL[next]}>
      {options[next].map(text => <button key={text} disabled={!available} onClick={() => onSay(text)}>{text}</button>)}
      {next === 'investment_goal' && state.riskLevel === 0 && <button onClick={onRisk}>先去做风险测评</button>}
    </div>}
    <div className="onboarding-actions">
      {next && <button disabled={!available} onClick={() => onSay(`${LABEL[next]}这个问题跳过`)}>跳过这题</button>}
      <button disabled={busy} onClick={onEnd}>{configured ? '全部跳过' : '跳过引导'}</button>
    </div>
    {!configured && <p className="data-note">聊天服务暂不可用，可以先跳过，之后在「我的 → 个性化与记忆」中设置。</p>}
  </section>;
}
