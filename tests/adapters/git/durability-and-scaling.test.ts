import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { GitRevisionStore } from "../../../src/adapters/revisions/git";
import { bytes, git, identity, setup, source } from "./helpers";

const observations = vi.hoisted(() => ({ synced: [] as string[], rejectSync: null as string | null, commands: [] as string[][] }));
// Observe real filesystem and Git boundaries. These wrappers never replace stored bytes or command results.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      const location = path.resolve(String(args[0]));
      observations.synced.push(location);
      if (location === observations.rejectSync) throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
      await sync();
    };
    return handle;
  } };
});
vi.mock("node:child_process", async (original) => {
  const processes = await original<typeof import("node:child_process")>();
  return { ...processes, spawn: (...args: Parameters<typeof processes.spawn>) => {
    if (args[0] === "/usr/bin/git") observations.commands.push([...(args[1] as string[])]);
    return processes.spawn(...args);
  } };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  observations.rejectSync = null;
  observations.synced = [];
  observations.commands = [];
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe("Git durability boundaries and read scaling", () => {
  it("requires new root ancestry to cross parent fsync boundaries before preparation can succeed", async () => {
    const context = await setup(); cleanup.push(context.close);
    const anchor = await realpath(context.rootDirectory);
    const rootDirectory = path.join(anchor, "new-parent", "new-child", "private-root");
    const store = new GitRevisionStore({ rootDirectory, storeId: "fresh-root-test" });
    observations.rejectSync = anchor;
    await expect(store.prepare({ identity: identity(), source: source({}) })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(observations.synced).toContain(anchor);
    observations.rejectSync = null;
    observations.synced = [];
    const prepared = await store.prepare({ identity: identity(), source: source({}) });
    for (const directory of [rootDirectory, path.dirname(rootDirectory), path.dirname(path.dirname(rootDirectory)), anchor]) {
      expect(observations.synced).toContain(directory);
    }
    expect(await new GitRevisionStore({ rootDirectory, storeId: "fresh-root-test" }).inspectCandidate(identity())).toEqual(prepared);
  });

  it("bounds real Git process growth when reading every file across many directories", async () => {
    const context = await setup(async () => true); cleanup.push(context.close);
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`directory-${index}/file`, Buffer.from(`bytes-${index}\r\n`)]));
    const snapshot = source(files, ["explicit-empty"]);
    const prepared = await context.store.prepare({ identity: identity(), source: snapshot });
    const reader = context.reopen();
    observations.commands = [];
    // Cold concurrent reads must share immutable validation work too.
    await Promise.all(Object.entries(files).map(async ([name, expected]) => {
      expect(await bytes(await reader.openFile(prepared, name))).toEqual(expected);
    }));
    const manifest = await reader.readManifest(prepared);
    // Returned manifests must not become mutable aliases into a retained validation cache.
    (manifest.entries as unknown[]).splice(0);
    for (const [name, expected] of Object.entries(files)) expect(await bytes(await reader.openFile(prepared, name))).toEqual(expected);
    expect(await reader.readManifest(prepared)).toEqual(snapshot.manifest);
    const listings = observations.commands.filter((args) => args.includes("ls-tree")).length;
    expect(listings).toBeLessThanOrEqual(3);
    expect(observations.commands.length).toBeLessThanOrEqual(8 * Object.keys(files).length + 32);
    const refs = (await git(context.repository, "for-each-ref", "--format=%(refname)")).trim().split("\n");
    await context.store.deleteCollectible({ scope: prepared.scope, candidateId: prepared.candidateId,
      privateReference: prepared.privateReference, collectionFence: 1, expiresAt: "2026-11-04T00:00:00.000Z" }, "2026-11-03T13:00:00.000Z");
    // Even matching refs cannot override a new tombstone after cache warming.
    for (const ref of refs) await git(context.repository, "update-ref", ref, prepared.privateReference.opaqueKey.split("/").at(-1)!);
    await expect(reader.readManifest(prepared)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await expect(reader.openFile(prepared, "directory-0/file")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  });

  it("rechecks revision retention and verifies streamed bytes after immutable mappings enter the cache", async () => {
    const context = await setup(); cleanup.push(context.close);
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "a": Buffer.from("original") }) });
    const reader = context.reopen();
    await reader.readManifest(prepared);
    const objectId = prepared.privateReference.opaqueKey.split("/").at(-1)!;
    const alias = (await git(context.repository, "for-each-ref", "--format=%(refname)", "refs/contextvault/revisions")).trim();
    await git(context.repository, "update-ref", "-d", alias);
    await expect(reader.openFile(prepared, "a")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await git(context.repository, "update-ref", alias, objectId);
    const blob = (await git(context.repository, "rev-parse", `${objectId}:files/a`)).trim();
    const blobPath = path.join(context.repository, "objects", blob.slice(0, 2), blob.slice(2));
    await chmod(blobPath, 0o600);
    await writeFile(blobPath,
      deflateSync(Buffer.concat([Buffer.from("blob 8\0"), Buffer.from("tampered")])));
    await expect(bytes(await reader.openFile(prepared, "a"))).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    await expect(reader.inspectCandidate(identity())).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });
});
