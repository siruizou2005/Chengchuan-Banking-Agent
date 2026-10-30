export function migrateRisk(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_evaluations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draft_id TEXT,
      stage TEXT NOT NULL CHECK(stage IN ('ANALYSIS','DRAFT','PRE_APPROVAL','PRE_EXECUTION')),
      core_action TEXT NOT NULL, final_action TEXT NOT NULL, age_band TEXT NOT NULL,
      policy_version TEXT NOT NULL, facts_hash TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS risk_evaluations_user ON risk_evaluations(user_id,created_at);
    CREATE TRIGGER IF NOT EXISTS risk_evaluations_immutable_update BEFORE UPDATE ON risk_evaluations BEGIN SELECT RAISE(ABORT,'immutable risk evaluation'); END;
    CREATE TRIGGER IF NOT EXISTS risk_evaluations_immutable_delete BEFORE DELETE ON risk_evaluations BEGIN SELECT RAISE(ABORT,'immutable risk evaluation'); END;
    CREATE TABLE IF NOT EXISTS risk_flags (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), scope_ref TEXT NOT NULL,
      flag_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('OPEN','UNDER_REVIEW','CONFIRMED','FALSE_POSITIVE','RESOLVED','EXPIRED')),
      evaluation_id TEXT NOT NULL REFERENCES risk_evaluations(id), created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_reviews (
      id TEXT PRIMARY KEY, flag_id TEXT NOT NULL REFERENCES risk_flags(id), reviewer_id TEXT NOT NULL REFERENCES users(id),
      disposition TEXT NOT NULL, rationale TEXT NOT NULL, next_review_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_appeals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), flag_id TEXT NOT NULL REFERENCES risk_flags(id),
      rationale TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_drafts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), source_account_ref TEXT NOT NULL REFERENCES accounts(id),
      beneficiary_ref TEXT NOT NULL, payload TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL CHECK(currency='CNY'),
      version INTEGER NOT NULL CHECK(version>0), payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
       ('RISK_CHECKED','AWAITING_APPROVAL','USER_APPROVED','PRE_EXECUTION_CHECK','HOLD_REVIEW','BLOCKED','SUBMITTING','PENDING','SETTLED','FAILED','CANCELLED','EXPIRED')),
      evaluation_id TEXT REFERENCES risk_evaluations(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_approval_intents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draft_id TEXT NOT NULL REFERENCES risk_drafts(id),
      version INTEGER NOT NULL, payload_hash TEXT NOT NULL, auth_action_id TEXT NOT NULL REFERENCES agent_actions(id),
      required_level TEXT NOT NULL, policy_version TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_approvals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draft_id TEXT NOT NULL REFERENCES risk_drafts(id),
      version INTEGER NOT NULL, payload_hash TEXT NOT NULL, challenge_id TEXT NOT NULL UNIQUE REFERENCES risk_approval_intents(id),
      auth_assertion_ref TEXT NOT NULL, strong INTEGER NOT NULL, policy_version TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_payments (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES risk_drafts(id), user_id TEXT NOT NULL REFERENCES users(id),
      provider_key TEXT NOT NULL UNIQUE, provider_reference TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('SUBMITTING','PENDING','SETTLED','FAILED')),
      held INTEGER NOT NULL DEFAULT 0, last_event_sequence INTEGER NOT NULL DEFAULT -1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_provider_events (
      event_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES risk_payments(id), status TEXT NOT NULL,
      payload_hash TEXT NOT NULL, signature_validated INTEGER NOT NULL CHECK(signature_validated=1), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_metrics (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draft_id TEXT,
      evaluation_id TEXT REFERENCES risk_evaluations(id), kind TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_mock_provider (
      provider_key TEXT PRIMARY KEY, payment_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_mock_secret (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_migrations(version,created_at) VALUES('risk-mvp-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
}
