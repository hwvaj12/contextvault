import type {
  ActorId, AuditEvent, AuthorizationPrecondition, BindingScope, CandidateIdentity, CandidateCollectionTarget, CandidateWriter, CleanupId, CleanupStatus, CleanupTargets,
  CollectionPermit, CommandIdentity, CredentialId, CustomerScope, ErrorCode, EventId, Fence, FinalizationIntent, FinalizationOperation, IdempotencyScope, Manifest,
  LegacyRevisionAlias, MigrationId, Operation, OperationId, OutboxEvent, PermissionGrant, PreparedRevision, Principal, ProcessingClaim, ReceiptSelection, Revision,
  RevisionId, Run, RunId, RunScope, Sha256, StorageBinding, StorageBindingId, Submission, SubmissionId, SubmissionWriter, SubmissionCollectionPermit, SubmissionCollectionAttempt, SubmissionCollectionTarget,
  StorageMigration, SubscriptionId, Timestamp, UploadReceipt, VerifiedRevisionCopy, Version, Workspace, WorkspaceCreationIntent, WorkspaceCreationOperation, WorkspaceScope,
} from "../domain";

export interface CompatibilityLock { release(): Promise<void> }
export interface CommandResult<Value, StoredOperation extends Operation = Operation> { value: Value; operation: StoredOperation; replayed: boolean }
export type CollectionWork = { kind: "cleanup"; cleanup: CleanupStatus } | { kind: "candidate"; candidate: CandidateCollectionTarget } | { kind: "submission"; submission: SubmissionCollectionTarget };
export interface PublicationEvents { audit: AuditEvent; outbox: OutboxEvent }
export interface FinalizerPreconditions {
  expectedRunVersion: Version;
  expectedOperationVersion: Version;
  expectedBindingGeneration: number;
  processingFence: Fence;
  authorization: AuthorizationPrecondition;
}
export interface AcceptRevisionInput extends FinalizerPreconditions {
  scope: RunScope;
  operationId: OperationId;
  expectedHeadRevisionId: RevisionId;
  expectedWorkspaceVersion: Version;
  submissionId: SubmissionId;
  candidate: PreparedRevision;
  events: PublicationEvents;
  acceptedAt: Timestamp;
}
export interface ReadOnlyCompletionInput extends FinalizerPreconditions {
  scope: RunScope;
  operationId: OperationId;
  events: PublicationEvents;
  completedAt: Timestamp;
}
export type WorkspaceStatusTransition =
  | { from: "active"; to: "suspended" | "deleted" }
  | { from: "suspended"; to: "active" | "deleted" };
export interface SwitchStorageBindingInput {
  scope: WorkspaceScope;
  principal: Principal;
  authorization: AuthorizationPrecondition;
  migrationId: MigrationId;
  expectedMigrationVersion: Version;
  migrationFence: Fence;
  expectedWorkspaceVersion: Version;
  expectedHeadRevisionId: RevisionId;
  expectedSourceBindingGeneration: number;
  expectedRetainedRevisionSetDigest: Sha256;
  expectedVerifiedCopySetDigest: Sha256;
  events: PublicationEvents;
  now: Timestamp;
}
export interface PublicationResult { run: Run; revision: Revision; operation: Operation }
export interface ProcessingCAS {
  scope: WorkspaceScope;
  operationId: OperationId;
  expectedOperationVersion: Version;
  processingFence: Fence;
  now: Timestamp;
}
export interface ClaimFinalizationInput {
  scope: RunScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity<"finalize">;
  expectedRunVersion: Version; intent: FinalizationIntent; claim: ProcessingClaim; now: Timestamp;
}
export interface ClaimWorkspaceCreationInput {
  principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity<"workspace:create">;
  intent: WorkspaceCreationIntent; claim: ProcessingClaim; now: Timestamp;
}
export interface AcceptWorkspaceCreationInput extends ProcessingCAS {
  authorization: AuthorizationPrecondition;
  initialRevision: PreparedRevision;
  events: PublicationEvents;
}
export interface ExpiredActiveRun {
  scope: RunScope;
  expectedState: "active";
  expectedRunVersion: Version;
  expectedLeaseVersion: Version;
  expectedLeaseExpiresAt: Timestamp;
}
export interface ExpireActiveRunInput extends ExpiredActiveRun { now: Timestamp; events: PublicationEvents }
/** Tenant principals resolve only their own tenant. Administrators must explicitly select one tenant and obtain a current scoped permit. */
export type ResourceLookupContext =
  | { kind: "tenant"; principal: Extract<Principal, { kind: "customer" | "service" }> }
  | {
      kind: "administrator"; principal: Extract<Principal, { kind: "administrator" }>; scope: CustomerScope;
      authorization: AuthorizationPrecondition & { action: "run:read" | "operation:read"; scope: CustomerScope };
    };
