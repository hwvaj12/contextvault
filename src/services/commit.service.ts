import { getStorage, Commit } from "../storage";

export type { Commit };

export async function getCommitHistory(workspaceId: string, limit: number = 20): Promise<Commit[]> {
  return getStorage().listCommits(workspaceId, limit);
}
