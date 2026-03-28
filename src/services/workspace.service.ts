import { getStorage, Workspace } from "../storage";

export type { Workspace };

export function createWorkspace(id: string, customerId: string, name: string): Workspace {
  return getStorage().createWorkspace({ id, customerId, name });
}

export function getWorkspace(id: string): Workspace | null {
  return getStorage().getWorkspace(id);
}

export function listWorkspaces(): Workspace[] {
  return getStorage().listWorkspaces();
}

export function softDeleteWorkspace(id: string): void {
  getStorage().deleteWorkspace(id);
}

export function updateLatestCommit(id: string, commitId: string, updatedAt: string): void {
  getStorage().updateLatestCommit(id, commitId, updatedAt);
}
