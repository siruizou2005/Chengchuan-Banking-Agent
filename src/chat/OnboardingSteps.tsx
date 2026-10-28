import { useState } from 'react';
import { Check } from 'lucide-react';
import { api, formValues } from '../api';
import { useBank } from '../bank';
import { InlineError, PinField } from '../ui';
import { RISK_QUESTIONS } from '../products';
import { useFeishuBot, useFeishuCode, useWeChatLogin } from '../pages/channelConnect';
import type { ChannelName, OnboardingChannels } from '../types';

export const CHANNEL_NAME: Record<ChannelName, string> = { wechat: '微信', feishu: '飞书' };

// 首次引导里绑定飞书/微信：支付密码只在这里输入、不经过对话；输一次就为选中的渠道各生成二维码（银行飞书机器人为绑定码），扫码后自动进入下一步。
export function OnboardingBind({ channels, onBound, onContinue }: { channels: OnboardingChannels; onBound: (channel: ChannelName) => void; onContinue: () => void }) {
  const { refresh } = useBank();
  const done = async (channel: ChannelName) => { await refresh(); onBound(channel); };
  const wechat = useWeChatLogin(() => done('wechat')), feishu = useFeishuBot(() => done('feishu')), code = useFeishuCode(() => done('feishu'));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = channels.choice.filter(c => !channels.bound.includes(c));
  const running = (c: ChannelName) => c === 'wechat' ? wechat.waiting : Boolean(feishu.bot || code.code);
  const idle = pending.filter(c => !running(c));
  async function start(pin: string) {
    setBusy(true); setError('');
    try {
      if (idle.includes('wechat')) await wechat.start(pin);
      if (idle.includes('feishu')) await (channels.feishu === 'personal' ? feishu.start(pin) : code.create(pin));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="onboarding-bind">
    {channels.choice.filter(c => channels.bound.includes(c)).map(c => <p className="onboarding-bound" key={c}><Check size={14} />{CHANNEL_NAME[c]}已绑定</p>)}
    {idle.length > 0 && <form className="onboarding-pin" onSubmit={e => { const f = formValues(e); void start(f.pin); }}>
      <PinField />
      <button className="pill small primary" disabled={busy}>生成{idle.map(c => CHANNEL_NAME[c]).join('、')}{idle.includes('feishu') && channels.feishu === 'shared' ? '绑定码' : '二维码'}</button>
    </form>}
    {pending.includes('wechat') && wechat.login && <div className="onboarding-qr">
      {wechat.waiting && <img src={wechat.login.image} width="180" height="180" alt="微信助手绑定二维码" />}
      <p role="status">{wechat.waiting && wechat.login.status === 'waiting_scan' ? '请用手机微信扫码，并在微信中确认' : wechat.message}</p>
      {wechat.login.status === 'awaiting_code' && <form className="chat-chips onboarding-chips onboarding-name" onSubmit={async e => {
        const form = e.currentTarget, f = formValues(e); setBusy(true); setError('');
        try { await wechat.verify(f.code); form.reset(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}><input name="code" required maxLength={32} autoComplete="one-time-code" placeholder="微信扫码页面显示的验证码" aria-label="微信扫码验证码" /><button type="submit" className="primary" disabled={busy}>提交</button></form>}
    </div>}
    {pending.includes('feishu') && feishu.bot && <div className="onboarding-qr">
      <img src={feishu.bot.image} width="180" height="180" alt="飞书专属机器人创建二维码" />
      <p role="status">{feishu.status}</p>
      <a className="btn-text" href={feishu.bot.url} target="_blank" rel="noreferrer">在飞书中打开</a>
    </div>}
    {pending.includes('feishu') && !feishu.bot && feishu.status && <p className="data-note">{feishu.status}</p>}
    {pending.includes('feishu') && code.code && <div className="binding-code"><strong>{code.code}</strong><span>在飞书私聊银行机器人，发送：绑定 {code.code}</span></div>}
    {pending.length > 0 && channels.bound.some(c => channels.choice.includes(c)) && <button className="btn-text onboarding-back" onClick={onContinue}>先到这里，继续下一步</button>}
    <InlineError message={error || wechat.error} />
  </div>;
}

// 风险测评在对话里逐题作答，与「理财 → 风险测评」同一套题目和评级规则，答完最后一题即提交。
export function OnboardingRisk({ disabled, onDone }: { disabled: boolean; onDone: (level: number) => Promise<void> }) {
  const [answers, setAnswers] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const question = RISK_QUESTIONS[answers.length];
  async function pick(score: number) {
    const next = [...answers, score];
    if (next.length < RISK_QUESTIONS.length) { setAnswers(next); return; }
    setBusy(true); setError('');
    try { const { level } = await api<{ level: number }>('/risk-assessment', 'POST', { answers: next }); await onDone(level); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="onboarding-risk">
    <p className="onboarding-question">第 {answers.length + 1}/{RISK_QUESTIONS.length} 题：{question.title}</p>
    <div className="chat-chips onboarding-chips onboarding-options" role="group" aria-label={question.title}>
      {question.options.map((option, i) => <button key={option} disabled={disabled || busy} onClick={() => void pick(i + 1)}>{option}</button>)}
    </div>
    {answers.length > 0 && <button className="btn-text onboarding-back" disabled={busy} onClick={() => setAnswers(list => list.slice(0, -1))}>上一题</button>}
    <InlineError message={error} />
  </div>;
}
