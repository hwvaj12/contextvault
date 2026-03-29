/** Configuration options for the ContextVault client. */
export interface ClientOptions {
  /** API key used for authentication via the X-API-Key header. */
  apiKey: string;
  /** Base URL of the ContextVault server. Defaults to http://localhost:3000 */
  baseUrl?: string;
  /** Maximum number of retry attempts for network errors. Defaults to 3. */
  maxRetries?: number;
}

/** A ContextVault workspace. */
export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** A sandbox instance created from a workspace checkout. */
export interface Sandbox {
  workspaceId: string;
  sandboxId: string;
  path?: string;
  status?: string;
  createdAt?: string;
}

/** A file entry within a commit or pull response. */
export interface FileEntry {
  path: string;
  content: string;
}

/** Metadata attached to a commit. */
export interface CommitMetadata {
  agentId?: string;
  taskId?: string;
  tags?: string[];
}

/** A commit entry in the workspace history. */
export interface CommitEntry {
  commitId: string;
  workspaceId: string;
  parentId: string | null;
  files?: string[];
  metadata?: CommitMetadata;
  sizeBytes?: number;
  createdAt: string;
}

/** The result of a pull operation. */
export interface PullResult {
  commitId: string | null;
  workspaceId: string;
  parentId?: string | null;
  files: FileEntry[];
  metadata?: CommitMetadata;
  sizeBytes?: number;
  createdAt?: string;
}

/** The result of a commit history request. */
export interface HistoryResult {
  commits: CommitEntry[];
  count: number;
}

/** Options for creating a workspace. */
export interface CreateWorkspaceOptions {
  customerId: string;
  name: string;
}

/** Options for listing workspaces. */
export interface ListWorkspacesOptions {
  customerId?: string;
}

/** Options for committing sandbox changes. */
export interface CommitOptions {
  message?: string;
  author?: string;
  agentId?: string;
  taskId?: string;
  tags?: string[];
}

/** Options for pushing files to a workspace. */
export interface PushOptions {
  files: FileEntry[];
  metadata?: CommitMetadata;
}

/** The result of a push operation. */
export interface PushResult {
  commitId: string;
  workspaceId: string;
  parentId: string | null;
  files: string[];
  metadata?: CommitMetadata;
  sizeBytes: number;
  createdAt: string;
}

/** A diff entry comparing two commits. */
export interface DiffResult {
  from: string;
  to: string;
  diff: Record<string, unknown>[];
}

/** Rollback result. */
export interface RollbackResult {
  commitId: string;
  rolledBackTo: string;
  workspaceId: string;
  files: FileEntry[];
  sizeBytes: number;
  createdAt: string;
}

/** Destroy result for sandbox teardown. */
export interface DestroyResult {
  workspaceId: string;
  status: string;
}

/** Raw API error response shape. */
export interface ApiErrorResponse {
  error: string | { code: string; message: string };
}
