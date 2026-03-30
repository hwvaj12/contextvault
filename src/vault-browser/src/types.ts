export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface Commit {
  id: string;
  parentId: string | null;
  metadata?: {
    agentId?: string;
    taskId?: string;
    tags?: string[];
  };
  sizeBytes?: number;
  createdAt: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  hunks?: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  content: string; // full unified diff string with \n separated lines
}

export interface DiffResult {
  from: string;
  to: string;
  files: DiffFile[];
  summary: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

export interface ListWorkspacesResponse {
  data: Workspace[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface Webhook {
  id: string;
  customerId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}
