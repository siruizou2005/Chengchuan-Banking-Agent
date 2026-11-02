// Finished channel work is kept for a month: long past any platform retry, so duplicates within that window stay
// caught, and requests stay viewable in the App. Anything still in progress is never touched.
export const RECORD_RETENTION_MS=30*86400000;
const OPEN_DELIVERY="source_outbox_id IS NOT NULL AND status IN ('pending','retry_wait','sending')";
export function pruneChannelRecords(bank,at=Date.now()) {
  const cutoff=at-RECORD_RETENTION_MS,iso=new Date(cutoff).toISOString(),{run}=bank;
  // WeChat leaves a delivered notice at 'forwarded', so such a row is only open while its delivery is.
  run(`DELETE FROM channel_outbox WHERE next_at<? AND status<>'pending' AND id NOT IN (SELECT source_outbox_id FROM feishu_deliveries WHERE ${OPEN_DELIVERY}) AND id NOT IN (SELECT source_outbox_id FROM wechat_deliveries WHERE ${OPEN_DELIVERY})`,iso);
  for(const table of ['feishu_deliveries','wechat_deliveries'])run(`DELETE FROM ${table} WHERE created_at<? AND status IN ('api_accepted','cancelled','expired','failed','unknown')`,cutoff);
  for(const table of ['feishu_inbox','wechat_inbox'])run(`DELETE FROM ${table} WHERE COALESCE(finished_at,received_at)<? AND status NOT IN ('queued','running')`,cutoff);
  run("DELETE FROM agent_execution_queue WHERE created_at<? AND status NOT IN ('queued','running')",cutoff);
  run('DELETE FROM puma_queue_epochs WHERE request_id NOT IN (SELECT request_id FROM agent_execution_queue)');
  // A 'prepared' effect is an unresolved tool call that still needs checking.
  run("DELETE FROM agent_tool_effects WHERE created_at<? AND status<>'prepared'",cutoff);
  run('DELETE FROM channel_codes WHERE expires_at<?',iso);
}
// Clearing assistant data also covers what the pipelines kept of the conversation. Unsent replies are dropped; requests
// still in progress keep their input so they can end with a refusal. The Feishu tables declare these columns NOT NULL.
export function clearChannelRecords(bank,userId) {
  const {run}=bank,bindings='binding_id IN (SELECT id FROM channel_bindings WHERE user_id=?)';
  run("UPDATE feishu_deliveries SET status='cancelled' WHERE user_id=? AND status IN ('pending','retry_wait')",userId);
  run("UPDATE feishu_deliveries SET body_cipher='',sent_body_cipher=NULL WHERE user_id=? AND status<>'sending'",userId);
  run("UPDATE feishu_inbox SET result_json=NULL,input_cipher='' WHERE user_id=? AND status NOT IN ('queued','running')",userId);
  run(`UPDATE wechat_deliveries SET status='cancelled' WHERE ${bindings} AND status IN ('pending','retry_wait')`,userId);
  run(`UPDATE wechat_deliveries SET body_cipher=NULL,context_token_cipher=NULL WHERE ${bindings} AND status<>'sending'`,userId);
  run("UPDATE wechat_inbox SET result_json=NULL,input_cipher=NULL,context_token_cipher=NULL WHERE user_id=? AND status NOT IN ('queued','running')",userId);
  run(`UPDATE channel_outbox SET body='' WHERE ${bindings} AND status<>'pending'`,userId);
}
