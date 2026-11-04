import Database from "better-sqlite3";
import { migrateCatalog } from "./catalog-schema";
import * as path from "path";
import * as fs from "fs";
import { AsyncLocalStorage } from "node:async_hooks";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "contextvault.db");

let db: Database.Database | null = null;
const context = new AsyncLocalStorage<Database.Database>();

/** Keep legacy repositories inside the owning application's connection, including asynchronous callbacks. */
export function withDatabase<T>(database: Database.Database, work: () => T): T { return context.run(database, work); }

function openPrivateDatabase(filename: string): Database.Database {
  if (!path.isAbsolute(filename)) throw new Error("Catalog path must be absolute");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try { const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600); fs.closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Catalog must be a private regular file");
  fs.chmodSync(filename, 0o600);
  const database = new Database(filename);
  try { database.pragma("journal_mode = WAL"); database.pragma("foreign_keys = ON"); initSchema(database); return database; }
  catch (error) { database.close(); throw error; }
}

export function getDb(filename?: string): Database.Database {
  if (filename !== undefined) return openPrivateDatabase(filename);
  const scoped = context.getStore();
  if (scoped) return scoped;
  if (db) return db;
  db = openPrivateDatabase(DB_PATH);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** For tests: create an in-memory database */
export function createTestDb(filename = ":memory:"): Database.Database {
  const testDb = new Database(filename);
  if (filename !== ":memory:") testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");
  try {
    initSchema(testDb);
    return testDb;
  } catch (error) {
    testDb.close();
    throw error;
  }
}

export function initSchema(database: Database.Database): void {
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
  migrateCatalog(database);
}
