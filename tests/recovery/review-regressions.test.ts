import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { WorkspaceMaintenance } from "../../src/application/maintenance";
import type { Run, RunScope, SubmissionId } from "../../src/domain";
import { command, principal, scopeOf, setup } from "./helpers";

async function beginFile(context: Awaited<ReturnType<typeof setup>>, run: Run, id: string, expiresAt = "2026-11-03T13:00:00.000Z") {
  const scope: RunScope = { ...run.scope, runId: run.id }; const submissionId = id as SubmissionId;
  await context.submissions.begin({ scope, principal, submissionId, command: command("submission:create", {}, scope), expiresAt });
  const bytes = Buffer.from([0, 255, 128]); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const input = { scope, principal, submissionId, receiptId: `receipt-${id}` as never, path: `${id}.bin`, declaredByteLength: bytes.length, declaredSha256: sha256, command: command("submission:file", { submissionId, path: `${id}.bin`, declaredByteLength: bytes.length, declaredSha256: sha256 }, scope) };
  return { input, bytes, async write() { return context.submissions.writeFile({ ...input, bytes: (async function* () { yield bytes; })() }); } };
}
const abort = (context: Awaited<ReturnType<typeof setup>>, run: Run) => context.app.abort({ scope: { ...run.scope, runId: run.id }, principal, idempotencyKey: `abort-${run.id}`, request: { expectedRunVersion: run.version, reason: "review regression" } });

