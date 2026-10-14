export function migrateFeishu(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL, binding_session_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
      user_id TEXT NOT NULL, message_id TEXT NOT NULL, input_cipher TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', is_command INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL, queue_deadline INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      run_id TEXT NOT NULL, result_json TEXT, safe_error_code TEXT, progress_sent INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      UNIQUE(binding_id,binding_generation,message_id)
    );
    CREATE INDEX IF NOT EXISTS feishu_inbox_work ON feishu_inbox(status,seq);
    CREATE INDEX IF NOT EXISTS feishu_inbox_user ON feishu_inbox(user_id,received_at);
    CREATE TABLE IF NOT EXISTS feishu_deliveries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL, binding_session_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
      user_id TEXT NOT NULL, request_id TEXT, message_id TEXT, source_outbox_id TEXT UNIQUE,
      kind TEXT NOT NULL, body_cipher TEXT NOT NULL, sent_body_cipher TEXT, uuid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      api_accepted_at INTEGER, server_message_id TEXT, safe_error_code TEXT, needs_review INTEGER NOT NULL DEFAULT 0,
      UNIQUE(request_id,kind)
    );
    CREATE INDEX IF NOT EXISTS feishu_delivery_work ON feishu_deliveries(status,next_at);
  `);
  const columns=new Set(db.prepare('PRAGMA table_info(channel_outbox)').all().map(c=>c.name));
  for(const [name,type] of [['binding_generation','INTEGER'],['binding_session_id','TEXT']])
    if(!columns.has(name)) db.exec(`ALTER TABLE channel_outbox ADD COLUMN ${name} ${type}`);
  db.exec(`UPDATE channel_outbox SET
    binding_generation=(SELECT binding_generation FROM channel_bindings WHERE id=binding_id),
    binding_session_id=(SELECT binding_session_id FROM channel_bindings WHERE id=binding_id)
    WHERE binding_generation IS NULL`);
}
