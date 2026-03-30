import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// We need to mock the db module before importing run service
let mockDb: Database.Database;

// Inline db initialization for isolated tests
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
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret_hash TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
  return db;
}

function insertTestWorkspace(db: Database.Database, id = "ws_TEST001"): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspaces (id, customer_id, name, repo_location, created_at, updated_at, last_accessed_at)
    VALUES (?, 'test-customer', 'Test Workspace', '/tmp/test', ?, ?, ?)
  `).run(id, now, now, now);
}

// Mock the db module
import { vi } from "vitest";
vi.mock("../../src/db", () => ({
  getDb: () => mockDb,
}));

// Now import services
import { createRun, getRun, transitionRun, getActiveRunsForWorkspace, listRunsForWorkspace } from "../../src/services/run.service";

describe("Run Service", () => {
  beforeEach(() => {
    mockDb = initTestDb();
    insertTestWorkspace(mockDb);
  });

  afterEach(() => {
    mockDb.close();
  });

  it("should create a run", () => {
    const run = createRun("ws_TEST001", "test-agent");
    expect(run).toBeDefined();
    expect(run.id).toMatch(/^run_/);
    expect(run.workspaceId).toBe("ws_TEST001");
    expect(run.agentId).toBe("test-agent");
    expect(run.status).toBe("created");
    expect(run.mergeStatus).toBe("pending");
  });

  it("should get a run by id", () => {
    const created = createRun("ws_TEST001", "test-agent");
    const fetched = getRun(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it("should return null for non-existent run", () => {
    expect(getRun("run_NONEXISTENT")).toBeNull();
  });

  it("should transition through valid states", () => {
    const run = createRun("ws_TEST001", "test-agent");

    const provisioning = transitionRun(run.id, "provisioning");
    expect(provisioning.status).toBe("provisioning");

    const ready = transitionRun(run.id, "ready");
    expect(ready.status).toBe("ready");

    const running = transitionRun(run.id, "running");
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();

    const finalizing = transitionRun(run.id, "finalizing");
    expect(finalizing.status).toBe("finalizing");

    const merged = transitionRun(run.id, "merged", { mergeStatus: "merged" });
    expect(merged.status).toBe("merged");
    expect(merged.mergeStatus).toBe("merged");
    expect(merged.completedAt).toBeDefined();

    const cleaned = transitionRun(run.id, "cleaned_up");
    expect(cleaned.status).toBe("cleaned_up");
  });

  it("should reject invalid state transitions", () => {
    const run = createRun("ws_TEST001", "test-agent");

    expect(() => transitionRun(run.id, "running")).toThrow("Invalid transition");
    expect(() => transitionRun(run.id, "merged")).toThrow("Invalid transition");
    expect(() => transitionRun(run.id, "cleaned_up")).toThrow("Invalid transition");
  });

  it("should allow abort from running", () => {
    const run = createRun("ws_TEST001", "test-agent");
    transitionRun(run.id, "provisioning");
    transitionRun(run.id, "ready");
    transitionRun(run.id, "running");

    const aborted = transitionRun(run.id, "aborted", {
      failureReason: "Test abort",
    });
    expect(aborted.status).toBe("aborted");
    expect(aborted.failureReason).toBe("Test abort");
  });

  it("should store base commit and sandbox path", () => {
    const run = createRun("ws_TEST001", "test-agent");
    const updated = transitionRun(run.id, "provisioning", {
      baseCommit: "abc123",
      workspaceHeadAtStart: "abc123",
      sandboxPath: "/tmp/sandbox/test",
    });
    expect(updated.baseCommit).toBe("abc123");
    expect(updated.workspaceHeadAtStart).toBe("abc123");
    expect(updated.sandboxPath).toBe("/tmp/sandbox/test");
  });

  it("should list active runs for workspace", () => {
    createRun("ws_TEST001", "agent-1");
    createRun("ws_TEST001", "agent-2");
    const run3 = createRun("ws_TEST001", "agent-3");
    // Complete one run
    transitionRun(run3.id, "failed", { failureReason: "test" });

    const active = getActiveRunsForWorkspace("ws_TEST001");
    expect(active).toHaveLength(2);
  });

  it("should list runs for workspace with limit", () => {
    for (let i = 0; i < 5; i++) {
      createRun("ws_TEST001", `agent-${i}`);
    }
    const runs = listRunsForWorkspace("ws_TEST001", 3);
    expect(runs).toHaveLength(3);
  });
});
