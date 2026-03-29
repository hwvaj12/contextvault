import { getDb } from "../db";
import { ulid } from "ulid";
import { logAuditEvent } from "./audit.service";

export interface Lock {
  id: string;
  workspaceId: string;
  lockType: "exclusive" | "shared";
  ownerRunId: string;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
}

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function rowToLock(row: any): Lock {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    lockType: row.lock_type,
    ownerRunId: row.owner_run_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

/** Remove expired locks */
export function expireStale(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare("DELETE FROM locks WHERE expires_at < ?").run(now);
  return result.changes;
}

/** Acquire a lock on a workspace for a run */
export function acquireLock(
  workspaceId: string,
  runId: string,
  lockType: "exclusive" | "shared" = "exclusive",
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): Lock {
  const db = getDb();

  // Clean up expired locks first
  expireStale();

  // Check for existing locks
  const existing = db.prepare(
    "SELECT * FROM locks WHERE workspace_id = ?"
  ).all(workspaceId) as any[];

  if (existing.length > 0) {
    if (lockType === "exclusive") {
      throw new Error(
        `Workspace ${workspaceId} is already locked by run ${existing[0].owner_run_id}`
      );
    }
    // Shared lock requested — check if any exclusive lock exists
    const hasExclusive = existing.some((l: any) => l.lock_type === "exclusive");
    if (hasExclusive) {
      throw new Error(
        `Workspace ${workspaceId} has an exclusive lock held by run ${existing.find((l: any) => l.lock_type === "exclusive").owner_run_id}`
      );
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const lock: Lock = {
    id: `lock_${ulid()}`,
    workspaceId,
    lockType,
    ownerRunId: runId,
    acquiredAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastHeartbeatAt: now.toISOString(),
  };

  db.prepare(`
    INSERT INTO locks (id, workspace_id, lock_type, owner_run_id, acquired_at, expires_at, last_heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    lock.id,
    lock.workspaceId,
    lock.lockType,
    lock.ownerRunId,
    lock.acquiredAt,
    lock.expiresAt,
    lock.lastHeartbeatAt
  );

  logAuditEvent({
    workspaceId,
    runId,
    actorType: "system",
    actorId: "lock-service",
    eventType: "lock.acquired",
    payload: { lockId: lock.id, lockType, ttlMs },
  });

  return lock;
}

/** Release a lock */
export function releaseLock(lockId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT * FROM locks WHERE id = ?").get(lockId) as any;
  if (!row) return;

  db.prepare("DELETE FROM locks WHERE id = ?").run(lockId);

  logAuditEvent({
    workspaceId: row.workspace_id,
    runId: row.owner_run_id,
    actorType: "system",
    actorId: "lock-service",
    eventType: "lock.released",
    payload: { lockId },
  });
}

/** Release all locks for a run */
export function releaseLocksForRun(runId: string): void {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM locks WHERE owner_run_id = ?").all(runId) as any[];
  for (const row of rows) {
    releaseLock(row.id);
  }
}

/** Heartbeat to extend lock TTL */
export function heartbeatLock(lockId: string, ttlMs: number = DEFAULT_LOCK_TTL_MS): Lock {
  const db = getDb();
  const row = db.prepare("SELECT * FROM locks WHERE id = ?").get(lockId) as any;
  if (!row) throw new Error(`Lock ${lockId} not found`);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  db.prepare(
    "UPDATE locks SET last_heartbeat_at = ?, expires_at = ? WHERE id = ?"
  ).run(now.toISOString(), expiresAt.toISOString(), lockId);

  return { ...rowToLock(row), lastHeartbeatAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
}

/** Get active lock for a workspace */
export function getWorkspaceLock(workspaceId: string): Lock | null {
  const db = getDb();
  expireStale();
  const row = db.prepare("SELECT * FROM locks WHERE workspace_id = ? LIMIT 1").get(workspaceId) as any;
  return row ? rowToLock(row) : null;
}

/** Check if a run holds the lock for a workspace */
export function runHoldsLock(workspaceId: string, runId: string): boolean {
  const db = getDb();
  expireStale();
  const row = db.prepare(
    "SELECT 1 FROM locks WHERE workspace_id = ? AND owner_run_id = ?"
  ).get(workspaceId, runId);
  return !!row;
}
