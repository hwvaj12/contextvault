import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { vi } from "vitest";

let mockDb: Database.Database;

function initTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      repo_location TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      current_head TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      storage_class TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT NOT NULL,
      base_commit TEXT,
      workspace_head_at_start TEXT,
      final_commit TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      sandbox_path TEXT,
      started_at TEXT,
      completed_at TEXT,
      failure_reason TEXT,
      execution_summary TEXT,
      merge_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE locks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      lock_type TEXT NOT NULL DEFAULT 'exclusive',
      owner_run_id TEXT NOT NULL REFERENCES runs(id),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertWorkspace(db: Database.Database, id = "ws_TEST001") {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspaces (id, customer_id, name, repo_location, created_at, updated_at, last_accessed_at)
    VALUES (?, 'test', 'Test', '/tmp', ?, ?, ?)
  `).run(id, now, now, now);
}

function insertRun(db: Database.Database, id: string, workspaceId = "ws_TEST001") {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO runs (id, workspace_id, agent_id, status, merge_status, created_at, updated_at)
    VALUES (?, ?, 'agent', 'running', 'pending', ?, ?)
  `).run(id, workspaceId, now, now);
}

vi.mock("../../src/db", () => ({
  getDb: () => mockDb,
}));

import {
  acquireLock,
  releaseLock,
  releaseLocksForRun,
  heartbeatLock,
  getWorkspaceLock,
  runHoldsLock,
  expireStale,
} from "../../src/services/lock.service";

describe("Lock Service", () => {
  beforeEach(() => {
    mockDb = initTestDb();
    insertWorkspace(mockDb);
    insertRun(mockDb, "run_001");
    insertRun(mockDb, "run_002");
  });

  afterEach(() => {
    mockDb.close();
  });

  it("should acquire an exclusive lock", () => {
    const lock = acquireLock("ws_TEST001", "run_001");
    expect(lock.id).toMatch(/^lock_/);
    expect(lock.workspaceId).toBe("ws_TEST001");
    expect(lock.lockType).toBe("exclusive");
    expect(lock.ownerRunId).toBe("run_001");
  });

  it("should reject second exclusive lock", () => {
    acquireLock("ws_TEST001", "run_001");
    expect(() => acquireLock("ws_TEST001", "run_002")).toThrow("already locked");
  });

  it("should release a lock", () => {
    const lock = acquireLock("ws_TEST001", "run_001");
    releaseLock(lock.id);
    const current = getWorkspaceLock("ws_TEST001");
    expect(current).toBeNull();
  });

  it("should release all locks for a run", () => {
    insertWorkspace(mockDb, "ws_TEST002");
    insertRun(mockDb, "run_003", "ws_TEST002");

    // Note: A run can only hold one lock (one per workspace), but we test the batch release
    const lock = acquireLock("ws_TEST001", "run_001");
    releaseLocksForRun("run_001");
    expect(getWorkspaceLock("ws_TEST001")).toBeNull();
  });

  it("should heartbeat to extend lock", () => {
    const lock = acquireLock("ws_TEST001", "run_001");
    const extended = heartbeatLock(lock.id, 10 * 60 * 1000);
    expect(new Date(extended.expiresAt).getTime()).toBeGreaterThan(
      new Date(lock.expiresAt).getTime()
    );
  });

  it("should check if run holds lock", () => {
    acquireLock("ws_TEST001", "run_001");
    expect(runHoldsLock("ws_TEST001", "run_001")).toBe(true);
    expect(runHoldsLock("ws_TEST001", "run_002")).toBe(false);
  });

  it("should expire stale locks", () => {
    // Insert a lock with past expiry directly
    const now = new Date();
    const past = new Date(now.getTime() - 60000).toISOString();
    mockDb.prepare(`
      INSERT INTO locks (id, workspace_id, lock_type, owner_run_id, acquired_at, expires_at, last_heartbeat_at)
      VALUES ('lock_stale', 'ws_TEST001', 'exclusive', 'run_001', ?, ?, ?)
    `).run(past, past, past);

    const expired = expireStale();
    expect(expired).toBe(1);
    expect(getWorkspaceLock("ws_TEST001")).toBeNull();
  });

  it("should allow lock after previous is released", () => {
    const lock1 = acquireLock("ws_TEST001", "run_001");
    releaseLock(lock1.id);
    const lock2 = acquireLock("ws_TEST001", "run_002");
    expect(lock2.ownerRunId).toBe("run_002");
  });
});
