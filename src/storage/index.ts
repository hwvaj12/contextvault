import { IStorage } from "./interfaces";
import * as sqliteWorkspace from "./sqlite-workspace";
import * as sqliteCommit from "./sqlite-commit";

export type { IStorage, Workspace, Commit, CreateWorkspaceInput, CreateCommitInput } from "./interfaces";

class SqliteStorage implements IStorage {
  createWorkspace = sqliteWorkspace.createWorkspace;
  getWorkspace = sqliteWorkspace.getWorkspace;
  listWorkspaces = sqliteWorkspace.listWorkspaces;
  deleteWorkspace = sqliteWorkspace.deleteWorkspace;
  updateLatestCommit = sqliteWorkspace.updateLatestCommit;
  createCommit = sqliteCommit.createCommit;
  listCommits = sqliteCommit.listCommits;
}

let instance: IStorage | null = null;

export function createStorage(): IStorage {
  if (instance) return instance;

  const type = process.env.STORAGE_TYPE || "sqlite";

  switch (type) {
    case "sqlite":
      instance = new SqliteStorage();
      return instance;
    default:
      throw new Error(`Unknown storage type: ${type}`);
  }
}

export function getStorage(): IStorage {
  if (!instance) {
    return createStorage();
  }
  return instance;
}
