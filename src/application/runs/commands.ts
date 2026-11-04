import { WorkspaceError, type AbortRequest, type FinalizationIntent, type FinalizeRequest, type HeartbeatRequest, type RunScope } from "../../domain";
import type { ExpiredActiveRun } from "../../ports/control-store";
import { LifecycleRuntime, type AuthenticatedCommand } from "./runtime";

export type RunCommand<Request> = AuthenticatedCommand<Request> & { scope: RunScope };
export async function claimFinalization(runtime: LifecycleRuntime, input: RunCommand<FinalizeRequest>) {
  input = structuredClone(input);
  if (!Number.isSafeInteger(input.request.expectedRunVersion) || input.request.expectedRunVersion < 1) throw new WorkspaceError("INVALID_REQUEST", "Expected lifecycle version is required");
  const scope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
  const authorization = await runtime.authorize(input.principal, "run:finalize", scope);
  const command = runtime.command("finalize", input, scope, input.scope.runId);
  const existing = await runtime.control.findOperation(command.idempotencyScope, command.idempotencyKey);
  let intent: FinalizationIntent;
  if (existing) {
    if (existing.kind !== "finalize") throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Finalize key belongs to another operation");
    // Catalog replay validates the new digest/request before using the original immutable source identity.
    intent = { ...existing.intent, request: { method: "POST", path: `/v1/runs/${input.scope.runId}/finalize`, body: input.request } } as FinalizationIntent;
  } else {
    const run = await runtime.control.getRun(scope, input.scope.runId);
    if (!run) throw new WorkspaceError("RUN_NOT_FOUND", "Run does not exist in this customer scope");
    if (run.mode === "read-only") {
      if ("submissionId" in input.request) throw new WorkspaceError("INVALID_REQUEST", "Read-only completion cannot select a submission");
      intent = { schemaVersion: 1, kind: "finalize", mode: "read-only", request: { method: "POST", path: `/v1/runs/${run.id}/finalize`, body: { expectedRunVersion: input.request.expectedRunVersion } }, source: null, candidateIdentity: null };
    } else {
      if (!input.request.submissionId) throw new WorkspaceError("INVALID_REQUEST", "Read-write finalization requires a sealed submission");
      const submission = await runtime.dependencies.submissions.get(input.scope, input.request.submissionId as any);
      if (!submission) throw new WorkspaceError("SUBMISSION_NOT_FOUND", "Selected submission does not belong to this run");
      if (submission.state !== "sealed" || !submission.manifestDigest) throw new WorkspaceError("RECEIPT_MISMATCH", "Selected submission must be sealed");
      intent = { schemaVersion: 1, kind: "finalize", mode: "read-write", request: { method: "POST", path: `/v1/runs/${run.id}/finalize`, body: { ...input.request, submissionId: submission.id } }, source: { submissionId: submission.id, submissionVersion: submission.version, manifestDigest: submission.manifestDigest },
        candidateIdentity: { candidateId: runtime.id("candidate") as any, revisionId: runtime.id("revision") as any, operationId: command.operationId, scope: run.scope, parentRevisionId: run.baseRevisionId, createdAt: command.requestedAt } };
    }
  }
  const now = runtime.now();
  return runtime.control.claimFinalization({ scope: input.scope, principal: input.principal, authorization, command, expectedRunVersion: input.request.expectedRunVersion, intent, claim: { ownerId: runtime.dependencies.ownerId, fence: 1, expiresAt: runtime.until(now, runtime.processingTtlMs) }, now });
}

export async function abort(runtime: LifecycleRuntime, input: RunCommand<AbortRequest>) {
  input = structuredClone(input);
  if (!Number.isSafeInteger(input.request.expectedRunVersion) || input.request.expectedRunVersion < 1 || typeof input.request.reason !== "string" || !input.request.reason.trim() || input.request.reason.length > 4096) throw new WorkspaceError("INVALID_REQUEST", "Abort lifecycle version and reason are required");
  const scope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
  const authorization = await runtime.authorize(input.principal, "run:abort", scope);
  const command = runtime.command("abort", input, scope, input.scope.runId);
  const operation = { id: command.operationId, scope, runId: input.scope.runId, principal: input.principal };
  return runtime.control.abortRun({ scope: input.scope, principal: input.principal, authorization, command, expectedRunVersion: input.request.expectedRunVersion, reason: input.request.reason, events: runtime.events(operation, "run.aborted", command.requestedAt), now: command.requestedAt });
}

export async function heartbeat(runtime: LifecycleRuntime, input: RunCommand<HeartbeatRequest>) {
  input = structuredClone(input);
  if (!Number.isSafeInteger(input.request.expectedLeaseVersion) || input.request.expectedLeaseVersion < 1) throw new WorkspaceError("INVALID_REQUEST", "Expected lease version is required");
  const scope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
  await runtime.authorize(input.principal, "run:heartbeat", scope);
  const command = runtime.command("run:heartbeat", input, scope, input.scope.runId);
  const run = await runtime.control.getRun(scope, input.scope.runId);
  if (!run) throw new WorkspaceError("RUN_NOT_FOUND", "Run does not exist in this customer scope");
  const now = runtime.now();
  const expiresAt = new Date(Math.max(Date.parse(runtime.until(now, runtime.leaseTtlMs)), Date.parse(run.lease.expiresAt) + 1)).toISOString();
  return runtime.control.renewRunLease({ scope: input.scope, principal: input.principal, command, expectedLeaseVersion: input.request.expectedLeaseVersion, now, expiresAt });
}

/** Internal maintenance action; the catalog atomically rechecks every scanned expiry field. */
export async function expireActiveRun(runtime: LifecycleRuntime, input: ExpiredActiveRun) {
  input = structuredClone(input);
  const scope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
  const run = await runtime.control.getRun(scope, input.scope.runId);
  if (!run) throw new WorkspaceError("RUN_NOT_FOUND", "Run does not exist");
  const operation = { id: `expiry-${run.id}-${input.expectedLeaseVersion}` as any, scope, runId: run.id, principal: run.principal };
  return runtime.control.expireActiveRun({ ...input, now: runtime.now(), events: runtime.events(operation, "run.expired") });
}
