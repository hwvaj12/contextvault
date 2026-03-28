import { IStorage } from "./interfaces";
import { GitStorage } from "./git-workspace";

export type { IStorage, Workspace, Commit, CreateWorkspaceInput, CreateCommitInput } from "./interfaces";
export { GitStorage } from "./git-workspace";

let instance: GitStorage | null = null;

export function createStorage(): GitStorage {
  if (instance) return instance;
  instance = new GitStorage();
  return instance;
}

export function getStorage(): GitStorage {
  if (!instance) {
    return createStorage();
  }
  return instance;
}
