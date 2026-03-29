import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { vi } from "vitest";
import simpleGit from "simple-git";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

let mockDb: Database.Database;
let testDir: string;

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

vi.mock("../../src/db", () => ({
  getDb: () => mockDb,
}));

import {
  createWorkspace,
  getWorkspace,
  bulkDeleteWorkspaces,
} from "../../src/services/workspace.service";

describe("Bulk Delete Workspaces", () => {
  beforeEach(async () => {
    mockDb = initTestDb();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-bulk-del-"));

    // Override the data directories so workspace creation uses our temp dir
    const dataDir = path.join(testDir, "data");
    const workspacesDir = path.join(dataDir, "workspaces");
    const metaDir = path.join(dataDir, "workspace-meta");
    const sandboxesDir = path.join(dataDir, "sandboxes");
    await fs.mkdir(workspacesDir, { recursive: true });
    await fs.mkdir(metaDir, { recursive: true });
    await fs.mkdir(sandboxesDir, { recursive: true });
  });

  afterEach(async () => {
    mockDb.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should create 3 workspaces, bulk-delete 2, and verify 1 remains", async () => {
    // Create 3 workspaces
    const ws1 = await createWorkspace("ws_del_1", "cust-1", "Workspace 1");
    const ws2 = await createWorkspace("ws_del_2", "cust-1", "Workspace 2");
    const ws3 = await createWorkspace("ws_del_3", "cust-1", "Workspace 3");

    expect(ws1.id).toBe("ws_del_1");
    expect(ws2.id).toBe("ws_del_2");
    expect(ws3.id).toBe("ws_del_3");

    // Verify all 3 exist
    const before1 = await getWorkspace("ws_del_1");
    const before2 = await getWorkspace("ws_del_2");
    const before3 = await getWorkspace("ws_del_3");
    expect(before1).not.toBeNull();
    expect(before2).not.toBeNull();
    expect(before3).not.toBeNull();

    // Bulk-delete workspaces 1 and 2
    const result = await bulkDeleteWorkspaces(["ws_del_1", "ws_del_2"]);
    expect(result.deleted).toBe(2);
    expect(result.failed).toHaveLength(0);

    // Verify ws_del_1 and ws_del_2 are gone
    const after1 = await getWorkspace("ws_del_1");
    const after2 = await getWorkspace("ws_del_2");
    expect(after1).toBeNull();
    expect(after2).toBeNull();

    // Verify ws_del_3 still exists
    const after3 = await getWorkspace("ws_del_3");
    expect(after3).not.toBeNull();
    expect(after3!.id).toBe("ws_del_3");
    expect(after3!.name).toBe("Workspace 3");

    // Verify DB records are gone for deleted workspaces
    const dbRow1 = mockDb.prepare("SELECT * FROM workspaces WHERE id = ?").get("ws_del_1");
    const dbRow2 = mockDb.prepare("SELECT * FROM workspaces WHERE id = ?").get("ws_del_2");
    expect(dbRow1).toBeUndefined();
    expect(dbRow2).toBeUndefined();

    // Verify DB record still exists for remaining workspace
    const dbRow3 = mockDb.prepare("SELECT * FROM workspaces WHERE id = ?").get("ws_del_3") as any;
    expect(dbRow3).toBeDefined();
    expect(dbRow3.name).toBe("Workspace 3");
  });
});
