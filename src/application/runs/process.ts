import { WorkspaceError, canonicalJson, manifestDigest, type ErrorCode, type FinalizationOperation, type Operation, type OperationId, type PreparedRevision, type WorkspaceCreationOperation, type WorkspaceScope } from "../../domain";
import type { SnapshotSource } from "../../ports/streams";
import { LifecycleRuntime } from "./runtime";

export interface ProcessOperationInput { scope: WorkspaceScope; operationId: OperationId; processingFence: number }
type RecoverableOperation = FinalizationOperation | WorkspaceCreationOperation;
const terminalFailures = new Set<ErrorCode>(["FORBIDDEN", "CREDENTIAL_REVOKED", "REVISION_CONFLICT", "STORAGE_BINDING_CHANGED", "WORKSPACE_INACTIVE", "WORKSPACE_NOT_FOUND", "INVALID_MANIFEST", "QUOTA_EXCEEDED", "RECEIPT_MISMATCH", "INVALID_REQUEST"]);
function unknown(id: OperationId): WorkspaceError { return new WorkspaceError("PUBLICATION_OUTCOME_UNKNOWN", "Publication requires reconciliation using its durable operation", { operationId: id, retryable: true }); }
function assertClaim(runtime: LifecycleRuntime, operation: Operation, fence: number): asserts operation is RecoverableOperation {
  if (operation.kind !== "workspace:create" && operation.kind !== "finalize") throw new WorkspaceError("INVALID_TRANSITION", "Operation has no lifecycle processor");
  if (operation.state !== "processing" || !operation.claim || operation.claim.fence !== fence || operation.claim.ownerId !== runtime.dependencies.ownerId || operation.claim.expiresAt <= runtime.now()) throw new WorkspaceError("STALE_FENCE", "Processing requires the current unexpired worker claim", { operationId: operation.id });
}

export async function renewProcessingClaim(runtime: LifecycleRuntime, input: ProcessOperationInput): Promise<Operation> {
  const operation = await runtime.control.getOperation(input.scope, input.operationId);
  if (!operation) throw new WorkspaceError("OPERATION_NOT_FOUND", "Operation does not exist");
  assertClaim(runtime, operation, input.processingFence);
  const now = runtime.now();
  const expiresAt = new Date(Math.max(Date.parse(runtime.until(now, runtime.processingTtlMs)), Date.parse(operation.claim!.expiresAt) + 1)).toISOString();
  return runtime.control.renewProcessingClaim({ scope: operation.scope, operationId: operation.id, expectedOperationVersion: operation.version, processingFence: input.processingFence, now, expiresAt });
}

/** Renew only the processing claim while storage runs; never renew the client's run lease. */
async function prepareWithRenewal(runtime: LifecycleRuntime, operation: RecoverableOperation, work: (signal: AbortSignal) => Promise<PreparedRevision>) {
  let current: Operation = operation;
  let renewal = Promise.resolve();
  let renewing = false;
  let renewalError: unknown;
  const controller = new AbortController();
  const timer = runtime.renewalIntervalMs ? setInterval(() => {
    if (renewing || renewalError) return;
    renewing = true;
    renewal = (async () => {
      try {
        const now = runtime.now();
        const expiresAt = new Date(Math.max(Date.parse(runtime.until(now, runtime.processingTtlMs)), Date.parse(current.claim!.expiresAt) + 1)).toISOString();
        current = await runtime.control.renewProcessingClaim({ scope: current.scope, operationId: current.id, expectedOperationVersion: current.version, processingFence: operation.claim!.fence, now, expiresAt });
      } catch (error) { renewalError = error; controller.abort(error); }
      finally { renewing = false; }
    })();
  }, runtime.renewalIntervalMs) : undefined;
  timer?.unref();
  try {
    const candidate = await work(controller.signal);
    if (timer) clearInterval(timer);
    await renewal;
    if (renewalError) throw renewalError;
    return { operation: current as RecoverableOperation, candidate };
  } finally { if (timer) clearInterval(timer); await renewal; }
}