export interface CatalogSubscription {
  id: SubscriptionId;
  customerId: CustomerScope["customerId"];
  active: boolean;
  eventTypes: readonly string[];
  destination: string;
  signingSecretRef: string | null;
  /** Frozen presentation metadata shares one canonical event but has its own durable recipient delivery. */
  representation?: { eventType: string; payload: Record<string, unknown>; subscriptionId: SubscriptionId; deliveryId: string };
}
export interface CredentialAuthority {
  credentialId: CredentialId;
  actorId: ActorId;
  customerId: CustomerScope["customerId"] | null;
  credentialVersion: Version;
  permissionEpoch: number;
  policyVersion: Version;
  revokedAt: Timestamp | null;
  grants: readonly PermissionGrant[];
}

/** One transactional authority. Tenant operations use explicit scope; maintenance scans return tenant-scoped records. */
export interface ControlStore {
  claimRestore(input: { scope: WorkspaceScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity<"restore">; intent: import("../domain").RestoreIntent; claim: ProcessingClaim; now: Timestamp }): Promise<{ operation: import("../domain").RestoreOperation; replayed: boolean }>;
  acceptRestore(input: ProcessingCAS & { authorization: AuthorizationPrecondition; candidate: PreparedRevision; events: PublicationEvents }): Promise<import("../domain").RestoreOperation>;
  failRestore(input: ProcessingCAS & { code: ErrorCode; message: string; events: PublicationEvents }): Promise<import("../domain").RestoreOperation>;
  createBundle(input: { scope: CustomerScope; principal: Principal; bundle: import("../domain").BundleRecord }): Promise<import("../domain").BundleRecord>;
  getBundle(scope: CustomerScope, id: string): Promise<import("../domain").BundleRecord | null>;
  selectBundleManifest(input: { scope: CustomerScope; principal: Principal; id: string; expectedVersion: Version; header: import("../domain").SignedWorkspaceBundle; now: Timestamp }): Promise<import("../domain").BundleRecord>;
  completeBundle(input: { scope: CustomerScope; principal: Principal; id: string; expectedVersion: Version; now: Timestamp }): Promise<import("../domain").BundleRecord>;
  /** Coordinate private compatibility metadata across processes, independently of canonical transactions. No lease-based takeover. */
  acquireCompatibilityLock(scope: WorkspaceScope, resource: string): Promise<CompatibilityLock>;
  getWorkspace(scope: WorkspaceScope): Promise<Workspace | null>;
  listWorkspaces(scope: CustomerScope, cursor?: string, limit?: number): Promise<{ workspaces: readonly Workspace[]; nextCursor: string | null }>;
  listWorkspaceMetadata(scope: CustomerScope, offset: number, limit: number): Promise<{ workspaces: readonly Workspace[]; total: number }>;
  getBinding(scope: WorkspaceScope, bindingId: StorageBindingId): Promise<StorageBinding | null>;
  getRevision(scope: WorkspaceScope, revisionId: RevisionId): Promise<Revision | null>;
  listRevisions(scope: WorkspaceScope, cursor?: string, limit?: number): Promise<{ revisions: readonly Revision[]; nextCursor: string | null }>;
  getRun(scope: WorkspaceScope, runId: RunId): Promise<Run | null>;
  listRuns(scope: WorkspaceScope, cursor?: string, limit?: number): Promise<{ runs: readonly Run[]; nextCursor: string | null }>;
  getOperation(scope: WorkspaceScope, operationId: OperationId): Promise<Operation | null>;
  /** Resolve by ID within one authenticated tenant, then enforce current credential/grant policy. No workspace enumeration or unscoped SQL fallback. */
  resolveRun(context: ResourceLookupContext, runId: RunId): Promise<Run | null>;
  /** Includes pending creation operations whose draft workspace is not yet visible. Require the operation:read lookup action. */
  resolveOperation(context: ResourceLookupContext, operationId: OperationId): Promise<Operation | null>;
  findOperation(scope: IdempotencyScope, key: string): Promise<Operation | null>;
  getAuthority(scope: CustomerScope, principal: Principal): Promise<CredentialAuthority | null>;
  /** Explicit grant/revocation updates advance epochs atomically; old authorization can no longer publish. */
  updateAuthority(input: {
    scope: CustomerScope; principal: Principal; authorization: AuthorizationPrecondition; authority: CredentialAuthority;
    expectedCredentialVersion: Version | null; expectedPermissionEpoch: number;
  }): Promise<CredentialAuthority>;

