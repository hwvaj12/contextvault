import type { ErrorCode } from "./errors";
import type { CleanupState, MaterializationState, RunState, TerminalRunState } from "./lifecycle";
import type { Manifest } from "./manifest";
import type {
  AbortRequest, CreateWorkspaceRequest, FinalizeRequest, HeartbeatRequest,
  OpenRunRequest, RestoreRequest, RunView, SealRequest,
} from "./http";

declare const opaque: unique symbol;
export type OpaqueId<Name extends string> = string & { readonly [opaque]: Name };
export type CustomerId = OpaqueId<"Customer">;
export type ActorId = OpaqueId<"Actor">;
export type CredentialId = OpaqueId<"Credential">;
export type WorkspaceId = OpaqueId<"Workspace">;
export type StorageBindingId = OpaqueId<"StorageBinding">;
export type RevisionId = OpaqueId<"Revision">;
export type CandidateId = OpaqueId<"Candidate">;
export type RunId = OpaqueId<"Run">;
export type SubmissionId = OpaqueId<"Submission">;
export type ReceiptId = OpaqueId<"Receipt">;
export type OperationId = OpaqueId<"Operation">;
export type CleanupId = OpaqueId<"Cleanup">;
export type EventId = OpaqueId<"Event">;
export type SubscriptionId = OpaqueId<"Subscription">;
export type MigrationId = OpaqueId<"Migration">;
export type ClientSessionId = OpaqueId<"ClientSession">;
export type Timestamp = string;
export type Version = number;
export type Fence = number;
export type Sha256 = string;

export interface CustomerScope { customerId: CustomerId }
export interface WorkspaceScope extends CustomerScope { workspaceId: WorkspaceId }
export interface BindingScope extends WorkspaceScope { storageBindingId: StorageBindingId; bindingGeneration: number }
export interface RunScope extends BindingScope { runId: RunId }

export type Action = "workspace:create" | "workspace:read" | "workspace:write" | "workspace:delete" | "workspace:restore" | "workspace:export" | "workspace:admin" | "workspace:migrate" | "credential:manage" | "run:open-read" | "run:open-write" | "run:read" | "run:upload" | "run:finalize" | "run:abort" | "run:heartbeat" | "operation:read";
export interface PermissionGrant { action: Action; customerId: CustomerId; workspaceId: WorkspaceId | null }
export interface CredentialIdentity {
  id: CredentialId;
  kind: "api-key" | "service" | "external";
  version: Version;
}
interface PrincipalIdentity {
  actorId: ActorId;
  credential: CredentialIdentity;
  /** Catalog-backed revocation and permission epochs, rather than middleware-only claims. */
  permissionEpoch: number;
  authenticatedAt: Timestamp;
}
/** Every variant is verified. Missing identity is never a Principal. */
export type Principal =
  | (PrincipalIdentity & { kind: "customer"; customerId: CustomerId })
  | (PrincipalIdentity & { kind: "service"; customerId: CustomerId })
  | (PrincipalIdentity & { kind: "administrator" });

export interface AuthorizationPrecondition {
  principal: Principal;
  scope: CustomerScope | WorkspaceScope;
  action: Action;
  policyVersion: Version;
  permissionEpoch: number;
  credentialVersion: Version;
}

