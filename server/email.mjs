// Email one-time codes through Resend (https://resend.com/docs/api-reference/emails/send-email).
// Server-only: the API key and sender come from the environment and are never sent to the browser.

// RFC 2606 / 6761 reserved names never receive mail, so codes for them are shown on the page instead.
export const isReservedEmail = email => /@(?:[^@]+\.)?(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i.test(email || '');
export const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  return domain ? `${name.slice(0, 1)}***@${domain}` : '';
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * { channel: 'resend_email', async sendVerificationCode({ email, code, expiresIn, verificationId, actionTitle }) }.
 * Resolves only when Resend accepts the message; rejects on HTTP errors or timeout. The error never
 * carries the code, address or the provider's response body.
 */
export function createResendProvider({ apiKey, from = '澄川银行 <onboarding@resend.dev>', fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!apiKey) throw new TypeError('RESEND_API_KEY is required');
  return {
    channel: 'resend_email',
    async sendVerificationCode({ email, code, expiresIn, verificationId, actionTitle }) {
      const minutes = Math.round(expiresIn / 60);
      const text = `【澄川银行】验证码 ${code}，用于：${actionTitle}。${minutes}分钟内有效。请勿将验证码告诉聊天助手或他人。\n\n澄川银行为模拟银行演示项目，不涉及真实资金。`;
      const html = `<div style="font-family:-apple-system,'PingFang SC',sans-serif;color:#1a1a1a;line-height:1.7"><p>您正在澄川银行办理：<b>${escapeHtml(actionTitle)}</b></p><p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#4a6cf7;margin:12px 0">${code}</p><p>验证码${minutes}分钟内有效。请勿将验证码告诉聊天助手或他人。</p><p style="color:#999;font-size:12px">澄川银行为模拟银行演示项目，不涉及真实资金。如非本人操作请忽略本邮件。</p></div>`;
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        // The verification id makes provider-side retries idempotent: one code, at most one email.
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': verificationId },
        body: JSON.stringify({ from, to: [email], subject: `澄川银行验证码：${actionTitle}`, text, html }),
      });
      if (!response.ok) throw new Error(`Resend rejected the email (HTTP ${response.status})`);
    },
  };
}
