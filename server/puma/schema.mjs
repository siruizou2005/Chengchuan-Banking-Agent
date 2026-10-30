// Additive sidecars; no historical payment or memory keys are migrated.
export function migratePuma(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS puma_control (
      user_id TEXT PRIMARY KEY REFERENCES users(id), epoch INTEGER NOT NULL DEFAULT 0,
      stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN (0,1)), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS puma_queue_epochs (
      request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS puma_consents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL,
      version INTEGER NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
      UNIQUE(user_id,scope,version)
    );
    CREATE TABLE IF NOT EXISTS puma_events (
      event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL,
      occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, source TEXT NOT NULL, initiated_by TEXT NOT NULL,
      schema_version INTEGER NOT NULL, correlation_id TEXT NOT NULL, resource_ref TEXT NOT NULL,
      consent_scope TEXT NOT NULL, payload_ref TEXT, evidence_quality TEXT NOT NULL,
      fingerprint TEXT NOT NULL, UNIQUE(user_id,source,type,resource_ref,fingerprint)
    );
    CREATE INDEX IF NOT EXISTS puma_events_scope ON puma_events(user_id,type,occurred_at);
    CREATE TRIGGER IF NOT EXISTS puma_events_no_update BEFORE UPDATE ON puma_events BEGIN SELECT RAISE(ABORT,'immutable PUMA event'); END;
    CREATE TRIGGER IF NOT EXISTS puma_events_no_delete BEFORE DELETE ON puma_events BEGIN SELECT RAISE(ABORT,'immutable PUMA event'); END;
    CREATE TABLE IF NOT EXISTS puma_memory_provenance (
      memory_id TEXT NOT NULL, version INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      record_type TEXT NOT NULL, source_event_ids TEXT NOT NULL, verification_status TEXT NOT NULL,
      model_version TEXT, valid_from TEXT NOT NULL, expires_at TEXT, consent_scope TEXT NOT NULL,
      last_corrected_at TEXT, supersedes_id TEXT, caused_by_agent_recommendation INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(memory_id,version)
    );
    CREATE TABLE IF NOT EXISTS puma_delegates (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delegate_user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL, identity_status TEXT NOT NULL, scope TEXT NOT NULL, min_amount INTEGER NOT NULL,
      expires_at TEXT NOT NULL, jurisdiction TEXT, legal_review_ref TEXT, conflict INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS puma_delegate_requirements (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draft_id TEXT NOT NULL REFERENCES risk_drafts(id),
      draft_version INTEGER NOT NULL, digest TEXT NOT NULL, delegate_id TEXT NOT NULL REFERENCES puma_delegates(id),
      delegate_version INTEGER NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL,
      auth_context TEXT, created_at TEXT NOT NULL, UNIQUE(draft_id,draft_version,delegate_id,delegate_version)
    );
    CREATE TABLE IF NOT EXISTS puma_risk_links (
      flag_id TEXT PRIMARY KEY REFERENCES risk_flags(id), user_id TEXT NOT NULL REFERENCES users(id),
      scope TEXT NOT NULL, subject_ref TEXT NOT NULL, severity TEXT NOT NULL, evidence_ids TEXT NOT NULL,
      model_or_rule_version TEXT NOT NULL, review_owner TEXT, review_due TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS puma_metrics (
      id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, value REAL NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS puma_feedback (
      id TEXT PRIMARY KEY, flag_id TEXT NOT NULL REFERENCES risk_flags(id), reviewer_id TEXT NOT NULL REFERENCES users(id),
      outcome TEXT NOT NULL CHECK(outcome IN ('CONFIRMED_FRAUD','CONFIRMED_LEGITIMATE','INCONCLUSIVE')),
      evidence_ids TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS puma_feedback_no_update BEFORE UPDATE ON puma_feedback BEGIN SELECT RAISE(ABORT,'immutable review feedback'); END;
    CREATE TRIGGER IF NOT EXISTS puma_feedback_no_delete BEFORE DELETE ON puma_feedback BEGIN SELECT RAISE(ABORT,'immutable review feedback'); END;
    CREATE TABLE IF NOT EXISTS puma_audit (
      id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id), action TEXT NOT NULL,
      resource_ref TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS puma_audit_no_update BEFORE UPDATE ON puma_audit BEGIN SELECT RAISE(ABORT,'immutable PUMA audit'); END;
    CREATE TRIGGER IF NOT EXISTS puma_audit_no_delete BEFORE DELETE ON puma_audit BEGIN SELECT RAISE(ABORT,'immutable PUMA audit'); END;
    CREATE TRIGGER IF NOT EXISTS puma_reviews_no_update BEFORE UPDATE ON risk_reviews BEGIN SELECT RAISE(ABORT,'immutable risk review'); END;
    CREATE TRIGGER IF NOT EXISTS puma_reviews_no_delete BEFORE DELETE ON risk_reviews BEGIN SELECT RAISE(ABORT,'immutable risk review'); END;
    INSERT OR IGNORE INTO schema_migrations(version,created_at) VALUES('puma-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
