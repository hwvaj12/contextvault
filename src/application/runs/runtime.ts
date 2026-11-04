import { randomUUID } from "node:crypto";
import { WorkspaceError, canonicalRequestDigest, type Action, type CommandIdentity, type CustomerScope, type Operation, type OperationKind, type Principal, type StorageBinding, type StorageBindingId, type Timestamp, type WorkspaceScope } from "../../domain";
import type { AccessPolicy, ControlStore, RevisionStore, SubmissionStore } from "../../ports";
import type { PublicationEvents } from "../../ports/control-store";

export interface LifecycleDependencies {
  control: ControlStore;
  accessPolicy: AccessPolicy;
  submissions: SubmissionStore;
  revisionStore(binding: StorageBinding): RevisionStore | Promise<RevisionStore>;
  /** Construct metadata only, without storage I/O. Never use an agent-selected storage locator. */
  createBinding(scope: WorkspaceScope, id: StorageBindingId, createdAt: Timestamp): StorageBinding | Promise<StorageBinding>;
  ownerId: string;
  now?: () => Timestamp;
  newId?: (kind: string) => string;
  leaseTtlMs?: number;
  processingTtlMs?: number;
  processingRenewIntervalMs?: number;
  hook?: (stage: "before-prepare" | "after-prepare" | "after-record-prepared" | "before-accept" | "after-accept", operation: Operation) => Promise<void>;
}
export interface AuthenticatedCommand<Request> { principal: Principal; idempotencyKey: string; request: Request }
export class LifecycleRuntime {
  readonly leaseTtlMs: number;
  readonly processingTtlMs: number;
  readonly renewalIntervalMs: number;
  constructor(readonly dependencies: LifecycleDependencies) {
    if (!dependencies.ownerId) throw new WorkspaceError("INVALID_REQUEST", "Processing worker identity is required");
    this.leaseTtlMs = dependencies.leaseTtlMs ?? 300_000;
    this.processingTtlMs = dependencies.processingTtlMs ?? 300_000;
    this.renewalIntervalMs = dependencies.processingRenewIntervalMs ?? Math.min(30_000, Math.floor(this.processingTtlMs / 3));
    if (![this.leaseTtlMs, this.processingTtlMs].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(this.renewalIntervalMs) || this.renewalIntervalMs < 0 || this.renewalIntervalMs >= this.processingTtlMs) throw new WorkspaceError("INVALID_REQUEST", "Lifecycle lease settings are invalid");
  }
  get control() { return this.dependencies.control; }
  now(): Timestamp {
    const value = this.dependencies.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new WorkspaceError("INVALID_REQUEST", "Clock must return a valid timestamp");
    return new Date(value).toISOString();
  }
  id(kind: string): string { return this.dependencies.newId?.(kind) ?? `${kind}-${randomUUID()}`; }
  until(now: Timestamp, ttl: number): Timestamp { return new Date(Date.parse(now) + ttl).toISOString(); }
  async authorize(principal: Principal, action: Action, scope: CustomerScope | WorkspaceScope) {
    const decision = await this.dependencies.accessPolicy.evaluate(principal, action, scope);
    if (!decision.allowed) throw new WorkspaceError(decision.code, decision.message);
    return decision.precondition;
  }
  command<Kind extends OperationKind>(kind: Kind, input: AuthenticatedCommand<unknown>, scope: CustomerScope | WorkspaceScope, runId: string | null = null): CommandIdentity<Kind> {
    if (!input.principal?.credential || typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 256) throw new WorkspaceError("INVALID_REQUEST", "An authenticated command and idempotency key are required");
    const workspaceId = "workspaceId" in scope ? scope.workspaceId : null;
    return {
      idempotencyScope: { customerId: scope.customerId, actorId: input.principal.actorId, kind, workspaceId, runId: runId as any },
      idempotencyKey: input.idempotencyKey, operationId: this.id("operation") as any, requestedAt: this.now(),
      requestDigest: canonicalRequestDigest({ schemaVersion: 1, customerId: scope.customerId, actorId: input.principal.actorId, credentialId: input.principal.credential.id, kind,
        resource: { ...(workspaceId ? { workspaceId } : {}), ...(runId ? { runId } : {}) }, payload: input.request }),
    };
  }
  events(operation: Pick<Operation, "id" | "scope" | "runId" | "principal">, type: string, createdAt = this.now()): PublicationEvents {
    const event = { scope: operation.scope, runId: operation.runId, operationId: operation.id, actorId: operation.principal.actorId, type, payload: {}, createdAt };
    return { audit: { ...event, id: `audit-${operation.id}` as any }, outbox: { ...event, id: `outbox-${operation.id}` as any, deliveryState: "pending", version: 1, attempts: 0, nextAttemptAt: createdAt, claim: null } };
  }
}
