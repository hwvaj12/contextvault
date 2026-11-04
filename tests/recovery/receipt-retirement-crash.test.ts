import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { WorkspaceError, canonicalJson } from "../../src/domain";
import type { RunScope, SubmissionId } from "../../src/domain";
import { command, principal, scopeOf, setup } from "./helpers";

async function uploaded() {
  const context = await setup();
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const runScope: RunScope = { ...run.scope, runId: run.id };
  const submissionId = "before-ack-submission" as SubmissionId;
  await context.submissions.begin({ scope: runScope, principal, submissionId, command: command("submission:create", {}, runScope), expiresAt: "2026-11-03T13:00:00.000Z" });
  const bytes = Buffer.from([0, 255, 128, 13, 10]); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const input = { scope: runScope, principal, submissionId, receiptId: "before-ack-receipt" as never, path: "before-ack.bin", declaredByteLength: bytes.length, declaredSha256: sha256, command: command("submission:file", { submissionId, path: "before-ack.bin", declaredByteLength: bytes.length, declaredSha256: sha256 }, runScope) };
  const receipt = await context.submissions.writeFile({ ...input, bytes: (async function* () { yield bytes; })() });
  await context.app.abort({ scope: runScope, principal, idempotencyKey: "before-ack-abort", request: { expectedRunVersion: run.version, reason: "retirement crash regression" } });
  return { context, scope, input, receipt };
}

