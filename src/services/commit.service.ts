import { getStorage, Commit } from "../storage";

export type { Commit };

export function createCommit(
  id: string,
  workspaceId: string,
  parentId: string | null,
  metadata: Record<string, unknown>,
  sizeBytes: number,
  createdAt: string
): Commit {
  return getStorage().createCommit({ id, workspaceId, parentId, metadata, sizeBytes, createdAt });
}

export function getCommitHistory(workspaceId: string, limit: number = 20): Commit[] {
  return getStorage().listCommits(workspaceId, limit);
}
