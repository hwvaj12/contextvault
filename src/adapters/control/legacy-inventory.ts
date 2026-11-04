import Database from 'better-sqlite3';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, canonicalizeManifest, manifestDigest, verifyFileStream, WorkspaceError, workspaceLimits, type LegacyInventory, type LegacyInventoryIssue, type LegacyRevisionInventory, type LegacyWorkspaceInventory, type LegacyWorkInventory, type ManifestEntry, type WorkspaceLimits } from '../../domain';
import { assertSafeDirectory, createSafeDirectory, descriptorBytes, openRegularFile, syncDirectory } from '../../application/files';
import { openImmutableBackupFile, proofDigest, saveImmutableJson } from '../../application/migrations/archive';
import type { LegacyAdoptionSource } from '../../ports/control-store';

const execute = promisify(execFile);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
type Metadata = { id: string; declaredId?: string; customerId: string | null; name: string; head: string | null; repository: string; status: string; origin: 'sqlite' | 'json' | 'repository' | 'catalog'; issue?: string; rawDigest?: string };
const stamp = (stat: Awaited<ReturnType<typeof lstat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Offline legacy evidence only. This adapter never supplies runtime workspace authority. */
export class FilesystemLegacyInventory implements LegacyAdoptionSource {
  readonly sourceRoot: string; readonly databasePath: string;
  constructor(options: { sourceRoot: string; databasePath: string }) {
    if (![options.sourceRoot, options.databasePath].every(path => isAbsolute(path) && !path.includes('\0'))) throw new WorkspaceError('INVALID_REQUEST', 'Legacy inventory requires explicit absolute paths');
    this.sourceRoot = resolve(options.sourceRoot); this.databasePath = resolve(options.databasePath);
    this.contained(this.databasePath);
  }
  private contained(path: string) { const value = relative(this.sourceRoot, path); if (value.startsWith('..') || isAbsolute(value)) throw new WorkspaceError('INVALID_REQUEST', 'Legacy evidence escaped the selected source root'); return path; }
  private async regular(path: string) {
    const handle = await openRegularFile(this.sourceRoot, relative(this.sourceRoot, this.contained(path)));
    try { return await handle.readFile(); } finally { await handle.close(); }
  }
  private environment() {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' };
  }
  private gitArguments(repository: string, args: string[]) { return ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', repository, ...args]; }
  private async git(repository: string, args: string[], maximum = 20 * 1024 * 1024) { return (await execute('git', this.gitArguments(repository, args), { env: this.environment(), encoding: 'buffer', maxBuffer: maximum, timeout: 30000, killSignal: 'SIGKILL' })).stdout; }
  private async hasContentFilters(repository: string) {
    try { return (await this.git(repository, ['config', '--includes', '--name-only', '--get-regexp', '^filter\\.'])).length > 0; }
    catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
  }
  private async gitInput(repository: string, args: string[], input: string) {
    const child = spawn('git', this.gitArguments(repository, args), { env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] }); const chunks: Buffer[] = []; let length = 0;
    const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new WorkspaceError('STORAGE_UNAVAILABLE', 'Legacy retained history could not be enumerated'))); }); child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(input); const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try { for await (const bytes of child.stdout) { length += bytes.length; if (length > 20 * 1024 * 1024) throw new WorkspaceError('QUOTA_EXCEEDED', 'Legacy retained history exceeds its enumeration bound'); chunks.push(bytes); } await done; return Buffer.concat(chunks).toString('utf8'); }
    finally { clearTimeout(timer); child.kill('SIGKILL'); await done.catch(() => {}); }
  }
  private async blobDigest(repository: string, oid: string, length: number) {
    const child = spawn('git', this.gitArguments(repository, ['cat-file', 'blob', oid]), { env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new WorkspaceError('STORAGE_UNAVAILABLE', 'Legacy object could not be read'))); });
    child.stderr.resume(); const digest = createHash('sha256'); let count = 0; const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try { for await (const chunk of child.stdout) { count += chunk.length; if (count > length) { child.kill('SIGKILL'); throw new WorkspaceError('RECEIPT_MISMATCH', 'Legacy blob length changed'); } digest.update(chunk); } await exit; if (count !== length) throw new WorkspaceError('RECEIPT_MISMATCH', 'Legacy blob length differs from its tree'); return digest.digest('hex'); }
    finally { clearTimeout(timer); child.kill('SIGKILL'); await exit.catch(() => {}); }
  }
  private async rows(): Promise<{ metadata: Metadata[]; runs: LegacyWorkInventory['runs']; locks: LegacyWorkInventory['locks'] }> {
    try { const handle = await openRegularFile(this.sourceRoot, relative(this.sourceRoot, this.databasePath)); await handle.close(); } catch (error) { if (missing(error)) return { metadata: [], runs: [], locks: [] }; throw error; }
    // Copy database/WAL evidence before opening SQLite, so inventory cannot create or change source journals.
    const copy = await mkdtemp(join(await realpath(tmpdir()), 'cv-legacy-sqlite-read-')); const before = new Map<string, string>();
    try {
      for (const suffix of ['', '-wal']) {
        const file = this.databasePath + suffix;
        try {
          const source = await openRegularFile(this.sourceRoot, relative(this.sourceRoot, file));
          try { const destination = await open(join(copy, 'legacy.db') + suffix, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            try { before.set(file, stamp(await source.stat())); for await (const bytes of descriptorBytes(source, 65536)) await destination.writeFile(bytes); await destination.sync(); }
            finally { await destination.close(); }
          } finally { await source.close(); }
        }
        catch (error) { if (!missing(error)) throw error; before.set(file, 'missing'); }
      }
      const db = new Database(join(copy, 'legacy.db'), { readonly: true, fileMustExist: true });
      let values: Metadata[]; let runs: LegacyWorkInventory['runs'] = []; let locks: LegacyWorkInventory['locks'] = [];
      try {
        db.pragma('query_only = ON');
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get();
        values = !exists ? [] : (db.prepare('SELECT id,customer_id,name,current_head,repo_location,status FROM workspaces ORDER BY id').all() as any[]).map(row => ({ id: row.id, customerId: row.customer_id, name: row.name, head: row.current_head, repository: row.repo_location, status: row.status, origin: 'sqlite' }));
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_records'").get()) for (const row of db.prepare("SELECT data FROM catalog_records WHERE kind='workspace'").all() as { data: string }[]) { const value = JSON.parse(row.data); values.push({ id: value.id, customerId: value.customerId, name: value.name, head: value.currentRevisionId, repository: join(this.sourceRoot, 'workspaces', value.id), status: value.status, origin: 'catalog', issue: 'CATALOG_AUTHORITY_PRESENT' }); }
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get()) runs = db.prepare('SELECT id,workspace_id AS workspaceId,status,sandbox_path AS sandboxPath,base_commit AS baseCommit,workspace_head_at_start AS workspaceHeadAtStart,final_commit AS finalCommit,updated_at AS updatedAt FROM runs ORDER BY id').all() as LegacyWorkInventory['runs'];
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='locks'").get()) locks = db.prepare('SELECT id,workspace_id AS workspaceId,owner_run_id AS ownerRunId,lock_type AS lockType,acquired_at AS acquiredAt,expires_at AS expiresAt,last_heartbeat_at AS lastHeartbeatAt FROM locks ORDER BY id').all() as LegacyWorkInventory['locks'];
      } finally { db.close(); }
      for (const [file, value] of before) { let current: string; try { current = stamp(await lstat(file)); } catch (error) { if (!missing(error)) throw error; current = 'missing'; } if (current !== value) throw new WorkspaceError('CAPTURE_CHANGED', 'Legacy database changed during inventory'); }
      return { metadata: values, runs, locks };
    } finally { await rm(copy, { recursive: true, force: true }); }
  }
  private async metadata() {
    const rows = await this.rows(); const values = rows.metadata; const directory = join(this.sourceRoot, 'workspace-meta'); let files: string[];
    try { await assertSafeDirectory(directory); files = await readdir(directory); } catch (error) { if (missing(error)) files = []; else throw error; }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const id = basename(file, '.json'); let rawDigest: string | undefined;
      try { const bytes = await this.regular(join(directory, file)); rawDigest = hash(bytes); const data = JSON.parse(bytes.toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid metadata object');
        values.push({ id, ...(data.id !== undefined ? { declaredId: data.id } : {}), customerId: data.customerId ?? null, name: data.name ?? id, head: data.latestCommitId ?? null, repository: join(this.sourceRoot, 'workspaces', id), status: data.deletedAt ? 'deleted' : 'active', origin: 'json', rawDigest, ...(!safeId.test(id) ? { issue: 'INVALID_IDENTITY' } : {}) });
      } catch { values.push({ id, customerId: null, name: id, head: null, repository: join(this.sourceRoot, 'workspaces', id), status: 'unknown', origin: 'json', issue: 'INVALID_METADATA', ...(rawDigest ? { rawDigest } : {}) }); }
    }
    const repositories = join(this.sourceRoot, 'workspaces'); let entries: string[];
    try { await assertSafeDirectory(repositories); entries = await readdir(repositories); } catch (error) { if (missing(error)) entries = []; else throw error; }
    for (const id of entries.sort()) if (!values.some(value => value.id === id)) values.push({ id, customerId: null, name: id, head: null, repository: join(repositories, id), status: 'unknown', origin: 'repository', issue: 'MISSING_METADATA' });
    for (const id of [...new Set([...rows.runs.map(value => value.workspaceId), ...rows.locks.map(value => value.workspaceId)])].sort()) if (!values.some(value => value.id === id)) values.push({ id, customerId: null, name: id, head: null, repository: join(repositories, id), status: 'unknown', origin: 'sqlite', issue: 'MISSING_METADATA' });
    return { ...rows, metadata: values };
  }
  private async sandboxes(runs: LegacyWorkInventory['runs']) {
    const paths = new Map<string, Set<string | null>>();
    for (const run of runs) if (run.sandboxPath) {
      const path = resolve(this.sourceRoot, run.sandboxPath); const owners = paths.get(path) ?? new Set<string | null>();
      owners.add(run.id); paths.set(path, owners);
    }
    for (const name of ['sandboxes', 'legacy-compat/sandboxes']) {
      const directory = join(this.sourceRoot, name);
      try { await assertSafeDirectory(directory); for (const child of (await readdir(directory)).sort()) if (!paths.has(join(directory, child))) paths.set(join(directory, child), new Set([null])); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const values: LegacyWorkInventory['sandboxes'][number][] = [];
    for (const [path, owners] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
      for (const runId of owners) {
        try { this.contained(path); await assertSafeDirectory(dirname(path)); const stat = await lstat(path); values.push({ path, runId, exists: true, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special' }); }
        catch (error) { if (missing(error)) values.push({ path, runId, exists: false, kind: 'missing' }); else values.push({ path, runId, exists: null, kind: 'uninspectable' }); }
      }
    }
    return values;
  }
  async openRevision(workspace: LegacyWorkspaceInventory, revision: LegacyRevisionInventory, limits: WorkspaceLimits) {
    if (!workspace.eligible || !workspace.repository || !workspace.revisions.some(value => canonicalJson(value) === canonicalJson(revision)) || !/^[a-f0-9]{40,64}$/.test(revision.alias)) throw new WorkspaceError('INVALID_REQUEST', 'Legacy source must match its reviewed inventory');
    const repository = this.contained(workspace.repository); const manifest = canonicalizeManifest(revision.manifest, limits);
    const args = this.gitArguments.bind(this); const environment = this.environment();
    return { manifest, openFile: async (path: string, options?: { signal?: AbortSignal }) => {
      const entry = manifest.entries.find(value => value.path === path); if (!entry || entry.kind !== 'file') throw new WorkspaceError('REVISION_NOT_FOUND', 'Legacy file is outside the selected manifest');
      const child = spawn('git', args(repository, ['cat-file', 'blob', `${revision.alias}:${path}`]), { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.resume();
      const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new WorkspaceError('STORAGE_UNAVAILABLE', 'Legacy source object could not be read'))); });
      const stop = () => { child.kill('SIGKILL'); }; options?.signal?.addEventListener('abort', stop, { once: true }); const timer = setTimeout(stop, 30000);
      return (async function* () { try {
        const chunks = (async function* () { for await (const chunk of child.stdout) { options?.signal?.throwIfAborted(); for (let offset = 0; offset < chunk.length; offset += limits.maxChunkBytes) yield chunk.subarray(offset, offset + limits.maxChunkBytes); } await done; })();
        yield* verifyFileStream(entry, chunks, limits);
      } finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', stop); stop(); await done.catch(() => {}); } })();
    } };
  }
  async backup(inventory: LegacyInventory, workspace: LegacyWorkspaceInventory, directory: string) {
    const rel = relative(this.sourceRoot, resolve(directory));
    if (inventory.sourceRoot !== this.sourceRoot || inventory.databasePath !== this.databasePath || !workspace.eligible || !workspace.repository || !isAbsolute(directory) || !(rel === '..' || rel.startsWith('../'))) throw new WorkspaceError('INVALID_REQUEST', 'Legacy backup requires a separate explicit private directory');
    await createSafeDirectory(directory); const files: { path: string; byteLength: number; sha256: string }[] = []; let total = 0; let count = 0;
    const copy = async (sourceRoot: string, path: string, destination: string) => {
      if (++count > 1000000) throw new WorkspaceError('QUOTA_EXCEEDED', 'Legacy backup exceeds its file bound');
      const sourcePath = join(sourceRoot, path); const source = await openRegularFile(dirname(sourcePath), basename(sourcePath)); const original = stamp(await source.stat()); const digest = createHash('sha256'); let bytes = 0;
      const parent = resolve(directory, destination, '..'); await createSafeDirectory(parent); const temporary = join(parent, `backup-${createHash('sha256').update(destination).digest('hex')}-${Date.now()}-${Math.random().toString(16).slice(2)}.pending`); const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { for await (const chunk of descriptorBytes(source, 65536)) { bytes += chunk.length; total += chunk.length; if (total > 100 * 1024 ** 3) throw new WorkspaceError('QUOTA_EXCEEDED', 'Legacy backup exceeds its total byte bound'); digest.update(chunk); await output.writeFile(chunk); } await output.sync(); if (stamp(await source.stat()) !== original) throw new WorkspaceError('CAPTURE_CHANGED', 'Legacy file changed during backup'); }
      finally { await output.close(); await source.close(); }
      const sha256 = digest.digest('hex');
      try { try { await link(temporary, join(directory, destination)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const existingPath = join(directory, destination); const ownName = new RegExp(`^backup-${createHash('sha256').update(destination).digest('hex')}-[0-9]+-[a-f0-9]+\\.pending$`); const existing = await openImmutableBackupFile(dirname(existingPath), basename(existingPath), ownName); const check = createHash('sha256'); let size = 0; try { for await (const chunk of descriptorBytes(existing, 65536)) { check.update(chunk); size += chunk.length; } } finally { await existing.close(); } if (size !== bytes || check.digest('hex') !== sha256) throw new WorkspaceError('RECEIPT_MISMATCH', 'Existing legacy backup differs; original backup was retained'); } await syncDirectory(parent); }
      finally { await unlink(temporary); }
      files.push({ path: destination, byteLength: bytes, sha256 });
    };
    const repository = this.contained(workspace.repository);
    const visit = async (path: string) => { await assertSafeDirectory(join(repository, path)); await createSafeDirectory(join(directory, 'repository', path)); for (const name of (await readdir(join(repository, path))).sort()) { const file = path ? `${path}/${name}` : name; const stat = await lstat(join(repository, file)); if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(file); else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await copy(repository, file, `repository/${file}`); else throw new WorkspaceError('INVALID_MANIFEST', 'Legacy repository backup contains a link or special file'); } };
    await visit('');
    for (const suffix of ['', '-wal']) { try { await copy(this.sourceRoot, relative(this.sourceRoot, this.databasePath) + suffix, `metadata/legacy.db${suffix}`); } catch (error) { if (!missing(error)) throw error; } }
    try { await copy(this.sourceRoot, `workspace-meta/${workspace.workspaceId}.json`, 'metadata/workspace.json'); } catch (error) { if (!missing(error)) throw error; }
    const receipt = { schemaVersion: 1, sourceFingerprint: inventory.sourceFingerprint, workspaceId: workspace.workspaceId, files }; await saveImmutableJson(directory, 'legacy-receipt.json', receipt); return proofDigest(receipt);
  }
  async inspect(overrides: Partial<WorkspaceLimits> = {}): Promise<LegacyInventory> {
    await assertSafeDirectory(this.sourceRoot); const limits = workspaceLimits(overrides); const evidence = await this.metadata(); const metadata = evidence.metadata; const sandboxes = await this.sandboxes(evidence.runs); const workspaces: LegacyWorkspaceInventory[] = [];
    for (const id of [...new Set(metadata.map(record => record.id))].sort()) {
      const records = metadata.filter(record => record.id === id); const selected = records[0]; const issues: LegacyInventoryIssue[] = []; const revisions: LegacyRevisionInventory[] = [];
      const authorityHeads: LegacyWorkspaceInventory['authorityHeads'][number][] = records.map(record => ({ source: record.origin, head: record.head }));
      const issue = (code: string, message: string, revision?: string) => issues.push({ code, message, ...(revision ? { revision } : {}) });
      const runs = evidence.runs.filter(run => run.workspaceId === id); const locks = evidence.locks.filter(lock => lock.workspaceId === id); const owned = new Set(runs.map(run => run.id));
      const legacyWork: LegacyWorkInventory = { runs, locks, sandboxes: sandboxes.filter(sandbox => sandbox.runId === null || owned.has(sandbox.runId)) };
      if (runs.some(run => !['merged', 'conflicted', 'failed', 'aborted', 'cleaned_up'].includes(run.status))) issue('SURVIVING_RUN', 'Legacy agent work requires explicit operator settlement');
      if (locks.length) issue('SURVIVING_LOCK', 'Legacy locks require explicit writer-stop proof; expiry does not prove settlement');
      if (legacyWork.sandboxes.some(sandbox => sandbox.exists !== false)) issue('SURVIVING_SANDBOX', 'Legacy sandbox data requires explicit ownership and operator resolution');
      for (const record of records) if (record.issue) issue(record.issue, 'Legacy metadata requires explicit operator resolution');
      if (!safeId.test(id) || typeof selected.customerId !== 'string' || !selected.customerId || selected.customerId.length > 255 || typeof selected.name !== 'string' || !selected.name.trim() || selected.name.length > 255) issue('INVALID_IDENTITY', 'Workspace and customer identifiers require explicit valid metadata');
      if (records.some(record => record.declaredId !== undefined && record.declaredId !== record.id)) issue('AUTHORITY_CONFLICT', 'Metadata filename and its declared workspace identity disagree');
      if (new Set(records.map(record => record.customerId)).size !== 1 || new Set(records.map(record => record.status)).size !== 1 || new Set(records.map(record => record.head)).size !== 1 || new Set(records.map(record => record.name)).size !== 1 || new Set(records.map(record => record.repository && resolve(record.repository))).size !== 1) issue('AUTHORITY_CONFLICT', 'Legacy metadata sources disagree about ownership, name, status, repository or head');
      let repository: string | null = selected.repository ? resolve(selected.repository) : null; let head: string | null = selected.head;
      try {
        if (!repository) throw new WorkspaceError('INVALID_REQUEST', 'Legacy repository location is unavailable');
        this.contained(repository); await assertSafeDirectory(repository);
        const bare = (await this.git(repository, ['rev-parse', '--is-bare-repository'])).toString().trim() === 'true';
        const gitDirectory = resolve((await this.git(repository, ['rev-parse', '--absolute-git-dir'])).toString().trim());
        if (gitDirectory !== repository && !gitDirectory.startsWith(repository + '/')) issue('EXTERNAL_REPOSITORY', 'Legacy repository metadata lives outside its selected repository');
        for (const file of ['objects/info/alternates', 'objects/info/http-alternates', 'shallow']) { try { if ((await lstat(join(gitDirectory, file))).size) issue('EXTERNAL_REPOSITORY', 'Legacy repository requires external or incomplete object history'); } catch (error) { if (!missing(error)) throw error; } }
        const actualHead = (await this.git(repository, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
        authorityHeads.push({ source: 'git', head: actualHead });
        if (!head || head !== actualHead) issue('AUTHORITY_CONFLICT', 'Legacy accepted-head metadata and repository HEAD disagree');
        if (!bare) {
          // Status can execute configured filters. Preserve those repositories for explicit offline resolution without invoking them.
          if (await this.hasContentFilters(repository)) issue('UNSUPPORTED_GIT_FILTER', 'Repository-defined content filters require explicit offline resolution before read-only inventory');
          else if ((await this.git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=all'])).length) issue('DIRTY_WORKSPACE', 'Legacy repository contains uncommitted or untracked data, including ignored contents');
        }
        const commits = (await this.git(repository, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'])).toString().trim().split('\n').filter(row => row.endsWith(' commit')).map(row => row.split(' ')[0]);
        if (commits.length > 10000) throw new WorkspaceError('QUOTA_EXCEEDED', 'Legacy retained history exceeds the inventory revision bound');
        const all = (await this.gitInput(repository, ['rev-list', '--stdin', '--reverse', '--topo-order', '--parents'], commits.join('\n') + '\n')).trim().split('\n').filter(Boolean);
        if (all.length > 10000) throw new WorkspaceError('QUOTA_EXCEEDED', 'Legacy retained history exceeds the inventory revision bound');
        const ancestors = new Set((await this.git(repository, ['rev-list', 'HEAD'])).toString().trim().split('\n'));
        for (const row of all) {
          const [alias, ...parents] = row.split(' ');
          if (parents.length > 1) issue('INCOMPATIBLE_HISTORY', 'Canonical history cannot silently replace a merge topology', alias);
          if (!ancestors.has(alias)) issue('NONCANONICAL_HISTORY', 'Retained history outside the accepted ancestry requires explicit archival', alias);
          let offendingPath: string | undefined;
          try {
            const entries: ManifestEntry[] = [];
            const listing = new TextDecoder('utf-8', { fatal: true }).decode(await this.git(repository, ['ls-tree', '-rz', '--long', alias]));
            for (const record of listing.split('\0').filter(Boolean)) {
              const tab = record.indexOf('\t'); const [mode, type, oid, rawLength] = record.slice(0, tab).split(/\s+/); const path = record.slice(tab + 1);
              offendingPath = path;
              if (!['100644', '100755'].includes(mode) || type !== 'blob') throw new WorkspaceError('INVALID_MANIFEST', 'Legacy history contains a link or unsupported Git entry');
              const length = Number(rawLength); if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxFileBytes) throw new WorkspaceError('QUOTA_EXCEEDED', 'Legacy retained file exceeds its byte limit');
              entries.push({ path, kind: 'file', byteLength: length, sha256: await this.blobDigest(repository, oid, length) });
            }
            let manifest;
            try { manifest = canonicalizeManifest({ schemaVersion: 1, entries }, limits); }
            catch (error) {
              // Canonical validation is monotone over prefixes. Find the first offending entry without duplicating its rules.
              let low = 1; let high = entries.length;
              while (low < high) { const middle = Math.floor((low + high) / 2); try { canonicalizeManifest({ schemaVersion: 1, entries: entries.slice(0, middle) }, limits); low = middle + 1; } catch { high = middle; } }
              offendingPath = entries[low - 1]?.path;
              canonicalizeManifest({ schemaVersion: 1, entries: entries.slice(0, low) }, limits); throw error;
            }
            revisions.push({ alias, parentAlias: parents[0] ?? null, manifest, manifestDigest: manifestDigest(manifest) });
          } catch (error) { const rule = error instanceof WorkspaceError ? error.message : 'Retained revision cannot be represented by the configured canonical manifest'; issues.push({ code: error instanceof WorkspaceError ? error.code : 'INVALID_MANIFEST', message: rule, revision: alias, ...(offendingPath ? { path: offendingPath } : {}), rule }); }
        }
        if ((await this.git(repository, ['rev-parse', '--verify', 'HEAD'])).toString().trim() !== actualHead) issue('CAPTURE_CHANGED', 'Legacy repository changed during inventory');
      } catch (error) { issue(error instanceof WorkspaceError ? error.code : 'MISSING_REPOSITORY', 'Legacy repository could not be safely inventoried'); }
      workspaces.push({ workspaceId: id, customerId: selected.customerId ?? null, name: selected.name, status: selected.status, repository, selectedHead: issues.some(issue => issue.code === 'AUTHORITY_CONFLICT') ? null : head, authorityHeads, legacyWork, revisions, issues, eligible: issues.length === 0 });
    }
    return { schemaVersion: 1, sourceRoot: this.sourceRoot, databasePath: this.databasePath, sourceFingerprint: hash(canonicalJson({ metadata, workspaces })), workspaces };
  }
}
