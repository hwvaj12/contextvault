import type { ErrorCode } from "./errors";
import type { CleanupState, RunState, TerminalRunState } from "./lifecycle";
import type { Manifest } from "./manifest";
import type { OperationKind } from "./model";

/** Wire DTOs contain no private storage locations, server paths, credentials, or processing fences. */
export interface Links { [relation: string]: { href: string } }
export interface CreateWorkspaceRequest { customerId: string; name: string }
export interface OpenRunRequest { mode: "read-only" | "read-write"; agentLabel: string; task: string; reason: string }
export interface SealRequest { manifest: Manifest; receipts: readonly { path: string; receiptId: string }[] }
export interface FinalizeRequest { expectedRunVersion: number; submissionId?: string }
export interface AbortRequest { expectedRunVersion: number; reason: string }
export interface HeartbeatRequest { expectedLeaseVersion: number }
export interface RestoreRequest { revisionId: string; expectedRevisionId: string; expectedWorkspaceVersion: number; reason: string }
export interface CleanupView { state: CleanupState; version: number; attempts: number; lastError: string | null }
export interface RunOutcomeView { state: TerminalRunState; revisionId: string | null; changed: boolean; completedAt: string; errorCode?: ErrorCode }
export interface WorkspaceView {
  id: string; customerId: string; name: string; currentRevisionId: string; version: number;
  status: "active" | "suspended" | "deleted"; createdAt: string; updatedAt: string; _links: Links;
}
export interface RunView {
  id: string; workspaceId: string; mode: "read-only" | "read-write"; agentLabel: string; task: string; reason: string;
  baseRevisionId: string; version: number; state: RunState; expiresAt: string; leaseVersion: number;
  operationId: string | null; outcome: RunOutcomeView | null; cleanup: CleanupView;
  createdAt: string; updatedAt: string; _links: Links;
}
export interface UploadReceiptView {
  id: string; runId: string; submissionId: string; path: string; byteLength: number; sha256: string; completedAt: string;
}
export interface SubmissionView {
  id: string; runId: string; state: "uploading" | "sealed" | "expired"; version: number;
  expiresAt: string; manifestDigest: string | null; sealedAt: string | null; _links: Links;
}
export type OperationResultView =
  | { kind: "finalize"; runState: "finalized" | "conflicted" | "failed"; revisionId: string | null; changed: boolean }
  | { kind: "workspace:create"; workspaceId: string; revisionId: string }
  | { kind: "workspace:status"; workspaceId: string; status: "active" | "suspended" | "deleted" }
  | { kind: "storage:migrate"; migrationId: string; storageBindingId: string; bindingGeneration: number }
  | { kind: "revision:alias"; workspaceId: string; aliases: readonly { alias: string; revisionId: string }[] }
  | { kind: "run:open"; runId: string }
  | { kind: "submission:create"; submissionId: string }
  | { kind: "submission:file"; receiptId: string }
  | { kind: "submission:seal"; submissionId: string; manifestDigest: string }
  | { kind: "run:heartbeat"; runId: string; leaseVersion: number }
  | { kind: "abort"; runState: "aborted"; revisionId: null; changed: false }
  | { kind: "restore"; revisionId: string; changed: boolean };
export interface OperationView {
  id: string; workspaceId: string; runId: string | null; kind: OperationKind;
  state: "pending" | "processing" | "succeeded" | "failed";
  phase: "claimed" | "preparing" | "prepared" | "accepting" | "complete";
  version: number; result: OperationResultView | null;
  error: { code: ErrorCode; message: string; operationId?: string; retryable?: boolean } | null;
  createdAt: string; updatedAt: string; _links: Links;
}
export interface RevisionView {
  id: string; workspaceId: string; parentRevisionId: string | null; manifestDigest: string; createdAt: string; _links: Links;
}
export interface RevisionListView { revisions: readonly RevisionView[]; nextCursor: string | null }
