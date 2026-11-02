export function migrateMerchantCategories(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_categories (
      merchant_key TEXT PRIMARY KEY, tag TEXT, status TEXT NOT NULL CHECK(status IN ('classified','unknown','pending')),
      attempts INTEGER NOT NULL DEFAULT 0, retry_after TEXT, model TEXT NOT NULL, prompt_version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merchant_category_runs (
      business_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, lease_until TEXT,
      batches INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, classified INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost REAL,
      error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ledger_category_overrides (
      user_id TEXT NOT NULL REFERENCES users(id), ledger_id INTEGER NOT NULL REFERENCES ledger(id),
      tag TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,ledger_id)
    );
    CREATE TABLE IF NOT EXISTS merchant_category_overrides (
      user_id TEXT NOT NULL REFERENCES users(id), merchant_key TEXT NOT NULL,
      tag TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,merchant_key)
    );
  `);
}
