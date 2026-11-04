import { expect, it, vi } from "vitest";
import { WorkspaceError, canonicalJson } from "../../src/domain";
import type { RunScope, SubmissionId } from "../../src/domain";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceMaintenance } from "../../src/application/maintenance";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { command, finalInput, principal, scopeOf, setup, source } from "./helpers";

it("fences an unrecorded prepared candidate before collection and preserves accepted bytes", async () => {
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "finalize") throw new WorkspaceError("RECEIPT_MISMATCH", "terminal fixture fault after real preparation"); } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "orphan.bin": Buffer.from([0, 255, 128]) });
  const operation = await context.app.finalize(finalInput(run, submission.id));
  expect(operation.state).toBe("failed"); expect(operation.candidate).toBeNull();
  if (operation.kind !== "finalize" || !operation.intent.candidateIdentity) throw new Error("Mutable candidate required");
  const identity = operation.intent.candidateIdentity;
  expect(await context.store.inspectCandidate(identity)).not.toBeNull();
  const permit = await context.control.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  await context.store.deleteCollectible(permit, context.clock.value);
  expect(await context.store.inspectCandidate(identity)).toBeNull();
  expect((await context.read(scope)).manifest.entries).toEqual([]);
  const original = (await context.control.listRevisions(scope)).revisions[0];
  await expect(context.control.claimCandidateCollection({ scope: original.scope, candidateId: "not-an-orphan" as never, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" })).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  await context.store.deleteCollectible(permit, context.clock.value);
  await expect(context.store.prepare({ identity, source: source({ "orphan.bin": Buffer.from([0, 255, 128]) }) })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});

it("retains bytes while an aborted upload writer is active, then collects after its stopped acknowledgment", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const runScope: RunScope = { ...run.scope, runId: run.id }; const submissionId = "held-submission" as SubmissionId;
  await context.submissions.begin({ scope: runScope, principal, submissionId, command: command("submission:create", {}, runScope), expiresAt: "2026-11-03T13:00:00.000Z" });
  const bytes = Buffer.from([0, 255, 128]); const sha256 = createHash("sha256").update(bytes).digest("hex");
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
  async function* stream() { yield bytes.subarray(0, 1); started(); await held; yield bytes.subarray(1); }
  const pending = context.submissions.writeFile({ scope: runScope, principal, submissionId, receiptId: "held-receipt" as never, path: "held.bin", declaredByteLength: bytes.length, declaredSha256: sha256, bytes: stream(), command: command("submission:file", { submissionId, path: "held.bin", declaredByteLength: bytes.length, declaredSha256: sha256 }, runScope) });
  void pending.catch(() => {});
  await Promise.race([ready, pending.then(() => { throw new Error("Upload must reach held bytes"); })]);
  await context.app.abort({ scope: runScope, principal, idempotencyKey: "abort-held", request: { expectedRunVersion: run.version, reason: "cancel held writer" } });
  try { await expect(context.control.claimSubmissionCollection({ scope: runScope, submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" })).rejects.toMatchObject({ code: "FORBIDDEN" }); }
  finally { release(); await pending.catch(() => {}); }
  const permit = await context.control.claimSubmissionCollection({ scope: runScope, submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  await context.submissions.collect(permit, context.clock.value);
  await context.submissions.collect(permit, context.clock.value);
  expect((await context.read(scope)).manifest.entries).toEqual([]);
});

it("does not treat elapsed time as proof that an interrupted writer stopped", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const runScope: RunScope = { ...run.scope, runId: run.id }; const submissionId = "interrupted-submission" as SubmissionId;
  await context.submissions.begin({ scope: runScope, principal, submissionId, command: command("submission:create", {}, runScope), expiresAt: "2026-11-03T13:00:00.000Z" });
  const upload = command("submission:file", {}, runScope);
  const attemptKey = createHash("sha256").update(canonicalJson({ scope: upload.idempotencyScope, key: upload.idempotencyKey })).digest("hex");
  await context.control.beginSubmissionWrite({ scope: runScope, principal, command: upload, submissionId, writerId: "interrupted-writer", attemptKey, storeId: context.backend === "git" ? "local-lifecycle-test" : "private-s3-test", now: context.clock.value });
  await context.app.abort({ scope: runScope, principal, idempotencyKey: "abort-interrupted", request: { expectedRunVersion: run.version, reason: "process interrupted" } });
  context.clock.value = "2026-11-05T12:00:00.000Z";
  await context.reopen();
  await expect(context.control.claimSubmissionCollection({ scope: runScope, submissionId, now: context.clock.value, expiresAt: "2026-11-05T13:00:00.000Z" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await context.control.getRun(scope, run.id))?.state).toBe("aborted");
});

it("retains an expired sealed source selected by recoverable finalization", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const submission = await context.upload(run, { "retained.bin": Buffer.from([0, 255]) });
  await context.app.claimFinalization(finalInput(run, submission.id));
  context.clock.value = "2026-11-03T13:10:00.000Z";
  await expect(context.control.claimSubmissionCollection({ scope: { ...run.scope, runId: run.id }, submissionId: submission.id, now: context.clock.value, expiresAt: "2026-11-03T14:00:00.000Z" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await context.control.getSubmission({ ...run.scope, runId: run.id }, submission.id))?.state).toBe("sealed");
});

it("collects completed submission bytes while retaining exact accepted contents and terminal outcomes", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const payload = Buffer.from([0, 255, 128, 0]);
  const submission = await context.upload(run, { "accepted.bin": payload });
  const receipt = (await context.control.getReceipt({ ...run.scope, runId: run.id }, submission.id, submission.receipts[0].receiptId))!;
  await context.app.finalize(finalInput(run, submission.id));
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value });
  await maintenance.runOnce();
  expect((await context.control.getCleanup(scope, run.cleanupId))?.state).toBe("complete");
  expect((await context.control.getRun(scope, run.id))?.state).toBe("finalized");
  expect((await context.read(scope)).files["accepted.bin"]).toEqual(payload);
  if (context.backend === "git") await expect(readFile(join(context.root, "submissions", "attempts", receipt.privateReference.opaqueKey, "bytes"))).rejects.toMatchObject({ code: "ENOENT" });
  else expect((await context.keys()).filter(key => key.includes("/submissions/") && key.endsWith("/bytes"))).toHaveLength(0);
});

it("keeps cleanup failure independent and resumes with its existing collection fence", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const submission = await context.upload(run, { "retained.txt": Buffer.from("accepted") });
  await context.app.finalize(finalInput(run, submission.id));
  const failure = vi.spyOn(context.submissions, "collect").mockRejectedValueOnce(new Error("temporary cleanup failure"));
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, retryDelayMs: 100 });
  await maintenance.runOnce();
  expect((await context.control.getCleanup(scope, run.cleanupId))?.state).not.toBe("complete");
  expect((await context.read(scope)).files["retained.txt"]).toEqual(Buffer.from("accepted"));
  failure.mockRestore(); context.clock.value = "2026-11-03T12:00:00.200Z";
  await maintenance.runOnce();
  expect((await context.control.getCleanup(scope, run.cleanupId))?.state).toBe("complete");
  expect((await context.control.getRun(scope, run.id))?.state).toBe("finalized");
});

it("resolves failed creation cleanup through its persisted draft binding", async () => {
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "workspace:create") throw new WorkspaceError("RECEIPT_MISMATCH", "creator failed after durable preparation"); } });
  const claimed = await context.app.claimWorkspaceCreation({ principal, idempotencyKey: "failed-creation", request: { customerId: "tenant-a", name: "never accepted" } });
  const failed = await context.app.processOperation({ scope: claimed.operation.scope, operationId: claimed.operation.id, processingFence: claimed.operation.claim!.fence });
  expect(failed.state).toBe("failed");
  const cleanup = (await context.control.listDueCleanup({ now: context.clock.value, limit: 10 }))[0];
  expect(await context.control.getBinding(failed.scope, claimed.operation.intent.binding.id)).toBeNull();
  expect((await context.control.getCleanupTargets(failed.scope, cleanup.id))!.candidates[0].binding).toEqual(claimed.operation.intent.binding);
  await new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value }).runOnce();
  expect((await context.control.getCleanup(failed.scope, cleanup.id))?.state).toBe("complete");
  expect(await context.control.getWorkspace(failed.scope)).toBeNull();
});

