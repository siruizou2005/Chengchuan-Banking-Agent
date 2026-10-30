import { now } from '../db.mjs';
import { requireThat } from '../errors.mjs';

export function controlState(bank, userId) {
  const row = bank.get('SELECT epoch,stopped,updated_at FROM puma_control WHERE user_id=?', userId);
  return { epoch: row?.epoch || 0, stopped: Boolean(row?.stopped), updatedAt: row?.updated_at || null };
}
export function assertAgentControl(bank, userId, epoch) {
  const state = controlState(bank, userId);
  const consent=bank.get("SELECT * FROM puma_consents WHERE user_id=? AND scope='agent_tools' ORDER BY version DESC LIMIT 1",userId);
  requireThat(!consent||(!consent.revoked_at&&consent.expires_at>now()),'助手动作授权已撤销或过期，请重新授权',423,'AGENT_CONSENT_REQUIRED');
  requireThat(!state.stopped && (epoch === undefined || epoch === state.epoch),
    '智能助手已停止，请在安全中心重新授权恢复；原任务不会自动恢复', 423, 'AGENT_STOPPED');
  return state.epoch;
}
export function createAgentControl(bank, services, drafts) {
  const running = new Map();
  function register(userId, controller) {
    assertAgentControl(bank, userId);
    if (!running.has(userId)) running.set(userId, new Set());
    running.get(userId).add(controller);
    return () => { running.get(userId)?.delete(controller); if (!running.get(userId)?.size) running.delete(userId); };
  }
  function stop(user) {
    const started = performance.now();
    const result = bank.atomic(() => {
      bank.run(`INSERT INTO puma_control VALUES(?,1,1,?) ON CONFLICT(user_id)
        DO UPDATE SET epoch=epoch+1,stopped=1,updated_at=excluded.updated_at`, user.id, now());
      bank.run("UPDATE agent_execution_queue SET status='interrupted' WHERE user_id=? AND status IN ('queued','running')", user.id);
      bank.run('UPDATE user_execution_leases SET lease_epoch=lease_epoch+1,lease_until=0 WHERE user_id=?', user.id);
      bank.run("UPDATE channel_outbox SET status='cancelled' WHERE kind='report' AND status IN ('pending','forwarded') AND binding_id IN (SELECT id FROM channel_bindings WHERE user_id=?)",user.id);
      bank.run("UPDATE feishu_deliveries SET status='cancelled' WHERE user_id=? AND kind='report' AND status IN ('pending','retry_wait')",user.id);
      bank.run("UPDATE wechat_deliveries SET status='cancelled' WHERE kind='report' AND status IN ('pending','retry_wait') AND binding_id IN (SELECT id FROM channel_bindings WHERE user_id=?)",user.id);
      for (const a of bank.all("SELECT id FROM agent_actions WHERE user_id=? AND tool<>'risk_transfer_approval' AND status IN ('proposed','confirmed','awaiting_verification')", user.id)) services.cancel(user, a.id);
      bank.run("UPDATE scheduled_tasks SET status='cancelled' WHERE user_id=? AND status IN ('pending','awaiting_verification')", user.id);
      for (const a of bank.all("SELECT DISTINCT action_id FROM operation_authorizations WHERE user_id=? AND status='active'", user.id)) services.authorization.revoke(a.action_id, 'STOP_ALL_AGENT_ACTIONS');
      for (const d of bank.all("SELECT id FROM risk_drafts WHERE user_id=? AND status IN ('RISK_CHECKED','AWAITING_APPROVAL','USER_APPROVED','HOLD_REVIEW','BLOCKED')", user.id)) drafts.cancel(user, d.id);
      bank.audit(user.id, 'puma.agent.stopped', '', { epoch: controlState(bank, user.id).epoch });
      bank.run('INSERT INTO puma_audit(user_id,action,resource_ref,detail,created_at) VALUES(?,?,?,?,?)', user.id, 'STOP_ALL_AGENT_ACTIONS', user.id, JSON.stringify(controlState(bank, user.id)), now());
      return { ...controlState(bank, user.id), payments: bank.all('SELECT draft_id,status FROM risk_payments WHERE user_id=?', user.id), providerCancellation: 'UNSUPPORTED_BY_PROVIDER' };
    });
    for (const controller of running.get(user.id) || []) controller.abort(new Error('AGENT_STOPPED'));
    bank.run('INSERT INTO puma_metrics(user_id,kind,value,created_at) VALUES(?,?,?,?)', user.id, 'STOP_LATENCY_MS', performance.now() - started, now());
    return result;
  }
  function resume(user, pin) {
    services.pin(user, pin);
    bank.atomic(() => {
      bank.run(`INSERT INTO puma_control VALUES(?,1,0,?) ON CONFLICT(user_id)
        DO UPDATE SET epoch=epoch+1,stopped=0,updated_at=excluded.updated_at`, user.id, now());
      bank.audit(user.id, 'puma.agent.resumed', '', { epoch: controlState(bank, user.id).epoch });
    });
    return controlState(bank, user.id);
  }
  return { state: user => controlState(bank, user.id), stop, resume, register };
}
