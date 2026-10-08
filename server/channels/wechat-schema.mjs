import { randomUUID } from 'node:crypto';

export function migrateWeChat(db) {
  const columns = new Map([
    ['external_bot_id', 'TEXT'], ['binding_generation', 'INTEGER NOT NULL DEFAULT 1'],
    ['binding_session_id', 'TEXT'], ['context_updated_at', 'INTEGER'],
    ['last_inbound_at', 'INTEGER'], ['last_api_accepted_at', 'INTEGER'], ['last_poll_at', 'INTEGER'],
    ['last_error_code', 'TEXT'], ['connection_state', "TEXT NOT NULL DEFAULT 'awaiting_first_message'"],
    ['auth_state', "TEXT NOT NULL DEFAULT 'valid'"], ['authorized_at', 'INTEGER'],
    ['reauth_required_at', 'INTEGER'], ['auth_policy_version', "TEXT NOT NULL DEFAULT 'wechat-v1'"],
    ['lease_owner', 'TEXT'], ['lease_until', 'INTEGER NOT NULL DEFAULT 0'], ['lease_epoch', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  const existing = new Set(db.prepare('PRAGMA table_info(channel_bindings)').all().map(c => c.name));
  for (const [name, ddl] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE channel_bindings ADD COLUMN ${name} ${ddl}`);
  for (const row of db.prepare('SELECT id FROM channel_bindings WHERE binding_session_id IS NULL').all()) {
    db.prepare('UPDATE channel_bindings SET binding_session_id=? WHERE id=?').run(randomUUID(), row.id);
  }
  // Conflicts block new WeChat registrations, not the bank startup or existing balances.
  if (!db.prepare("SELECT user_id FROM channel_bindings WHERE channel='wechat' AND status='active' GROUP BY user_id HAVING count(*)>1").get()) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS wechat_one_active_user ON channel_bindings(user_id) WHERE channel='wechat' AND status='active'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_execution_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      channel TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL, deadline INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_queue_user ON agent_execution_queue(user_id,status,seq);
    CREATE TABLE IF NOT EXISTS user_execution_leases (
      user_id TEXT PRIMARY KEY, request_id TEXT, lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS agent_tool_effects (
      request_id TEXT NOT NULL, run_id TEXT, tool_call_id TEXT NOT NULL, effect_type TEXT NOT NULL, args_digest TEXT NOT NULL,
      status TEXT NOT NULL, effect_ref TEXT, result_json TEXT, binding_id TEXT, binding_session_id TEXT, binding_generation INTEGER,
      created_at INTEGER NOT NULL, committed_at INTEGER, safe_error_code TEXT, PRIMARY KEY(request_id,tool_call_id)
    );
    CREATE TABLE IF NOT EXISTS wechat_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL, binding_session_id TEXT NOT NULL,
      binding_generation INTEGER NOT NULL, user_id TEXT NOT NULL, upstream_message_id TEXT NOT NULL, upstream_created_at INTEGER,
      input_cipher TEXT, context_token_cipher TEXT, status TEXT NOT NULL, is_command INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL, queue_deadline INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      run_id TEXT NOT NULL, result_json TEXT, safe_error_code TEXT, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      lease_epoch INTEGER NOT NULL DEFAULT 0, progress_sent INTEGER NOT NULL DEFAULT 0,
      UNIQUE(binding_id,binding_generation,upstream_message_id)
    );
    CREATE INDEX IF NOT EXISTS wechat_inbox_pending ON wechat_inbox(status,queue_deadline,received_at);
    CREATE INDEX IF NOT EXISTS wechat_inbox_lease ON wechat_inbox(status,lease_until);
    CREATE TABLE IF NOT EXISTS wechat_quarantine (
      id INTEGER PRIMARY KEY, binding_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, reason TEXT NOT NULL,
      batch_digest TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(binding_id,binding_generation,batch_digest,reason)
    );
    CREATE TABLE IF NOT EXISTS wechat_deliveries (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, binding_session_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
      request_id TEXT, kind TEXT NOT NULL, part_index INTEGER NOT NULL DEFAULT 0, client_id TEXT NOT NULL UNIQUE,
      body_cipher TEXT, context_token_cipher TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, api_accepted_at INTEGER, user_confirmed_at INTEGER, platform_delivered_at INTEGER,
      lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, lease_epoch INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER, upstream_code TEXT, response_quality TEXT, server_message_id TEXT, safe_error_code TEXT,
      delivery_evidence TEXT, needs_review INTEGER NOT NULL DEFAULT 0, source_outbox_id TEXT UNIQUE,
      UNIQUE(request_id,kind,part_index)
    );
    CREATE INDEX IF NOT EXISTS wechat_delivery_pending ON wechat_deliveries(status,next_at,priority);
    CREATE INDEX IF NOT EXISTS wechat_delivery_lease ON wechat_deliveries(status,lease_until);
    CREATE TRIGGER IF NOT EXISTS wechat_credentials_changed AFTER UPDATE OF password_hash,pin_hash ON users
    WHEN NEW.password_hash <> OLD.password_hash OR NEW.pin_hash <> OLD.pin_hash
    BEGIN
      UPDATE channel_bindings SET auth_state='reauth_required', reauth_required_at=unixepoch()*1000,
        last_error_code='CREDENTIALS_CHANGED' WHERE user_id=NEW.id AND channel='wechat' AND status='active';
    END;
    CREATE TRIGGER IF NOT EXISTS wechat_account_suspended AFTER UPDATE OF status ON accounts
    WHEN NEW.type='debit' AND NEW.status <> 'active' AND NEW.status <> OLD.status
    BEGIN
      UPDATE channel_bindings SET auth_state='suspended', last_error_code='ACCOUNT_UNAVAILABLE'
        WHERE user_id=NEW.user_id AND channel='wechat' AND status='active';
    END;
  `);
}