it("makes durable fair cleanup progress across blocked targets, later jobs and global work after worker restarts", async () => {
  let sequence = 0;
  const context = await setup({ newId: kind => `${kind}-${String(++sequence).padStart(6, "0")}` });
  const { workspace } = await context.create(); const scope = scopeOf(workspace); const first = await context.open(scope);
  const blocked = await beginFile(context, first, "a-blocked");
  const sibling = await beginFile(context, first, "b-sibling"); await sibling.write();
  let ready!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const pending = context.submissions.writeFile({ ...blocked.input, bytes: (async function* () { yield blocked.bytes.subarray(0, 1); ready(); await held; yield blocked.bytes.subarray(1); })() });
  void pending.catch(() => {}); await Promise.race([started, pending]);
  try {
    await abort(context, first);
    const later = await context.open(scope); const eligible = await beginFile(context, later, "c-later-job"); await eligible.write(); await abort(context, later);
    const active = await context.open(scope); const global = await beginFile(context, active, "d-global", "2026-11-03T12:00:00.500Z"); await global.write();
    for (let tick = 1; tick <= 30; tick++) {
      context.clock.value = new Date(Date.parse("2026-11-03T12:00:00.000Z") + tick * 1000).toISOString();
      const report = await new WorkspaceMaintenance({ lifecycle: context.peer(`cleanup-restart-${tick}`), now: () => context.clock.value, batchSize: 1 }).runOnce();
      expect(report.collected).toBeLessThanOrEqual(1);
    }
    for (const id of [sibling.input.submissionId, eligible.input.submissionId, global.input.submissionId]) {
      const row = context.control.database.prepare("SELECT data FROM catalog_records WHERE kind='submission-collection' AND id=?").get(id) as { data: string } | undefined;
      expect(row && JSON.parse(row.data).collectedAt, id).toBeTruthy();
    }
    expect((await context.control.getCleanup(scope, later.cleanupId))?.state).toBe("complete");
    expect((await context.control.getCleanup(scope, first.cleanupId))?.state).not.toBe("complete");
    await expect(context.control.claimSubmissionCollection({ scope: blocked.input.scope, submissionId: blocked.input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await context.control.getRun(scope, active.id))?.state).toBe("active");
  } finally { release(); await pending.catch(() => {}); }
});

it.each(["complete", "partial"])("replays a durable authorized receipt after %s byte retirement without reading retry bytes", async retirement => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const file = await beginFile(context, run, "retired-replay"); const receipt = await file.write(); await abort(context, run);
  const permit = await context.control.claimSubmissionCollection({ scope: file.input.scope, submissionId: file.input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  if (retirement === "partial") {
    const acknowledge = context.control.recordSubmissionCollectionProgress.bind(context.control);
    const stop = vi.spyOn(context.control, "recordSubmissionCollectionProgress").mockImplementationOnce(async input => { await acknowledge(input); throw new Error("stop after acknowledged receipt retirement"); });
    await expect(context.submissions.collect(permit, context.clock.value)).rejects.toThrow("stop after acknowledged receipt retirement"); stop.mockRestore();
  } else await context.submissions.collect(permit, context.clock.value);
  await context.reopen();
  expect(await context.control.isUploadReceiptRetired(receipt)).toBe(true);
  expect(await context.control.isUploadReceiptRetired({ ...receipt, privateReference: { ...receipt.privateReference, opaqueKey: "another-attempt" } })).toBe(false);
  let consumed = 0; const retry = () => (async function* () { consumed++; throw new Error("Retry bytes must remain unread"); yield Buffer.alloc(0); })();
  await expect(context.submissions.writeFile({ ...file.input, bytes: retry() })).resolves.toEqual(receipt);
  expect(consumed).toBe(0);
  const authority = (await context.control.getAuthority(scope, principal))!;
  const authorization = await context.app.runtime.authorize(principal, "credential:manage", { customerId: scope.customerId });
  await context.control.updateAuthority({ scope, principal, authorization, expectedCredentialVersion: authority.credentialVersion, expectedPermissionEpoch: authority.permissionEpoch, authority: { ...authority, credentialVersion: authority.credentialVersion + 1, permissionEpoch: authority.permissionEpoch + 1, revokedAt: context.clock.value } });
  await expect(context.submissions.writeFile({ ...file.input, bytes: retry() })).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" });
  expect(consumed).toBe(0);
});

it.each([false, true])("rejects missing unretired bytes even when a collection permit exists=%s", async marked => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const file = await beginFile(context, run, "missing-unretired"); const receipt = await file.write(); await abort(context, run);
  if (marked) await context.control.claimSubmissionCollection({ scope: file.input.scope, submissionId: file.input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  if (context.backend === "git") await rm(join(context.root, "submissions", "attempts", receipt.privateReference.opaqueKey, "bytes"));
  else {
    const key = (await context.keys()).find(key => key.endsWith(`/${receipt.privateReference.opaqueKey}/bytes`)); expect(key).toBeTruthy();
    await context.client!.send(new DeleteObjectCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Key: key! }));
  }
  expect(await context.control.isUploadReceiptRetired(receipt)).toBe(false);
  let consumed = 0;
  const bytes = (async function* () { consumed++; throw new Error("Retry bytes must remain unread"); yield Buffer.alloc(0); })();
  await expect(context.submissions.writeFile({ ...file.input, bytes })).rejects.toMatchObject(context.backend === "git" ? { code: "ENOENT" } : { name: "NoSuchKey" });
  expect(consumed).toBe(0);
});

it("matches SQLite byte ordering when proving partial receipt retirement for opaque identifiers", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const file = await beginFile(context, run, "opaque-order"); const receipts = [];
  for (const [id, path] of [["receipt-\uE000", "first.bin"], ["receipt-\u{10000}", "second.bin"]]) receipts.push(await context.submissions.writeFile({ ...file.input, receiptId: id as never, path, command: command("submission:file", { path, sha256: file.input.declaredSha256 }, file.input.scope), bytes: (async function* () { yield file.bytes; })() }));
  await abort(context, run);
  const permit = await context.control.claimSubmissionCollection({ scope: file.input.scope, submissionId: file.input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  const acknowledge = context.control.recordSubmissionCollectionProgress.bind(context.control);
  const stop = vi.spyOn(context.control, "recordSubmissionCollectionProgress").mockImplementationOnce(async input => { await acknowledge(input); throw new Error("stop after first opaque receipt"); });
  await expect(context.submissions.collect(permit, context.clock.value)).rejects.toThrow("stop after first opaque receipt"); stop.mockRestore();
  expect(await context.control.isUploadReceiptRetired(receipts[0])).toBe(true);
  expect(await context.control.isUploadReceiptRetired(receipts[1])).toBe(false);
  await context.submissions.collect(permit, context.clock.value);
  expect(await context.control.isUploadReceiptRetired(receipts[1])).toBe(true);
});

it("delivers healthy frozen recipients despite an earlier failure and preserves progress across worker restarts", async () => {
  const context = await setup();
  for (const id of ["a-unavailable", "b-healthy", "c-healthy"]) context.control.registerSubscription({ id: id as never, customerId: "tenant-a" as never, active: true, eventTypes: ["workspace.created"], destination: `https://${id}.example/hook`, signingSecretRef: null });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const calls: { recipient: string; event: string; fence: number }[] = [];
  for (let tick = 0; tick < 8; tick++) {
    context.clock.value = new Date(Date.parse("2026-11-03T12:00:00.000Z") + tick * 3_600_000).toISOString();
    await new WorkspaceMaintenance({ lifecycle: context.peer(`delivery-restart-${tick}`), now: () => context.clock.value, batchSize: 1, deliver: async (event, recipient) => {
      calls.push({ recipient: recipient.id, event: event.id, fence: event.claim!.fence });
      if (recipient.id === "a-unavailable") throw new Error("endpoint unavailable");
    } }).runOnce();
  }
  expect(calls.filter(call => call.recipient === "b-healthy")).toHaveLength(1);
  expect(calls.filter(call => call.recipient === "c-healthy")).toHaveLength(1);
  expect(new Set(calls.map(call => call.event)).size).toBe(1);
  expect(calls.every((call, index) => !index || call.fence > calls[index - 1].fence)).toBe(true);
  const eventId = calls[0].event as never;
  expect((await context.control.listDeliveredSubscriptions(scope, eventId)).sort()).toEqual(["b-healthy", "c-healthy"]);
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(1);
  expect((await context.control.listAudit(scope)).events).toHaveLength(1);
});

it("lets a later event's healthy recipient progress while an earlier event keeps retrying", async () => {
  let sequence = 0;
  const context = await setup({ newId: kind => `${kind}-${String(++sequence).padStart(6, "0")}` });
  context.control.registerSubscription({ id: "a-unavailable" as never, customerId: "tenant-a" as never, active: true, eventTypes: ["workspace.created"], destination: "https://unavailable.example/hook", signingSecretRef: null });
  await context.create();
  const calls: { recipient: string; workspace: string }[] = [];
  const tick = (index: number) => new WorkspaceMaintenance({ lifecycle: context.peer(`event-restart-${index}`), now: () => context.clock.value, batchSize: 1, deliver: async (event, recipient) => {
    calls.push({ recipient: recipient.id, workspace: event.scope.workspaceId }); if (recipient.id === "a-unavailable") throw new Error("endpoint unavailable");
  } }).runOnce();
  await tick(0);
  context.control.registerSubscription({ id: "b-healthy" as never, customerId: "tenant-a" as never, active: true, eventTypes: ["workspace.created"], destination: "https://healthy.example/hook", signingSecretRef: null });
  const later = await context.create();
  for (let index = 1; index <= 8; index++) { context.clock.value = new Date(Date.parse("2026-11-03T12:00:00.000Z") + index * 3_600_000).toISOString(); await tick(index); }
  expect(calls.filter(call => call.recipient === "b-healthy")).toEqual([{ recipient: "b-healthy", workspace: later.workspace.id }]);
});
