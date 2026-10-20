import { isDemoUser, UNLIMITED_EMAILS } from './demo-users.mjs';
import { isReservedEmail, maskEmail } from './email.mjs';
import { hash, requireThat } from './errors.mjs';

// Any one-time-code channel satisfies the policy's `sms` factor: real SMS, real email, or the simulation.
export const hasSmsFactor = factors => factors.some(factor => ['simulated_sms', 'tencent_sms', 'resend_email'].includes(factor));

const beijingDate = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

/**
 * Server-only adapters:
 *   provider: { channel: 'tencent_sms', async sendVerificationCode({ phone, code, expiresIn, verificationId, actionTitle }) }
 *   email:    { channel: 'resend_email', async sendVerificationCode({ email, code, expiresIn, verificationId, actionTitle }) }
 * Resolve only after provider acceptance; reject on failure/timeout. Never log code or credentials.
 * Channel order: reserved demo address (code shown on the page) → real email → SMS → simulation.
 * See docs/SMS.md.
 */
export function createSmsDelivery(bank, { provider, email: emailProvider, limits = {} } = {}) {
  if (provider && (provider.channel !== 'tencent_sms' || typeof provider.sendVerificationCode !== 'function')) {
    throw new TypeError('Invalid SMS provider: expected tencent_sms and sendVerificationCode');
  }
  if (emailProvider && (emailProvider.channel !== 'resend_email' || typeof emailProvider.sendVerificationCode !== 'function')) {
    throw new TypeError('Invalid email provider: expected resend_email and sendVerificationCode');
  }
  bank.db?.exec('CREATE TABLE IF NOT EXISTS otp_sends (id INTEGER PRIMARY KEY, target_hash TEXT NOT NULL, channel TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS otp_sends_target ON otp_sends(target_hash,created_at);');
  const intervalMs = limits.intervalMs ?? 60000, perTarget = limits.perTargetDaily ?? 10;
  const daily = limits.daily ?? Number(process.env.OTP_DAILY_LIMIT || 90); // Resend's free plan allows 100 emails a day.
  // Paid or quota-bound sends are rate limited per address and in total; call inside the caller's transaction.
  function reserve(channel, target) {
    const key = hash(`${channel}:${target}`), now = Date.now(), day = beijingDate(now);
    const last = bank.get('SELECT MAX(created_at) AS at FROM otp_sends WHERE target_hash=?', key).at;
    requireThat(!last || now - last >= intervalMs, `验证码发送过于频繁，请${Math.ceil((intervalMs - (now - last)) / 1000)}秒后再试`, 429, 'RATE_LIMITED');
    if (UNLIMITED_EMAILS.has(target)) return bank.run('INSERT INTO otp_sends(target_hash,channel,day,created_at) VALUES(?,?,?,?)', key, channel, day, now);
    requireThat(bank.get('SELECT COUNT(*) AS n FROM otp_sends WHERE target_hash=? AND day=?', key, day).n < perTarget, '今日验证码发送次数已达上限，请明天再试', 429, 'RATE_LIMITED');
    requireThat(bank.get('SELECT COUNT(*) AS n FROM otp_sends WHERE channel=? AND day=?', channel, day).n < daily, '今日验证码发送量已达上限，请稍后再试', 429, 'RATE_LIMITED');
    bank.run('INSERT INTO otp_sends(target_hash,channel,day,created_at) VALUES(?,?,?,?)', key, channel, day, now);
  }
  const real = (adapter, target, field) => ({
    channel: adapter.channel, simulated: false, target: field === 'email' ? maskEmail(target) : `${target.slice(0, 3)}****${target.slice(-4)}`,
    reserve: () => reserve(adapter.channel, target),
    send: message => adapter.sendVerificationCode({ ...message, [field]: target }),
  });
  // The simulation shows the code on the page; a copy also goes to the message center.
  const simulated = (reason, notify) => ({
    channel: 'simulated_sms', simulated: true, reason, showCode: true, reserve() {},
    async send({ code, actionTitle }) { notify?.(code, actionTitle); },
  });
  function forEmail(address) {
    if (isReservedEmail(address)) return simulated('demo_email');
    if (emailProvider) return real(emailProvider, address, 'email');
    return simulated('provider_not_configured');
  }
  return {
    forEmail,
    forUser(user) {
      const notify = (code, actionTitle) => bank.notify(user.id, '模拟验证码', `【澄川银行】验证码 ${code}，用于：${actionTitle}。5分钟内有效。请勿发送给聊天助手或他人。`);
      if (user.email && (isReservedEmail(user.email) || emailProvider)) {
        const delivery = forEmail(user.email);
        return delivery.simulated ? simulated(delivery.reason, notify) : delivery;
      }
      if (provider && !isDemoUser(user)) return real(provider, user.phone, 'phone');
      return simulated(isDemoUser(user) ? 'demo_account' : !user.email ? 'no_email' : 'provider_not_configured', notify);
    },
  };
}
