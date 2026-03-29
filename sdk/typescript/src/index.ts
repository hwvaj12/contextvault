// Main client
export { ContextVaultClient } from "./client";

// Resource classes
export { Workspaces } from "./workspaces";
export { Webhooks } from "./webhooks";

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
  DiffHunk,
  DiffFile,
  DiffSummary,
  DiffResult,
  RollbackResult,
  DestroyResult,
  BulkDeleteResult,
  ApiErrorResponse,
  WebhookRegistration,
  RegisterWebhookOptions,
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
