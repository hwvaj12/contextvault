export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  defaultBranch: string;
  currentHead: string | null;
  status: string;
  storageClass: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
  files?: string[];
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface DiffResult {
  from: string;
  to: string;
  files: DiffFile[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}
