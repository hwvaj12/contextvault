import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, identity, setup, source } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
async function store() { const context = await setup(); cleanup.push(context.close); return context; }

describe("durable Git candidate identity", () => {
  it("reuses the original identity and locator across instances and concurrent retries", async () => {
    const context = await store();
    const input = { identity: identity(), source: source({ "a": Buffer.from("one") }) };
    const results = await Promise.all(Array.from({ length: 6 }, () => context.reopen().prepare(input)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await context.reopen().inspectCandidate(identity())).toEqual(results[0]);
  });

  it("recovers the original prepared identity after the preparing process exits", async () => {
    const context = await store();
    const project = fileURLToPath(new URL("../../../", import.meta.url));
    const adapter = fileURLToPath(new URL("../../../src/adapters/revisions/git", import.meta.url));
    const script = `
      const { GitRevisionStore } = require(process.argv[2]);
      const { createHash } = require("node:crypto");
      const input = JSON.parse(process.argv[1]);
      const data = Buffer.from("from child\\r\\n");
      const source = { manifest: { schemaVersion: 1, entries: [{ path: "child", kind: "file", byteLength: data.length, sha256: createHash("sha256").update(data).digest("hex") }] },
        async openFile() { return (async function* () { yield data; })(); } };
      new GitRevisionStore(input.options).prepare({ identity: input.identity, source }).then(
        value => process.stdout.write(JSON.stringify(value)), error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    const result = await promisify(execFile)(process.execPath, ["--require", "ts-node/register/transpile-only", "-e", script,
      JSON.stringify({ options: { rootDirectory: context.rootDirectory, storeId: "private-git-test" }, identity: identity() }), adapter],
      { cwd: project, env: { PATH: "/usr/bin:/bin", TS_NODE_COMPILER_OPTIONS: '{"ignoreDeprecations":"6.0"}' } });
    const prepared = JSON.parse(result.stdout);
    expect(result.stderr).toBe("");
    expect(await context.reopen().inspectCandidate(identity())).toEqual(prepared);
    expect(await context.reopen().prepare({ identity: identity(), source: source({ "child": Buffer.from("from child\r\n") }) })).toEqual(prepared);
  });

  it("rejects the same candidate with changed bytes or identity metadata", async () => {
    const context = await store();
    const snapshot = source({ "a": Buffer.from("original") });
    const winner = await context.store.prepare({ identity: identity(), source: snapshot });
    await expect(context.reopen().prepare({ identity: identity(), source: source({ "a": Buffer.from("changed") }) })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    for (const changed of [
      { ...identity(), operationId: "other" }, { ...identity(), revisionId: "other" },
      { ...identity(), createdAt: "2026-11-04T12:00:00.000Z" }, { ...identity(), parentRevisionId: "parent" },
    ]) await expect(context.reopen().prepare({ identity: changed as ReturnType<typeof identity>, source: snapshot })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await context.reopen().inspectCandidate(identity())).toEqual(winner);
  });

  it("verifies streams during retries and preserves the winning candidate", async () => {
    const context = await store();
    const snapshot = source({ "a": Buffer.from("original") });
    const winner = await context.store.prepare({ identity: identity(), source: snapshot });
    const corrupt = { ...snapshot, async openFile() { return (async function* () { yield Buffer.from("changed!"); })(); } };
    await expect(context.store.prepare({ identity: identity(), source: corrupt })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    expect(await context.reopen().inspectCandidate(identity())).toEqual(winner);
  });

  it("isolates tenant, workspace, binding, and binding generation candidates", async () => {
    const context = await store();
    const identities = [identity(), ...["customerId", "workspaceId", "storageBindingId", "bindingGeneration"].map((key) => ({
      ...identity(), scope: { ...identity().scope, [key]: key === "bindingGeneration" ? 2 : "other" },
    }))];
    const results = await Promise.all(identities.map((value) => context.store.prepare({ identity: value as ReturnType<typeof identity>, source: source({}) })));
    expect(new Set(results.map((value) => value.privateReference.opaqueKey)).size).toBe(5);
  });

  it("allows one concurrent winner without replacing its different snapshot", async () => {
    const context = await store();
    const results = await Promise.allSettled(["one", "two"].map((value) => context.reopen().prepare({ identity: identity(), source: source({ "a": Buffer.from(value) }) })));
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    const winner = results.find((value) => value.status === "fulfilled");
    expect(await context.reopen().inspectCandidate(identity())).toEqual(winner?.status === "fulfilled" ? winner.value : null);
  });

  it("recovers interrupted object writes without treating unretained objects as a prepared candidate", async () => {
    const context = await store();
    const snapshot = source({ "a": Buffer.from("interrupted") });
    const interrupted = { ...snapshot, async openFile() { return (async function* () { yield Buffer.from("inter"); throw new Error("process interrupted"); })(); } };
    await expect(context.store.prepare({ identity: identity(), source: interrupted })).rejects.toThrow("process interrupted");
    expect(await context.reopen().inspectCandidate(identity())).toBeNull();
    expect(await git(context.repository, "for-each-ref", "--format=%(refname)")).toBe("");
    const prepared = await context.reopen().prepare({ identity: identity(), source: snapshot });
    expect(await context.reopen().inspectCandidate(identity())).toEqual(prepared);
  });

  it("repairs a missing retention alias and preserves an existing different alias", async () => {
    const context = await store();
    const input = { identity: identity(), source: source({ "a": Buffer.from("original") }) };
    const prepared = await context.store.prepare(input);
    const alias = (await git(context.repository, "for-each-ref", "--format=%(refname)", "refs/contextvault/revisions")).trim();
    await git(context.repository, "update-ref", "-d", alias);
    await expect(context.reopen().inspectCandidate(identity())).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await context.reopen().prepare(input)).toEqual(prepared);
    const other = await context.store.prepare({ identity: identity("other"), source: source({}) });
    const otherObject = other.privateReference.opaqueKey.split("/").at(-1)!;
    await git(context.repository, "update-ref", alias, otherObject);
    await expect(context.reopen().prepare(input)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await git(context.repository, "rev-parse", "--verify", alias)).trim()).toBe(otherObject);
  });

  it("preserves lock owners and keeps private server paths out of storage errors", async () => {
    const context = await store();
    const input = { identity: identity(), source: source({ "a": Buffer.from("original") }) };
    const prepared = await context.store.prepare(input);
    const ref = (await git(context.repository, "for-each-ref", "--format=%(refname)", "refs/contextvault/candidates")).trim();
    const lock = path.join(context.repository, `${ref}.lock`);
    await writeFile(lock, "other process owns this lock", { flag: "wx" });
    const failure = await context.reopen().prepare(input).catch((error: Error) => error);
    expect(failure).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect((failure as Error).message).not.toContain(context.rootDirectory);
    await expect(writeFile(lock, "replacement", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
    await rm(lock);
    expect(await context.reopen().inspectCandidate(identity())).toEqual(prepared);
  });
});