async function reconcile(runtime: LifecycleRuntime, input: ProcessOperationInput, error: unknown): Promise<Operation> {
  let current: Operation | null;
  try { current = await runtime.control.getOperation(input.scope, input.operationId); } catch { throw unknown(input.operationId); }
  if (!current) throw unknown(input.operationId);
  if (current.state === "succeeded" || current.state === "failed") return current;
  if (current.claim?.fence !== input.processingFence || current.claim.ownerId !== runtime.dependencies.ownerId || current.claim.expiresAt <= runtime.now()) throw new WorkspaceError("STALE_FENCE", "Processing claim changed before reconciliation", { operationId: input.operationId });
  if (!(error instanceof WorkspaceError) || !terminalFailures.has(error.code)) {
    if (error instanceof WorkspaceError && ["STALE_FENCE", "VERSION_CONFLICT"].includes(error.code)) throw error;
    throw unknown(input.operationId);
  }
  const cas = { scope: current.scope, operationId: current.id, expectedOperationVersion: current.version, processingFence: input.processingFence, now: runtime.now() };
  try {
    if (current.kind === "finalize") return await runtime.control.failFinalization({ ...cas, code: error.code, message: error.message, events: runtime.events(current, error.code === "REVISION_CONFLICT" ? "run.conflicted" : "run.failed") });
    if (current.kind === "workspace:create") return await runtime.control.failWorkspaceCreation({ ...cas, code: error.code, message: error.message, events: runtime.events(current, "workspace.creation-failed"), cleanup: { id: `cleanup-${current.id}` as any, scope: current.scope, runId: null, state: "pending", version: 1, attempts: 0, claim: null, nextAttemptAt: cas.now, lastError: null } });
  } catch {
    try {
      const reconciled = await runtime.control.getOperation(input.scope, input.operationId);
      if (reconciled?.state === "succeeded" || reconciled?.state === "failed") return reconciled;
      if (reconciled?.claim?.fence !== input.processingFence) throw new WorkspaceError("STALE_FENCE", "Processing claim changed", { operationId: input.operationId });
    } catch (readError) { if (readError instanceof WorkspaceError && readError.code === "STALE_FENCE") throw readError; }
  }
  throw unknown(input.operationId);
}

