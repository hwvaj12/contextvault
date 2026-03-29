// Main client
export { ContextVaultClient } from "./client";

// Resource classes
export { Workspaces } from "./workspaces";

// Types
export type {
  ClientOptions,
  Workspace,
  Sandbox,
  FileEntry,
  CommitEntry,
  CommitResult,
  CommitMetadata,
  PullResult,
  HistoryResult,
  CreateWorkspaceOptions,
  ListWorkspacesOptions,
  CommitOptions,
  PushOptions,
  PushResult,
  DiffResult,
  RollbackResult,
  DestroyResult,
  ApiErrorResponse,
} from "./types";

// Errors
export {
  ContextVaultError,
  NotFoundError,
  AuthError,
  NetworkError,
  ValidationError,
  ConflictError,
} from "./errors";
