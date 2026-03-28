import { db } from "../db/client";

export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    customerId: row.customer_id as string,
    name: row.name as string,
    latestCommitId: (row.latest_commit_id as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string) || null,
  };
}

export function createWorkspace(id: string, customerId: string, name: string): Workspace {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspaces (id, customer_id, name, latest_commit_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL)`
  ).run(id, customerId, name, now, now);

  return { id, customerId, name, latestCommitId: null, createdAt: now, updatedAt: now, deletedAt: null };
}

export function getWorkspace(id: string): Workspace | null {
  const row = db.prepare(
    `SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL`
  ).get(id) as Record<string, unknown> | undefined;

  return row ? rowToWorkspace(row) : null;
}

export function listWorkspaces(): Workspace[] {
  const rows = db.prepare(
    `SELECT * FROM workspaces WHERE deleted_at IS NULL`
  ).all() as Record<string, unknown>[];

  return rows.map(rowToWorkspace);
}

export function softDeleteWorkspace(id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ?`
  ).run(now, now, id);
}

export function updateLatestCommit(id: string, commitId: string, updatedAt: string): void {
  db.prepare(
    `UPDATE workspaces SET latest_commit_id = ?, updated_at = ? WHERE id = ?`
  ).run(commitId, updatedAt, id);
}
