import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError } from "../../src/domain/errors";
import type { CommandIdentity, Operation, Principal, RunScope, Submission, UploadReceipt } from "../../src/domain/model";
import type { ControlStore } from "../../src/ports";

export const now = "2026-11-03T12:00:00.000Z";
export const scope = { customerId: "customer", workspaceId: "workspace", storageBindingId: "binding", bindingGeneration: 1, runId: "run" } as RunScope;
export const principal = { kind: "customer", customerId: scope.customerId, actorId: "actor", credential: { id: "credential", kind: "api-key", version: 1 }, permissionEpoch: 1, authenticatedAt: now } as Principal;
export const submissionId = "submission" as Submission["id"];
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function command(kind: CommandIdentity["idempotencyScope"]["kind"], key = kind, requestDigest = digest(key)): CommandIdentity {
  return { idempotencyScope: { customerId: scope.customerId, workspaceId: scope.workspaceId, runId: scope.runId, actorId: principal.actorId, kind }, idempotencyKey: key, requestDigest, operationId: `operation-${key}` as CommandIdentity["operationId"], requestedAt: now };
}
export async function* stream(bytes: Uint8Array | string) { yield Buffer.from(bytes); }
export async function consume(source: AsyncIterable<Uint8Array>) { const chunks: Uint8Array[] = []; for await (const chunk of source) chunks.push(chunk); return Buffer.concat(chunks); }
export async function temporary() { return mkdtemp(join(await realpath(tmpdir()), "cv-submissions-")); }
export const remove = (root: string) => rm(root, { recursive: true, force: true });

/** Coordination double only. These tests exercise the real byte adapter, not SQLite transaction isolation. */
export function catalog() {
  const submissions = new Map<string, Submission>();
  const receipts = new Map<string, UploadReceipt>();
  const operations = new Map<string, Operation>();
  let runWritable = true;
  let recoverable = false;
  const getOperation = (input: { command: CommandIdentity }) => {
    const recorded = operations.get(input.command.idempotencyKey);
    if (recorded && recorded.command.requestDigest !== input.command.requestDigest) throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Changed request");
    return recorded;
  };
  const save = (input: { command: CommandIdentity }, result: object, resource: unknown) => {
    operations.set(input.command.idempotencyKey, { command: input.command, state: "succeeded", result } as Operation);
    return { value: structuredClone(resource), operation: operations.get(input.command.idempotencyKey)!, replayed: false };
  };
  const writable = (id: string, version: number) => {
    const submission = submissions.get(id)!;
    if (!runWritable) throw new WorkspaceError("INVALID_TRANSITION", "Run closed");
    if (submission.state !== "uploading") throw new WorkspaceError("SUBMISSION_SEALED", "Submission closed");
    if (submission.version !== version) throw new WorkspaceError("VERSION_CONFLICT", "Version changed");
    return submission;
  };
  const control = {
    findOperation: async (_: unknown, key: string) => structuredClone(operations.get(key) ?? null),
    getSubmission: async (_: unknown, id: string) => structuredClone(submissions.get(id) ?? null),
    getReceipt: async (_: unknown, id: string, receiptId: string) => { const receipt = receipts.get(receiptId); return receipt?.submissionId === id ? structuredClone(receipt) : null; },
    createSubmission: async (input: Parameters<ControlStore["createSubmission"]>[0]) => {
      const old = getOperation(input);
      if (old) return { value: structuredClone(submissions.get(input.submissionId)), operation: old, replayed: true };
      const submission: Submission = { id: input.submissionId, scope: input.scope, state: "uploading", version: 1, expiresAt: input.expiresAt, manifest: null, manifestDigest: null, receipts: [], createdAt: now, sealedAt: null };
      submissions.set(input.submissionId, submission);
      return save(input, { kind: "submission:create", submissionId: submission.id }, submission);
    },
    registerUploadReceipt: async (input: Parameters<ControlStore["registerUploadReceipt"]>[0]) => {
      const old = getOperation(input);
      if (old) return { value: structuredClone(receipts.get((old.result as { receiptId: string }).receiptId)), operation: old, replayed: true };
      const submission = writable(input.receipt.submissionId, input.expectedSubmissionVersion);
      if (receipts.has(input.receipt.id)) throw new WorkspaceError("RECEIPT_MISMATCH", "Attempt already exists");
      receipts.set(input.receipt.id, input.receipt);
      submission.version++;
      return save(input, { kind: "submission:file", receiptId: input.receipt.id }, input.receipt);
    },
    sealSubmission: async (input: Parameters<ControlStore["sealSubmission"]>[0]) => {
      const old = getOperation(input);
      if (old) return { value: structuredClone(submissions.get(input.submissionId)), operation: old, replayed: true };
      const submission = writable(input.submissionId, input.expectedSubmissionVersion);
      Object.assign(submission, { state: "sealed", version: submission.version + 1, manifest: input.manifest, manifestDigest: input.manifestDigest, receipts: input.receipts, sealedAt: input.now });
      return save(input, { kind: "submission:seal", submissionId: submission.id, manifestDigest: input.manifestDigest }, submission);
    },
    expireSubmission: async (input: Parameters<ControlStore["expireSubmission"]>[0]) => {
      if (recoverable) throw new WorkspaceError("FINALIZATION_IN_PROGRESS", "Recoverable source");
      const submission = submissions.get(input.submissionId)!;
      if (submission.version !== input.expectedVersion) throw new WorkspaceError("VERSION_CONFLICT", "Version changed");
      submission.state = "expired"; submission.version++; return structuredClone(submission);
    },
  } as unknown as ControlStore;
  return { control, submissions, receipts, operations, closeRun: () => { runWritable = false; }, protect: () => { recoverable = true; } };
}
