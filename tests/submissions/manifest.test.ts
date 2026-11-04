import { afterEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import { catalog, command, consume, digest, now, principal, remove, scope, stream, submissionId, temporary } from "./helpers";

let root: string;
afterEach(async () => { if (root) await remove(root); });
it("seals a complete canonical snapshot with exact fixture bytes and explicit empty directories", async () => {
  root = await temporary();
  const fixture = JSON.parse(await readFile(new URL("../fixtures/workspaces/canonical.v1.json", import.meta.url), "utf8"));
  const store = new LocalSubmissionStore({ root, control: catalog().control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const receipts = [];
  for (const [path, file] of Object.entries(fixture.files) as [string, { hex: string; sha256: string }][]) {
    const receipt = await store.writeFile({ scope, principal, command: command("submission:file", path), submissionId, receiptId: path as never, path, declaredSha256: file.sha256, bytes: stream(Buffer.from(file.hex, "hex")) });
    receipts.push({ path, receiptId: receipt.id });
  }
  const sealed = await store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest: fixture.input, receipts, sealedAt: now });
  expect(sealed.manifestDigest).toBe(fixture.sha256);
  expect(JSON.stringify(sealed.manifest)).toBe(fixture.canonical);
  expect(await consume(await store.openSealedFile(scope, submissionId, "binary.bin"))).toEqual(Buffer.from("00ff800d0a", "hex"));
  expect(await consume(await store.openSealedFile(scope, submissionId, "notes.txt"))).toEqual(Buffer.from("hello\r\n"));
});
it("requires exactly one matching immutable receipt per manifest file", async () => {
  root = await temporary(); const store = new LocalSubmissionStore({ root, control: catalog().control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  const receipt = await store.writeFile({ scope, principal, command: command("submission:file"), submissionId, receiptId: "r" as never, path: "é.txt", bytes: stream(""), declaredSha256: digest("") });
  const manifest = { schemaVersion: 1 as const, entries: [{ path: "é.txt", kind: "file" as const, byteLength: 0, sha256: digest("") }] };
  for (const receipts of [[], [{ path: "é.txt", receiptId: receipt.id }, { path: "é.txt", receiptId: receipt.id }], [{ path: "other", receiptId: receipt.id }]]) {
    await expect(store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest, receipts, sealedAt: now })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  }
  await store.seal({ scope, principal, command: command("submission:seal"), submissionId, manifest, receipts: [{ path: "é.txt", receiptId: receipt.id }], sealedAt: now });
  expect(await consume(await store.openSealedFile(scope, submissionId, "é.txt"))).toEqual(Buffer.alloc(0));
});