it("retires a failed creation whose preparation never started without selecting an environment binding", async () => {
  const context = await setup({ hook: async (stage, operation) => { if (stage === "before-prepare" && operation.kind === "workspace:create") throw new WorkspaceError("INVALID_REQUEST", "fail before storage I/O"); } });
  const claimed = await context.app.claimWorkspaceCreation({ principal, idempotencyKey: "no-io-creation", request: { customerId: "tenant-a", name: "unprepared draft" } });
  const failed = await context.app.processOperation({ scope: claimed.operation.scope, operationId: claimed.operation.id, processingFence: claimed.operation.claim!.fence });
  expect(failed.state).toBe("failed");
  expect(await context.control.getWorkspace(failed.scope)).toBeNull();
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value });
  expect((await maintenance.runOnce()).errors).toEqual([]);
  const cleanupId = `cleanup-${failed.id}` as never;
  expect((await context.control.getCleanup(failed.scope, cleanupId))?.state).toBe("complete");
  expect((await context.control.getCleanupTargets(failed.scope, cleanupId))?.candidates).toEqual([]);
  expect((await maintenance.runOnce()).collected).toBe(0);
});

it("advances bounded orphan scans past retained history and active bases", async () => {
  let sequence = 0;
  const context = await setup({ newId: kind => `${kind}-${String(++sequence).padStart(6, "0")}`, hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "finalize") throw new WorkspaceError("RECEIPT_MISMATCH", "orphan after retained history"); } });
  const retained = [];
  for (let index = 0; index < 3; index++) { const { workspace } = await context.create(); retained.push(scopeOf(workspace)); }
  const run = await context.open(retained[0]); const submission = await context.upload(run, { "orphan.txt": Buffer.from("collect") });
  const failed = await context.app.finalize(finalInput(run, submission.id));
  if (failed.kind !== "finalize" || !failed.intent.candidateIdentity) throw new Error("Expected orphan identity");
  const job = (await context.control.getCleanup(run.scope, run.cleanupId))!;
  const claim = await context.control.claimCleanup({ scope: run.scope, cleanupId: job.id, expectedVersion: job.version, ownerId: "defer-job", now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  await context.control.completeCleanup({ scope: job.scope, cleanupId: job.id, expectedVersion: claim.version, fence: claim.claim!.fence, now: context.clock.value, error: "deferred job; global scan remains available", nextAttemptAt: "2026-11-03T13:00:00.000Z" });
  const active = await context.open(retained[1]);
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, batchSize: 1 });
  for (let index = 0; index < 12 && await context.store.inspectCandidate(failed.intent.candidateIdentity); index++) expect((await maintenance.runOnce()).collected).toBeLessThanOrEqual(1);
  expect(await context.store.inspectCandidate(failed.intent.candidateIdentity)).toBeNull();
  for (const scope of retained) expect((await context.read(scope)).manifest.entries).toEqual([]);
  expect((await context.control.getRun(active.scope, active.id))?.state).toBe("active");
});

