export function migrateReports(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_subscriptions (
      user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL CHECK(channel IN ('feishu','wechat')),
      kind TEXT NOT NULL CHECK(kind IN ('daily','weekly','monthly')), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      next_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,channel,kind)
    );
    CREATE INDEX IF NOT EXISTS report_subscriptions_due ON report_subscriptions(next_at) WHERE enabled=1;
    CREATE TABLE IF NOT EXISTS report_pushes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, period_key TEXT NOT NULL,
      period_from TEXT NOT NULL, period_to TEXT NOT NULL, slot_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
      binding_id TEXT, outbox_id TEXT UNIQUE, created_at TEXT NOT NULL,
      UNIQUE(user_id,channel,kind,period_key)
    );
  `);
  if(!db.prepare('PRAGMA table_info(channel_outbox)').all().some(c=>c.name==='kind')) db.exec('ALTER TABLE channel_outbox ADD COLUMN kind TEXT');
}
