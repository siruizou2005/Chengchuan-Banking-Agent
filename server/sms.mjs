import { isDemoUser } from './demo-users.mjs';

export const hasSmsFactor = factors => factors.some(factor => ['simulated_sms', 'tencent_sms'].includes(factor));

/**
 * Server-only adapter: { channel: 'tencent_sms', async sendVerificationCode(message) }.
 * message: { phone, code, expiresIn, verificationId, actionTitle }.
 * Resolve only after provider acceptance; reject on failure/timeout. Never log code
 * or credentials. See docs/SMS.md for the production integration checklist.
 */
export function createSmsDelivery(bank, { provider } = {}) {
  if (provider && (provider.channel !== 'tencent_sms' || typeof provider.sendVerificationCode !== 'function')) {
    throw new TypeError('Invalid SMS provider: expected tencent_sms and sendVerificationCode');
  }
  return {
    forUser(user) {
      const reason = isDemoUser(user) ? 'demo_account' : !provider ? 'provider_not_configured' : null;
      if (!reason) return { channel: provider.channel, simulated: false, send: message => provider.sendVerificationCode(message) };
      return {
        channel: 'simulated_sms', simulated: true, reason,
        async send({ code, actionTitle }) {
          bank.notify(user.id, '模拟短信验证码', `【澄川银行】验证码 ${code}，用于：${actionTitle}。5分钟内有效。请勿发送给聊天助手或他人。`);
        },
      };
    },
  };
}
