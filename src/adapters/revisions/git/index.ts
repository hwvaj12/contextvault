import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceError, canonicalJson, canonicalizeManifest, canonicalManifestBytes, manifestDigest,
  validatePortablePath, verifyFileStream,
} from "../../../domain";
import type { BindingScope, CandidateIdentity, CollectionPermit, FileEntry, Manifest, PreparedRevision, PrivateLocator, Timestamp } from "../../../domain";
import type { PrepareRevisionInput, RevisionStore, RevisionWriterTracking } from "../../../ports/revision-store";
import type { ByteStream, RevisionReference, StreamOptions } from "../../../ports/streams";
import { gitBlob, gitCommand } from "./process";
import { oidPattern, snapshotTree, treeEntries, validateTree, writeTree } from "./trees";
import { syncDirectoryAncestry, syncPath, syncRefDirectories } from "./durability";

export interface GitRevisionStoreOptions {
  /** Server-controlled private directory, never an agent checkout or caller-supplied locator. */
  rootDirectory: string;
  storeId: string;
  /** Verify a current catalog collection claim which permanently fences later acceptance. Default: deny. */
  verifyCollectionPermit?: (permit: CollectionPermit, now: Timestamp) => Promise<boolean>;
  /** Required for collection; server composition uses durable catalog writer records. */
  writerTracking?: RevisionWriterTracking;
}
interface LoadedCandidate {
  identity: CandidateIdentity; manifest: Manifest; files: Map<string, string>;
  fileEntries: Map<string, FileEntry>; prepared: PreparedRevision; weight: number;
}
const maxCachedCandidates = 16;
const maxCachePayloadBytes = 64 * 1024 * 1024;
const zero = "0".repeat(40);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const conflict = (): never => { throw new WorkspaceError("REVISION_CONFLICT", "Candidate identity or immutable contents differ from the retained revision"); };
const missing = (): never => { throw new WorkspaceError("REVISION_NOT_FOUND", "Internal revision reference does not match retained content"); };
const broken = (): never => { throw new WorkspaceError("STORAGE_UNAVAILABLE", "Private Git revision metadata is invalid"); };
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value); }
function scopeValid(value: unknown): value is BindingScope {
  return exact(value, ["customerId", "workspaceId", "storageBindingId", "bindingGeneration"])
    && id(value.customerId) && id(value.workspaceId) && id(value.storageBindingId)
    && Number.isSafeInteger(value.bindingGeneration) && (value.bindingGeneration as number) > 0;
}
function identityCopy(value: CandidateIdentity): CandidateIdentity {
  if (!exact(value, ["candidateId", "revisionId", "operationId", "scope", "parentRevisionId", "createdAt"])
    || !scopeValid(value.scope) || !id(value.candidateId) || !id(value.revisionId) || !id(value.operationId)
    || (value.parentRevisionId !== null && !id(value.parentRevisionId)) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new WorkspaceError("INVALID_REQUEST", "Revision preparation requires the original complete candidate identity");
  }
  return JSON.parse(canonicalJson(value));
}
function refs(identity: CandidateIdentity) {
  const scoped = hash(identity.scope);
  const candidate = hash({ scope: identity.scope, candidateId: identity.candidateId });
  return { scoped, candidate, candidateRef: `refs/contextvault/candidates/${scoped}/${candidate}`,
    revisionRef: `refs/contextvault/revisions/${scoped}/${hash(identity.revisionId)}`,
    collectedRef: `refs/contextvault/collected/${scoped}/${candidate}` };
}