  /** Before any storage I/O, persist exact request, draft IDs/binding, empty manifest, candidate identity, and processing claim atomically. */
  claimWorkspaceCreation(input: ClaimWorkspaceCreationInput): Promise<{ operation: WorkspaceCreationOperation; replayed: boolean }>;
  /** Recheck claim/fence/current authorization, match the persisted candidate, then atomically accept workspace/revision/result/events. */
  acceptWorkspaceCreation(input: AcceptWorkspaceCreationInput): Promise<CommandResult<Workspace, WorkspaceCreationOperation>>;
  /** Record terminal failure only after proving creation acceptance did not commit; retain candidate cleanup state separately. */
  failWorkspaceCreation(input: ProcessingCAS & { code: ErrorCode; message: string; events: PublicationEvents; cleanup: CleanupStatus }): Promise<WorkspaceCreationOperation>;
  /** Pin the current catalog head and binding in the same transaction as command and run creation. */
  openRun(input: {
    scope: WorkspaceScope; principal: Principal; authorization: AuthorizationPrecondition;
    command: CommandIdentity; runId: RunId; cleanupId: CleanupId; mode: Run["mode"];
    agentLabel: string; task: string; reason: string; expiresAt: Timestamp; createdAt: Timestamp;
  }): Promise<CommandResult<Run>>;
  /** Tombstone invalidates publication/access atomically, preserves accepted history, and schedules independent cleanup. */
  transitionWorkspaceStatus(input: {
    scope: WorkspaceScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity;
    expectedVersion: Version; transition: WorkspaceStatusTransition; events: PublicationEvents; now: Timestamp;
  }): Promise<CommandResult<Workspace>>;
  /** Active, unexpired lease CAS only. Never revive expiry or change Run.version. */
  renewRunLease(input: {
    scope: RunScope; principal: Principal; command: CommandIdentity; expectedLeaseVersion: Version; now: Timestamp; expiresAt: Timestamp;
  }): Promise<CommandResult<Run>>;
  /** Check recorded key/digest first. Same-input retries return the persisted operation, including completion. */
  /** Match request, run mode, selected sealed source/version/digest, and candidate scope before persisting intent in the claim transaction. */
  claimFinalization(input: ClaimFinalizationInput): Promise<CommandResult<Run, FinalizationOperation>>;
  /** Abort and finalize race through one active-state/version predicate. Repeated abort returns its recorded result. */
  abortRun(input: {
    scope: RunScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity;
    expectedRunVersion: Version; reason: string; events: PublicationEvents; now: Timestamp;
  }): Promise<CommandResult<Run>>;
  /** Bind legacy push presentation to the exact authorized finalize command before its claim. This metadata never establishes acceptance. */
  recordLegacyPush(input: { scope: RunScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity<"finalize"> }): Promise<void>;
  recordPreparedRevision(input: ProcessingCAS & { candidate: PreparedRevision }): Promise<Operation>;
  /**
   * Atomically recheck ownership, active workspace, authorization/key epochs, head, all versions, binding, and fence.
   * Update head, accepted revision, run result, operation, audit, and outbox together.
   * Equal manifests complete without a new revision, but stale read-write heads still conflict.
   */
  acceptRevision(input: AcceptRevisionInput): Promise<PublicationResult>;
  /** Recheck auth/status/binding/run/operation/fence only. A changed current head/version cannot conflict a pinned read. */
  completeReadOnly(input: ReadOnlyCompletionInput): Promise<PublicationResult>;
  /** Prove acceptance did not commit before recording terminal failure. A stale fence cannot replace any outcome. */
  failFinalization(input: ProcessingCAS & { code: ErrorCode; message: string; events: PublicationEvents }): Promise<Operation>;
  /** Defaults to lifecycle kinds. Composition explicitly selects additional kinds with registered use-case processors. */
  listRecoverableOperations(input: { now: Timestamp; limit: number; kinds?: readonly Operation["kind"][] }): Promise<readonly Operation[]>;
  /** Recovery increments the fence. Additional kinds require an explicit matching registration, without inventing outcomes. */
  claimRecovery(input: { scope: WorkspaceScope; operationId: OperationId; expectedVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp; kind?: Operation["kind"] }): Promise<Operation>;
  renewProcessingClaim(input: ProcessingCAS & { expiresAt: Timestamp }): Promise<Operation>;
  /** Internal bounded scan: active runs with expired client leases only. Processing finalizations are recovery work, never expiry candidates. */
  listExpiredActiveRuns(input: { now: Timestamp; limit: number; cursor?: string }): Promise<{ runs: readonly ExpiredActiveRun[]; nextCursor: string | null }>;
  /** Require stored expiry <= now and CAS active/lifecycle/lease versions. Atomically record expiry/audit/outbox/cleanup without changing accepted contents. */
  expireActiveRun(input: ExpireActiveRunInput): Promise<{ run: Run; cleanup: CleanupStatus }>;

