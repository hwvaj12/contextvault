import {
  WorkspaceError, canonicalJson, canonicalizeManifest, manifestDigest, validatePortablePath,
  type BindingScope, type CandidateIdentity, type CollectionPermit, type FileEntry, type Manifest,
  type PreparedRevision, type PrivateLocator, type Timestamp,
} from '../../../domain';
import type { PrepareRevisionInput, RevisionStore, RevisionWriterTracking } from '../../../ports/revision-store';
import type { ByteStream, RevisionReference, StreamOptions } from '../../../ports/streams';
import { S3Objects, hash, type S3ObjectOptions } from './objects';
import { StreamLimiter } from '../../../application/files';
import { randomUUID } from 'node:crypto';
export type { S3ObjectOptions } from './objects';
export interface S3RevisionStoreOptions extends S3ObjectOptions {
  /** Must verify current catalog eligibility and permanently fence later acceptance. Default: deny. */
  verifyCollectionPermit?: (permit: CollectionPermit, now: Timestamp) => Promise<boolean>;
  /** Collection stays denied without completed, durable writer tracking. */
  writerTracking?: RevisionWriterTracking;
}
interface Intent { schemaVersion: 1; identity: CandidateIdentity; manifest: Manifest }
interface Loaded { intent: Intent; prepared: PreparedRevision; entries: Map<string, FileEntry>; weight: number }
const conflict = (): never => { throw new WorkspaceError('REVISION_CONFLICT', 'Candidate identity or immutable revision contents differ'); };
const missing = (): never => { throw new WorkspaceError('REVISION_NOT_FOUND', 'Internal revision reference does not match retained S3 content'); };
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
function scopeValid(v: unknown): v is BindingScope {
  return exact(v, ['customerId', 'workspaceId', 'storageBindingId', 'bindingGeneration']) && id(v.customerId) && id(v.workspaceId) && id(v.storageBindingId) && Number.isSafeInteger(v.bindingGeneration) && (v.bindingGeneration as number) > 0;
}
function identityCopy(v: CandidateIdentity): CandidateIdentity {
  if (!exact(v, ['candidateId', 'revisionId', 'operationId', 'scope', 'parentRevisionId', 'createdAt']) || !scopeValid(v.scope)
    || !id(v.candidateId) || !id(v.revisionId) || !id(v.operationId) || (v.parentRevisionId !== null && !id(v.parentRevisionId)) || !id(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt))) {
    throw new WorkspaceError('INVALID_REQUEST', 'Revision preparation requires the original complete candidate identity');
  }
  return structuredClone(v);
}
/** Revision-local immutable objects prepare bytes. The catalog alone establishes publication. */
export class S3RevisionStore implements RevisionStore {
  private readonly objects: S3Objects;
  private readonly cache = new Map<string, Loaded>();
  private cacheBytes = 0;
  private readonly loading = new Map<string, Promise<Loaded | null>>();
  private readonly loadLimiter: StreamLimiter;
  private readonly options: S3RevisionStoreOptions;
  constructor(options: S3RevisionStoreOptions) {
    if (options.writerTracking && [options.writerTracking.begin, options.writerTracking.finish, options.writerTracking.stopped].some(method => typeof method !== 'function')) throw new WorkspaceError('INVALID_REQUEST', 'Revision writer tracking must be complete');
    const tracking = options.writerTracking;
    this.options = { ...options, writerTracking: tracking ? { begin: tracking.begin.bind(tracking), finish: tracking.finish.bind(tracking), stopped: tracking.stopped.bind(tracking) } : undefined }; this.objects = new S3Objects(options);
    this.loadLimiter = new StreamLimiter(this.objects.limits.maxConcurrentStreams);
  }
  private root(identity: CandidateIdentity): string { return `v1/${hash(identity.scope)}/${hash({ scope: identity.scope, candidateId: identity.candidateId })}`; }
  private alias(identity: CandidateIdentity): string { return `revisions/${hash(identity.scope)}/${hash(identity.revisionId)}.json`; }
  private locator(identity: CandidateIdentity): PrivateLocator { return { storeId: this.options.storeId, opaqueKey: this.root(identity) }; }
  private prepared(intent: Intent): PreparedRevision {
    const { createdAt, ...identity } = intent.identity;
    return { ...identity, manifestDigest: manifestDigest(intent.manifest, this.objects.limits), privateReference: this.locator(intent.identity), preparedAt: createdAt };
  }
  private fileKey(root: string, path: string): string { return `${root}/files/${hash(path)}`; }
  private async alive(root: string): Promise<boolean> { return !await this.objects.exists(`${root}/collected.json`); }
  private async load(root: string): Promise<Loaded | null> {
    if (this.cache.has(root)) return this.loadUncached(root);
    const pending = this.loading.get(root); if (pending) return pending;
    // Admit distinct keys before creating their promise or downloading a metadata body.
    const release = await this.loadLimiter.acquire();
    const admitted = this.loading.get(root);
    if (admitted) { release(); return admitted; }
    const loading = this.loadUncached(root).finally(() => { this.loading.delete(root); release(); });
    this.loading.set(root, loading);
    return loading;
  }
  private async loadUncached(root: string): Promise<Loaded | null> {
    let loaded = this.cache.get(root);
    if (!loaded) {
      const raw = await this.objects.json<Intent>(`${root}/intent.json`); if (!raw) return null;
      if (!exact(raw, ['schemaVersion', 'identity', 'manifest']) || raw.schemaVersion !== 1) return missing();
      const identity = identityCopy(raw.identity); const manifest = canonicalizeManifest(raw.manifest, this.objects.limits);
      if (root !== this.root(identity)) return missing();
      const intent: Intent = { schemaVersion: 1, identity, manifest };
      if (canonicalJson(raw) !== canonicalJson(intent)) return missing();
      loaded = { intent, prepared: this.prepared(intent), entries: new Map(manifest.entries.filter((e): e is FileEntry => e.kind === 'file').map(e => [e.path, e])),
        weight: Buffer.byteLength(canonicalJson(intent)) + manifest.entries.length * 512 };
      if (loaded.weight <= 32 * 1024 * 1024) {
        while (this.cache.size >= 16 || this.cacheBytes + loaded.weight > 32 * 1024 * 1024) {
          const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.weight; this.cache.delete(first);
        }
        this.cache.set(root, loaded); this.cacheBytes += loaded.weight;
      }
    } else { this.cache.delete(root); this.cache.set(root, loaded); }
    return loaded;
  }
  private async complete(root: string, loaded: Loaded): Promise<boolean> {
    if (!await this.alive(root)) return false;
    const marker = await this.objects.json(`${root}/prepared.json`);
    if (!marker) return false;
    if (canonicalJson(marker) !== canonicalJson({ schemaVersion: 1, intentDigest: hash(loaded.intent), prepared: loaded.prepared })) return missing();
    const alias = await this.objects.json(this.alias(loaded.intent.identity));
    if (canonicalJson(alias) !== canonicalJson({ root, intentDigest: hash(loaded.intent) })) return missing();
    return this.alive(root);
  }
  async prepare(input: PrepareRevisionInput): Promise<PreparedRevision> {
    const identity = identityCopy(input.identity); const tracking = this.options.writerTracking;
    if (!tracking) return this.prepareOwned({ ...input, identity });
    const writerId = randomUUID(); await tracking.begin(identity, writerId);
    return this.objects.withStoppedWriter(() => this.prepareOwned({ ...input, identity }), () => tracking.finish(identity, writerId));
  }
  private async prepareOwned(input: PrepareRevisionInput): Promise<PreparedRevision> {
    input.signal?.throwIfAborted();
    const identity = identityCopy(input.identity); const manifest = canonicalizeManifest(input.source.manifest, this.objects.limits);
    const intent: Intent = { schemaVersion: 1, identity, manifest }; const root = this.root(identity);
    if (!await this.alive(root)) return conflict();
    // Bind identity, complete manifest, and revision alias durably before opening any source bytes.
    await this.objects.putJson(`${root}/intent.json`, intent, conflict, input.signal);
    await this.objects.putJson(this.alias(identity), { root, intentDigest: hash(intent) }, conflict, input.signal);
    for (const entry of manifest.entries) if (entry.kind === 'file') {
      if (!await this.alive(root)) return conflict();
      await this.objects.upload(this.fileKey(root, entry.path), await input.source.openFile(entry.path, { signal: input.signal }), entry, input.signal);
    }
    if (!await this.alive(root)) return conflict();
    const prepared = this.prepared(intent);
    await this.objects.putJson(`${root}/prepared.json`, { schemaVersion: 1, intentDigest: hash(intent), prepared }, conflict, input.signal);
    if (!await this.alive(root)) return conflict();
    return prepared;
  }
  private async retained(reference: RevisionReference): Promise<{ root: string; loaded: Loaded }> {
    if (!scopeValid(reference.scope) || reference.privateReference?.storeId !== this.options.storeId || !/^v1\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(reference.privateReference.opaqueKey)) return missing();
    const root = reference.privateReference.opaqueKey;
    if (root.split('/')[1] !== hash(reference.scope)) return missing();
    const loaded = await this.load(root);
    if (!loaded || canonicalJson(loaded.intent.identity.scope) !== canonicalJson(reference.scope) || loaded.prepared.revisionId !== reference.revisionId
      || loaded.prepared.manifestDigest !== reference.manifestDigest || !await this.complete(root, loaded)) return missing();
    return { root, loaded };
  }
  async readManifest(reference: RevisionReference): Promise<Manifest> { return structuredClone((await this.retained(reference)).loaded.intent.manifest); }
  async openFile(reference: RevisionReference, path: string, options: StreamOptions = {}): Promise<ByteStream> {
    options.signal?.throwIfAborted(); validatePortablePath(path, this.objects.limits);
    const { root, loaded } = await this.retained(reference); const entry = loaded.entries.get(path); if (!entry) return missing();
    return this.objects.file(this.fileKey(root, path), entry, options);
  }
  async inspectCandidate(input: CandidateIdentity): Promise<PreparedRevision | null> {
    const identity = identityCopy(input); const root = this.root(identity);
    if (!await this.alive(root)) return null;
    const loaded = await this.load(root); if (!loaded) return null;
    if (canonicalJson(loaded.intent.identity) !== canonicalJson(identity)) return conflict();
    if (!await this.complete(root, loaded)) return null;
    for (const entry of loaded.entries.values()) {
      const release = await this.objects.limiter.acquire();
      try { await this.objects.verify(this.fileKey(root, entry.path), entry); } finally { release(); }
    }
    if (!await this.alive(root)) return null;
    return structuredClone(loaded.prepared);
  }
  async deleteCollectible(input: CollectionPermit, now: Timestamp): Promise<void> {
    const permit = structuredClone(input);
    const stale = (): never => { throw new WorkspaceError('STALE_FENCE', 'S3 collection requires an exact unexpired catalog permit'); };
    if (!this.options.verifyCollectionPermit || !this.options.writerTracking || !scopeValid(permit.scope) || !id(permit.candidateId) || !Number.isSafeInteger(permit.collectionFence) || permit.collectionFence <= 0
      || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.parse(now)) return stale();
    if (permit.kind === 'partial' ? permit.storeId !== this.options.storeId || permit.identity.candidateId !== permit.candidateId || canonicalJson(permit.identity.scope) !== canonicalJson(permit.scope) : permit.privateReference?.storeId !== this.options.storeId) return stale();
    const root = `v1/${hash(permit.scope)}/${hash({ scope: permit.scope, candidateId: permit.candidateId })}`;
    if (permit.kind !== 'partial' && permit.privateReference.opaqueKey !== root) return stale();
    const tombstoneKey = `${root}/collected.json`;
    const tombstone = await this.objects.json<{ scope: BindingScope; candidateId: string; privateReference: PrivateLocator; identity: CandidateIdentity }>(tombstoneKey);
    const intent = await this.load(root);
    const identity = permit.kind === 'partial' ? identityCopy(permit.identity) : intent?.intent.identity ?? (tombstone?.identity ? identityCopy(tombstone.identity) : null);
    if (!identity || identity.candidateId !== permit.candidateId || canonicalJson(identity.scope) !== canonicalJson(permit.scope) || (intent && canonicalJson(intent.intent.identity) !== canonicalJson(identity))) return stale();
    const expected = { scope: permit.scope, candidateId: permit.candidateId, privateReference: permit.kind === 'partial' ? { storeId: permit.storeId, opaqueKey: root } : permit.privateReference, identity };
    if (tombstone ? canonicalJson(tombstone) !== canonicalJson(expected) : !intent && (permit.kind !== 'partial' || await this.objects.hasContents(root))) return stale();
    if (!await this.options.writerTracking.stopped(identity)) return stale();
    // The callback must permanently fence later acceptance before it returns true.
    if (!await this.options.verifyCollectionPermit(permit, now)) return stale();
    await this.objects.putJson(tombstoneKey, expected, stale);
    await this.objects.collect(root, tombstoneKey);
    const cached = this.cache.get(root); if (cached) { this.cacheBytes -= cached.weight; this.cache.delete(root); }
  }
}
export function createS3RevisionStore(options: S3RevisionStoreOptions): RevisionStore { return new S3RevisionStore(options); }
