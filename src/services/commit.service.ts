import { db } from "../db/client";

export interface Commit {
  id: string;
  workspaceId: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
}

function rowToCommit(row: Record<string, unknown>): Commit {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    parentId: (row.parent_id as string) || null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    sizeBytes: row.size_bytes as number,
    createdAt: row.created_at as string,
  };
}

export function createCommit(
  id: string,
  workspaceId: string,
  parentId: string | null,
  metadata: Record<string, unknown>,
  sizeBytes: number,
  createdAt: string
): Commit {
  db.prepare(
    `INSERT INTO commits (id, workspace_id, parent_id, metadata, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, parentId, JSON.stringify(metadata), sizeBytes, createdAt);

  return { id, workspaceId, parentId, metadata, sizeBytes, createdAt };
}

export function getCommitHistory(workspaceId: string, limit: number = 20): Commit[] {
  const rows = db.prepare(
    `SELECT * FROM commits WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(workspaceId, limit) as Record<string, unknown>[];

  return rows.map(rowToCommit);
}
