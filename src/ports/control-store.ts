import type {
  ActorId, AuditEvent, AuthorizationPrecondition, BindingScope, CandidateIdentity, CleanupId, CleanupStatus,
  CollectionPermit, CommandIdentity, CredentialId, CustomerScope, ErrorCode, EventId, Fence, FinalizationIntent, FinalizationOperation, IdempotencyScope, Manifest,
  LegacyRevisionAlias, MigrationId, Operation, OperationId, OutboxEvent, PermissionGrant, PreparedRevision, Principal, ProcessingClaim, ReceiptSelection, Revision,
  RevisionId, Run, RunId, RunScope, Sha256, StorageBinding, StorageBindingId, Submission, SubmissionId,
  StorageMigration, SubscriptionId, Timestamp, UploadReceipt, VerifiedRevisionCopy, Version, Workspace, WorkspaceCreationIntent, WorkspaceCreationOperation, WorkspaceScope,
} from "../domain";

export interface CommandResult<Value, StoredOperation extends Operation = Operation> { value: Value; operation: StoredOperation; replayed: boolean }
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
  getWorkspace(scope: WorkspaceScope): Promise<Workspace | null>;
  listWorkspaces(scope: CustomerScope, cursor?: string, limit?: number): Promise<{ workspaces: readonly Workspace[]; nextCursor: string | null }>;
  getBinding(scope: WorkspaceScope, bindingId: StorageBindingId): Promise<StorageBinding | null>;
  getRevision(scope: WorkspaceScope, revisionId: RevisionId): Promise<Revision | null>;
  listRevisions(scope: WorkspaceScope, cursor?: string, limit?: number): Promise<{ revisions: readonly Revision[]; nextCursor: string | null }>;
  getRun(scope: WorkspaceScope, runId: RunId): Promise<Run | null>;
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
  listRecoverableOperations(input: { now: Timestamp; limit: number }): Promise<readonly Operation[]>;
  /** Recovery increments the fencing token monotonically and preserves persisted candidate identity. */
  claimRecovery(input: { scope: WorkspaceScope; operationId: OperationId; expectedVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp }): Promise<Operation>;
  renewProcessingClaim(input: ProcessingCAS & { expiresAt: Timestamp }): Promise<Operation>;
  /** Internal bounded scan: active runs with expired client leases only. Processing finalizations are recovery work, never expiry candidates. */
  listExpiredActiveRuns(input: { now: Timestamp; limit: number; cursor?: string }): Promise<{ runs: readonly ExpiredActiveRun[]; nextCursor: string | null }>;
  /** Require stored expiry <= now and CAS active/lifecycle/lease versions. Atomically record expiry/audit/outbox/cleanup without changing accepted contents. */
  expireActiveRun(input: ExpireActiveRunInput): Promise<{ run: Run; cleanup: CleanupStatus }>;

  createSubmission(input: { scope: RunScope; principal: Principal; command: CommandIdentity; submissionId: SubmissionId; expiresAt: Timestamp }): Promise<CommandResult<Submission>>;
  getSubmission(scope: RunScope, submissionId: SubmissionId): Promise<Submission | null>;
  getReceipt(scope: RunScope, submissionId: SubmissionId, receiptId: UploadReceipt["id"]): Promise<UploadReceipt | null>;
  /** Register completed immutable bytes only while both run and submission are writable. */
  registerUploadReceipt(input: { scope: RunScope; principal: Principal; command: CommandIdentity; expectedSubmissionVersion: Version; receipt: UploadReceipt; now: Timestamp }): Promise<CommandResult<UploadReceipt>>;
  /** CAS uploading to sealed, validate selected receipts exactly, and block late registrations in one transaction. */
  sealSubmission(input: {
    scope: RunScope; principal: Principal; command: CommandIdentity; submissionId: SubmissionId; expectedSubmissionVersion: Version;
    manifest: Manifest; manifestDigest: Sha256; receipts: readonly ReceiptSelection[]; now: Timestamp;
  }): Promise<CommandResult<Submission>>;
  expireSubmission(input: { scope: RunScope; submissionId: SubmissionId; expectedVersion: Version; now: Timestamp }): Promise<Submission>;

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
  listDueCleanup(input: { now: Timestamp; limit: number }): Promise<readonly CleanupStatus[]>;
  claimCleanup(input: { scope: WorkspaceScope; cleanupId: CleanupId; expectedVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp }): Promise<CleanupStatus>;
  completeCleanup(input: { scope: WorkspaceScope; cleanupId: CleanupId; expectedVersion: Version; fence: Fence; now: Timestamp; error: string | null; nextAttemptAt: Timestamp }): Promise<CleanupStatus>;
  /** Mark/fence before sweep. Deny accepted history, active bases, operations, migrations, and exports. */
  claimCandidateCollection(input: { scope: BindingScope; candidateId: CandidateIdentity["candidateId"]; now: Timestamp; expiresAt: Timestamp }): Promise<CollectionPermit>;
  listPendingOutbox(input: { now: Timestamp; limit: number }): Promise<readonly OutboxEvent[]>;
  claimOutbox(input: { scope: WorkspaceScope; eventId: EventId; expectedVersion: Version; ownerId: string; now: Timestamp; expiresAt: Timestamp }): Promise<OutboxEvent>;
  /** Every recipient lookup requires the event's customer scope. Delivery remains at least once with stable IDs. */
  listSubscriptions(scope: CustomerScope, eventType: string): Promise<readonly CatalogSubscription[]>;
  recordDelivery(input: { scope: WorkspaceScope; eventId: EventId; subscriptionId: SubscriptionId; expectedVersion: Version; fence: Fence; delivered: boolean; now: Timestamp; nextAttemptAt: Timestamp }): Promise<OutboxEvent>;
  listAudit(scope: WorkspaceScope, cursor?: string, limit?: number): Promise<{ events: readonly AuditEvent[]; nextCursor: string | null }>;
}
