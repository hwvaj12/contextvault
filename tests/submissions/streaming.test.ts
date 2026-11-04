import { afterEach, expect, it } from "vitest";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import { catalog, command, consume, digest, now, principal, remove, scope, stream, submissionId, temporary } from "./helpers";
let root: string;
afterEach(async () => { if (root) await remove(root); });
it("rejects digest, declared length, streamed quota, and aborted uploads before catalog registration", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, limits: { maxFileBytes: 4 }, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const input = { scope, principal, command: command("submission:file"), submissionId, receiptId: "r" as never, path: "file", bytes: stream("abc"), declaredSha256: digest("abc") };
  await expect(store.writeFile({ ...input, declaredSha256: digest("other") })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  await expect(store.writeFile({ ...input, bytes: stream("abc"), declaredByteLength: 2 })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  await expect(store.writeFile({ ...input, bytes: stream("abcde"), declaredSha256: digest("abcde") })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  const controller = new AbortController(); controller.abort();
  await expect(store.writeFile({ ...input, bytes: stream("abc"), signal: controller.signal })).rejects.toBeDefined();
  expect(db.receipts.size).toBe(0);
});
it("bounds stream concurrency across uploads and enforces complete snapshot quotas", async () => {
  root = await temporary(); const db = catalog(); const store = new LocalSubmissionStore({ root, control: db.control, limits: { maxConcurrentStreams: 2, maxTotalBytes: 5 }, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  let active = 0; let maximum = 0;
  async function* source() { active++; maximum = Math.max(maximum, active); await Promise.resolve(); yield Buffer.from("abc"); active--; }
  const receipts = await Promise.all(["a", "b", "c", "d"].map((path) => store.writeFile({ scope, principal, command: command("submission:file", path), submissionId, receiptId: path as never, path, bytes: source(), declaredSha256: digest("abc") })));
  expect(maximum).toBeLessThanOrEqual(2);
  await expect(store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest: { schemaVersion: 1, entries: receipts.map((r) => ({ path: r.path, kind: "file", byteLength: r.byteLength, sha256: r.sha256 })) }, receipts: receipts.map((r) => ({ path: r.path, receiptId: r.id })), sealedAt: now })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});
it("verifies physical receipt bytes independently of one-byte logical path limits", async () => {
  root = await temporary(); const db = catalog();
  const store = new LocalSubmissionStore({ root, control: db.control, limits: { maxPathBytes: 1, maxComponentBytes: 1 }, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const input = { scope, principal, command: command("submission:file"), submissionId, receiptId: "receipt" as never, path: "a", bytes: stream("x"), declaredSha256: digest("x") };
  const receipt = await store.writeFile(input);
  expect((await store.writeFile({ ...input, bytes: stream("x") })).id).toBe(receipt.id);
  await expect(store.writeFile({ ...input, command: command("submission:file", "invalid"), path: "ab", bytes: stream("x") })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest: { schemaVersion: 1, entries: [{ path: "a", kind: "file", byteLength: 1, sha256: digest("x") }] }, receipts: [{ path: "a", receiptId: receipt.id }], sealedAt: now });
  expect(await consume(await store.openSealedFile(scope, submissionId, "a"))).toEqual(Buffer.from("x"));
});
