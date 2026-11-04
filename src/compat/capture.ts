import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { canonicalJson, canonicalizeManifest, manifestDigest, WorkspaceError, type Manifest, type Principal, type RunId, type WorkspaceScope } from '../domain';
import { assertSafeDirectory, containedPath, createSafeDirectory, openRegularFile, persistByteStream, removeWorkspace, syncDirectory, walkWorkspace } from '../application/files';
import type { ByteStream, SnapshotSource } from '../ports/streams';
import type { WorkspaceRuntime } from '../config/runtime';
import { hash, loadJournal, saveJournal } from './journal';
export interface CapturedSource { kind: 'capture'; captureId: string; manifest: Manifest }
export interface CaptureOwner { group: string; key: string; requestDigest: string; journalFile: string; runId?: RunId | null }
interface Allocation {
  captureId: string; scope: WorkspaceScope; actorId: string; credentialId: string; group: string; key: string;
  requestDigest: string; journalRef: string; runId: RunId | null; manifest: Manifest;
  state: 'allocating' | 'sealed' | 'discarding' | 'failed' | 'cleaned'; retryable: boolean;
}
interface CaptureMetadata { captureId: string; scope: WorkspaceScope; actorId: string; credentialId: string; manifestDigest: string; state: 'allocated' | 'sealed'; allocation?: { group: string; key: string } }
const owner = (principal: Principal) => ({ actorId: principal.actorId, credentialId: principal.credential.id });
function root(runtime: WorkspaceRuntime, captureId: string) {
  if (!/^capture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(captureId)) throw new WorkspaceError('INVALID_REQUEST', 'Invalid immutable capture identity');
  return join(runtime.configuration.dataDirectory, 'legacy-compat', 'captures', captureId);
}
const legacyRoot = (runtime: WorkspaceRuntime) => join(runtime.configuration.dataDirectory, 'legacy-compat');
function allocationDirectory(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, group: string) { return join(legacyRoot(runtime), 'capture-owners', hash({ scope, ...owner(principal), group })); }
function allocationFile(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, group: string, key: string) { return join(allocationDirectory(runtime, principal, scope, group), `${hash(key)}.json`); }
function journalReference(runtime: WorkspaceRuntime, file: string) {
  const value = relative(legacyRoot(runtime), file).split(sep).join('/');
  if (!/^(commands|checkpoints)\/[a-f0-9]{64}\.json$/.test(value)) throw new WorkspaceError('INVALID_REQUEST', 'Capture ownership requires a scoped command journal'); return value;
}
function validateAllocation(record: Allocation, principal: Principal, scope: WorkspaceScope, group: string) {
  if (canonicalJson(record.scope) !== canonicalJson(scope) || canonicalJson(owner(principal)) !== canonicalJson({ actorId: record.actorId, credentialId: record.credentialId }) || record.group !== group) throw new WorkspaceError('FORBIDDEN', 'Capture allocation belongs to another owner');
}
async function allocation(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, identity: CaptureOwner) {
  const file = allocationFile(runtime, principal, scope, identity.group, identity.key); const record = await loadJournal<Allocation>(file);
  if (record) {
    validateAllocation(record, principal, scope, identity.group);
    if (record.key !== identity.key || record.requestDigest !== identity.requestDigest || record.journalRef !== journalReference(runtime, identity.journalFile)) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Capture allocation belongs to another original command');
    if (identity.runId && record.runId && identity.runId !== record.runId) throw new WorkspaceError('RECEIPT_MISMATCH', 'Capture allocation belongs to another run');
  }
  return { file, record };
}
async function referenced(runtime: WorkspaceRuntime, record: Allocation) {
  const journal = await loadJournal<{ source?: { kind?: string; captureId?: string } }>(join(legacyRoot(runtime), ...record.journalRef.split('/')));
  return journal?.source?.kind === 'capture' && journal.source.captureId === record.captureId;
}
// Callers hold the owning session/command OS mutex. A failed allocation owns its payload until disposal is durable.
async function discard(runtime: WorkspaceRuntime, file: string, record: Allocation, terminal = false): Promise<boolean> {
  if (!terminal && await referenced(runtime, record)) return false;
  record.state = 'discarding'; record.retryable = !terminal; await saveJournal(file, record);
  try { await removeWorkspace(root(runtime, record.captureId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  record.state = terminal ? 'cleaned' : 'failed'; await saveJournal(file, record); return true;
}
export async function hasPendingCapture(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, identity: CaptureOwner) {
  const { record } = await allocation(runtime, principal, scope, identity); return !!record && !['failed', 'cleaned'].includes(record.state);
}
async function retained(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, identity: CaptureOwner): Promise<CapturedSource | null> {
  const { file, record } = await allocation(runtime, principal, scope, identity); if (!record || record.state === 'failed') return null;
  if (record.state === 'cleaned' || (record.state === 'discarding' && !record.retryable)) throw new WorkspaceError('INVALID_TRANSITION', 'The original capture was explicitly cleaned up');
  if (record.state === 'discarding' && record.retryable) { if (await discard(runtime, file, record)) return null; }
  const metadata = await loadJournal<CaptureMetadata>(join(root(runtime, record.captureId), 'state.json'));
  if (metadata?.state === 'sealed' && metadata.manifestDigest === manifestDigest(record.manifest)) {
    record.state = 'sealed'; await saveJournal(file, record); return { kind: 'capture', captureId: record.captureId, manifest: record.manifest };
  }
  throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Interrupted capture is retained; explicitly abandon the stopped session before a new capture');
}
async function allocate(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, identity: CaptureOwner, manifest: Manifest) {
  const file = allocationFile(runtime, principal, scope, identity.group, identity.key);
  const record: Allocation = { captureId: `capture-${randomUUID()}`, scope, ...owner(principal), group: identity.group, key: identity.key, requestDigest: identity.requestDigest, journalRef: journalReference(runtime, identity.journalFile), runId: identity.runId ?? null, manifest, state: 'allocating', retryable: false };
  // This external owner record is durable before a payload directory or file can be created.
  await saveJournal(file, record); return { file, record };
}
async function prepare(runtime: WorkspaceRuntime, record: Allocation) {
  await saveJournal(join(root(runtime, record.captureId), 'state.json'), { captureId: record.captureId, scope: record.scope, actorId: record.actorId, credentialId: record.credentialId, manifestDigest: manifestDigest(record.manifest), state: 'allocated', allocation: { group: record.group, key: record.key } } satisfies CaptureMetadata);
  await createSafeDirectory(join(root(runtime, record.captureId), 'files'));
}
async function seal(runtime: WorkspaceRuntime, file: string, record: Allocation): Promise<CapturedSource> {
  await saveJournal(join(root(runtime, record.captureId), 'state.json'), { captureId: record.captureId, scope: record.scope, actorId: record.actorId, credentialId: record.credentialId, manifestDigest: manifestDigest(record.manifest), state: 'sealed', allocation: { group: record.group, key: record.key } } satisfies CaptureMetadata);
  record.state = 'sealed'; await saveJournal(file, record); return { kind: 'capture', captureId: record.captureId, manifest: record.manifest };
}
export async function discardUnselectedCapture(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, identity: CaptureOwner) {
  const { file, record } = await allocation(runtime, principal, scope, identity); if (record) await discard(runtime, file, record);
}
export async function* ownedCaptureRuns(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, group: string): AsyncIterable<{ runId: RunId; pending: boolean }> {
  let directory; try { await assertSafeDirectory(allocationDirectory(runtime, principal, scope, group)); directory = await opendir(allocationDirectory(runtime, principal, scope, group)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for await (const entry of directory) {
    if (!entry.name.endsWith('.json')) continue; const file = join(allocationDirectory(runtime, principal, scope, group), entry.name); const record = await loadJournal<Allocation>(file); if (!record || record.state === 'cleaned') continue;
    validateAllocation(record, principal, scope, group); if (file !== allocationFile(runtime, principal, scope, group, record.key) || !record.runId) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Capture ownership requires reconciliation');
    yield { runId: record.runId, pending: ['allocating', 'sealed'].includes(record.state) };
  }
}
export async function cleanupOwnedCaptures(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, group: string) {
  let directory; try { await assertSafeDirectory(allocationDirectory(runtime, principal, scope, group)); directory = await opendir(allocationDirectory(runtime, principal, scope, group)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for await (const entry of directory) {
    if (!entry.name.endsWith('.json')) continue; const file = join(allocationDirectory(runtime, principal, scope, group), entry.name); const record = await loadJournal<Allocation>(file); if (!record || record.state === 'cleaned') continue;
    validateAllocation(record, principal, scope, group); if (file !== allocationFile(runtime, principal, scope, group, record.key) || !record.runId) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Capture ownership requires reconciliation');
    const run = await runtime.control.getRun(scope, record.runId);
    if (!run?.outcome || ['active', 'finalizing'].includes(run.state)) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Pending capture source must remain available');
    await discard(runtime, file, record, true);
  }
}
export async function bindCaptureRun(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, source: CapturedSource, runId: RunId) {
  const metadata = await loadJournal<CaptureMetadata>(join(root(runtime, source.captureId), 'state.json'));
  if (!metadata?.allocation) return; // Earlier unowned captures remain conservatively retained.
  const file = allocationFile(runtime, principal, scope, metadata.allocation.group, metadata.allocation.key); const record = await loadJournal<Allocation>(file);
  if (!record || record.captureId !== source.captureId) throw new WorkspaceError('RECEIPT_MISMATCH', 'Capture allocation is unavailable'); validateAllocation(record, principal, scope, metadata.allocation.group);
  if (record.runId && record.runId !== runId) throw new WorkspaceError('RECEIPT_MISMATCH', 'Capture source cannot be shared by different runs');
  if (!record.runId) { record.runId = runId; await saveJournal(file, record); }
}
const fingerprint = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => canonicalJson({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
async function scan(runtime: WorkspaceRuntime, directory: string, baseline: Manifest) {
  const limits = runtime.configuration.limits; const entries = await walkWorkspace(directory, false, limits); const explicit = new Set(baseline.entries.filter(e => e.kind === 'directory').map(e => e.path));
  const fingerprints = new Map<string, string>(); const manifestEntries = []; let total = 0;
  for (const entry of entries) {
    if (entry.kind === 'directory') { if (explicit.has(entry.path) || !entries.some(child => child.path.startsWith(`${entry.path}/`))) manifestEntries.push(entry); continue; }
    const handle = await openRegularFile(directory, entry.path);
    try {
      const before = await handle.stat(); if (before.size > limits.maxFileBytes || total + before.size > limits.maxTotalBytes) throw new WorkspaceError('QUOTA_EXCEEDED', 'Sandbox exceeds snapshot byte limits');
      const hash = createHash('sha256'); let byteLength = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: limits.maxChunkBytes })) { byteLength += chunk.byteLength; if (byteLength > limits.maxFileBytes || total + byteLength > limits.maxTotalBytes) throw new WorkspaceError('QUOTA_EXCEEDED', 'Sandbox exceeds snapshot byte limits'); hash.update(chunk); }
      const after = await handle.stat(); if (fingerprint(before) !== fingerprint(after) || byteLength !== before.size) throw new WorkspaceError('CAPTURE_CHANGED', 'Sandbox changed during capture');
      total += byteLength; fingerprints.set(entry.path, fingerprint(after)); manifestEntries.push({ ...entry, byteLength, sha256: hash.digest('hex') });
    } finally { await handle.close(); }
  }
  return { manifest: canonicalizeManifest({ schemaVersion: 1, entries: manifestEntries }, limits), fingerprints, entries };
}
async function unchanged(runtime: WorkspaceRuntime, directory: string, scanned: Awaited<ReturnType<typeof scan>>) {
  const entries = await walkWorkspace(directory, false, runtime.configuration.limits);
  if (canonicalJson(entries) !== canonicalJson(scanned.entries)) throw new WorkspaceError('CAPTURE_CHANGED', 'Sandbox changed during capture');
  for (const [path, expected] of scanned.fingerprints) if (fingerprint(await lstat(containedPath(directory, path))) !== expected) throw new WorkspaceError('CAPTURE_CHANGED', 'Sandbox changed during capture');
}
export async function inspectWorkspace(runtime: WorkspaceRuntime, directory: string, baseline: Manifest): Promise<Manifest> { const scanned = await scan(runtime, directory, baseline); await unchanged(runtime, directory, scanned); return scanned.manifest; }
export async function captureWorkspace(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, directory: string, baseline: Manifest, identity: CaptureOwner): Promise<CapturedSource> {
  const existing = await retained(runtime, principal, scope, identity); if (existing) return existing;
  const scanned = await scan(runtime, directory, baseline); const { file, record } = await allocate(runtime, principal, scope, identity, scanned.manifest); const destination = join(root(runtime, record.captureId), 'files');
  try {
  await prepare(runtime, record);
  for (const entry of scanned.manifest.entries) {
    const target = containedPath(destination, entry.path); await createSafeDirectory(entry.kind === 'directory' ? target : dirname(target)); if (entry.kind !== 'file') continue;
    const source = await openRegularFile(directory, entry.path); let output;
    try {
      if (fingerprint(await source.stat()) !== scanned.fingerprints.get(entry.path)) throw new WorkspaceError('CAPTURE_CHANGED', 'Sandbox changed before immutable copy');
      output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await persistByteStream(output, source.createReadStream({ autoClose: false, highWaterMark: runtime.configuration.limits.maxChunkBytes }), entry, runtime.configuration.limits);
      if (fingerprint(await source.stat()) !== scanned.fingerprints.get(entry.path)) throw new WorkspaceError('CAPTURE_CHANGED', 'Sandbox changed during immutable copy');
    } finally { await source.close(); await output?.close(); }
    await syncDirectory(dirname(target));
  }
  await unchanged(runtime, directory, scanned); return await seal(runtime, file, record);
  } catch (error) { await discard(runtime, file, record).catch(() => {}); throw error; }
}
export async function captureInline(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, input: { manifest: Manifest; files: { path: string; base64: string }[] }, identity: CaptureOwner): Promise<CapturedSource> {
  const existing = await retained(runtime, principal, scope, identity); if (existing) return existing;
  const manifest = canonicalizeManifest(input.manifest, runtime.configuration.limits); const { file, record } = await allocate(runtime, principal, scope, identity, manifest); const destination = join(root(runtime, record.captureId), 'files');
  try {
  await prepare(runtime, record);
  for (const entry of manifest.entries) {
    const target = containedPath(destination, entry.path); await createSafeDirectory(entry.kind === 'directory' ? target : dirname(target)); if (entry.kind !== 'file') continue;
    const file = input.files.find(file => file.path === entry.path); if (!file) throw new WorkspaceError('RECEIPT_MISMATCH', 'Snapshot source is unavailable'); const bytes = Buffer.from(file.base64, 'base64');
    const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await persistByteStream(output, (async function* () { for (let offset = 0; offset < bytes.length; offset += runtime.configuration.limits.maxChunkBytes) yield bytes.subarray(offset, offset + runtime.configuration.limits.maxChunkBytes); })(), entry, runtime.configuration.limits); } finally { await output.close(); }
    await syncDirectory(dirname(target));
  }
  return await seal(runtime, file, record);
  } catch (error) { await discard(runtime, file, record).catch(() => {}); throw error; }
}
export async function capturedProvider(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, source: CapturedSource): Promise<SnapshotSource> {
  const directory = root(runtime, source.captureId); const metadata = await loadJournal<CaptureMetadata>(join(directory, 'state.json'));
  if (!metadata || metadata.state !== 'sealed' || canonicalJson(metadata.scope) !== canonicalJson(scope) || canonicalJson(owner(principal)) !== canonicalJson({ actorId: metadata.actorId, credentialId: metadata.credentialId }) || metadata.manifestDigest !== manifestDigest(source.manifest)) throw new WorkspaceError('RECEIPT_MISMATCH', 'Immutable capture identity differs from its durable source');
  return { manifest: source.manifest, async openFile(path) {
    const handle = await openRegularFile(join(directory, 'files'), path);
    return (async function* () { try { yield* handle.createReadStream({ autoClose: false, highWaterMark: runtime.configuration.limits.maxChunkBytes }); } finally { await handle.close(); } })();
  } };
}
export async function hydrateWorkspace(runtime: WorkspaceRuntime, directory: string, manifest: Manifest, openFile: (path: string) => Promise<ByteStream>): Promise<void> {
  await createSafeDirectory(directory);
  for (const entry of manifest.entries) {
    const target = containedPath(directory, entry.path); await createSafeDirectory(entry.kind === 'directory' ? target : dirname(target)); if (entry.kind !== 'file') continue;
    const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await persistByteStream(output, await openFile(entry.path), entry, runtime.configuration.limits); } finally { await output.close(); }
    await syncDirectory(dirname(target));
  }
}
