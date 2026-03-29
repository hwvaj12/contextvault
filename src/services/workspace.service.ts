import { getDb } from "../db";
import { getStorage } from "../storage";
import { Workspace } from "../storage/interfaces";
import { logAuditEvent } from "./audit.service";
import { deliver } from "./webhook.service";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";

export type { Workspace };

const DATA_DIR = path.join(process.cwd(), "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    latestCommitId: row.current_head ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.status === "deleted" ? row.updated_at : null,
  };
}

export async function createWorkspace(
  id: string,
  customerId: string,
  name: string
): Promise<Workspace> {
  // Create the git repo via existing storage layer
  const ws = await getStorage().createWorkspace({ id, customerId, name });

  const now = new Date().toISOString();
  const repoLocation = path.join(WORKSPACES_DIR, id);

  // Insert into SQLite
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO workspaces (id, customer_id, name, repo_location, default_branch, current_head, status, storage_class, created_at, updated_at, last_accessed_at)
    VALUES (?, ?, ?, ?, 'main', NULL, 'active', 'standard', ?, ?, ?)
  `).run(id, customerId, name, repoLocation, now, now, now);

  logAuditEvent({
    workspaceId: id,
    actorType: "user",
    actorId: customerId,
    eventType: "workspace.created",
    payload: { name, customerId },
  });

  deliver("workspace.created", { workspaceId: id, customerId, name });

  return {
    ...ws,
  };
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ? AND status != 'deleted'").get(id) as any;

  if (row) {
    // Update last_accessed_at
    db.prepare("UPDATE workspaces SET last_accessed_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id
    );
    return rowToWorkspace(row);
  }

  // Fall back to JSON metadata for backward compatibility
  return getStorage().getWorkspace(id);
}

export interface ListWorkspacesOptions {
  limit?: number;
  offset?: number;
  customerId?: string;
}

export interface ListWorkspacesResult {
  workspaces: Workspace[];
  total: number;
}

export async function listWorkspaces(options: ListWorkspacesOptions = {}): Promise<ListWorkspacesResult> {
  const { limit = 50, offset = 0, customerId } = options;

  const db = getDb();

  if (customerId) {
    const rows = db.prepare(
      "SELECT * FROM workspaces WHERE status != 'deleted' AND customer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(customerId, limit, offset) as any[];

    const total = db.prepare(
      "SELECT COUNT(*) as count FROM workspaces WHERE status != 'deleted' AND customer_id = ?"
    ).get(customerId) as { count: number };

    return {
      workspaces: rows.map(rowToWorkspace),
      total: total.count,
    };
  }

  const rows = db.prepare(
    "SELECT * FROM workspaces WHERE status != 'deleted' ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as any[];

  const total = db.prepare(
    "SELECT COUNT(*) as count FROM workspaces WHERE status != 'deleted'"
  ).get() as { count: number };

  if (rows.length > 0) {
    return {
      workspaces: rows.map(rowToWorkspace),
      total: total.count,
    };
  }

  // Fall back to JSON metadata
  const fallback = await getStorage().listWorkspaces();
  return {
    workspaces: fallback,
    total: fallback.length,
  };
}

export async function softDeleteWorkspace(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE workspaces SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, id);

  // Also delete from JSON metadata for backward compatibility
  await getStorage().deleteWorkspace(id);

  logAuditEvent({
    workspaceId: id,
    actorType: "user",
    actorId: "system",
    eventType: "workspace.deleted",
  });

  deliver("workspace.deleted", { workspaceId: id });
}

export async function deleteWorkspace(id: string): Promise<void> {
  const db = getDb();

  // Remove any active sandbox
  const sandboxDir = path.join(DATA_DIR, "sandboxes", id);
  const sandboxMeta = path.join(DATA_DIR, "sandboxes", `${id}.meta.json`);
  await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(sandboxMeta, { force: true }).catch(() => {});

  // Remove the bare repo
  const repoDir = path.join(WORKSPACES_DIR, id);
  await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});

  // Remove JSON metadata
  const metaFile = path.join(DATA_DIR, "workspace-meta", `${id}.json`);
  await fs.rm(metaFile, { force: true }).catch(() => {});

  // Delete related DB records (audit_events don't have FK, locks/runs do)
  db.prepare("DELETE FROM locks WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM runs WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);

  logAuditEvent({
    workspaceId: id,
    actorType: "user",
    actorId: "system",
    eventType: "workspace.hard_deleted",
  });
}

export interface BulkDeleteResult {
  deleted: number;
  failed: { id: string; error: string }[];
}

export async function bulkDeleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
  let deleted = 0;
  const failed: { id: string; error: string }[] = [];

  for (const id of ids) {
    try {
      await deleteWorkspace(id);
      deleted++;
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return { deleted, failed };
}

export async function cloneWorkspace(
  sourceId: string,
  targetCustomerId: string,
  newName?: string
): Promise<Workspace> {
  // Verify source exists
  const source = await getWorkspace(sourceId);
  if (!source) {
    throw new Error(`Source workspace not found: ${sourceId}`);
  }

  const newId = `ws_${(await import("ulid")).ulid()}`;
  const name = newName || `${source.name} (clone)`;
  const sourceRepoDir = path.join(WORKSPACES_DIR, sourceId);
  const targetRepoDir = path.join(WORKSPACES_DIR, newId);

  // Clone the bare git repo
  const { execSync } = await import("child_process");
  execSync(`git clone --bare "${sourceRepoDir}" "${targetRepoDir}"`, {
    stdio: "pipe",
  });

  const now = new Date().toISOString();

  // Insert new workspace record into SQLite
  const db = getDb();
  const sourceRow = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(sourceId) as any;
  const currentHead = sourceRow?.current_head ?? null;

  db.prepare(`
    INSERT INTO workspaces (id, customer_id, name, repo_location, default_branch, current_head, status, storage_class, created_at, updated_at, last_accessed_at)
    VALUES (?, ?, ?, ?, 'main', ?, 'active', 'standard', ?, ?, ?)
  `).run(newId, targetCustomerId, name, targetRepoDir, currentHead, now, now, now);

  // Write JSON metadata for backward compatibility
  const metaDir = path.join(DATA_DIR, "workspace-meta");
  if (!fsSync.existsSync(metaDir)) {
    await fs.mkdir(metaDir, { recursive: true });
  }
  await fs.writeFile(
    path.join(metaDir, `${newId}.json`),
    JSON.stringify({ id: newId, customerId: targetCustomerId, name, createdAt: now, updatedAt: now })
  );

  logAuditEvent({
    workspaceId: newId,
    actorType: "user",
    actorId: targetCustomerId,
    eventType: "workspace.cloned",
    payload: { sourceWorkspaceId: sourceId, name, customerId: targetCustomerId },
  });

  deliver("workspace.cloned", { sourceWorkspaceId: sourceId, workspaceId: newId, customerId: targetCustomerId, name });

  return {
    id: newId,
    customerId: targetCustomerId,
    name,
    latestCommitId: currentHead,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function updateWorkspaceHead(workspaceId: string, commitHash: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE workspaces SET current_head = ?, updated_at = ? WHERE id = ?").run(
    commitHash,
    now,
    workspaceId
  );
}
