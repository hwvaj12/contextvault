import { getStorage, Workspace } from "../storage";

export type { Workspace };

export async function createWorkspace(id: string, customerId: string, name: string): Promise<Workspace> {
  return getStorage().createWorkspace({ id, customerId, name });
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  return getStorage().getWorkspace(id);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return getStorage().listWorkspaces();
}

export async function softDeleteWorkspace(id: string): Promise<void> {
  return getStorage().deleteWorkspace(id);
}
