import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlStore } from "../../src/adapters/control/sqlite-control-store";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import { createTestDb } from "../../src/db";
import { manifestDigest, type FinalizationIntent, type Manifest, type RunScope, type UploadReceipt } from "../../src/domain";
import type { WriteSubmissionFileInput } from "../../src/ports/submission-store";
import { command, fixture, now, principal, scope } from "../control/helpers";
import { consume, digest, stream } from "./helpers";

const submissionExpiresAt = "2026-11-03T12:10:00.000Z";
const processingExpiresAt = "2026-11-03T12:05:00.000Z";
const afterExpiry = "2026-11-03T12:15:00.000Z";
const recoveryExpiresAt = "2026-11-03T12:30:00.000Z";
const binary = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x41, 0x00]);
const submissionId = "binary-submission" as UploadReceipt["submissionId"];
const filePath = "snapshot.bin";
type Resources = {
  root: string;
  databases: ReturnType<typeof createTestDb>[];
  releases: (() => void)[];
  writers: Promise<unknown>[];
};
const resources: Resources[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const release of resource.releases) release();
    await Promise.allSettled(resource.writers);
    for (const database of resource.databases) if (database.open) database.close();
    await rm(resource.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cv-catalog-submissions-"));
  const resource: Resources = { root, databases: [], releases: [], writers: [] };
  resources.push(resource);
  const filename = join(root, "catalog.sqlite");
  const connect = () => {
    const database = createTestDb(filename);
    resource.databases.push(database);
    return new SqliteControlStore(database);
  };
  const control = connect();
  // The fixture seeds an empty accepted catalog. Its initial locator does not exercise Git storage.
  const catalog = await fixture(control.database);
  const run = await catalog.open();
  const runScope: RunScope = { ...run.scope, runId: run.id };
  const clock = { now };
  const adapter = (store = control) => new LocalSubmissionStore({ root: join(root, "bytes"), control: store, now: () => clock.now });
  const store = adapter();
  const submission = await store.begin({
    scope: runScope, principal, command: command("submission:create", {}, run.id), submissionId, expiresAt: submissionExpiresAt,
  });
  const head = await control.getWorkspace(scope);
  return { resource, control, catalog, run, runScope, clock, adapter, store, submission, head, connect };
}

type Context = Awaited<ReturnType<typeof setup>>;
function upload(context: Context, key: string, bytes = binary): WriteSubmissionFileInput {
  const payload = { submissionId, path: filePath, declaredByteLength: bytes.length, declaredSha256: digest(bytes) };
  return {
    scope: context.runScope, principal, submissionId, path: filePath,
    command: command("submission:file", payload, context.run.id, scope.workspaceId, key),
    receiptId: `receipt-${key}` as UploadReceipt["id"], bytes: stream(bytes),
    declaredByteLength: bytes.length, declaredSha256: digest(bytes),
  };
}

function selection(receipt: UploadReceipt): { manifest: Manifest; receipts: { path: string; receiptId: UploadReceipt["id"] }[] } {
  return {
    manifest: { schemaVersion: 1, entries: [{ path: receipt.path, kind: "file", byteLength: receipt.byteLength, sha256: receipt.sha256 }] },
    receipts: [{ path: receipt.path, receiptId: receipt.id }],
  };
}

async function seal(context: Context, receipt: UploadReceipt, store = context.store) {
  const selected = selection(receipt);
  return store.seal({
    scope: context.runScope, principal, submissionId, ...selected, sealedAt: context.clock.now,
    command: command("submission:seal", selected, context.run.id),
  });
}

async function heldUpload(context: Context, input: WriteSubmissionFileInput, bytes: Buffer) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  context.resource.releases.push(release);
  async function* held() {
    yield bytes.subarray(0, 1);
    started();
    await gate;
    yield bytes.subarray(1);
  }
  const pending = context.store.writeFile({ ...input, bytes: held() });
  context.resource.writers.push(pending);
  void pending.catch(() => {});
  await Promise.race([ready, pending.then(() => { throw new Error("Upload completed before its held stream was released"); })]);
  return { release, pending };
}

