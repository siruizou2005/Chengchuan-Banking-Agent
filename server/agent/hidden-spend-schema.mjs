export function migrateHiddenSpend(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hidden_spend_analyses (
      user_id TEXT NOT NULL REFERENCES users(id), period TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,period)
    );
  `);
}
