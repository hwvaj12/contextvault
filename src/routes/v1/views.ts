import type { Operation, OperationView, Run, RunView, Submission, SubmissionView, UploadReceipt, UploadReceiptView, Workspace, WorkspaceView, CleanupStatus } from "../../domain";
const runPath = (id: string) => `/v1/runs/${encodeURIComponent(id)}`;
export function workspaceView(workspace: Workspace): WorkspaceView {
  const { id, customerId, name, currentRevisionId, version, status, createdAt, updatedAt } = workspace; const base = `/v1/workspaces/${encodeURIComponent(id)}`;
  return { id, customerId, name, currentRevisionId, version, status, createdAt, updatedAt, _links: { self: { href: base }, runs: { href: `${base}/runs` } } };
}
export function runView(run: Run, cleanup: Pick<CleanupStatus, "state" | "version" | "attempts" | "lastError">, now: string): RunView {
  const { id, mode, agentLabel, task, reason, baseRevisionId, version, state, operationId, outcome, createdAt, updatedAt } = run; const base = runPath(id);
  return { id, workspaceId: run.scope.workspaceId, mode, agentLabel, task, reason, baseRevisionId, version, state, expiresAt: run.lease.expiresAt, leaseVersion: run.lease.version, operationId, outcome: structuredClone(outcome),
    cleanup: { state: cleanup.state, version: cleanup.version, attempts: cleanup.attempts, lastError: cleanup.lastError ? "Cleanup remains pending" : null }, createdAt, updatedAt,
    _links: { self: { href: base }, ...(operationId ? { operation: { href: `/v1/operations/${encodeURIComponent(operationId)}` } } : {}),
      ...(state === "active" && run.lease.expiresAt > now ? { manifest: { href: `${base}/workspace/manifest` }, files: { href: `${base}/workspace/files` }, finalize: { href: `${base}/finalize` }, abort: { href: `${base}/abort` }, heartbeat: { href: `${base}/heartbeat` }, ...(mode === "read-write" ? { submissions: { href: `${base}/submissions` } } : {}) } : {}) } };
}
export function submissionView(submission: Submission): SubmissionView {
  const { id, state, version, expiresAt, manifestDigest, sealedAt } = submission; const base = `${runPath(submission.scope.runId)}/submissions/${encodeURIComponent(id)}`;
  return { id, runId: submission.scope.runId, state, version, expiresAt, manifestDigest, sealedAt, _links: { self: { href: base }, ...(state === "uploading" ? { files: { href: `${base}/files` }, seal: { href: `${base}/seal` } } : {}) } };
}
export function receiptView(receipt: UploadReceipt): UploadReceiptView {
  const { id, submissionId, path, byteLength, sha256, completedAt } = receipt;
  return { id, runId: receipt.scope.runId, submissionId, path, byteLength, sha256, completedAt };
}
export function operationView(operation: Operation): OperationView {
  const { id, runId, kind, state, phase, version, result, createdAt, updatedAt } = operation;
  return { id, workspaceId: operation.scope.workspaceId, runId, kind, state, phase, version, result: structuredClone(result), error: operation.error ? { code: operation.error.code, message: "The operation has a recorded failure", operationId: id, retryable: operation.error.retryable } : null,
    createdAt, updatedAt, _links: { self: { href: `/v1/operations/${encodeURIComponent(id)}` }, ...(runId ? { run: { href: runPath(runId) } } : {}) } };
}