describe("real SQLite catalog and local submission bytes", () => {
  it("reopens exact sealed binary bytes without publishing an accepted head", async () => {
    const context = await setup();
    const receipt = await context.store.writeFile(upload(context, "binary-upload"));
    expect(receipt).toMatchObject({ byteLength: binary.length, sha256: digest(binary), path: filePath });
    expect(await context.control.getReceipt(context.runScope, submissionId, receipt.id)).toEqual(receipt);
    await expect(context.store.openSealedFile(context.runScope, submissionId, filePath)).rejects.toMatchObject({ code: "SUBMISSION_SEALED" });

    const selected = selection(receipt);
    await expect(context.store.seal({
      scope: context.runScope, principal, submissionId, ...selected, receipts: [{ path: filePath, receiptId: "absent" as UploadReceipt["id"] }],
      command: command("submission:seal", { invalidReceipt: true }, context.run.id), sealedAt: now,
    })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    expect((await context.store.get(context.runScope, submissionId))?.state).toBe("uploading");
    const sealed = await seal(context, receipt);
    expect(sealed.manifestDigest).toBe(manifestDigest(selected.manifest));
    expect(await consume(await context.store.openSealedFile(context.runScope, submissionId, filePath))).toEqual(binary);
    expect(await context.control.getWorkspace(scope)).toEqual(context.head);

    context.control.database.close();
    const reopened = context.connect();
    const reopenedBytes = context.adapter(reopened);
    expect(await reopenedBytes.get(context.runScope, submissionId)).toEqual(sealed);
    expect(await reopened.getReceipt(context.runScope, submissionId, receipt.id)).toEqual(receipt);
    expect(await consume(await reopenedBytes.openSealedFile(context.runScope, submissionId, filePath))).toEqual(binary);
    expect(await reopened.getWorkspace(scope)).toEqual(context.head);
    expect((await reopened.getRun(scope, context.run.id))?.state).toBe("active");
    expect((await reopened.listRevisions(scope)).revisions).toHaveLength(1);
  });

  it("rejects late registration after another connection seals an in-progress upload", async () => {
    const context = await setup();
    const receipt = await context.store.writeFile(upload(context, "selected-upload"));
    const lateBytes = Buffer.from([0x00, 0x10, 0xfe, 0x00]);
    const lateInput = upload(context, "late-upload", lateBytes);
    const held = await heldUpload(context, lateInput, lateBytes);
    const other = context.connect();
    expect(await other.getReceipt(context.runScope, submissionId, lateInput.receiptId)).toBeNull();
    const sealed = await seal(context, receipt, context.adapter(other));
    held.release();
    await expect(held.pending).rejects.toMatchObject({ code: "SUBMISSION_SEALED" });

    expect(await other.getSubmission(context.runScope, submissionId)).toEqual(sealed);
    expect(await other.getReceipt(context.runScope, submissionId, lateInput.receiptId)).toBeNull();
    expect(await other.findOperation(lateInput.command.idempotencyScope, lateInput.command.idempotencyKey)).toBeNull();
    expect(await consume(await context.adapter(other).openSealedFile(context.runScope, submissionId, filePath))).toEqual(binary);
    expect(await other.getWorkspace(scope)).toEqual(context.head);
    expect((await other.getRun(scope, context.run.id))?.version).toBe(context.run.version);
  });

  it("retains an expired sealed source while finalization awaits recovery with a newer fence", async () => {
    const context = await setup();
    const receipt = await context.store.writeFile(upload(context, "recovery-source"));
    const sealed = await seal(context, receipt);
    const body = { expectedRunVersion: context.run.version, submissionId };
    const finalize = command("finalize", body, context.run.id);
    const intent: FinalizationIntent = {
      schemaVersion: 1, kind: "finalize", mode: "read-write",
      request: { method: "POST", path: `/v1/runs/${context.run.id}/finalize`, body },
      source: { submissionId, submissionVersion: sealed.version, manifestDigest: sealed.manifestDigest! },
      candidateIdentity: {
        candidateId: "recoverable-candidate" as never, revisionId: "recoverable-revision" as never,
        operationId: finalize.operationId, scope: context.run.scope, parentRevisionId: context.run.baseRevisionId, createdAt: now,
      },
    };
    const claimed = await context.control.claimFinalization({
      scope: context.runScope, principal, authorization: await context.catalog.auth("run:finalize"), command: finalize,
      expectedRunVersion: context.run.version, intent, claim: { ownerId: "interrupted-worker", fence: 1, expiresAt: processingExpiresAt }, now,
    });
    context.clock.now = afterExpiry;
    context.control.database.close();
    const reopened = context.connect();
    const reopenedBytes = context.adapter(reopened);
    expect((await reopened.listRecoverableOperations({ now: afterExpiry, limit: 10 })).map(operation => operation.id)).toContain(claimed.operation.id);
    await expect(reopenedBytes.expire(context.runScope, submissionId, sealed.version, afterExpiry)).rejects.toMatchObject({ code: "FINALIZATION_IN_PROGRESS" });
    const recovered = await reopened.claimRecovery({
      scope, operationId: claimed.operation.id, expectedVersion: claimed.operation.version,
      ownerId: "recovery-worker", now: afterExpiry, expiresAt: recoveryExpiresAt,
    });
    expect(recovered.claim?.fence).toBe(2);
    expect(recovered.intent).toEqual(intent);
    await expect(reopened.renewProcessingClaim({
      scope, operationId: recovered.id, expectedOperationVersion: recovered.version,
      processingFence: 1, now: afterExpiry, expiresAt: recoveryExpiresAt,
    })).rejects.toMatchObject({ code: "STALE_FENCE" });
    await expect(reopenedBytes.expire(context.runScope, submissionId, sealed.version, afterExpiry)).rejects.toMatchObject({ code: "FINALIZATION_IN_PROGRESS" });
    expect(await reopenedBytes.get(context.runScope, submissionId)).toEqual(sealed);
    expect(await consume(await reopenedBytes.openSealedFile(context.runScope, submissionId, filePath))).toEqual(binary);
    expect((await reopened.getRun(scope, context.run.id))?.state).toBe("finalizing");
    expect(await reopened.getWorkspace(scope)).toEqual(context.head);
  });

  it("uses current authority after held bytes finish and refuses revoked receipt registration", async () => {
    const context = await setup();
    const input = upload(context, "revoked-upload");
    const held = await heldUpload(context, input, binary);
    const other = context.connect();
    const customer = { customerId: context.runScope.customerId };
    const authority = await other.getAuthority(customer, principal);
    expect(authority).not.toBeNull();
    await other.updateAuthority({
      scope: customer, principal, authorization: await context.catalog.auth("credential:manage", customer),
      authority: { ...authority!, credentialVersion: 2, permissionEpoch: 2, revokedAt: now },
      expectedCredentialVersion: 1, expectedPermissionEpoch: 1,
    });
    held.release();
    await expect(held.pending).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" });

    expect(await other.getReceipt(context.runScope, submissionId, input.receiptId)).toBeNull();
    expect(await other.findOperation(input.command.idempotencyScope, input.command.idempotencyKey)).toBeNull();
    expect(await other.getSubmission(context.runScope, submissionId)).toEqual(context.submission);
    await expect(context.adapter(other).seal({
      scope: context.runScope, principal, submissionId, manifest: { schemaVersion: 1, entries: [] }, receipts: [],
      command: command("submission:seal", {}, context.run.id), sealedAt: now,
    })).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" });
    expect(await other.getWorkspace(scope)).toEqual(context.head);
    expect((await other.listRevisions(scope)).revisions).toHaveLength(1);
    expect((await other.getRun(scope, context.run.id))?.state).toBe("active");
  });

  it("replays the original immutable receipt after a committed upload response is lost and adapters reopen", async () => {
    const context = await setup();
    const input = upload(context, "lost-response");
    const register = context.control.registerUploadReceipt.bind(context.control);
    let committed: UploadReceipt | undefined;
    // Fault injection occurs after the real SQLite transaction commits; catalog coordination stays real.
    const response = vi.spyOn(context.control, "registerUploadReceipt").mockImplementationOnce(async registration => {
      committed = (await register(registration)).value;
      throw new Error("upload response lost after commit");
    });
    await expect(context.store.writeFile(input)).rejects.toThrow("upload response lost after commit");
    response.mockRestore();
    expect(committed).toBeDefined();
    expect(await context.control.getReceipt(context.runScope, submissionId, input.receiptId)).toEqual(committed);
    const uploaded = await context.control.getSubmission(context.runScope, submissionId);
    const originalOperation = await context.control.findOperation(input.command.idempotencyScope, input.command.idempotencyKey);
    expect(originalOperation).toMatchObject({ state: "succeeded", result: { kind: "submission:file", receiptId: input.receiptId } });

    context.control.database.close();
    const reopened = context.connect();
    const reopenedBytes = context.adapter(reopened);
    let consumedRetryBody = false;
    async function* retryBody() { consumedRetryBody = true; yield binary; }
    const replay = await reopenedBytes.writeFile({ ...input, bytes: retryBody() });
    expect(replay).toEqual(committed);
    expect(consumedRetryBody).toBe(false);
    expect(await reopened.getSubmission(context.runScope, submissionId)).toEqual(uploaded);
    expect(await reopened.findOperation(input.command.idempotencyScope, input.command.idempotencyKey)).toEqual(originalOperation);
    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM catalog_records WHERE kind='receipt'").get()).toEqual({ count: 1 });
    await expect(reopenedBytes.writeFile({
      ...input, command: { ...input.command, requestDigest: digest("changed upload request") }, bytes: stream(binary),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await seal(context, replay, reopenedBytes);
    expect(await consume(await reopenedBytes.openSealedFile(context.runScope, submissionId, filePath))).toEqual(binary);
    expect(await reopened.getWorkspace(scope)).toEqual(context.head);
  });
});