/** Immutable Git objects retain bytes; only the catalog can establish acceptance. */
export class GitRevisionStore implements RevisionStore {
  private initialized?: Promise<string>;
  private readonly options: GitRevisionStoreOptions;
  private readonly loaded = new Map<string, LoadedCandidate>();
  private readonly loading = new Map<string, Promise<LoadedCandidate>>();
  private cachePayloadBytes = 0;
  constructor(options: GitRevisionStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory) || !id(options.storeId)) throw new WorkspaceError("INVALID_REQUEST", "Git storage requires an absolute private directory and store ID");
    if (options.writerTracking && [options.writerTracking.begin, options.writerTracking.finish, options.writerTracking.stopped].some(method => typeof method !== "function")) throw new WorkspaceError("INVALID_REQUEST", "Revision writer tracking must be complete");
    const tracking = options.writerTracking;
    this.options = { ...options, writerTracking: tracking ? { begin: tracking.begin.bind(tracking), finish: tracking.finish.bind(tracking), stopped: tracking.stopped.bind(tracking) } : undefined };
  }

  private repository(): Promise<string> {
    if (!this.initialized) this.initialized = this.initialize().catch((error) => {
      this.initialized = undefined;
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("STORAGE_UNAVAILABLE", "Cannot initialize private Git storage", { retryable: true });
    });
    return this.initialized;
  }
  private async initialize(): Promise<string> {
    await mkdir(this.options.rootDirectory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.options.rootDirectory)).isDirectory()) throw new WorkspaceError("INVALID_REQUEST", "Git storage root must be a private real directory");
    const root = await realpath(this.options.rootDirectory);
    // A durable child cannot compensate for an unflushed parent entry naming the storage root.
    await syncDirectoryAncestry(root);
    const repository = path.join(root, "objects.git");
    const marker = canonicalJson({ format: "contextvault-private-git-v1", storeId: this.options.storeId });
    try { await lstat(repository); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = await mkdtemp(path.join(root, "initializing-"));
      try {
        await gitCommand(null, ["init", "--bare", "--object-format=sha1", "--template=", temporary]);
        await writeFile(path.join(temporary, "contextvault-format"), marker, { flag: "wx", mode: 0o600 });
        for (const name of ["config", "HEAD", "description", "contextvault-format"]) await syncPath(path.join(temporary, name), true);
        await syncPath(temporary);
        try { await rename(temporary, repository); }
        catch (failure) { if (!["EEXIST", "ENOTEMPTY"].includes((failure as NodeJS.ErrnoException).code ?? "")) throw failure; }
        await syncPath(root);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    let storedMarker: string | null = null;
    if ((await lstat(repository)).isDirectory()) {
      try { storedMarker = await readFile(path.join(repository, "contextvault-format"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (storedMarker !== marker) {
      throw new WorkspaceError("INVALID_REQUEST", "Git storage refuses unowned repositories or symlinks");
    }
    return repository;
  }

  private async lookup(repository: string, ref: string): Promise<string | null> {
    const result = await gitCommand(repository, ["rev-parse", "--verify", "--quiet", ref], undefined, undefined, [0, 1]);
    if (result.code === 1) return null;
    const objectId = result.bytes.toString("ascii").trim();
    if (!oidPattern.test(objectId)) return broken();
    return objectId;
  }
  private async blob(repository: string, bytes: ByteStream | Uint8Array, signal?: AbortSignal): Promise<string> {
    const objectId = (await gitCommand(repository, ["hash-object", "-w", "--no-filters", "--stdin"], bytes, signal)).bytes.toString("ascii").trim();
    if (!oidPattern.test(objectId)) return broken();
    return objectId;
  }
  private locator(identity: CandidateIdentity, objectId: string): PrivateLocator {
    const names = refs(identity);
    return { storeId: this.options.storeId, opaqueKey: `v1/${names.scoped}/${names.candidate}/${objectId}` };
  }
  private prepared(identity: CandidateIdentity, manifest: Manifest, objectId: string): PreparedRevision {
    const { createdAt, ...persisted } = identity;
    return { ...persisted, manifestDigest: manifestDigest(manifest), privateReference: this.locator(identity, objectId), preparedAt: createdAt };
  }

  async prepare(input: PrepareRevisionInput): Promise<PreparedRevision> {
    const identity = identityCopy(input.identity); const tracking = this.options.writerTracking;
    if (!tracking) return this.prepareOwned({ ...input, identity });
    const writerId = randomUUID(); await tracking.begin(identity, writerId);
    try { return await this.prepareOwned({ ...input, identity }); }
    finally { await tracking.finish(identity, writerId); }
  }
  private async prepareOwned(input: PrepareRevisionInput): Promise<PreparedRevision> {
    input.signal?.throwIfAborted();
    const identity = identityCopy(input.identity);
    const manifest = canonicalizeManifest(input.source.manifest);
    const repository = await this.repository();
    const names = refs(identity);
    if (await this.lookup(repository, names.collectedRef)) return conflict();
    const files = new Map<string, string>();
    for (const entry of manifest.entries) {
      input.signal?.throwIfAborted();
      if (entry.kind === "file") files.set(entry.path, await this.blob(repository,
        verifyFileStream(entry, await input.source.openFile(entry.path, { signal: input.signal })), input.signal));
    }
    const filesObject = await writeTree(repository, snapshotTree(manifest, files), input.signal);
    const identityObject = await this.blob(repository, Buffer.from(canonicalJson(identity)), input.signal);
    const manifestObject = await this.blob(repository, canonicalManifestBytes(manifest), input.signal);
    const objectId = (await gitCommand(repository, ["mktree", "-z"], Buffer.from(
      `040000 tree ${filesObject}\tfiles\0` + `100644 blob ${identityObject}\tidentity\0` + `100644 blob ${manifestObject}\tmanifest\0`), input.signal)).bytes.toString("ascii").trim();
    for (let attempt = 0; attempt < 16; attempt++) {
      const existing = await this.lookup(repository, names.candidateRef);
      const alias = await this.lookup(repository, names.revisionRef);
      if ((existing && existing !== objectId) || (alias && alias !== objectId) || await this.lookup(repository, names.collectedRef)) return conflict();
      const commands = `start\nverify ${names.collectedRef} ${zero}\n`
        + `${existing ? "verify" : "create"} ${names.candidateRef} ${objectId}\n`
        + `${alias ? "verify" : "create"} ${names.revisionRef} ${objectId}\nprepare\ncommit\n`;
      try {
        await gitCommand(repository, ["update-ref", "--stdin"], Buffer.from(commands), input.signal);
        await syncRefDirectories(repository, names.scoped);
        return this.prepared(identity, manifest, objectId);
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!(error instanceof WorkspaceError) || error.code !== "STORAGE_UNAVAILABLE" || attempt === 15) throw error;
      }
    }
    return broken();
  }

  private async load(repository: string, objectId: string): Promise<LoadedCandidate> {
    const cached = this.loaded.get(objectId);
    if (cached) {
      this.loaded.delete(objectId);
      this.loaded.set(objectId, cached);
      return cached;
    }
    const existing = this.loading.get(objectId);
    if (existing) return existing;
    const pending = this.loadUncached(repository, objectId).then((candidate) => {
      this.cache(objectId, candidate);
      return candidate;
    }).finally(() => { if (this.loading.get(objectId) === pending) this.loading.delete(objectId); });
    // Coalesce requests for the same immutable object without an unbounded pending-key cache.
    if (this.loading.size < maxCachedCandidates) this.loading.set(objectId, pending);
    return pending;
  }
  private cache(objectId: string, candidate: LoadedCandidate): void {
    if (candidate.weight > maxCachePayloadBytes) return;
    const old = this.loaded.get(objectId);
    if (old) { this.cachePayloadBytes -= old.weight; this.loaded.delete(objectId); }
    while (this.loaded.size >= maxCachedCandidates || this.cachePayloadBytes + candidate.weight > maxCachePayloadBytes) {
      const oldest = this.loaded.keys().next().value!;
      this.cachePayloadBytes -= this.loaded.get(oldest)!.weight;
      this.loaded.delete(oldest);
    }
    this.loaded.set(objectId, candidate);
    this.cachePayloadBytes += candidate.weight;
  }
  private async loadUncached(repository: string, objectId: string): Promise<LoadedCandidate> {
    const entries = await treeEntries(repository, objectId);
    if (entries.size !== 3 || entries.get("files")?.kind !== "directory" || entries.get("identity")?.kind !== "file" || entries.get("manifest")?.kind !== "file") return broken();
    const identityBytes = (await gitCommand(repository, ["cat-file", "blob", entries.get("identity")!.objectId])).bytes;
    const manifestBytes = (await gitCommand(repository, ["cat-file", "blob", entries.get("manifest")!.objectId])).bytes;
    let identity: CandidateIdentity;
    let manifest: Manifest;
    try {
      identity = identityCopy(JSON.parse(identityBytes.toString("utf8")));
      manifest = canonicalizeManifest(JSON.parse(manifestBytes.toString("utf8")));
      if (!Buffer.from(canonicalJson(identity)).equals(identityBytes) || !Buffer.from(canonicalManifestBytes(manifest)).equals(manifestBytes)) return broken();
    } catch { return broken(); }
    const files = await validateTree(repository, entries.get("files")!.objectId, snapshotTree(manifest, new Map()));
    const fileEntries = new Map(manifest.entries.filter((entry): entry is FileEntry => entry.kind === "file").map((entry) => [entry.path, entry]));
    // Budget UTF-16 payloads and conservative per-entry overhead; also cap snapshot and pending-key counts.
    const weight = 2 * (identityBytes.length + manifestBytes.length) + manifest.entries.length * 256 + 4096
      + [...files.keys()].reduce((total, name) => total + name.length * 2 + 208, 0);
    return { identity, manifest, files, fileEntries, prepared: this.prepared(identity, manifest, objectId), weight };
  }
  private async retained(reference: RevisionReference): Promise<{ repository: string; loaded: LoadedCandidate }> {
    if (!scopeValid(reference.scope) || reference.privateReference?.storeId !== this.options.storeId
      || !/^v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{40}$/.test(reference.privateReference.opaqueKey)) return missing();
    const [ , scoped, candidate, objectId] = reference.privateReference.opaqueKey.split("/");
    if (scoped !== hash(reference.scope)) return missing();
    const repository = await this.repository();
    const candidateObject = await this.lookup(repository, `refs/contextvault/candidates/${scoped}/${candidate}`);
    if ((candidateObject !== null && candidateObject !== objectId)
      || await this.lookup(repository, `refs/contextvault/collected/${scoped}/${candidate}`)) return missing();
    const loaded = await this.load(repository, objectId);
    if (canonicalJson(loaded.identity.scope) !== canonicalJson(reference.scope) || loaded.identity.revisionId !== reference.revisionId
      || loaded.prepared.manifestDigest !== reference.manifestDigest || canonicalJson(loaded.prepared.privateReference) !== canonicalJson(reference.privateReference)
      || await this.lookup(repository, refs(loaded.identity).revisionRef) !== objectId) return missing();
    return { repository, loaded };
  }

  async readManifest(reference: RevisionReference): Promise<Manifest> { return structuredClone((await this.retained(reference)).loaded.manifest); }
  async openFile(reference: RevisionReference, name: string, options: StreamOptions = {}): Promise<ByteStream> {
    options.signal?.throwIfAborted();
    validatePortablePath(name);
    const { repository, loaded } = await this.retained(reference);
    const entry = loaded.fileEntries.get(name);
    if (!entry) throw new WorkspaceError("REVISION_NOT_FOUND", "File is absent from the exact revision manifest");
    return verifyFileStream(entry, gitBlob(repository, loaded.files.get(name)!, options.signal));
  }
  async inspectCandidate(input: CandidateIdentity): Promise<PreparedRevision | null> {
    const identity = identityCopy(input);
    const repository = await this.repository();
    const names = refs(identity);
    if (await this.lookup(repository, names.collectedRef)) return null;
    const candidateObject = await this.lookup(repository, names.candidateRef);
    const revisionObject = await this.lookup(repository, names.revisionRef);
    const objectId = candidateObject ?? revisionObject;
    if (!objectId) return null;
    if (revisionObject !== objectId) return broken();
    const loaded = await this.load(repository, objectId);
    if (canonicalJson(identity) !== canonicalJson(loaded.identity)) return conflict();
    if (await this.lookup(repository, names.collectedRef)) return null;
    for (const entry of loaded.manifest.entries) if (entry.kind === "file") {
      for await (const _chunk of verifyFileStream(entry, gitBlob(repository, loaded.files.get(entry.path)!))) { /* Verify complete immutable bytes. */ }
    }
    await syncRefDirectories(repository, names.scoped);
    return structuredClone(loaded.prepared);
  }

  async deleteCollectible(input: CollectionPermit, now: Timestamp): Promise<void> {
    const permit: CollectionPermit = JSON.parse(canonicalJson(input));
    const stale = (): never => { throw new WorkspaceError("STALE_FENCE", "Collection requires a matching unexpired catalog claim"); };
    if (!this.options.verifyCollectionPermit || !this.options.writerTracking || !scopeValid(permit.scope) || !id(permit.candidateId)
      || !Number.isSafeInteger(permit.collectionFence) || permit.collectionFence <= 0
      || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.parse(now)) return stale();
    if (permit.kind === "partial") return this.deletePartialCollectible(permit, now);
    if (permit.privateReference?.storeId !== this.options.storeId
      || !/^v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{40}$/.test(permit.privateReference.opaqueKey)) return stale();
    const [ , scoped, candidate, objectId] = permit.privateReference.opaqueKey.split("/");
    if (scoped !== hash(permit.scope) || candidate !== hash({ scope: permit.scope, candidateId: permit.candidateId })) return stale();
    const repository = await this.repository();
    const candidateRef = `refs/contextvault/candidates/${scoped}/${candidate}`;
    const collectedRef = `refs/contextvault/collected/${scoped}/${candidate}`;
    const collected = await this.lookup(repository, collectedRef);
    if (collected) {
      if (!await this.options.verifyCollectionPermit(permit, now)) return stale();
      const tombstone = JSON.parse((await gitCommand(repository, ["cat-file", "blob", collected])).bytes.toString("utf8"));
      const identity = identityCopy(tombstone.identity);
      if (canonicalJson(tombstone.permit.privateReference) !== canonicalJson(permit.privateReference)
        || identity.candidateId !== permit.candidateId || canonicalJson(identity.scope) !== canonicalJson(permit.scope)) return stale();
      if (!await this.options.writerTracking.stopped(identity)) return stale();
      await syncRefDirectories(repository, scoped);
      await this.removeCollectedRefs(repository, identity, objectId, collected, permit, now);
      return;
    }
    if (await this.lookup(repository, candidateRef) !== objectId) return stale();
    const loaded = await this.load(repository, objectId);
    if (loaded.identity.candidateId !== permit.candidateId || canonicalJson(loaded.identity.scope) !== canonicalJson(permit.scope)
      || canonicalJson(loaded.prepared.privateReference) !== canonicalJson(permit.privateReference)) return stale();
    if (!await this.options.writerTracking.stopped(loaded.identity)) return stale();
    const names = refs(loaded.identity);
    if (await this.lookup(repository, names.revisionRef) !== objectId) return stale();
    const tombstone = await this.blob(repository, Buffer.from(canonicalJson({ identity: loaded.identity, permit })));
    // The callback checks eligibility and permanently fences later acceptance before returning true.
    if (!await this.options.verifyCollectionPermit(permit, now)) return stale();
    try {
      // Persist the nonreplaceable tombstone before removing any retention reference.
      await gitCommand(repository, ["update-ref", "--stdin"], Buffer.from(`start\nverify ${candidateRef} ${objectId}\nverify ${names.revisionRef} ${objectId}\ncreate ${collectedRef} ${tombstone}\nprepare\ncommit\n`));
    } catch (error) {
      if (!await this.lookup(repository, collectedRef)) throw error;
      // A concurrent collector must validate the winning immutable tombstone too.
      return this.deleteCollectible(permit, now);
    }
    await syncRefDirectories(repository, names.scoped);
    await this.removeCollectedRefs(repository, loaded.identity, objectId, tombstone, permit, now);
  }

  private async deletePartialCollectible(permit: CollectionPermit & { kind: "partial" }, now: Timestamp): Promise<void> {
    const stale = (): never => { throw new WorkspaceError("STALE_FENCE", "Partial Git collection requires current exact ownership"); };
    if (permit.storeId !== this.options.storeId || canonicalJson(permit.identity.scope) !== canonicalJson(permit.scope) || permit.identity.candidateId !== permit.candidateId) return stale();
    const identity = identityCopy(permit.identity);
    if (!this.options.writerTracking || !await this.options.writerTracking.stopped(identity)) return stale();
    const names = refs(identity); const repository = await this.repository();
    for (let attempt = 0; attempt < 16; attempt++) {
      const collected = await this.lookup(repository, names.collectedRef);
      if (collected) {
        const record = JSON.parse((await gitCommand(repository, ["cat-file", "blob", collected])).bytes.toString("utf8")) as { identity: CandidateIdentity; objectId: string | null; partial: boolean };
        if (record.partial !== true || canonicalJson(record.identity) !== canonicalJson(identity) || (record.objectId !== null && !oidPattern.test(record.objectId))) return stale();
        if (!await this.options.verifyCollectionPermit!(permit, now)) return stale();
        await syncRefDirectories(repository, names.scoped);
        if (record.objectId) await this.removeCollectedRefs(repository, identity, record.objectId, collected, permit, now);
        return;
      }
      const objectId = await this.lookup(repository, names.candidateRef);
      const alias = await this.lookup(repository, names.revisionRef);
      if (objectId) {
        const loaded = await this.load(repository, objectId);
        if (canonicalJson(loaded.identity) !== canonicalJson(identity) || alias !== objectId) return stale();
      } else if (alias) return stale();
      const tombstone = await this.blob(repository, Buffer.from(canonicalJson({ identity, objectId, partial: true, permit })));
      if (!await this.options.verifyCollectionPermit!(permit, now)) return stale();
      try {
        await gitCommand(repository, ["update-ref", "--stdin"], Buffer.from(`start\nverify ${names.candidateRef} ${objectId ?? zero}\nverify ${names.revisionRef} ${alias ?? zero}\ncreate ${names.collectedRef} ${tombstone}\nprepare\ncommit\n`));
      } catch (error) { if (attempt === 15 || !await this.lookup(repository, names.collectedRef)) throw error; continue; }
      await syncRefDirectories(repository, names.scoped);
      if (objectId) await this.removeCollectedRefs(repository, identity, objectId, tombstone, permit, now);
      return;
    }
  }

  private async removeCollectedRefs(repository: string, identity: CandidateIdentity, objectId: string, tombstone: string, permit: CollectionPermit, now: Timestamp): Promise<void> {
    const names = refs(identity);
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = await this.lookup(repository, names.candidateRef);
      const revision = await this.lookup(repository, names.revisionRef);
      if ((candidate && candidate !== objectId) || (revision && revision !== objectId)) return conflict();
      if (!candidate && !revision) { await syncRefDirectories(repository, names.scoped); return; }
      if (!this.options.verifyCollectionPermit || !this.options.writerTracking || !await this.options.writerTracking.stopped(identity) || !await this.options.verifyCollectionPermit(permit, now)) throw new WorkspaceError("STALE_FENCE", "Git collection fence or writer state changed before reference retirement");
      try {
        await gitCommand(repository, ["update-ref", "--stdin"], Buffer.from(`start\nverify ${names.collectedRef} ${tombstone}\n`
          + (candidate ? `delete ${names.candidateRef} ${objectId}\n` : "")
          + (revision ? `delete ${names.revisionRef} ${objectId}\n` : "") + "prepare\ncommit\n"));
        await syncRefDirectories(repository, names.scoped);
        return;
      } catch (error) { if (attempt === 15) throw error; }
    }
  }
}