  createSubmission(input: { scope: RunScope; principal: Principal; command: CommandIdentity; submissionId: SubmissionId; expiresAt: Timestamp }): Promise<CommandResult<Submission>>;
  getSubmission(scope: RunScope, submissionId: SubmissionId): Promise<Submission | null>;
  getReceipt(scope: RunScope, submissionId: SubmissionId, receiptId: UploadReceipt["id"]): Promise<UploadReceipt | null>;
  /** Require catalog acknowledgment, or an exact private storage marker plus permanent catalog fencing. Neither absence nor a permit alone proves retirement. */
  isUploadReceiptRetired(receipt: UploadReceipt, storageMarker?: unknown): Promise<boolean>;
  /** Register completed immutable bytes only while both run and submission are writable. */
  registerUploadReceipt(input: { scope: RunScope; principal: Principal; command: CommandIdentity; expectedSubmissionVersion: Version; receipt: UploadReceipt; now: Timestamp }): Promise<CommandResult<UploadReceipt>>;
  /** CAS uploading to sealed, validate selected receipts exactly, and block late registrations in one transaction. */
  sealSubmission(input: {
    scope: RunScope; principal: Principal; command: CommandIdentity; submissionId: SubmissionId; expectedSubmissionVersion: Version;
    manifest: Manifest; manifestDigest: Sha256; receipts: readonly ReceiptSelection[]; now: Timestamp;
  }): Promise<CommandResult<Submission>>;
  expireSubmission(input: { scope: RunScope; submissionId: SubmissionId; expectedVersion: Version; now: Timestamp }): Promise<Submission>;
  /** Persist ownership before opening upload bytes. Only completion proves this writer stopped. */
  beginSubmissionWrite(input: { scope: RunScope; principal: Principal; command: CommandIdentity; submissionId: SubmissionId; writerId: string; attemptKey: string; storeId: string; now: Timestamp }): Promise<SubmissionWriter>;
  finishSubmissionWrite(input: { scope: RunScope; submissionId: SubmissionId; writerId: string; now: Timestamp }): Promise<SubmissionWriter>;
  claimSubmissionCollection(input: { scope: RunScope; submissionId: SubmissionId; now: Timestamp; expiresAt: Timestamp }): Promise<SubmissionCollectionPermit>;
  verifySubmissionCollectionPermit(permit: SubmissionCollectionPermit, now: Timestamp): Promise<boolean>;
  completeSubmissionCollection(permit: SubmissionCollectionPermit, now: Timestamp): Promise<void>;
  listSubmissionCollectionAttempts(input: { permit: SubmissionCollectionPermit; now: Timestamp; limit: number; cursor?: string }): Promise<{ attempts: readonly SubmissionCollectionAttempt[]; nextCursor: string | null }>;
  recordSubmissionCollectionProgress(input: { permit: SubmissionCollectionPermit; attemptId: string; now: Timestamp }): Promise<void>;
  listSubmissionCollectionTargets(input: { now: Timestamp; limit: number; cursor?: string }): Promise<{ submissions: readonly SubmissionCollectionTarget[]; nextCursor: string | null }>;

