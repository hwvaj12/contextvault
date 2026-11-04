import { afterEach, describe, expect, it } from "vitest";
import { canonicalManifestBytes } from "../../../src/domain";
import type { RevisionStore } from "../../../src/ports/revision-store";
import { bytes, canonicalSource, identity, reference, scope, source } from "./fixtures";

export interface RevisionStoreContractContext { store: RevisionStore; reopen(): RevisionStore; close(): Promise<void> }
/** Backend-neutral assertions. S3 must supply a real adapter and independent durable reopen. */
export function revisionStoreContract(backend: string, createContext: () => Promise<RevisionStoreContractContext>): void {
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
async function store() { const context = await createContext(); cleanup.push(context.close); return context; }

describe(`real ${backend} revision contract`, () => {
  it("retains the canonical manifest, binary bytes, CRLF, and explicit empty directories after reopen", async () => {
    const context = await store();
    const fixture = await canonicalSource();
    const prepared = await context.store.prepare({ identity: identity(), source: fixture.source });
    const { createdAt, ...persisted } = identity();
    expect(prepared).toMatchObject({ ...persisted, preparedAt: createdAt, manifestDigest: fixture.digest });
    const reopened = context.reopen();
    const manifest = await reopened.readManifest(reference(prepared));
    expect(Buffer.from(canonicalManifestBytes(manifest)).toString()).toBe(fixture.canonical);
    for (const [name, expected] of Object.entries(fixture.files)) expect(await bytes(await reopened.openFile(reference(prepared), name))).toEqual(expected);
    expect(await reopened.inspectCandidate(identity())).toEqual(prepared);
    expect(prepared).not.toHaveProperty("accepted");
  });

  it("roundtrips an empty workspace and nested empty directories", async () => {
    const context = await store();
    for (const [index, snapshot] of [source({}), source({}, ["empty", "nested/empty"])].entries()) {
      const prepared = await context.store.prepare({ identity: identity(String(index)), source: snapshot });
      expect(await context.reopen().readManifest(reference(prepared))).toEqual(snapshot.manifest);
    }
  });

  it("rejects corrupt bytes before retaining a candidate", async () => {
    const context = await store();
    const fixture = await canonicalSource();
    fixture.source.openFile = async () => (async function* () { yield Buffer.from("wrong"); })();
    await expect(context.store.prepare({ identity: identity(), source: fixture.source })).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    expect(await context.reopen().inspectCandidate(identity())).toBeNull();
  });

  it("rejects unsafe manifests and does not open their files", async () => {
    const context = await store();
    const snapshot = source({ "../escape": Buffer.from("secret") });
    snapshot.openFile = async () => { throw new Error("unsafe stream opened"); };
    await expect(context.store.prepare({ identity: identity(), source: snapshot })).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });

  it("validates every scope, revision, digest, store, and opaque locator before reading", async () => {
    const context = await store();
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "file": Buffer.from("bytes") }) });
    for (const bad of [
      { ...prepared, scope: { ...scope, customerId: "other" } },
      { ...prepared, scope: { ...scope, workspaceId: "other" } },
      { ...prepared, scope: { ...scope, bindingGeneration: 2 } },
      { ...prepared, revisionId: "other" }, { ...prepared, manifestDigest: "0".repeat(64) },
      { ...prepared, privateReference: { ...prepared.privateReference, storeId: "other" } },
      { ...prepared, privateReference: { ...prepared.privateReference, opaqueKey: "../../HEAD" } },
    ]) await expect(context.store.readManifest(bad as typeof prepared)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    for (const name of ["../escape", "file/../../HEAD", ".git/config", "missing"]) {
      await expect(context.store.openFile(prepared, name)).rejects.toBeDefined();
    }
  });

  it("honors cancellation before preparing or reading bytes", async () => {
    const context = await store();
    const controller = new AbortController(); controller.abort();
    await expect(context.store.prepare({ identity: identity(), source: source({}), signal: controller.signal })).rejects.toBeDefined();
    expect(await context.store.inspectCandidate(identity())).toBeNull();
    const prepared = await context.store.prepare({ identity: identity(), source: source({ "file": Buffer.from("bytes") }) });
    await expect(context.store.openFile(prepared, "file", { signal: controller.signal })).rejects.toBeDefined();
  });
});
}
