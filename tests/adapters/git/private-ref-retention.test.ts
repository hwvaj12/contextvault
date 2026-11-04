import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CollectionPermit } from "../../../src/domain";
import { bytes, canonicalSource, git, identity, setup, source } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
async function store(verify?: (permit: CollectionPermit, now: string) => Promise<boolean>) { const context = await setup(verify); cleanup.push(context.close); return context; }

describe("private Git retention", () => {
  it("retains candidates and revision aliases through real Git pruning without changing HEAD", async () => {
    const context = await store();
    const fixture = await canonicalSource();
    const prepared = await context.store.prepare({ identity: identity(), source: fixture.source });
    const head = await readFile(path.join(context.repository, "HEAD"), "utf8");
    expect(await git(context.repository, "for-each-ref", "--format=%(refname)")).toMatch(/refs\/contextvault\/candidates\//);
    expect(await git(context.repository, "for-each-ref", "--format=%(refname)")).toMatch(/refs\/contextvault\/revisions\//);
    expect(await git(context.repository, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
    await git(context.repository, "gc", "--prune=now");
    expect(await bytes(await context.reopen().openFile(prepared, "binary.bin"))).toEqual(fixture.files["binary.bin"]);
    expect(await readFile(path.join(context.repository, "HEAD"), "utf8")).toBe(head);
  });

  it("ignores hostile global config, Git environment, attributes filters, and newline conversion", async () => {
    const context = await store();
    const hostile = path.join(context.rootDirectory, "hostile.conf");
    const marker = path.join(context.rootDirectory, "filter-ran");
    await writeFile(hostile, `[core]\n autocrlf = true\n[filter "evil"]\n clean = touch ${marker}\n required = true\n`);
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR, GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: hostile, GIT_DIR: "/invalid/hostile-repository", GIT_OBJECT_DIRECTORY: "/invalid/objects" });
    try {
      const prepared = await context.store.prepare({ identity: identity(), source: source({ ".gitattributes": Buffer.from("* filter=evil text eol=lf\n"), "notes.txt": Buffer.from("hello\r\n") }) });
      expect(await bytes(await context.store.openFile(prepared, "notes.txt"))).toEqual(Buffer.from("hello\r\n"));
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("denies collection without current catalog authority and rejects expired or mismatched permits", async () => {
    let currentFence = 3;
    let accepted = true;
    const context = await store(async (permit) => !accepted && permit.collectionFence === currentFence);
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "a": Buffer.from("retained") }) });
    const permit: CollectionPermit = { scope: prepared.scope, candidateId: prepared.candidateId, privateReference: prepared.privateReference, collectionFence: 3, expiresAt: "2026-11-04T00:00:00.000Z" };
    const now = "2026-11-03T13:00:00.000Z";
    await expect(context.store.deleteCollectible(permit, now)).rejects.toMatchObject({ code: "STALE_FENCE" });
    accepted = false;
    await expect(context.store.deleteCollectible({ ...permit, collectionFence: 2 }, now)).rejects.toMatchObject({ code: "STALE_FENCE" });
    await expect(context.store.deleteCollectible({ ...permit, expiresAt: now }, now)).rejects.toMatchObject({ code: "STALE_FENCE" });
    await expect(context.store.deleteCollectible({ ...permit, candidateId: "other" as typeof permit.candidateId }, now)).rejects.toBeDefined();
    expect(await context.store.inspectCandidate(identity())).toEqual(prepared);
    currentFence = 4;
    await context.store.deleteCollectible({ ...permit, collectionFence: 4 }, now);
    expect(await context.reopen().inspectCandidate(identity())).toBeNull();
    await expect(context.store.readManifest(prepared)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  });

  it("defaults collection to denied", async () => {
    const context = await store();
    const prepared = await context.store.prepare({ identity: identity(), source: source({}) });
    await expect(context.store.deleteCollectible({ scope: prepared.scope, candidateId: prepared.candidateId, privateReference: prepared.privateReference, collectionFence: 1, expiresAt: "2026-11-04T00:00:00.000Z" }, "2026-11-03T13:00:00.000Z")).rejects.toMatchObject({ code: "STALE_FENCE" });
  });

  it("keeps exact history reads available through immutable revision aliases", async () => {
    const context = await store();
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "a": Buffer.from("history") }) });
    const candidateRef = (await git(context.repository, "for-each-ref", "--format=%(refname)", "refs/contextvault/candidates")).trim();
    await git(context.repository, "update-ref", "-d", candidateRef);
    await git(context.repository, "gc", "--prune=now");
    expect(await bytes(await context.reopen().openFile(prepared, "a"))).toEqual(Buffer.from("history"));
    expect(await context.reopen().inspectCandidate(identity())).toEqual(prepared);
    expect(await context.reopen().prepare({ identity: identity(), source: source({ "a": Buffer.from("history") }) })).toEqual(prepared);
    expect(await git(context.repository, "rev-parse", "--verify", candidateRef)).toContain(prepared.privateReference.opaqueKey.split("/").at(-1));
  });

  it("makes collection idempotent, prevents resurrection, and releases unreachable objects to real pruning", async () => {
    const context = await store(async () => true);
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "a": Buffer.from("orphan") }) });
    const permit: CollectionPermit = { scope: prepared.scope, candidateId: prepared.candidateId, privateReference: prepared.privateReference, collectionFence: 7, expiresAt: "2026-11-04T00:00:00.000Z" };
    await context.store.deleteCollectible(permit, "2026-11-03T13:00:00.000Z");
    await context.reopen().deleteCollectible(permit, "2026-11-03T13:00:00.000Z");
    await expect(context.reopen().prepare({ identity: identity(), source: source({ "a": Buffer.from("orphan") }) })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await git(context.repository, "gc", "--prune=now");
    await expect(git(context.repository, "cat-file", "-e", prepared.privateReference.opaqueKey.split("/").at(-1)!)).rejects.toBeDefined();
    expect(await context.reopen().inspectCandidate(identity())).toBeNull();
  });

  it("finishes interrupted collection when its durable tombstone already exists", async () => {
    const context = await store(async () => true);
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "a": Buffer.from("orphan") }) });
    const retained = (await git(context.repository, "for-each-ref", "--format=%(refname)")).trim().split("\n");
    const objectId = prepared.privateReference.opaqueKey.split("/").at(-1)!;
    const permit: CollectionPermit = { scope: prepared.scope, candidateId: prepared.candidateId, privateReference: prepared.privateReference, collectionFence: 7, expiresAt: "2026-11-04T00:00:00.000Z" };
    await context.store.deleteCollectible(permit, "2026-11-03T13:00:00.000Z");
    // Simulate process interruption between individual ref-file renames during transaction commit.
    for (const ref of retained) await git(context.repository, "update-ref", ref, objectId);
    expect(await context.reopen().inspectCandidate(identity())).toBeNull();
    await expect(context.reopen().readManifest(prepared)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await context.reopen().deleteCollectible(permit, "2026-11-03T13:00:00.000Z");
    expect(await git(context.repository, "for-each-ref", "--format=%(refname)", "refs/contextvault/candidates", "refs/contextvault/revisions")).toBe("");
    await git(context.repository, "gc", "--prune=now");
    await expect(git(context.repository, "cat-file", "-e", objectId)).rejects.toBeDefined();
  });

  it("refuses unowned repositories and repository symlinks without modifying their HEAD", async () => {
    for (const linked of [false, true]) {
      const context = await store();
      const foreign = linked ? path.join(context.rootDirectory, "foreign") : context.repository;
      await mkdir(foreign);
      await writeFile(path.join(foreign, "HEAD"), "ref: refs/heads/do-not-touch\n");
      if (linked) await symlink(foreign, context.repository, "dir");
      await expect(context.store.prepare({ identity: identity(), source: source({}) })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(await readFile(path.join(foreign, "HEAD"), "utf8")).toBe("ref: refs/heads/do-not-touch\n");
    }
  });
});
