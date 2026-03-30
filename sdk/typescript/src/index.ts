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
  WorkspaceBundleManifest,
  BundleFile,
  ExportResult,
  ImportResult,
  BundleVerificationResult,
  ImportWorkspaceOptions,
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

// Bundle verification
export {
  verifyWorkspaceBundle,
  verifyWorkspaceBundleSignature,
  CONTEXTVAULT_PUBLIC_KEY_CURRENT,
  ContextVaultPublicKeys,
  type ContextVaultPublicKey,
  type BundleVerificationResult,
  type ImportVerificationResult,
} from "./bundles";