it("resumes persisted cleanup progress with a new fence after a committed acknowledgment response is lost", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const submission = await context.upload(run, { "first.bin": Buffer.from([0, 255]), "second.bin": Buffer.from([128, 0]) });
  await context.app.abort({ scope: { ...run.scope, runId: run.id }, principal, idempotencyKey: "abort-progress", request: { expectedRunVersion: run.version, reason: "cleanup progress" } });
  const claimInput = { scope: { ...run.scope, runId: run.id }, submissionId: submission.id, now: context.clock.value, expiresAt: "2026-11-03T12:01:00.000Z" };
  const permit = await context.control.claimSubmissionCollection(claimInput);
  const before = await context.control.listSubmissionCollectionAttempts({ permit, now: context.clock.value, limit: 100 });
  const progress = context.control.recordSubmissionCollectionProgress.bind(context.control);
  const response = vi.spyOn(context.control, "recordSubmissionCollectionProgress").mockImplementationOnce(async input => { await progress(input); throw new Error("cleanup acknowledgment response lost"); });
  await expect(context.submissions.collect(permit, context.clock.value)).rejects.toThrow("acknowledgment response lost");
  response.mockRestore();
  const after = await context.control.listSubmissionCollectionAttempts({ permit, now: context.clock.value, limit: 100 });
  expect(after.attempts).toHaveLength(before.attempts.length - 1);
  context.clock.value = "2026-11-03T12:02:00.000Z";
  const newer = await context.control.claimSubmissionCollection({ ...claimInput, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  expect(newer.collectionFence).toBeGreaterThan(permit.collectionFence);
  await expect(context.submissions.collect(permit, context.clock.value)).rejects.toMatchObject({ code: "STALE_FENCE" });
  await context.submissions.collect(newer, context.clock.value);
  await context.submissions.collect(newer, context.clock.value);
  expect((await context.control.listSubmissionCollectionAttempts({ permit: newer, now: context.clock.value, limit: 100 })).attempts).toEqual([]);
  await expect(context.control.beginSubmissionWrite({ scope: claimInput.scope, principal, command: command("submission:file", {}, claimInput.scope), submissionId: submission.id, writerId: "late-writer", attemptKey: "untrusted", storeId: "untrusted", now: context.clock.value })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect((await context.read(scope)).manifest.entries).toEqual([]);
});

it("distinguishes stopped local writers from ambiguous remote write responses", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const runScope: RunScope = { ...run.scope, runId: run.id }; const submissionId = "uncertain-submission" as SubmissionId;
  await context.submissions.begin({ scope: runScope, principal, submissionId, command: command("submission:create", {}, runScope), expiresAt: "2026-11-03T13:00:00.000Z" });
  const payload = Buffer.from([0, 255, 128]); const sha256 = createHash("sha256").update(payload).digest("hex");
  if (context.client) {
    const send = context.client.send.bind(context.client);
    const response = vi.spyOn(context.client, "send").mockImplementation(async (input: any, ...options: any[]) => {
      const result = await (send as any)(input, ...options);
      if (input instanceof PutObjectCommand && input.input.Key?.endsWith("/bytes")) { response.mockRestore(); throw new Error("write response lost before its outcome was known"); }
      return result;
    });
  } else {
    const register = context.control.registerUploadReceipt.bind(context.control);
    vi.spyOn(context.control, "registerUploadReceipt").mockImplementationOnce(async input => { await register(input); throw new Error("receipt response lost after known local bytes"); });
  }
  async function* bytes() { yield payload; }
  await expect(context.submissions.writeFile({ scope: runScope, principal, submissionId, receiptId: "uncertain-receipt" as never, path: "uncertain.bin", declaredByteLength: payload.length, declaredSha256: sha256, bytes: bytes(), command: command("submission:file", { submissionId, path: "uncertain.bin", declaredByteLength: payload.length, declaredSha256: sha256 }, runScope) })).rejects.toThrow("response lost");
  await context.app.abort({ scope: runScope, principal, idempotencyKey: "abort-uncertain", request: { expectedRunVersion: run.version, reason: "retain uncertain remote writes" } });
  const claim = context.control.claimSubmissionCollection({ scope: runScope, submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  if (context.backend === "s3") await expect(claim).rejects.toMatchObject({ code: "FORBIDDEN" });
  else { const permit = await claim; await context.submissions.collect(permit, context.clock.value); }
  expect((await context.read(scope)).manifest.entries).toEqual([]);
  if (context.backend === "s3") {
    // Lose one real committed response inside the SDK, then let its conditional retry recover successfully.
    const client = context.client!;
    const { StandardRetryStrategy } = await import("@smithy/core/retry");
    client.config.maxAttempts = async () => 2;
    client.config.retryStrategy = async () => new StandardRetryStrategy(2);
    let lost = false;
    client.middlewareStack.add((next, sdk) => async args => {
      const result = await next(args);
      if (!lost && sdk.commandName === "PutObjectCommand" && (args.input as { Key?: string }).Key?.endsWith("/bytes")) {
        lost = true; const error = new Error("lost committed attempt inside SDK retry"); error.name = "TimeoutError"; throw error;
      }
      return result;
    }, { step: "deserialize", priority: "low", name: "testLostCommittedAttempt" });
    try {
      const next = await context.open(scope);
      const retried = await context.upload(next, { "retried.bin": payload });
      expect(lost).toBe(true); expect(retried.state).toBe("sealed");
      await context.app.abort({ scope: { ...next.scope, runId: next.id }, principal, idempotencyKey: "abort-retried", request: { expectedRunVersion: next.version, reason: "uncertain first SDK attempt" } });
      await expect(context.control.claimSubmissionCollection({ scope: { ...next.scope, runId: next.id }, submissionId: retried.id, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally { client.middlewareStack.remove("testLostCommittedAttempt"); }
  }
});
