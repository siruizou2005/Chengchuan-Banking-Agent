import { requireThat } from '../errors.mjs';
import { assertChannelExecution } from './execution.mjs';
const verified = new WeakMap();
export function assertPrincipal(bank, principal) {
  const proof=verified.get(principal);
  requireThat(proof?.bank === bank && principal.tenant_id === bank.get('SELECT tenant_id FROM personalization_instance WHERE id=1').tenant_id,
    '身份验证失败',403,'INVALID_PRINCIPAL');
  assertChannelExecution(bank,proof.context,principal.user_id);
}

// This database belongs to one bank. Tenant selection is never accepted from a request.
export function resolvePrincipal(bank, user, context = {}) {
  requireThat(user?.id && bank.get('SELECT 1 FROM users WHERE id=?', user.id), '请先登录', 401, 'UNAUTHENTICATED');
  assertChannelExecution(bank, context, user.id);
  const channel = context.channel || 'app';
  const binding = ['wechat','feishu'].includes(channel)
    ? bank.get("SELECT * FROM channel_bindings WHERE user_id=? AND channel=? AND status='active' AND auth_state='valid' AND (id=? OR binding_session_id=?)",user.id,channel,context.bindingId||context.sessionId||context.bindingSessionId||null,context.sessionId||context.bindingSessionId||null) : null;
  const principal = Object.freeze({ tenant_id: bank.get('SELECT tenant_id FROM personalization_instance WHERE id=1').tenant_id,
    user_id: user.id, channel, bot_account_id: binding?.external_bot_id || binding?.id || 'web',
    external_user_id: binding?.external_id || user.id, conversation_id: context.sessionId || null });
  verified.set(principal, {bank,context:{...context}});
  return principal;
}
