import { afterEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import * as files from "../../src/application/files";
import { catalog, command, consume, digest, now, principal, remove, scope, stream, submissionId, temporary } from "./helpers";
let root: string;
afterEach(async () => { vi.restoreAllMocks(); if (root) await remove(root); });
it("keeps selected bytes immutable when an in-flight upload finishes after seal", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const input = { scope, principal, submissionId, path: "file" };
  const first = await store.writeFile({ ...input, command: command("submission:file", "first"), receiptId: "first" as never, bytes: stream("old"), declaredSha256: digest("old") });
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  async function* delayed() { started(); await gate; yield Buffer.from("new"); }
  const late = store.writeFile({ ...input, command: command("submission:file", "late"), receiptId: "late" as never, bytes: delayed(), declaredSha256: digest("new") });
  await ready;
  await store.seal({ ...input, command: command("submission:seal"), manifest: { schemaVersion: 1, entries: [{ path: "file", kind: "file", byteLength: 3, sha256: digest("old") }] }, receipts: [{ path: "file", receiptId: first.id }], sealedAt: now });
  release(); await expect(late).rejects.toMatchObject({ code: "SUBMISSION_SEALED" });
  expect(await consume(await store.openSealedFile(scope, submissionId, "file"))).toEqual(Buffer.from("old"));
});
it("recovers the original receipt after catalog response loss and rejects changed-key reuse", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const original = db.control.registerUploadReceipt.bind(db.control);
  db.control.registerUploadReceipt = async (input) => { await original(input); throw new Error("response lost"); };
  const input = { scope, principal, command: command("submission:file"), submissionId, receiptId: "original" as never, path: "file", bytes: stream("exact"), declaredSha256: digest("exact") };
  await expect(store.writeFile(input)).rejects.toThrow("response lost"); db.control.registerUploadReceipt = original;
  const restarted = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  const recovered = await restarted.writeFile({ ...input, receiptId: "replacement" as never, bytes: stream("exact") });
  expect(recovered.id).toBe("original"); expect(db.receipts.size).toBe(1);
  await expect(restarted.writeFile({ ...input, command: { ...input.command, requestDigest: digest("changed") }, bytes: stream("exact") })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
});
it("checks sealed bytes again and keeps protected finalization sources on failed expiry", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const receipt = await store.writeFile({ scope, principal, command: command("submission:file"), submissionId, receiptId: "r" as never, path: "file", bytes: stream("old"), declaredSha256: digest("old") });
  const sealed = await store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest: { schemaVersion: 1, entries: [{ path: "file", kind: "file", byteLength: 3, sha256: digest("old") }] }, receipts: [{ path: "file", receiptId: receipt.id }], sealedAt: now });
  db.protect(); await expect(store.expire(scope, submissionId, sealed.version, now)).rejects.toMatchObject({ code: "FINALIZATION_IN_PROGRESS" });
  expect(await consume(await store.openSealedFile(scope, submissionId, "file"))).toEqual(Buffer.from("old"));
  await writeFile(join(root, "attempts", receipt.privateReference.opaqueKey, "bytes"), "bad");
  await expect(consume(await store.openSealedFile(scope, submissionId, "file"))).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
});
it("recovers the durable original attempt after interruption before registration", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const original = db.control.registerUploadReceipt.bind(db.control);
  db.control.registerUploadReceipt = async () => { throw new Error("registration unavailable"); };
  const input = { scope, principal, command: command("submission:file"), submissionId, receiptId: "original" as never, path: "file", bytes: stream("exact"), declaredSha256: digest("exact") };
  await expect(store.writeFile(input)).rejects.toThrow("registration unavailable"); expect(db.receipts.size).toBe(0);
  db.control.registerUploadReceipt = original;
  async function* unavailableBody() { throw new Error("retry body must not replace durable bytes"); yield Buffer.alloc(0); }
  const restarted = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  expect((await restarted.writeFile({ ...input, receiptId: "replacement" as never, bytes: unavailableBody() })).id).toBe("original");
});
it("snapshots seal receipt selections before asynchronous byte verification", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const receipt = await store.writeFile({ scope, principal, command: command("submission:file"), submissionId, receiptId: "original" as never, path: "file", bytes: stream("old"), declaredSha256: digest("old") });
  const selections = [{ path: "file", receiptId: receipt.id }];
  const original = db.control.getReceipt.bind(db.control);
  let calls = 0;
  db.control.getReceipt = async (...args) => { const result = await original(...args); if (++calls === 1) selections[0].receiptId = "replacement" as never; return result; };
  const sealed = await store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest: { schemaVersion: 1, entries: [{ path: "file", kind: "file", byteLength: 3, sha256: digest("old") }] }, receipts: selections, sealedAt: now });
  expect(sealed.receipts).toEqual([{ path: "file", receiptId: receipt.id }]);
});
it("syncs a concurrently discovered attempt before catalog registration", async () => {
  root = await temporary(); const db = catalog();
  const first = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  const retry = new LocalSubmissionStore({ root, control: db.control, now: () => now });
  const begin = { scope, principal, command: command("submission:create"), submissionId, expiresAt: now };
  await first.begin(begin); await retry.begin(begin);
  let releaseFirst!: () => void; let firstBlocked!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const blocked = new Promise<void>((resolve) => { firstBlocked = resolve; });
  let syncCalls = 0; let completedSyncs = 0;
  const realSyncDirectory = files.syncDirectory;
  vi.spyOn(files, "syncDirectory").mockImplementation(async (path) => {
    if (path !== join(root, "attempts")) return realSyncDirectory(path);
    if (++syncCalls === 1) { firstBlocked(); await gate; }
    await realSyncDirectory(path); completedSyncs++;
  });
  const register = db.control.registerUploadReceipt.bind(db.control);
  db.control.registerUploadReceipt = async (input) => {
    expect(completedSyncs, "Catalog registration requires a completed attempts-parent sync").toBeGreaterThan(0);
    return register(input);
  };
  const input = { scope, principal, command: command("submission:file"), submissionId, receiptId: "original" as never, path: "file", bytes: stream("exact"), declaredSha256: digest("exact") };
  const pending = first.writeFile(input);
  await blocked;
  try {
    const receipt = await retry.writeFile({ ...input, receiptId: "replacement" as never, bytes: stream("exact") });
    expect(receipt.id).toBe("original");
    expect(syncCalls).toBe(2);
  } finally { releaseFirst(); await pending; }
});
