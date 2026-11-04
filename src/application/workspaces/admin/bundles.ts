import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalJson, canonicalizeManifest, manifestDigest, WorkspaceError, type BundleRecord, type CustomerScope, type Principal, type SignedWorkspaceBundle, type WorkspaceScope } from '../../../domain';
import type { ByteStream, SnapshotSource } from '../../../ports/streams';
import type { ServerConfiguration } from '../../../config';
import type { LifecycleRuntime } from '../../runs/runtime';
import { createSafeDirectory, readWorkspaceFile, removeWorkspace, writeWorkspaceFile, StreamLimiter } from '../../files';
import type { SecretsService } from '../../../services/secrets.service';
import { scanContent } from '../../../utils/secrets-scanner';
import { acceptedRevision } from '../../revisions/read';
import type { WorkspaceRuntime } from '../../../config/runtime';

const magic = Buffer.from('CVBNDL1\n');
const handlePattern = /^bundle-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function bundleId(value: string): string { if (!handlePattern.test(value)) throw new WorkspaceError('INVALID_REQUEST', 'A tenant-scoped opaque bundle handle is required'); return value; }
export function bundleMetadata(bundle: BundleRecord) {
  const header = bundle.header;
  return { bundlePath: bundle.id, workspaceId: header?.workspaceId ?? null, manifest: header, state: bundle.state, fileCount: header?.files.length ?? 0, totalSizeBytes: header?.files.reduce((n, f) => n + f.size, 0) ?? 0, _links: { ...(bundle.state === 'ready' ? { download: { href: `/v1/bundles/${bundle.id}` } } : {}), ...(bundle.kind === 'upload' && bundle.state === 'uploading' ? { upload: { href: `/v1/bundles/${bundle.id}` } } : {}) } };
}
class FrameReader {
  private readonly iterator: AsyncIterator<Uint8Array>; private pending = Buffer.alloc(0); private offset = 0; private total = 0;
  constructor(source: ByteStream, readonly maximum: number) { this.iterator = source[Symbol.asyncIterator](); }
  async read(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.maximum) throw new WorkspaceError('QUOTA_EXCEEDED', 'Bundle frame is too large');
    const result = Buffer.alloc(length); let copied = 0;
    while (copied < length) {
      if (this.offset === this.pending.length) { const next = await this.iterator.next(); if (next.done) throw new WorkspaceError('INVALID_MANIFEST', 'Bundle payload ended early'); this.pending = Buffer.from(next.value); this.offset = 0; this.total += this.pending.length; if (this.total > this.maximum) throw new WorkspaceError('QUOTA_EXCEEDED', 'Bundle byte limit exceeded'); }
      const count = Math.min(length - copied, this.pending.length - this.offset); this.pending.copy(result, copied, this.offset, this.offset + count); copied += count; this.offset += count;
    }
    return result;
  }
  async *file(length: number, chunk: number): ByteStream { for (let remaining = length; remaining > 0;) { const count = Math.min(remaining, chunk); yield await this.read(count); remaining -= count; } }
  async end() { if (this.offset !== this.pending.length || !(await this.iterator.next()).done) throw new WorkspaceError('INVALID_MANIFEST', 'Bundle contains trailing payload'); }
  async close() { await this.iterator.return?.(); }
}
export class BundleService {
  private readonly streams: StreamLimiter;
  private readonly scanners = new StreamLimiter(1);
  constructor(readonly lifecycle: LifecycleRuntime, readonly configuration: ServerConfiguration, readonly secrets: () => SecretsService) { this.streams = new StreamLimiter(configuration.limits.maxConcurrentStreams); }
  private root(id: string) { return join(this.configuration.dataDirectory, 'bundles', bundleId(id), 'files'); }
  private lockScope(scope: CustomerScope, id: string): WorkspaceScope { return { ...scope, workspaceId: id as any }; }
  private async authorized(bundle: BundleRecord, principal: Principal) {
    if (bundle.kind === 'export') { if (!bundle.source) throw new WorkspaceError('REVISION_NOT_FOUND', 'Export source is unavailable'); await this.lifecycle.authorize(principal, 'workspace:export', bundle.source.scope); await this.lifecycle.authorize(principal, 'workspace:read', bundle.source.scope); }
    else await this.lifecycle.authorize(principal, 'workspace:create', { customerId: bundle.customerId });
  }
  async get(scope: CustomerScope, principal: Principal, id: string) {
    const bundle = await this.lifecycle.control.getBundle({ customerId: scope.customerId }, bundleId(id)); if (!bundle) throw new WorkspaceError('REVISION_NOT_FOUND', 'Bundle not found in this customer scope'); await this.authorized(bundle, principal); return bundle;
  }
  private keys() {
    const configured = this.configuration.signing; if (!configured) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Bundle signing keys are not configured');
    try { return { keyId: configured.keyId, privateKey: createPrivateKey({ key: Buffer.from(configured.privateKey, 'base64'), format: 'der', type: 'pkcs8' }), publicKey: createPublicKey({ key: Buffer.from(configured.publicKey, 'base64'), format: 'der', type: 'spki' }) }; }
    catch { throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Configured bundle signing keys are invalid'); }
  }
  private validated(header: SignedWorkspaceBundle) {
    const keys = this.keys(); const { signature, ...unsigned } = header ?? {};
    if (header?.version !== '1.0' || header.schemaVersion !== '1' || header.signedBy !== 'contextvault' || header.signatureAlgorithm !== 'Ed25519' || header.keyId !== keys.keyId || typeof header.workspaceId !== 'string' || !header.workspaceId || header.workspaceId.length > 255 || typeof header.revisionId !== 'string' || !header.revisionId || !Number.isFinite(Date.parse(header.createdAt)) || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new WorkspaceError('INVALID_MANIFEST', 'Bundle signature metadata is invalid');
    const manifest = canonicalizeManifest(header.snapshot, this.configuration.limits);
    const files = manifest.entries.flatMap(e => e.kind === 'file' ? [{ path: e.path, size: e.byteLength, hash: `sha256:${e.sha256}` }] : []);
    if (canonicalJson(header.files) !== canonicalJson(files) || !verify(null, Buffer.from(canonicalJson(unsigned)), keys.publicKey, Buffer.from(signature, 'base64'))) throw new WorkspaceError('INVALID_MANIFEST', 'Bundle signature or file selection is invalid');
    return manifest;
  }
  private async scan(bundle: BundleRecord) {
    if (!bundle.header) throw new WorkspaceError('INVALID_MANIFEST', 'Bundle manifest is missing');
    const release = await this.scanners.acquire();
    try {
      const tmk = await this.secrets().getTmk(bundle.customerId);
      for (const entry of bundle.header.snapshot.entries) {
        if (entry.kind !== 'file') continue;
        const decoder = new StringDecoder('utf8'); let pending: string[] = [];
        const inspect = (line: string) => { if ((line.length >= 4 && scanContent(line, entry.path).length) || (tmk?.tmk && line.includes(tmk.tmk))) throw new WorkspaceError('FORBIDDEN', 'Bundle contains embedded secrets'); };
        // Keep one line, rather than a complete file/array of lines. A single long line is bounded by maxFileBytes.
        const consume = (text: string, final = false) => { const lines = text.split('\n'); for (let index = 0; index < lines.length; index++) { pending.push(lines[index]); if (index < lines.length - 1 || final) { inspect(pending.join('')); pending = []; } } };
        for await (const bytes of readWorkspaceFile(this.root(bundle.id), entry, this.configuration.limits)) consume(decoder.write(Buffer.from(bytes)));
        consume(decoder.end(), true);
      }
    } finally { release(); }
  }
  async export(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, key: string, revisionId?: string) {
    await this.lifecycle.authorize(principal, 'workspace:export', scope); const selected = await acceptedRevision(runtime, principal, scope, revisionId); const keys = this.keys(); const now = this.lifecycle.now();
    const unsigned = { version: '1.0' as const, workspaceId: scope.workspaceId, revisionId: selected.revision.id, createdAt: now, schemaVersion: '1' as const, signatureAlgorithm: 'Ed25519' as const, signedBy: 'contextvault' as const, keyId: keys.keyId, snapshot: selected.manifest,
      files: selected.manifest.entries.flatMap(e => e.kind === 'file' ? [{ path: e.path, size: e.byteLength, hash: `sha256:${e.sha256}` }] : []) };
    const header: SignedWorkspaceBundle = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString('base64') }; this.validated(header);
    const bundle = await this.lifecycle.control.createBundle({ scope: { customerId: scope.customerId }, principal, bundle: { id: `bundle-${randomUUID()}`, customerId: scope.customerId, principal, kind: 'export', idempotencyKey: key, requestDigest: this.lifecycle.command('restore', { principal, idempotencyKey: key, request: { workspaceId: scope.workspaceId, revisionId: revisionId ?? null } }, scope).requestDigest, state: 'preparing', version: 1, source: selected.revision, header, manifestDigest: manifestDigest(selected.manifest), createdAt: now, updatedAt: now } });
    const lock = await this.lifecycle.control.acquireCompatibilityLock(this.lockScope(scope, bundle.id), 'bundle-payload');
    try {
      let current = await this.get(scope, principal, bundle.id); if (current.state === 'ready') return current;
      const release = await this.streams.acquire();
      try {
        try { await removeWorkspace(this.root(current.id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await createSafeDirectory(this.root(current.id));
        const source = current.source!; const binding = await this.lifecycle.control.getBinding(source.scope, source.scope.storageBindingId);
        if (!binding || binding.generation !== source.scope.bindingGeneration) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Export binding is unavailable');
        const store = await runtime.revisionStore(binding);
        for (const entry of current.header!.snapshot.entries) {
          await this.authorized(current, principal);
          if (entry.kind === 'directory') { await createSafeDirectory(join(this.root(current.id), entry.path)); continue; }
          await writeWorkspaceFile(this.root(current.id), entry, await store.openFile({ ...source, revisionId: source.id }, entry.path), this.configuration.limits);
        }
        await this.scan(current); current = await this.lifecycle.control.completeBundle({ scope: { customerId: scope.customerId }, principal, id: current.id, expectedVersion: current.version, now: this.lifecycle.now() }); return current;
      } finally { release(); }
    } finally { await lock.release(); }
  }
  async createUpload(principal: Principal, scope: CustomerScope, key: string) {
    const now = this.lifecycle.now(); return this.lifecycle.control.createBundle({ scope, principal, bundle: { id: `bundle-${randomUUID()}`, customerId: scope.customerId, principal, kind: 'upload', idempotencyKey: key, requestDigest: this.lifecycle.command('restore', { principal, idempotencyKey: key, request: { upload: true } }, scope).requestDigest, state: 'uploading', version: 1, source: null, header: null, manifestDigest: null, createdAt: now, updatedAt: now } });
  }
  async source(bundle: BundleRecord): Promise<SnapshotSource> {
    const retained = await this.lifecycle.control.getBundle({ customerId: bundle.customerId }, bundle.id);
    if (!retained || retained.state !== 'ready' || canonicalJson(retained) !== canonicalJson(bundle) || !bundle.header) throw new WorkspaceError('REVISION_NOT_FOUND', 'Immutable verified bundle source is unavailable');
    // Catalog selection already verified this immutable header. Key rotation cannot invalidate a retained source mid-publication.
    const manifest = canonicalizeManifest(bundle.header.snapshot, this.configuration.limits);
    if (manifestDigest(manifest) !== bundle.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Verified bundle manifest differs from its retained digest');
    return { manifest, openFile: async (path, options) => { const entry = manifest.entries.find(e => e.path === path); if (!entry || entry.kind !== 'file') throw new WorkspaceError('REVISION_NOT_FOUND', 'Bundle file not found'); return readWorkspaceFile(this.root(bundle.id), entry, this.configuration.limits, options, this.streams); } };
  }
  async download(principal: Principal, scope: CustomerScope, id: string): Promise<ByteStream> {
    const bundle = await this.get(scope, principal, id); if (bundle.state !== 'ready' || !bundle.header) throw new WorkspaceError('INVALID_TRANSITION', 'Bundle upload or export is incomplete');
    const source = await this.source(bundle); const header = Buffer.from(canonicalJson(bundle.header)); const length = Buffer.alloc(4); length.writeUInt32BE(header.length); const self = this;
    return (async function* () { await self.authorized(bundle, principal); for (const frame of [magic, length, header]) for (let offset = 0; offset < frame.length; offset += self.configuration.limits.maxChunkBytes) yield frame.subarray(offset, offset + self.configuration.limits.maxChunkBytes); for (const entry of source.manifest.entries) { if (entry.kind !== 'file') continue; for await (const chunk of await source.openFile(entry.path)) { await self.authorized(bundle, principal); yield chunk; } } })();
  }
  async upload(principal: Principal, scope: CustomerScope, id: string, bytes: ByteStream) {
    if (!bytes || typeof bytes[Symbol.asyncIterator] !== 'function') throw new WorkspaceError('INVALID_REQUEST', 'Bundle uploads require application/vnd.contextvault.bundle');
    const maximumHeader = 8192 + 2 * this.configuration.limits.maxEntries * (this.configuration.limits.maxPathBytes + 256);
    const reader = new FrameReader(bytes, maximumHeader + this.configuration.limits.maxTotalBytes + 12);
    const lock = await this.lifecycle.control.acquireCompatibilityLock(this.lockScope(scope, bundleId(id)), 'bundle-payload'); let release = () => {};
    try {
      release = await this.streams.acquire();
      let bundle = await this.get(scope, principal, id); if (bundle.kind !== 'upload') throw new WorkspaceError('INVALID_TRANSITION', 'An export handle cannot accept uploaded payload');
      if (!(await reader.read(8)).equals(magic)) throw new WorkspaceError('INVALID_MANIFEST', 'Unknown bundle format');
      const length = (await reader.read(4)).readUInt32BE(); if (length > maximumHeader) throw new WorkspaceError('QUOTA_EXCEEDED', 'Bundle manifest frame exceeds its limit');
      let header: SignedWorkspaceBundle; try { header = JSON.parse((await reader.read(length)).toString('utf8')); } catch { throw new WorkspaceError('INVALID_MANIFEST', 'Bundle manifest frame is invalid'); }
      const manifest = bundle.header && canonicalJson(bundle.header) === canonicalJson(header) ? canonicalizeManifest(header.snapshot, this.configuration.limits) : this.validated(header);
      bundle = await this.lifecycle.control.selectBundleManifest({ scope, principal, id, expectedVersion: bundle.version, header, now: this.lifecycle.now() });
      const ready = bundle.state === 'ready';
      if (!ready) { try { await removeWorkspace(this.root(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await createSafeDirectory(this.root(id)); }
      for (const entry of manifest.entries) {
        await this.authorized(bundle, principal);
        if (entry.kind === 'directory') { if (!ready) await createSafeDirectory(join(this.root(id), entry.path)); continue; }
        const source = reader.file(entry.byteLength, this.configuration.limits.maxChunkBytes);
        if (ready) { const { verifyFileStream } = await import('../../../domain'); for await (const _chunk of verifyFileStream(entry, source, this.configuration.limits)) { /* Verify replay without replacing immutable ready bytes. */ } }
        else await writeWorkspaceFile(this.root(id), entry, source, this.configuration.limits);
      }
      await reader.end(); if (ready) return bundle;
      await this.scan(bundle); return this.lifecycle.control.completeBundle({ scope, principal, id, expectedVersion: bundle.version, now: this.lifecycle.now() });
    } finally { try { await reader.close(); } finally { release(); await lock.release(); } }
  }
}
