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

import { createRun, getRun, transitionRun } from "../../src/services/run.service";
import { acquireLock, releaseLock, releaseLocksForRun } from "../../src/services/lock.service";
import {
  createRunBranch,
  buildStructuredCommitMessage,
  detectChanges,
  commitOnRunBranch,
  mergeRunBranch,
  deleteRunBranch,
} from "../../src/services/commit-gateway.service";
import { validatePath } from "../../src/utils/path-safety";
import { getAuditEvents } from "../../src/services/audit.service";

describe("Full Lifecycle Integration", () => {
  beforeEach(async () => {
    mockDb = initTestDb();

    // Create a temp directory to act as workspace repo
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-test-"));
    const repoDir = path.join(testDir, "workspace");
    await fs.mkdir(repoDir, { recursive: true });

    // Init a git repo with an initial commit
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig("receive.denyCurrentBranch", "updateInstead");
    await fs.writeFile(path.join(repoDir, "README.md"), "# Test Workspace\n");
    await git.add("-A");
    await git.commit("Initial commit");

    // Insert workspace into DB pointing to our temp repo
    const now = new Date().toISOString();
    const head = (await git.raw(["rev-parse", "HEAD"])).trim();
    mockDb.prepare(`
      INSERT INTO workspaces (id, customer_id, name, repo_location, current_head, created_at, updated_at, last_accessed_at)
      VALUES ('ws_INTTEST', 'cust-1', 'Integration Test', ?, ?, ?, ?, ?)
    `).run(repoDir, head, now, now, now);
  });

  afterEach(async () => {
    mockDb.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should run full lifecycle: create run → lock → branch → modify → commit → merge → cleanup", async () => {
    const repoDir = path.join(testDir, "workspace");

    // 1. Create run
    const run = createRun("ws_INTTEST", "test-agent");
    expect(run.status).toBe("created");

    // 2. Acquire lock
    const lock = acquireLock("ws_INTTEST", run.id);
    expect(lock.lockType).toBe("exclusive");

    // 3. Transition to provisioning
    transitionRun(run.id, "provisioning");

    // 4. Create run branch
    const { branchName, baseCommit } = await createRunBranch("ws_INTTEST", run.id);
    expect(branchName).toBe(`run/${run.id}`);

    // Update run with base commit and sandbox path
    transitionRun(run.id, "ready", {
      baseCommit,
      workspaceHeadAtStart: baseCommit,
      sandboxPath: repoDir,
    });

    // 5. Transition to running
    transitionRun(run.id, "running");

    // 6. Switch to run branch and make changes
    const git = simpleGit(repoDir);
    await git.raw(["checkout", branchName]);

    // Validate path safety
    validatePath(repoDir, "notes/session.md");

    // Write a new file
    await fs.mkdir(path.join(repoDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "notes/session.md"), "# Session Notes\n\nTest content.\n");

    // Modify existing file
    await fs.writeFile(path.join(repoDir, "README.md"), "# Test Workspace\n\nUpdated.\n");

    // 7. Detect changes
    const changes = await detectChanges(repoDir, baseCommit);
    expect(changes.added).toContain("notes/session.md");
    expect(changes.modified).toContain("README.md");

    // 8. Build structured commit message
    const commitMsg = buildStructuredCommitMessage({
      workspaceId: "ws_INTTEST",
      runId: run.id,
      agentId: "test-agent",
      changes,
      summary: "Added session notes",
    });
    expect(commitMsg.subject).toContain("contextvault:");
    expect(commitMsg.subject).toContain("ws_INTTEST");

    // 9. Commit on run branch
    const commitHash = await commitOnRunBranch(repoDir, commitMsg.full);
    expect(commitHash).toBeTruthy();

    // 10. Switch back to main for merge
    await git.raw(["checkout", "main"]);

    // 11. Transition to finalizing
    transitionRun(run.id, "finalizing");

    // 12. Merge run branch
    const mergeResult = await mergeRunBranch("ws_INTTEST", run.id, "main");
    expect(mergeResult.success).toBe(true);
    expect(mergeResult.mergeType).toBe("fast-forward");

    // 13. Mark as merged
    transitionRun(run.id, "merged", {
      finalCommit: mergeResult.commitHash!,
      mergeStatus: "merged",
    });

    const mergedRun = getRun(run.id);
    expect(mergedRun!.status).toBe("merged");
    expect(mergedRun!.finalCommit).toBeTruthy();

    // 14. Release lock
    releaseLocksForRun(run.id);

    // 15. Delete run branch
    await deleteRunBranch("ws_INTTEST", run.id);

    // 16. Mark cleaned up
    transitionRun(run.id, "cleaned_up");
    const finalRun = getRun(run.id);
    expect(finalRun!.status).toBe("cleaned_up");

    // 17. Verify audit trail
    const events = getAuditEvents("ws_INTTEST");
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("lock.acquired");
    expect(eventTypes).toContain("run.merged");
    expect(eventTypes).toContain("lock.released");
    expect(eventTypes).toContain("run.cleaned_up");

    // 18. Verify files exist in repo after merge
    const readmeContent = await fs.readFile(path.join(repoDir, "README.md"), "utf-8");
    expect(readmeContent).toContain("Updated.");
    const notesContent = await fs.readFile(path.join(repoDir, "notes/session.md"), "utf-8");
    expect(notesContent).toContain("Session Notes");
  });
});
