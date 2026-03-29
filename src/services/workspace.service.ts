import { getDb } from "../db";
import { getStorage } from "../storage";
import { Workspace } from "../storage/interfaces";
import { logAuditEvent } from "./audit.service";
import * as path from "path";

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

export async function listWorkspaces(): Promise<Workspace[]> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM workspaces WHERE status != 'deleted' ORDER BY created_at DESC").all() as any[];

  if (rows.length > 0) {
    return rows.map(rowToWorkspace);
  }

  // Fall back to JSON metadata
  return getStorage().listWorkspaces();
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