/** Trusted worker entrypoint. Public retries first enter the catalog command claim and current authorization. */
export async function processOperation(runtime: LifecycleRuntime, input: ProcessOperationInput): Promise<Operation> {
  input = structuredClone(input);
  let operation: Operation | null;
  try { operation = await runtime.control.getOperation(input.scope, input.operationId); } catch { throw unknown(input.operationId); }
  if (!operation) throw new WorkspaceError("OPERATION_NOT_FOUND", "Operation does not exist");
  if (operation.state === "succeeded" || operation.state === "failed") return operation;
  assertClaim(runtime, operation, input.processingFence);
  try {
    await runtime.authorize(operation.principal, operation.kind === "workspace:create" ? "workspace:create" : "run:finalize", operation.kind === "workspace:create" ? { customerId: operation.scope.customerId } : operation.scope);
    if (operation.kind === "workspace:create" || operation.intent.mode === "read-write") {
      const identity = operation.intent.candidateIdentity;
      if (!identity) throw new WorkspaceError("INVALID_TRANSITION", "Mutable publication requires a persisted candidate identity");
      const binding = operation.kind === "workspace:create" ? operation.intent.binding : await runtime.control.getBinding(operation.scope, identity.scope.storageBindingId);
      if (!binding || binding.generation !== identity.scope.bindingGeneration || canonicalJson(binding.scope) !== canonicalJson(operation.scope)) throw new WorkspaceError("STORAGE_BINDING_CHANGED", "Persisted operation binding is unavailable");
      const store = await runtime.dependencies.revisionStore(binding);
      let source: SnapshotSource;
      if (operation.kind === "workspace:create") {
        source = { manifest: operation.intent.initialManifest, async openFile() { throw new WorkspaceError("REVISION_NOT_FOUND", "The initial revision is empty"); } };
      } else {
        const selected = operation.intent.source;
        if (!selected) throw new WorkspaceError("INVALID_TRANSITION", "Mutable publication requires a persisted source");
        const scope = { ...identity.scope, runId: operation.runId };
        const submission = await runtime.dependencies.submissions.get(scope, selected.submissionId);
        if (!submission || submission.state !== "sealed" || submission.version !== selected.submissionVersion || submission.manifestDigest !== selected.manifestDigest || !submission.manifest || manifestDigest(submission.manifest) !== selected.manifestDigest) throw new WorkspaceError("RECEIPT_MISMATCH", "Sealed source differs from durable finalization intent");
        source = { manifest: submission.manifest, openFile: (path, options) => runtime.dependencies.submissions.openSealedFile(scope, submission.id, path, options) };
      }
      const original = operation;
      const prepared = await prepareWithRenewal(runtime, operation, async signal => {
        await runtime.dependencies.hook?.("before-prepare", original);
        const candidate = await store.inspectCandidate(identity) ?? await store.prepare({ identity, source, signal });
        if (original.candidate && canonicalJson(original.candidate) !== canonicalJson(candidate)) throw new WorkspaceError("RECEIPT_MISMATCH", "Prepared candidate differs from the persisted reference");
        await runtime.dependencies.hook?.("after-prepare", original);
        return candidate;
      });
      operation = prepared.operation;
      operation = await runtime.control.recordPreparedRevision({ scope: operation.scope, operationId: operation.id, expectedOperationVersion: operation.version, processingFence: input.processingFence, now: runtime.now(), candidate: prepared.candidate }) as RecoverableOperation;
      await runtime.dependencies.hook?.("after-record-prepared", operation);
    }
    await runtime.dependencies.hook?.("before-accept", operation);
    if (operation.kind === "workspace:create") {
      const authorization = await runtime.authorize(operation.principal, "workspace:create", { customerId: operation.scope.customerId });
      const now = runtime.now();
      const accepted = await runtime.control.acceptWorkspaceCreation({ scope: operation.scope, operationId: operation.id, expectedOperationVersion: operation.version, processingFence: input.processingFence, now, authorization, initialRevision: operation.candidate!, events: runtime.events(operation, "workspace.created", now) });
      await runtime.dependencies.hook?.("after-accept", accepted.operation);
      return accepted.operation;
    }
    if (operation.kind !== "finalize") throw new WorkspaceError("INVALID_TRANSITION", "Operation cannot publish a revision");
    const run = await runtime.control.getRun(operation.scope, operation.runId);
    if (!run) throw new WorkspaceError("RUN_NOT_FOUND", "Finalizing run is unavailable");
    const authorization = await runtime.authorize(operation.principal, "run:finalize", operation.scope);
    const now = runtime.now();
    const preconditions = { scope: { ...run.scope, runId: run.id }, operationId: operation.id, expectedRunVersion: run.version, expectedOperationVersion: operation.version, expectedBindingGeneration: run.scope.bindingGeneration, processingFence: input.processingFence, authorization, events: runtime.events(operation, "run.finalized", now) };
    const accepted = operation.intent.mode === "read-only"
      ? await runtime.control.completeReadOnly({ ...preconditions, completedAt: now })
      : await runtime.control.acceptRevision({ ...preconditions, expectedHeadRevisionId: run.baseRevisionId, expectedWorkspaceVersion: run.workspaceVersionAtOpen, submissionId: operation.intent.source.submissionId, candidate: operation.candidate!, acceptedAt: now });
    await runtime.dependencies.hook?.("after-accept", accepted.operation);
    return accepted.operation;
  } catch (error) { return reconcile(runtime, input, error); }
}