  getLegacyRevisionAlias(scope: WorkspaceScope, alias: string): Promise<LegacyRevisionAlias | null>;
  /** Register immutable workspace-scoped aliases. Reject conflicting aliases; never replace an existing mapping. */
  registerLegacyRevisionAliases(input: {
    scope: WorkspaceScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity;
    expectedWorkspaceVersion: Version; aliases: readonly LegacyRevisionAlias[]; events: PublicationEvents; now: Timestamp;
  }): Promise<CommandResult<readonly LegacyRevisionAlias[]>>;
  getStorageMigration(scope: WorkspaceScope, migrationId: MigrationId): Promise<StorageMigration | null>;
  /** Claim admission drain atomically. New mutable runs are rejected while this migration remains recoverable. */
  claimStorageMigration(input: {
    scope: WorkspaceScope; principal: Principal; authorization: AuthorizationPrecondition; command: CommandIdentity;
    migrationId: MigrationId; expectedWorkspaceVersion: Version; expectedHeadRevisionId: RevisionId;
    expectedSourceBindingGeneration: number; retainedRevisionSetDigest: Sha256; targetBinding: StorageBinding;
    claim: ProcessingClaim; now: Timestamp;
  }): Promise<StorageMigration>;
  /** Persist resumable, immutable verified copies under the migration fence; protect every source and target from GC. */
  recordVerifiedRevisionCopy(input: {
    scope: WorkspaceScope; migrationId: MigrationId; expectedMigrationVersion: Version; migrationFence: Fence;
    copy: VerifiedRevisionCopy; now: Timestamp;
  }): Promise<StorageMigration>;
  /** Resume a crashed transfer with a strictly newer claim fence and unchanged migration identity/copy checkpoints. */
  claimStorageMigrationRecovery(input: {
    scope: WorkspaceScope; migrationId: MigrationId; expectedMigrationVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp;
  }): Promise<StorageMigration>;
  renewStorageMigrationClaim(input: {
    scope: WorkspaceScope; migrationId: MigrationId; expectedMigrationVersion: Version; migrationFence: Fence; now: Timestamp; expiresAt: Timestamp;
  }): Promise<StorageMigration>;
  /**
   * Recheck authorization, source generation/head/versions, drained mutable runs, and the exact retained/copy sets.
   * Atomically switch every retained reference and binding; preserve revision IDs/history/aliases and record the operation/events.
   * Target generation must increase. A backend configuration toggle cannot perform this operation.
   */
  switchStorageBinding(input: SwitchStorageBindingInput): Promise<CommandResult<Workspace>>;
  /** Release admission only after proving cutover did not commit; preserve copies and source data for explicit cleanup. */
  failStorageMigration(input: {
    scope: WorkspaceScope; migrationId: MigrationId; expectedMigrationVersion: Version; migrationFence: Fence; message: string; now: Timestamp;
  }): Promise<StorageMigration>;

