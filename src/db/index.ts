import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "contextvault.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** For tests: create an in-memory database */
export function createTestDb(): Database.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  initSchema(testDb);
  return testDb;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      repo_location TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      current_head TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted')),
      storage_class TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_customer ON workspaces(customer_id);
    CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT NOT NULL,
      base_commit TEXT,
      workspace_head_at_start TEXT,
      final_commit TEXT,
      status TEXT NOT NULL DEFAULT 'created' CHECK(status IN (
        'created', 'provisioning', 'ready', 'running', 'finalizing',
        'merged', 'conflicted', 'failed', 'aborted', 'cleaned_up'
      )),
      sandbox_path TEXT,
      started_at TEXT,
      completed_at TEXT,
      failure_reason TEXT,
      execution_summary TEXT,
      merge_status TEXT NOT NULL DEFAULT 'pending' CHECK(merge_status IN (
        'pending', 'merged', 'conflicted', 'failed'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

    CREATE TABLE IF NOT EXISTS locks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      lock_type TEXT NOT NULL DEFAULT 'exclusive' CHECK(lock_type IN ('exclusive', 'shared')),
      owner_run_id TEXT NOT NULL REFERENCES runs(id),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_locks_workspace ON locks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('agent', 'user', 'system')),
      actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_events(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret_hash TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_customer ON webhooks(customer_id);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_customer ON api_keys(customer_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);
}
