export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Commit {
  id: string;
  workspaceId: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
}

export interface CreateWorkspaceInput {
  id: string;
  customerId: string;
  name: string;
}

export interface CreateCommitInput {
  id: string;
  workspaceId: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
}

export interface IStorage {
  // Workspace operations
  createWorkspace(data: CreateWorkspaceInput): Workspace;
  getWorkspace(id: string): Workspace | null;
  listWorkspaces(): Workspace[];
  deleteWorkspace(id: string): void;
  updateLatestCommit(id: string, commitId: string, updatedAt: string): void;

  // Commit operations
  createCommit(data: CreateCommitInput): Commit;
  listCommits(workspaceId: string, limit?: number): Commit[];
}
