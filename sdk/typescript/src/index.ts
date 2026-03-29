// Main client
export { ContextVaultClient } from "./client";

// Resource classes
export { Workspaces } from "./workspaces";
export { Webhooks } from "./webhooks";
export { ApiKeys } from "./apikeys";

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

export type {
  ApiKey,
  ApiKeyWithPlainKey,
  CreateApiKeyOptions,
} from "./apikeys";

// Errors
export {
  ContextVaultError,
  NotFoundError,
  AuthError,
  NetworkError,
  ValidationError,
  ConflictError,
} from "./errors";
