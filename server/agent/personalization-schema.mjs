import { randomUUID } from 'node:crypto';

export function migratePersonalization(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(agent_memory)').all().map(c => c.name));
    for (const [name, ddl] of Object.entries({
      tenant_id: "TEXT NOT NULL DEFAULT 'bank'", memory_id: 'TEXT', category: "TEXT NOT NULL DEFAULT 'preference'",
      status: "TEXT NOT NULL DEFAULT 'candidate'", confirmed: 'INTEGER NOT NULL DEFAULT 0',
      source_message_id: 'TEXT', source_channel: "TEXT NOT NULL DEFAULT 'legacy'", source_type: "TEXT NOT NULL DEFAULT 'legacy'",
      confidence: 'REAL NOT NULL DEFAULT 0.5', importance: 'REAL NOT NULL DEFAULT 0.5',
      created_at: 'TEXT', expires_at: 'TEXT', version: 'INTEGER NOT NULL DEFAULT 1',
    })) if (!columns.has(name)) db.exec(`ALTER TABLE agent_memory ADD COLUMN ${name} ${ddl}`);
    for (const row of db.prepare('SELECT user_id,key,updated_at FROM agent_memory WHERE memory_id IS NULL').all()) {
      db.prepare('UPDATE agent_memory SET memory_id=?,created_at=? WHERE user_id=? AND key=?').run('MEM'+randomUUID().replaceAll('-',''),row.updated_at,row.user_id,row.key);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS memory_id_unique ON agent_memory(memory_id);
      CREATE INDEX IF NOT EXISTS memory_scope ON agent_memory(tenant_id,user_id,status,expires_at);
      CREATE TABLE IF NOT EXISTS personalization_instance (id INTEGER PRIMARY KEY CHECK(id=1),tenant_id TEXT NOT NULL);
      INSERT OR IGNORE INTO personalization_instance VALUES(1,'bank');
      CREATE TABLE IF NOT EXISTS memory_candidates (
        memory_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        key TEXT NOT NULL, value TEXT NOT NULL, category TEXT NOT NULL, source_message_id TEXT NOT NULL,
        source_channel TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'model', confidence REAL NOT NULL DEFAULT 0.5,
        importance REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'candidate', confirmed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(tenant_id,user_id,key,value)
      );
      CREATE TABLE IF NOT EXISTS memory_changes (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),memory_id TEXT NOT NULL,
        action TEXT NOT NULL,version INTEGER NOT NULL,source_message_id TEXT,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,source_message_id TEXT NOT NULL,key TEXT NOT NULL,
        PRIMARY KEY(tenant_id,user_id,source_message_id,key)
      );
      CREATE TABLE IF NOT EXISTS memory_epochs (
        tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS memory_rejections (
        tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,key TEXT NOT NULL,value_digest TEXT NOT NULL,
        PRIMARY KEY(tenant_id,user_id,key,value_digest)
      );
      CREATE TABLE IF NOT EXISTS inference_calls (
        id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,
        step TEXT NOT NULL,trigger_source TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,
        input_tokens INTEGER,output_tokens INTEGER,cost REAL,error_code TEXT,created_at TEXT NOT NULL,
        finished_at TEXT,lease_until INTEGER NOT NULL,UNIQUE(tenant_id,user_id,request_id,step)
      );
      CREATE INDEX IF NOT EXISTS inference_quota ON inference_calls(tenant_id,user_id,created_at);
      CREATE TABLE IF NOT EXISTS agent_requests (
        tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,channel TEXT NOT NULL,message_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,error_code TEXT,
        created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id,channel,message_id)
      );
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
