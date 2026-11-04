import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  canonicalManifestBytes, canonicalizeManifest, manifestDigest, verifyFileStream,
  DEFAULT_WORKSPACE_LIMITS,
} from "../../src/domain/manifest";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const file = (path: string, bytes = "hello\r\n") => ({ path, kind: "file", byteLength: Buffer.byteLength(bytes), sha256: sha256(bytes) });

describe("manifest v1", () => {
  it("matches independent canonical bytes and digest fixtures", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/workspaces/canonical.v1.json", import.meta.url), "utf8"));
    expect(Buffer.from(canonicalManifestBytes(fixture.input)).toString("utf8")).toBe(fixture.canonical);
    expect(manifestDigest(fixture.input)).toBe(fixture.sha256);
    expect(canonicalizeManifest({ schemaVersion: 1, entries: [] })).toEqual({ schemaVersion: 1, entries: [] });
  });

  it("sorts UTF-8 paths and preserves declared directories, binary digests, and line endings", () => {
    const input = { schemaVersion: 1, entries: [file("z.txt"), { path: "empty", kind: "directory" }, file("a.bin", "\0ÿ")] };
    expect(canonicalizeManifest(input).entries.map((entry) => entry.path)).toEqual(["a.bin", "empty", "z.txt"]);
    expect(input.entries[0].path).toBe("z.txt");
    expect(manifestDigest({ schemaVersion: 1, entries: [file("a", "\n")] })).not.toBe(manifestDigest({ schemaVersion: 1, entries: [file("a", "\r\n")] }));
  });

  it.each(["/absolute", "../escape", "a/../b", "a//b", "a/./b", "a\\b", "C:/file", "a/", "a\0b", "a\nb", ".git/config", "nested/.GIT/config", ".contextvault/handle", "CON", "nul.txt", "com1", "LPT9.log", "CONIN$", "CONOUT$", "CLOCK$", "bad.", "bad ", "a:b", "e\u0301.txt", "bad\ud800.txt"])("rejects nonportable path %j", (path) => {
    expect(() => canonicalizeManifest({ schemaVersion: 1, entries: [file(path)] })).toThrowError(expect.objectContaining({ code: "INVALID_MANIFEST" }));
  });

  it.each([
    [file("a"), file("a")], [file("A"), file("a")], [file("a/one"), file("A/two")],
    [file("a"), file("a/b")], [file("straße"), file("STRASSE")],
    [{ path: "link", kind: "symlink", target: "a" }], [{ path: "pipe", kind: "fifo" }],
    [{ ...file("a"), byteLength: -1 }], [{ ...file("a"), sha256: "ABC" }],
    [{ ...file("a"), executable: true }], [{ path: "dir", kind: "directory", byteLength: 0 }],
  ])("rejects duplicate paths, collisions, unsafe kinds, and unsupported metadata", (...entries) => {
    expect(() => canonicalizeManifest({ schemaVersion: 1, entries })).toThrow();
  });

  it("enforces injected entry, UTF-8 path, component, file, and total byte limits", () => {
    expect(DEFAULT_WORKSPACE_LIMITS).toEqual({ maxEntries: 10000, maxPathBytes: 1024, maxComponentBytes: 255, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxConcurrentStreams: 4, maxChunkBytes: 64 * 1024 });
    for (const limits of [{ maxEntries: 1 }, { maxPathBytes: 2 }, { maxComponentBytes: 2 }, { maxFileBytes: 1 }, { maxTotalBytes: 10 }]) {
      expect(() => canonicalizeManifest({ schemaVersion: 1, entries: [file("one"), file("two")] }, limits)).toThrowError(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    }
    expect(() => canonicalizeManifest({ schemaVersion: 1, entries: [file("éé")] }, { maxPathBytes: 3 })).toThrow();
  });

  it("verifies arbitrary binary chunks without changing or buffering file bytes", async () => {
    const bytes = Uint8Array.from([0, 255, 128, 13, 10, 0, 42]);
    const entry = { path: "binary.bin", kind: "file" as const, byteLength: bytes.length, sha256: sha256(bytes) };
    async function* source() { yield bytes.subarray(0, 3); yield bytes.subarray(3); }
    const received: Uint8Array[] = [];
    for await (const chunk of verifyFileStream(entry, source(), { maxChunkBytes: 2 })) {
      expect(chunk.byteLength).toBeLessThanOrEqual(2);
      received.push(chunk);
    }
    expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
    async function consume(changes: object) { for await (const _ of verifyFileStream({ ...entry, ...changes }, source())) { /* Consume verified bytes. */ } }
    await expect(consume({ sha256: sha256("wrong") })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    await expect(consume({ byteLength: 6 })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });
});