type Uploaded = Awaited<ReturnType<typeof uploaded>>;
const marker = ({ receipt }: Uploaded) => ({ scope: receipt.scope, submissionId: receipt.submissionId, attemptKey: receipt.privateReference.opaqueKey, storeId: receipt.privateReference.storeId });
const claim = ({ context, input }: Uploaded) => context.control.claimSubmissionCollection({ scope: input.scope, submissionId: input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
async function storage(fixture: Uploaded, name: string, bytes?: Buffer) {
  const { context, receipt } = fixture;
  if (context.backend === "git") {
    const destination = join(context.root, "submissions", "attempts", receipt.privateReference.opaqueKey, name);
    if (bytes) await writeFile(destination, bytes); else await rm(destination);
  } else {
    const owned = (await context.keys()).find(key => key.includes(`/submissions/v1/attempts/${receipt.privateReference.opaqueKey}/`));
    if (!owned) throw new Error("Expected fixture-owned immutable attempt");
    const Key = owned.slice(0, owned.lastIndexOf("/") + 1) + name; const Bucket = process.env.CV_TEST_S3_BUCKET;
    if (bytes) await context.client!.send(new PutObjectCommand({ Bucket, Key, Body: bytes, ContentLength: bytes.length, ServerSideEncryption: "AES256", Metadata: { "cv-sha256": createHash("sha256").update(bytes).digest("hex") } }));
    else await context.client!.send(new DeleteObjectCommand({ Bucket, Key }));
  }
}
function retry({ context, input }: Uploaded) {
  let consumed = false;
  const promise = context.submissions.writeFile({ ...input, bytes: (async function* () { consumed = true; throw new Error("Retry bytes must remain unread"); yield Buffer.alloc(0); })() });
  return { promise, consumed: () => consumed };
}

it("replays a successful upload after byte deletion but before catalog acknowledgment, including after restart", async () => {
  const { context, scope, input, receipt } = await uploaded();
  const permit = await context.control.claimSubmissionCollection({ scope: input.scope, submissionId: input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T12:01:00.000Z" });
  const stop = vi.spyOn(context.control, "recordSubmissionCollectionProgress").mockRejectedValueOnce(new Error("crash before catalog acknowledgment"));
  await expect(context.submissions.collect(permit, context.clock.value)).rejects.toThrow("crash before catalog acknowledgment");
  stop.mockRestore();
  expect(await context.control.isUploadReceiptRetired(receipt)).toBe(false);
  await context.reopen();
  // Permit expiry does not undo permanent catalog retirement or an already written ownership marker.
  context.clock.value = "2026-11-03T12:02:00.000Z";
  let consumed = 0;
  const retry = () => (async function* () { consumed++; throw new Error("Retry bytes must remain unread"); yield Buffer.alloc(0); })();
  await expect(context.submissions.writeFile({ ...input, bytes: retry() })).resolves.toEqual(receipt);
  expect(consumed).toBe(0);
  // Reconciliation preserves the unfinished physical collection acknowledgment.
  expect(await context.control.isUploadReceiptRetired(receipt)).toBe(false);
  const replacement = await context.control.claimSubmissionCollection({ scope: input.scope, submissionId: input.submissionId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  expect(replacement.collectionFence).toBeGreaterThan(permit.collectionFence);
  await expect(context.submissions.collect(permit, context.clock.value)).rejects.toMatchObject({ code: "STALE_FENCE" });
  await context.submissions.collect(replacement, context.clock.value);
  expect(await context.control.isUploadReceiptRetired(receipt)).toBe(true);
  expect((await context.read(scope)).manifest.entries).toEqual([]);
});

it("rejects a matching storage marker without permanent catalog collection fencing", async () => {
  const fixture = await uploaded(); const { context, input } = fixture;
  const submission = (await context.control.getSubmission(input.scope, input.submissionId))!;
  context.clock.value = "2026-11-03T14:00:00.000Z";
  await context.submissions.expire(input.scope, input.submissionId, submission.version, context.clock.value);
  await storage(fixture, "collected.json", Buffer.from(canonicalJson(marker(fixture)))); await storage(fixture, "bytes");
  const replay = retry(fixture);
  await expect(replay.promise).rejects.toMatchObject(context.backend === "git" ? { code: "ENOENT" } : { name: "NoSuchKey" });
  expect(replay.consumed()).toBe(false);
});

it.each(["scope", "submission", "attempt", "store", "extra"])("rejects mismatched %s ownership in a storage marker despite an issued permit", async changed => {
  const fixture = await uploaded(); await claim(fixture);
  const expected = marker(fixture);
  const proposed = changed === "scope" ? { ...expected, scope: { ...expected.scope, customerId: "another-tenant" } }
    : changed === "submission" ? { ...expected, submissionId: "another-submission" }
    : changed === "attempt" ? { ...expected, attemptKey: "another-attempt" }
    : changed === "store" ? { ...expected, storeId: "another-store" } : { ...expected, arbitrary: true };
  await storage(fixture, "collected.json", Buffer.from(canonicalJson(proposed))); await storage(fixture, "bytes");
  const replay = retry(fixture);
  await expect(replay.promise).rejects.toMatchObject(fixture.context.backend === "git" ? { code: "ENOENT" } : { name: "NoSuchKey" });
  expect(replay.consumed()).toBe(false);
});

it.each(["json", "utf8", "size"])("rejects invalid %s storage markers before acknowledgment", async invalid => {
  const fixture = await uploaded(); await claim(fixture);
  const bytes = invalid === "json" ? Buffer.from("{") : invalid === "utf8" ? Buffer.from([255]) : Buffer.alloc(16 * 1024 + 1, 32);
  await storage(fixture, "collected.json", bytes); await storage(fixture, "bytes");
  const replay = retry(fixture);
  await expect(replay.promise).rejects.toBeInstanceOf(WorkspaceError);
  expect(replay.consumed()).toBe(false);
});

it("still detects retained byte corruption behind an exact marker and catalog fence", async () => {
  const fixture = await uploaded(); await claim(fixture);
  await storage(fixture, "collected.json", Buffer.from(canonicalJson(marker(fixture))));
  await storage(fixture, "bytes", Buffer.from([1, 255, 128, 13, 10]));
  const replay = retry(fixture);
  await expect(replay.promise).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  expect(replay.consumed()).toBe(false);
});

it("requires current authority before accepting pre-acknowledgment retirement evidence", async () => {
  const fixture = await uploaded(); const { context, scope } = fixture; const permit = await claim(fixture);
  const stop = vi.spyOn(context.control, "recordSubmissionCollectionProgress").mockRejectedValueOnce(new Error("crash before catalog acknowledgment"));
  await expect(context.submissions.collect(permit, context.clock.value)).rejects.toThrow("crash before catalog acknowledgment"); stop.mockRestore();
  const authority = (await context.control.getAuthority(scope, principal))!;
  const authorization = await context.app.runtime.authorize(principal, "credential:manage", { customerId: scope.customerId });
  await context.control.updateAuthority({ scope, principal, authorization, expectedCredentialVersion: authority.credentialVersion, expectedPermissionEpoch: authority.permissionEpoch, authority: { ...authority, credentialVersion: authority.credentialVersion + 1, permissionEpoch: authority.permissionEpoch + 1, revokedAt: context.clock.value } });
  const replay = retry(fixture);
  await expect(replay.promise).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" });
  expect(replay.consumed()).toBe(false);
});
