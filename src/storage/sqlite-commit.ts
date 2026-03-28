import { db } from "../db/client";
import { Commit, CreateCommitInput } from "./interfaces";

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

export function createCommit(data: CreateCommitInput): Commit {
  db.prepare(
    `INSERT INTO commits (id, workspace_id, parent_id, metadata, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    data.id,
    data.workspaceId,
    data.parentId,
    JSON.stringify(data.metadata),
    data.sizeBytes,
    data.createdAt
  );

  return {
    id: data.id,
    workspaceId: data.workspaceId,
    parentId: data.parentId,
    metadata: data.metadata,
    sizeBytes: data.sizeBytes,
    createdAt: data.createdAt,
  };
}

export function listCommits(workspaceId: string, limit: number = 20): Commit[] {
  const rows = db.prepare(
    `SELECT * FROM commits WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(workspaceId, limit) as Record<string, unknown>[];

  return rows.map(rowToCommit);
}
