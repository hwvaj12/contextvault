import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalJson, canonicalizeManifest, manifestDigest, WorkspaceError, type FileEntry, type Manifest, type Revision, type StorageMigration, type Workspace, type WorkspaceLimits } from '../../domain';
import { createSafeDirectory, descriptorBytes, openRegularFile, readVerifiedFile, readWorkspaceFile, syncDirectory, writeWorkspaceFile } from '../files';
import type { SnapshotSource } from '../../ports/streams';

export const proofDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Finish an interrupted link/unlink publication only when every duplicate is a known private backup temporary. */
export async function openImmutableBackupFile(directory: string, file: string, temporaryName: RegExp): Promise<FileHandle> {
  try { return await openRegularFile(directory, file); }
  catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'INVALID_MANIFEST') throw error;
    const final = join(directory, file); const before = await lstat(final);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink < 2) throw error;
    const duplicates: string[] = [];
    for (const name of await readdir(directory)) if (name !== file && temporaryName.test(name)) { const stat = await lstat(join(directory, name)); if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === before.dev && stat.ino === before.ino) duplicates.push(name); }
    const after = await lstat(final);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || duplicates.length !== before.nlink - 1) throw error;
    for (const name of duplicates) await unlink(join(directory, name)); await syncDirectory(directory);
    return openRegularFile(directory, file);
  }
}
const jsonTemporary = /^pending-[a-f0-9-]{36}\.json$/;
export async function saveImmutableJson(directory: string, file: string, value: unknown) {
  await createSafeDirectory(directory); const bytes = Buffer.from(canonicalJson(value));
  try { const current = await openImmutableBackupFile(directory, file, jsonTemporary); try { if (!(await current.readFile()).equals(bytes)) throw new WorkspaceError('RECEIPT_MISMATCH', 'Immutable migration evidence differs'); return; } finally { await current.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory, `pending-${randomUUID()}.json`); const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { try { await link(temporary, join(directory, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const current = await openRegularFile(directory, file); try { if (!(await current.readFile()).equals(bytes)) throw new WorkspaceError('RECEIPT_MISMATCH', 'Concurrent migration evidence differs'); } finally { await current.close(); } } await syncDirectory(directory); }
  finally { await unlink(temporary); }
}
export async function archiveRevision(directory: string, revision: Revision, source: SnapshotSource, limits: WorkspaceLimits, signal?: AbortSignal) {
  const root = join(directory, 'revisions', proofDigest(revision.id)); await createSafeDirectory(root);
  await saveImmutableJson(root, 'snapshot.json', { revision, manifest: source.manifest }); const files = join(root, 'files'); await createSafeDirectory(files);
  for (const entry of source.manifest.entries) {
    signal?.throwIfAborted();
    if (entry.kind === 'directory') { await createSafeDirectory(join(files, entry.path)); continue; }
    try { for await (const _chunk of readWorkspaceFile(files, entry, limits, { signal })) { /* Existing completed files are verified, never overwritten. */ } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeWorkspaceFile(files, entry, await source.openFile(entry.path, { signal }), limits, { signal }); }
  }
}
export async function archiveSecrets(directory: string, sourcePath: string, limits: WorkspaceLimits) {
  const source = await openRegularFile(dirname(sourcePath), basename(sourcePath)); const digest = createHash('sha256'); let size = 0;
  try { for await (const bytes of descriptorBytes(source, limits.maxChunkBytes)) { size += bytes.length; if (size > limits.maxFileBytes) throw new WorkspaceError('QUOTA_EXCEEDED', 'Secrets backup exceeds its configured byte limit'); digest.update(bytes); } } finally { await source.close(); }
  const entry: FileEntry = { path: 'legacy-secrets.json', kind: 'file', byteLength: size, sha256: digest.digest('hex') };
  try { for await (const _chunk of readWorkspaceFile(directory, entry, limits)) { /* Retain the first complete backup. */ } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeWorkspaceFile(directory, entry, readVerifiedFile(dirname(sourcePath), basename(sourcePath), entry, limits), limits); }
  return { byteLength: size, sha256: entry.sha256 };
}
export interface BackupReceipt { schemaVersion: 1; workspace: Workspace; revisions: readonly Revision[]; manifests: readonly { revisionId: string; manifest: Manifest }[]; catalogSha256: string; secrets: { byteLength: number; sha256: string } }

/** Read back durable backup bytes on every resume and immediately before acceptance. */
export async function verifyMigrationBackup(migration: StorageMigration, workspace: Workspace, revisions: readonly Revision[], catalogSha256: string, limits: WorkspaceLimits, signal?: AbortSignal) {
  if (migration.backup?.state !== 'ready') throw new WorkspaceError('RECEIPT_MISMATCH', 'Migration backup is incomplete');
  const directory = migration.backup.directory; const handle = await openRegularFile(directory, 'receipt.json'); let bytes: Buffer;
  try { if ((await handle.stat()).size > 64 * 1024 * 1024) throw new WorkspaceError('QUOTA_EXCEEDED', 'Migration backup receipt exceeds its bound'); bytes = await handle.readFile(); } finally { await handle.close(); }
  const receipt = JSON.parse(bytes.toString('utf8')) as BackupReceipt;
  if (proofDigest(receipt) !== migration.backup.receiptDigest || receipt.schemaVersion !== 1 || receipt.catalogSha256 !== catalogSha256 || canonicalJson(receipt.workspace) !== canonicalJson(workspace) || canonicalJson(receipt.revisions) !== canonicalJson(revisions) || receipt.manifests.length !== revisions.length) throw new WorkspaceError('RECEIPT_MISMATCH', 'Migration backup differs from its original verified receipt');
  for (const revision of revisions) {
    const selected = receipt.manifests.filter(value => value.revisionId === revision.id);
    if (selected.length !== 1) throw new WorkspaceError('RECEIPT_MISMATCH', 'Migration backup omits retained history');
    const manifest = canonicalizeManifest(selected[0].manifest, limits);
    if (manifestDigest(manifest) !== revision.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Migration backup manifest changed');
    const root = join(directory, 'revisions', proofDigest(revision.id));
    const snapshot = await openRegularFile(root, 'snapshot.json');
    try { if (!(await snapshot.readFile()).equals(Buffer.from(canonicalJson({ revision, manifest })))) throw new WorkspaceError('RECEIPT_MISMATCH', 'Migration backup revision metadata changed'); } finally { await snapshot.close(); }
    for (const entry of manifest.entries) if (entry.kind === 'file') for await (const _bytes of readWorkspaceFile(join(root, 'files'), entry, limits, { signal })) signal?.throwIfAborted();
  }
  const secrets: FileEntry = { path: 'legacy-secrets.json', kind: 'file', byteLength: receipt.secrets.byteLength, sha256: receipt.secrets.sha256 };
  for await (const _bytes of readWorkspaceFile(directory, secrets, limits, { signal })) signal?.throwIfAborted();
}