/** Server-private opaque locator. HTTP DTOs must never serialize this record. */
export interface PrivateLocator { storeId: string; opaqueKey: string }
export interface StorageBinding {
  id: StorageBindingId;
  scope: WorkspaceScope;
  backend: "git" | "s3";
  generation: number;
  location: PrivateLocator;
  configurationRef: string;
  status: "active" | "retired";
  createdAt: Timestamp;
}
export interface Workspace {
  id: WorkspaceId;
  customerId: CustomerId;
  name: string;
  currentRevisionId: RevisionId;
  version: Version;
  status: "active" | "suspended" | "deleted";
  storageBindingId: StorageBindingId;
  bindingGeneration: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
/** Catalog Revision records represent accepted content only. */
export interface Revision {
  id: RevisionId;
  scope: BindingScope;
  parentRevisionId: RevisionId | null;
  manifestDigest: Sha256;
  privateReference: PrivateLocator;
  originatingOperationId: OperationId;
  createdAt: Timestamp;
}
/** Durable preparation proves byte availability, never catalog acceptance. */
export interface PreparedRevision {
  candidateId: CandidateId;
  revisionId: RevisionId;
  scope: BindingScope;
  parentRevisionId: RevisionId | null;
  operationId: OperationId;
  manifestDigest: Sha256;
  privateReference: PrivateLocator;
  preparedAt: Timestamp;
}
/** Persist this identity before preparation; retries must reuse every field. */
export interface CandidateIdentity {
  candidateId: CandidateId;
  revisionId: RevisionId;
  operationId: OperationId;
  scope: BindingScope;
  parentRevisionId: RevisionId | null;
  createdAt: Timestamp;
}
export interface RunLease {
  /** Heartbeat changes this version, never Run.version. */
  version: Version;
  expiresAt: Timestamp;
  lastHeartbeatAt: Timestamp;
}
export interface FinalizationResult {
  kind: "finalize";
  runState: "finalized" | "conflicted" | "failed";
  revisionId: RevisionId | null;
  changed: boolean;
}
export interface RunOutcome {
  state: TerminalRunState;
  revisionId: RevisionId | null;
  changed: boolean;
  completedAt: Timestamp;
  errorCode?: ErrorCode;
}
export interface Run {
  id: RunId;
  scope: BindingScope;
  principal: Principal;
  agentLabel: string;
  task: string;
  reason: string;
  mode: "read-only" | "read-write";
  baseRevisionId: RevisionId;
  workspaceVersionAtOpen: Version;
  /** Lifecycle transitions only. Uploads, seal, and heartbeat never change this version. */
  version: Version;
  state: RunState;
  lease: RunLease;
  operationId: OperationId | null;
  outcome: RunOutcome | null;
  cleanupId: CleanupId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface UploadReceipt {
  id: ReceiptId;
  scope: RunScope;
  submissionId: SubmissionId;
  path: string;
  byteLength: number;
  sha256: Sha256;
  /** Each completed attempt references different immutable bytes. */
  privateReference: PrivateLocator;
  completedAt: Timestamp;
}
export interface ReceiptSelection { path: string; receiptId: ReceiptId }
export interface Submission {
  id: SubmissionId;
  scope: RunScope;
  state: "uploading" | "sealed" | "expired";
  /** Receipt registration and seal use this CAS version, independent of Run.version. */
  version: Version;
  expiresAt: Timestamp;
  manifest: Manifest | null;
  manifestDigest: Sha256 | null;
  receipts: readonly ReceiptSelection[];
  createdAt: Timestamp;
  sealedAt: Timestamp | null;
}
export type OperationKind = "workspace:create" | "workspace:status" | "storage:migrate" | "revision:alias" | "run:open" | "submission:create" | "submission:file" | "submission:seal" | "run:heartbeat" | "finalize" | "abort" | "restore";
export interface IdempotencyScope<Kind extends OperationKind = OperationKind> extends CustomerScope {
  actorId: ActorId;
  kind: Kind;
  workspaceId: WorkspaceId | null;
  runId: RunId | null;
}
export interface CommandIdentity<Kind extends OperationKind = OperationKind> {
  idempotencyScope: IdempotencyScope<Kind>;
  idempotencyKey: string;
  requestDigest: Sha256;
  operationId: OperationId;
  requestedAt: Timestamp;
}
export interface ProcessingClaim { ownerId: string; fence: Fence; expiresAt: Timestamp }
/** Exact validated JSON input. Authentication headers and API credentials are never persisted here. */
export interface JsonRequestSnapshot<Body> { method: "POST"; path: string; body: Body }
export type ReadOnlyFinalizeRequest = Omit<FinalizeRequest, "submissionId"> & { submissionId?: never };
export interface SealedSubmissionSelection {
  submissionId: SubmissionId;
  submissionVersion: Version;
  manifestDigest: Sha256;
}
/** Persist the source, original request, and candidate identity in the finalize claim transaction. */
export type FinalizationIntent =
  | {
      schemaVersion: 1; kind: "finalize"; mode: "read-write";
      request: JsonRequestSnapshot<FinalizeRequest & { submissionId: string }>;
      source: SealedSubmissionSelection; candidateIdentity: CandidateIdentity;
    }
  | {
      schemaVersion: 1; kind: "finalize"; mode: "read-only";
      request: JsonRequestSnapshot<ReadOnlyFinalizeRequest>;
      source: null; candidateIdentity: null;
    };
/** Draft metadata stays invisible to workspace reads until atomic creation acceptance. */
export interface WorkspaceCreationIntent {
  schemaVersion: 1;
  kind: "workspace:create";
  request: JsonRequestSnapshot<CreateWorkspaceRequest> & { path: "/v1/workspaces" };
  workspace: Workspace;
  binding: StorageBinding;
  candidateIdentity: CandidateIdentity & { parentRevisionId: null };
  initialManifest: { schemaVersion: 1; entries: readonly [] };
  initialManifestDigest: Sha256;
}
export type OperationResult = FinalizationResult
  | { kind: "workspace:create"; workspaceId: WorkspaceId; revisionId: RevisionId }
  | { kind: "workspace:status"; workspaceId: WorkspaceId; status: Workspace["status"] }
  | { kind: "storage:migrate"; migrationId: MigrationId; storageBindingId: StorageBindingId; bindingGeneration: number }
  | { kind: "revision:alias"; workspaceId: WorkspaceId; aliases: readonly LegacyRevisionAlias[] }
  | { kind: "run:open"; runId: RunId }
  | { kind: "submission:create"; submissionId: SubmissionId }
  | { kind: "submission:file"; receiptId: ReceiptId }
  | { kind: "submission:seal"; submissionId: SubmissionId; manifestDigest: Sha256 }
  | { kind: "run:heartbeat"; runId: RunId; leaseVersion: Version }
  | { kind: "abort"; runState: "aborted"; revisionId: null; changed: false }
  | { kind: "restore"; revisionId: RevisionId; changed: boolean };
export interface OperationRecord<Kind extends OperationKind> {
  id: OperationId;
  kind: Kind;
  scope: WorkspaceScope;
  runId: RunId | null;
  principal: Principal;
  command: CommandIdentity<Kind>;
  state: "pending" | "processing" | "succeeded" | "failed";
  phase: "claimed" | "preparing" | "prepared" | "accepting" | "complete";
  version: Version;
  claim: ProcessingClaim | null;
  candidate: PreparedRevision | null;
  result: Extract<OperationResult, { kind: Kind }> | null;
  error: { code: ErrorCode; message: string; retryable: boolean } | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export type FinalizationOperation = OperationRecord<"finalize"> & { runId: RunId; intent: FinalizationIntent };
export type WorkspaceCreationOperation = OperationRecord<"workspace:create"> & { runId: null; intent: WorkspaceCreationIntent };
export type OtherOperation = {
  [Kind in Exclude<OperationKind, "finalize" | "workspace:create">]: OperationRecord<Kind> & {
    intent: { kind: "command"; candidateIdentity: CandidateIdentity | null };
  }
}[Exclude<OperationKind, "finalize" | "workspace:create">];
export type Operation = FinalizationOperation | WorkspaceCreationOperation | OtherOperation;
export interface AuditEvent {
  id: EventId;
  scope: WorkspaceScope;
  runId: RunId | null;
  operationId: OperationId;
  actorId: ActorId;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: Timestamp;
}
export interface OutboxEvent extends AuditEvent {
  deliveryState: "pending" | "running" | "complete" | "failed";
  version: Version;
  attempts: number;
  nextAttemptAt: Timestamp;
  claim: ProcessingClaim | null;
}
export interface CleanupStatus {
  id: CleanupId;
  scope: WorkspaceScope;
  runId: RunId | null;
  state: CleanupState;
  version: Version;
  attempts: number;
  claim: ProcessingClaim | null;
  nextAttemptAt: Timestamp;
  lastError: string | null;
}
export interface CollectionPermit {
  scope: BindingScope;
  candidateId: CandidateId;
  privateReference: PrivateLocator;
  collectionFence: Fence;
  expiresAt: Timestamp;
}
export interface LegacyRevisionAlias { alias: string; revisionId: RevisionId }
export interface VerifiedRevisionCopy {
  revisionId: RevisionId;
  sourceManifestDigest: Sha256;
  target: PreparedRevision;
  /** Recorded only after exact source/target file bytes and manifests match. */
  verifiedAt: Timestamp;
}
/** Admission drain and copy checkpoints are catalog state, never an adapter-local current pointer. */
export interface StorageMigration {
  id: MigrationId;
  scope: WorkspaceScope;
  command: CommandIdentity;
  sourceBindingId: StorageBindingId;
  sourceBindingGeneration: number;
  targetBinding: StorageBinding;
  expectedHeadRevisionId: RevisionId;
  retainedRevisionSetDigest: Sha256;
  state: "draining" | "copying" | "verified" | "complete" | "failed";
  version: Version;
  claim: ProcessingClaim;
  copies: readonly VerifiedRevisionCopy[];
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  switchedAt: Timestamp | null;
}
/** Client identity is constructible directly from RunView, without catalog binding data. */
export type ClientRunIdentity = Pick<RunView, "id" | "workspaceId" | "baseRevisionId" | "version" | "mode">;
export interface ClientSealedSubmissionSelection { submissionId: string; manifestDigest: Sha256 }
interface PendingCommandRecord<Kind extends string, Request> {
  kind: Kind;
  idempotencyKey: string;
  request: Request;
  phase: "prepared" | "dispatched" | "outcome-unknown";
  operationId: string | null;
  preparedAt: Timestamp;
}
type PendingJsonCommand<Kind extends string, Body> = PendingCommandRecord<Kind, JsonRequestSnapshot<Body>>;
/** Save this record durably before dispatch. A retry reuses the stored key, request, and immutable source. */
export type PendingClientCommand =
  | PendingJsonCommand<"workspace:create", CreateWorkspaceRequest>
  | PendingJsonCommand<"run:open", OpenRunRequest>
  | PendingJsonCommand<"submission:create", Record<string, never>>
  | PendingJsonCommand<"submission:seal", SealRequest>
  | PendingJsonCommand<"run:heartbeat", HeartbeatRequest>
  | PendingJsonCommand<"abort", AbortRequest>
  | PendingJsonCommand<"restore", RestoreRequest>
  | (PendingJsonCommand<"finalize", FinalizeRequest & { submissionId: string }> & {
      mode: "read-write"; selectedSubmission: ClientSealedSubmissionSelection;
    })
  | (PendingJsonCommand<"finalize", ReadOnlyFinalizeRequest> & {
      mode: "read-only"; selectedSubmission: null;
    })
  | PendingCommandRecord<"submission:file", {
      method: "PUT"; path: string;
      /** Private immutable capture bytes survive restart; credentials never belong in this record. */
      capture: { captureId: string; privateFilePath: string; byteLength: number; sha256: Sha256 };
    }>;
/** Exists before workspace, run, or operation IDs are known. It is private client state, outside submitted contents. */
export interface LocalClientSessionState {
  schemaVersion: 1;
  sessionId: ClientSessionId;
  /** Validated HTTP origin without embedded credentials. */
  serverOrigin: string;
  workspaceId: string | null;
  run: ClientRunIdentity | null;
  /** An absolute path on the client's host, never a remote-server path. */
  path: string | null;
  /** Private state lives outside path and is excluded from capture/export. */
  privateStatePath: string;
  state: MaterializationState;
  pendingCommand: PendingClientCommand | null;
}
export interface LocalWorkspaceHandle extends LocalClientSessionState { workspaceId: string; run: ClientRunIdentity; path: string }

export interface Clock { now(): Timestamp }
export interface IdGenerator { next<Name extends string>(kind: Name): OpaqueId<Name> }
export interface FaultHooks { reach(point: string, scope: WorkspaceScope, operationId: OperationId): Promise<void> }
