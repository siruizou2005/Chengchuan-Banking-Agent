import { classifyMemory } from './modules.mjs';

// Runs inside the existing personalization migration transaction.
export function migrateModularMemory(db) {
  for(const table of ['agent_memory','memory_candidates']){
    const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
    for(const [name,ddl] of Object.entries({module:"TEXT NOT NULL DEFAULT 'general'",intent:"TEXT NOT NULL DEFAULT 'any'",memory_type:"TEXT NOT NULL DEFAULT 'explicit'"}))
      if(!columns.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_module_lookup ON ${table}(tenant_id,user_id,module,status,memory_type,intent,updated_at DESC)`);
  }
  const sessions=new Set(db.prepare('PRAGMA table_info(agent_sessions)').all().map(c=>c.name));
  if(!sessions.has('task_context'))db.exec("ALTER TABLE agent_sessions ADD COLUMN task_context TEXT NOT NULL DEFAULT '{}'");
  if(!db.prepare('PRAGMA table_info(inference_calls)').all().some(c=>c.name==='input_bytes'))db.exec('ALTER TABLE inference_calls ADD COLUMN input_bytes INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memory_modules (
      tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,module TEXT NOT NULL,activated_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,user_id,module)
    );
    CREATE TABLE IF NOT EXISTS behavior_events (
      event_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,request_id TEXT NOT NULL,session_id TEXT NOT NULL,
      source_channel TEXT NOT NULL,module TEXT NOT NULL,intent TEXT NOT NULL,signal TEXT NOT NULL,polarity INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,epoch INTEGER NOT NULL,created_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant_id,user_id,request_id,signal),UNIQUE(tenant_id,user_id,signal,fingerprint)
    );
    CREATE INDEX IF NOT EXISTS behavior_scope ON behavior_events(tenant_id,user_id,module,signal,revoked,created_at);
    CREATE INDEX IF NOT EXISTS behavior_signal_lookup ON behavior_events(tenant_id,user_id,signal,revoked,created_at DESC);
    CREATE TABLE IF NOT EXISTS behavior_hypotheses (
      hypothesis_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,module TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'behavioral',signal TEXT NOT NULL,hypothesis TEXT NOT NULL,
      status TEXT NOT NULL,confidence REAL NOT NULL,user_confirmed INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,epoch INTEGER NOT NULL,evidence_count INTEGER NOT NULL,session_count INTEGER NOT NULL,
      counter_count INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,
      UNIQUE(tenant_id,user_id,signal)
    );
    CREATE INDEX IF NOT EXISTS hypotheses_scope ON behavior_hypotheses(tenant_id,user_id,module,status,expires_at);
    CREATE TABLE IF NOT EXISTS memory_evidence (
      tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,hypothesis_id TEXT NOT NULL,event_id TEXT NOT NULL,polarity INTEGER NOT NULL,
      PRIMARY KEY(tenant_id,user_id,hypothesis_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS memory_module_summaries (
      tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,module TEXT NOT NULL,intent TEXT NOT NULL,epoch INTEGER NOT NULL,
      payload TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,user_id,module,intent)
    );
    CREATE TABLE IF NOT EXISTS memory_context_metrics (
      tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,request_id TEXT NOT NULL,route_json TEXT NOT NULL,skill_versions TEXT NOT NULL,
      memory_bytes INTEGER NOT NULL,skill_bytes INTEGER NOT NULL,augmentation_bytes INTEGER NOT NULL,
      total_input_bytes INTEGER NOT NULL,query_ms REAL NOT NULL,assembly_ms REAL NOT NULL,cache_hits INTEGER NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS memory_module_suggestions (
      suggestion_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,module TEXT NOT NULL,
      kind TEXT NOT NULL,metrics_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',created_at TEXT NOT NULL,
      UNIQUE(tenant_id,user_id,module,kind)
    );
  `);
  if(!db.prepare('PRAGMA table_info(memory_context_metrics)').all().some(c=>c.name==='sqlite_ms'))db.exec('ALTER TABLE memory_context_metrics ADD COLUMN sqlite_ms REAL NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(behavior_events)').all().some(c=>c.name==='run_id'))db.exec('ALTER TABLE behavior_events ADD COLUMN run_id TEXT');
  // Covers explicit unbind, upstream credential loss, password triggers and binding rotation.
  // Database-level fencing also invalidates a Web inference running in another worker.
  db.exec(`CREATE TRIGGER IF NOT EXISTS memory_channel_revoked AFTER UPDATE OF auth_state,status,binding_session_id,user_id ON channel_bindings
    WHEN OLD.auth_state='valid' AND (NEW.auth_state<>'valid' OR NEW.status<>'active' OR NEW.binding_session_id<>OLD.binding_session_id OR NEW.user_id<>OLD.user_id)
    BEGIN
      UPDATE behavior_events SET revoked=1 WHERE tenant_id=(SELECT tenant_id FROM personalization_instance WHERE id=1) AND user_id=OLD.user_id AND session_id=OLD.binding_session_id;
      UPDATE agent_sessions SET archived=1 WHERE user_id=OLD.user_id AND id IN (OLD.id,OLD.binding_session_id);
      UPDATE agent_sessions SET history='[]',task_context='{}' WHERE user_id=OLD.user_id;
      INSERT INTO memory_epochs(tenant_id,user_id,epoch) VALUES((SELECT tenant_id FROM personalization_instance WHERE id=1),OLD.user_id,1)
        ON CONFLICT(tenant_id,user_id) DO UPDATE SET epoch=epoch+1;
      DELETE FROM memory_module_summaries WHERE tenant_id=(SELECT tenant_id FROM personalization_instance WHERE id=1) AND user_id=OLD.user_id;
    END`);
  if(!db.prepare("SELECT 1 FROM schema_migrations WHERE version='memory.modules.v1'").get()){
    for(const table of ['agent_memory','memory_candidates'])for(const row of db.prepare(`SELECT memory_id,key,category,tenant_id,user_id,created_at FROM ${table}`).all()){
      const mapped=classifyMemory(row.key,row.category);
      db.prepare(`UPDATE ${table} SET module=?,intent=?,memory_type=? WHERE memory_id=? AND tenant_id=? AND user_id=?`).run(mapped.module,mapped.intent,mapped.memory_type,row.memory_id,row.tenant_id,row.user_id);
      db.prepare('INSERT OR IGNORE INTO user_memory_modules VALUES(?,?,?,?,?)').run(row.tenant_id,row.user_id,mapped.module,row.created_at||new Date().toISOString(),new Date().toISOString());
    }
    db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run('memory.modules.v1',new Date().toISOString());
  }
}