  getCleanup(scope: WorkspaceScope, cleanupId: CleanupId): Promise<CleanupStatus | null>;
  getCleanupTargets(scope: WorkspaceScope, cleanupId: CleanupId, limit?: number, cursor?: string): Promise<CleanupTargets | null>;
  /** Atomically advance durable fair scan positions. Selection confers no storage or publication authority. */
  nextCollectionWork(input: { now: Timestamp }): Promise<CollectionWork | null>;
  listCandidateCollectionTargets(input: { now: Timestamp; limit: number; cursor?: string }): Promise<{ candidates: readonly CandidateCollectionTarget[]; nextCursor: string | null }>;
  listDueCleanup(input: { now: Timestamp; limit: number }): Promise<readonly CleanupStatus[]>;
  claimCleanup(input: { scope: WorkspaceScope; cleanupId: CleanupId; expectedVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp }): Promise<CleanupStatus>;
  completeCleanup(input: { scope: WorkspaceScope; cleanupId: CleanupId; expectedVersion: Version; fence: Fence; now: Timestamp; error: string | null; nextAttemptAt: Timestamp; targetCursor?: string | null }): Promise<CleanupStatus>;
  releaseCleanupClaim(input: { scope: WorkspaceScope; cleanupId: CleanupId; expectedVersion: Version; fence: Fence; now: Timestamp; nextAttemptAt: Timestamp; targetCursor?: string | null }): Promise<CleanupStatus>;
  /** Mark/fence before sweep. Deny accepted history, active bases, operations, migrations, and exports. */
  claimCandidateCollection(input: { scope: BindingScope; candidateId: CandidateIdentity["candidateId"]; now: Timestamp; expiresAt: Timestamp }): Promise<CollectionPermit>;
  /** Confirm the current scoped collection fence immediately before an adapter deletes bytes. */
  verifyCollectionPermit(permit: CollectionPermit, now: Timestamp): Promise<boolean>;
  completeCandidateCollection(permit: CollectionPermit, now: Timestamp): Promise<void>;
  beginCandidateWrite(input: { identity: CandidateIdentity; writerId: string; ownerId: string; now: Timestamp }): Promise<CandidateWriter>;
  finishCandidateWrite(input: { identity: CandidateIdentity; writerId: string; now: Timestamp }): Promise<CandidateWriter>;
  areCandidateWritersStopped(identity: CandidateIdentity, ownerId: string): Promise<boolean>;
  listPendingOutbox(input: { now: Timestamp; limit: number }): Promise<readonly OutboxEvent[]>;
  claimOutbox(input: { scope: WorkspaceScope; eventId: EventId; expectedVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp }): Promise<OutboxEvent>;
  /** Every recipient lookup requires the event's customer scope. Delivery remains at least once with stable IDs. */
  listSubscriptions(scope: CustomerScope, eventType: string): Promise<readonly CatalogSubscription[]>;
  /** Read the immutable tenant-scoped recipient snapshot established by the first outbox claim. */
  listOutboxRecipients(scope: WorkspaceScope, eventId: EventId): Promise<readonly CatalogSubscription[]>;
  listDeliveredSubscriptions(scope: WorkspaceScope, eventId: EventId): Promise<readonly SubscriptionId[]>;
  /** Frozen, unsuccessful recipients due now, ordered by durable prior attempt time. */
  listDueOutboxRecipients(input: { scope: WorkspaceScope; eventId: EventId; now: Timestamp; limit: number }): Promise<readonly { recipient: CatalogSubscription; attempts: number }[]>;
  /** Release a bounded partial delivery batch without retracting receipts or resetting its monotonic fence. */
  releaseOutboxClaim(input: { scope: WorkspaceScope; eventId: EventId; expectedVersion: Version; fence: Fence; now: Timestamp; nextAttemptAt: Timestamp }): Promise<OutboxEvent>;
  recordDelivery(input: { scope: WorkspaceScope; eventId: EventId; subscriptionId: SubscriptionId; expectedVersion: Version; fence: Fence; delivered: boolean; now: Timestamp; nextAttemptAt: Timestamp }): Promise<OutboxEvent>;
  listAudit(scope: WorkspaceScope, cursor?: string, limit?: number): Promise<{ events: readonly AuditEvent[]; nextCursor: string | null }>;
}
