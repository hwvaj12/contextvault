import { constants } from 'node:fs';
import { lstat, open, opendir, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ContextVaultClient, validatePortablePath, workspaceLimits, type LocalWorkspaceSession, type OpenRunRequest } from '@contextvault/sdk';
import { controller, fail, optionalJson, readJson, recoverController, regular, safeDirectory, saveJson } from './private.js';

export interface SessionSelection { workspaceHandle?: string; workspaceId?: string }
interface Record { schemaVersion: 1; id: string; request: OpenRunRequest & { workspaceId: string; access: 'local' | 'remote' }; blocked: boolean; cleaned: boolean }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const handlePattern = /^session-[a-f0-9]{64}$/;
const limits = workspaceLimits();
export class Sessions {
  readonly directory: string;
  private readonly ready: Promise<void>;
  constructor(private readonly client: ContextVaultClient, parent: string, credential: string, customer: string | undefined) {
    const directory = join(parent, digest(JSON.stringify([client.baseUrl, credential, customer ?? null])));
    this.directory = directory;
    this.ready = (async () => {
      await safeDirectory(parent, true); const stat = await lstat(parent);
      if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_PATH', 'MCP private state must be owned by this user with mode 0700');
      for (const path of [directory, join(directory, 'sessions'), join(directory, 'controls'), join(directory, 'locks')]) await safeDirectory(path, true);
    })();
  }
  private path(name: string, id?: string) { return join(this.directory, name, ...(id ? [id] : [])); }
  private state(id: string) { return this.path('sessions', id) + '/state.json'; }
  private record(id: string) { return this.path('controls', id + '.json'); }
  private lock(id: string) { return this.path('locks', id + '.json'); }
  private async missingSessionDirectory(id: string) {
    await safeDirectory(this.path('sessions'));
    try { await lstat(this.path('sessions', id)); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return true; }
  }
  initialize() { return this.ready; }
  async select(input: SessionSelection): Promise<string> {
    await this.ready;
    if (input.workspaceHandle) { if (!handlePattern.test(input.workspaceHandle)) fail('INVALID_REQUEST', 'Use an opaque MCP workspace handle'); return input.workspaceHandle; }
    if (!input.workspaceId) return fail('INVALID_REQUEST', 'Provide workspaceHandle or workspaceId');
    const matches: string[] = [];
    for (const name of await readdir(this.path('controls'))) {
      if (!/^session-[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = await readJson<Record>(this.path('controls', name));
      if (value.request.workspaceId === input.workspaceId && !value.cleaned) matches.push(value.id);
    }
    if (matches.length !== 1) fail('INVALID_TRANSITION', 'Select the exact workspaceHandle; this workspace has no unique local session');
    return matches[0];
  }
  private view(session: LocalWorkspaceSession, record: Record) {
    return { workspaceHandle: record.id, workspaceId: session.workspaceId, runId: session.run.id, baseCommit: session.baseCommit, baseRevisionId: session.baseCommit,
      run: session.run, sessionStatus: session.sessionStatus, materializationState: session.materializationState, cleanupState: session.cleanupState, checkpointReceipt: session.checkpointReceipt,
      access: record.request.access === 'local' ? 'mcp-host-local' : 'remote-file-tools', ...(record.request.access === 'local' ? { path: session.path, sandboxPath: session.path, machine: 'mcp-host' } : {}) };
  }
  async open(input: OpenRunRequest & { workspaceId: string; access: 'local' | 'remote'; requestId?: string }) {
    await this.ready; const id = 'session-' + digest(input.requestId ?? randomUUID());
    return controller(this.lock(id), id, async () => {
      const { requestId: _requestId, ...request } = input;
      let record = await optionalJson<Record>(this.record(id));
      if (record && JSON.stringify(record.request) !== JSON.stringify(request)) fail('IDEMPOTENCY_KEY_REUSED', 'This requestId belongs to another exact checkout');
      let session: LocalWorkspaceSession;
      const initializeSaved = record?.schemaVersion === 1 && record.id === id && record.blocked === true && record.cleaned === false && await this.missingSessionDirectory(id);
      if (record && !initializeSaved) {
        session = await this.client.resumeWorkspace(this.state(id)); await this.client.workspaces.get(record.request.workspaceId);
        if (record.blocked) fail('RECONCILIATION_REQUIRED', 'Reconcile the original workspace handle before continuing');
        await session.status();
      } else {
        if (!record) { record = { schemaVersion: 1, id, request, blocked: true, cleaned: false }; await saveJson(this.record(id), record); }
        else await this.client.workspaces.get(record.request.workspaceId);
        // The SDK creates its directory before saving any command or dispatching HTTP.
        session = await this.client.openWorkspace({ ...request, stateDirectory: this.path('sessions', id) });
        record.blocked = false; await saveJson(this.record(id), record);
      }
      return this.view(session, record);
    }).catch(error => { if (error instanceof Error) Object.assign(error, { workspaceHandle: id }); throw error; });
  }
  async withSession(input: SessionSelection, action: (session: LocalWorkspaceSession, record: Record) => Promise<unknown>, mutate = false, reconcile = false) {
    const id = await this.select(input);
    return controller(this.lock(id), id, async () => {
      const record = await readJson<Record>(this.record(id));
      if (record.schemaVersion !== 1 || record.id !== id || !['local', 'remote'].includes(record.request.access)) fail('INVALID_REQUEST', 'MCP handle metadata is invalid');
      if (input.workspaceId && input.workspaceId !== record.request.workspaceId) fail('INVALID_REQUEST', 'Workspace identifier differs from this handle');
      const session = await this.client.resumeWorkspace(this.state(id));
      try {
        // An uncertain initial open has no run ID yet. Authorize its workspace before SDK reconciliation.
        if (reconcile) await this.client.workspaces.get(record.request.workspaceId); else await session.status();
        if (mutate && record.blocked && !reconcile) fail('RECONCILIATION_REQUIRED', 'Reconcile the original command before another mutation');
        if (mutate) { record.blocked = true; await saveJson(this.record(id), record); }
        const value = await action(session, record);
        if (mutate) { record.blocked = false; record.cleaned = session.cleanupState === 'complete'; await saveJson(this.record(id), record); }
        return value;
      } catch (error) { if (error instanceof Error) Object.assign(error, { workspaceHandle: id }); throw error; }
    });
  }
  async command(input: SessionSelection, name: 'status' | 'heartbeat' | 'checkpoint' | 'finalize' | 'abort' | 'cleanup' | 'reconcile' | 'destroy', reason?: string) {
    return this.withSession(input, async (session, record) => {
      if (name === 'status') { /* Current scoped status was already checked. */ }
      else if (name === 'heartbeat') await session.heartbeat();
      else if (name === 'checkpoint') await session.checkpoint({ writersStopped: true });
      else if (name === 'finalize') await session.finalize({ writersStopped: true });
      else if (name === 'abort') await session.abort({ writersStopped: true, reason: reason! });
      else if (name === 'cleanup') await session.cleanup({ writersStopped: true });
      else if (name === 'reconcile') await session.reconcile({ writersStopped: true });
      else { if (session.run.state === 'active') await session.abort({ writersStopped: true, reason: reason ?? 'explicit MCP destroy' }); await session.cleanup({ writersStopped: true }); }
      return this.view(session, record);
    }, name !== 'status', name === 'reconcile');
  }
  async recover(input: SessionSelection) {
    const id = await this.select(input); let record: Record | undefined; let initializationIncomplete = false;
    try { record = await readJson<Record>(this.record(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record !== undefined) {
      if (!record || record.schemaVersion !== 1 || record.id !== id || typeof record.request?.workspaceId !== 'string') fail('INVALID_REQUEST', 'MCP handle metadata is invalid');
      if (input.workspaceId && input.workspaceId !== record.request.workspaceId) fail('INVALID_REQUEST', 'Workspace identifier differs from this handle');
      await this.client.workspaces.get(record.request.workspaceId);
      initializationIncomplete = await this.missingSessionDirectory(id);
      if (initializationIncomplete) {
        if (record.blocked !== true || record.cleaned !== false) fail('RECONCILIATION_REQUIRED', 'Retain a journal whose initialized SDK data is unavailable');
      } else {
        await safeDirectory(this.path('sessions', id));
        try { await lstat(this.state(id)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; fail('RECONCILIATION_REQUIRED', 'Retain the SDK directory whose state is unavailable'); }
        // Recovery never removes a marker protecting an unreadable or unsafe SDK journal.
        await this.client.resumeWorkspace(this.state(id));
      }
    } else {
      if (!input.workspaceId) fail('INVALID_REQUEST', 'Provide workspaceId to recover initialization before its journal');
      await this.client.workspaces.get(input.workspaceId);
      // MCP control is durable before SDK initialization or HTTP. Existing SDK data makes absence ambiguous.
      if (!await this.missingSessionDirectory(id)) fail('RECONCILIATION_REQUIRED', 'Retain SDK data whose MCP journal is unavailable');
      initializationIncomplete = true;
    }
    await recoverController(this.lock(id), id);
    return { workspaceHandle: id, controllerRecovered: true, ...(initializationIncomplete ? { initializationIncomplete: true } : {}) };
  }
  private withContent(input: SessionSelection, action: (session: LocalWorkspaceSession, record: Record) => Promise<unknown>) {
    return this.withSession(input, async (session, record) => {
      // Run metadata remains readable for inactive workspaces. Content requires its own current workspace:read authority.
      await this.client.workspaces.get(record.request.workspaceId);
      return action(session, record);
    });
  }
  private async inspect(root: string) {
      const entries: { path: string; kind: 'directory' | 'file'; byteLength?: number }[] = []; let totalBytes = 0;
      const visit = async (directory: string, prefix: string) => {
        await safeDirectory(directory);
        for await (const entry of await opendir(directory)) {
          const name = entry.name;
          const path = validatePortablePath(prefix + name); const absolute = join(directory, name); const stat = await lstat(absolute);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail('UNSAFE_PATH', 'Workspace contains a link or special file');
          if (entries.length >= limits.maxEntries) fail('QUOTA_EXCEEDED', 'Workspace entry limit exceeded');
          if (stat.isFile()) { totalBytes += stat.size; if (stat.size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes || !Number.isSafeInteger(totalBytes)) fail('QUOTA_EXCEEDED', 'Workspace byte limit exceeded'); }
          entries.push(stat.isDirectory() ? { path, kind: 'directory' } : { path, kind: 'file', byteLength: stat.size });
          if (stat.isDirectory()) await visit(absolute, path + '/');
        }
      };
      await visit(root, ''); entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))); return { entries, totalBytes };
  }
  async files(input: SessionSelection) { return this.withContent(input, async session => { const { entries } = await this.inspect(session.path); return { entries }; }); }
  private async filePath(session: LocalWorkspaceSession, record: Record, path: string, writable: boolean) {
    if (writable && (record.blocked || session.run.state !== 'active' || session.run.mode !== 'read-write' || session.materializationState !== 'ready')) fail('INVALID_TRANSITION', 'File writes require a ready active writable workspace without pending commands');
    const absolute = join(session.path, validatePortablePath(path)); await safeDirectory(dirname(absolute)); return absolute;
  }
  async read(input: SessionSelection, path: string, offset: number, length: number) {
    return this.withContent(input, async (session, record) => {
      const absolute = await this.filePath(session, record, path, false); const stat = await regular(absolute);
      if (stat.size > limits.maxFileBytes) fail('QUOTA_EXCEEDED', 'File exceeds the shared byte limit');
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat(); if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) fail('UNSAFE_PATH', 'File identity changed');
        const bytes = Buffer.alloc(length); const result = await handle.read(bytes, 0, length, offset);
        return { path, offset, byteLength: result.bytesRead, fileByteLength: stat.size, base64: bytes.subarray(0, result.bytesRead).toString('base64'), eof: offset + result.bytesRead >= stat.size };
      } finally { await handle.close(); }
    });
  }
  async write(input: SessionSelection, path: string, base64: string, offset: number, truncate: boolean) {
    const bytes = Buffer.from(base64, 'base64'); if (bytes.toString('base64') !== base64 || bytes.length > limits.maxChunkBytes) fail('INVALID_REQUEST', 'Use canonical base64 with at most 64 KiB per file chunk');
    return this.withContent(input, async (session, record) => {
      const absolute = await this.filePath(session, record, path, true);
      try { await regular(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const snapshot = await this.inspect(session.path); const existing = snapshot.entries.find(entry => entry.path === path);
      if (offset > (existing?.byteLength ?? 0) || offset + bytes.length > limits.maxFileBytes || (truncate && offset !== 0)) fail('INVALID_REQUEST', 'Chunk offset or resulting file size is invalid');
      const nextBytes = Math.max(truncate ? 0 : existing?.byteLength ?? 0, offset + bytes.length);
      if ((!existing && snapshot.entries.length >= limits.maxEntries) || snapshot.totalBytes - (existing?.byteLength ?? 0) + nextBytes > limits.maxTotalBytes) fail('QUOTA_EXCEEDED', 'Workspace entry or total byte limit exceeded');
      const handle = await open(absolute, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_PATH', 'File is not a private regular file');
        if (offset > stat.size || offset + bytes.length > limits.maxFileBytes || (truncate && offset !== 0)) fail('INVALID_REQUEST', 'Chunk offset or resulting file size is invalid');
        if (truncate) await handle.truncate(0);
        let written = 0; while (written < bytes.length) { const part = await handle.write(bytes, written, bytes.length - written, offset + written); if (!part.bytesWritten) throw new Error('File write made no progress'); written += part.bytesWritten; }
        await handle.sync(); return { path, offset, byteLength: written, fileByteLength: (await handle.stat()).size };
      } finally { await handle.close(); }
    });
  }
  async remove(input: SessionSelection, path: string) { return this.withContent(input, async (session, record) => { const absolute = await this.filePath(session, record, path, true); await regular(absolute); await unlink(absolute); return { path, deleted: true }; }); }
  async directoryEntry(input: SessionSelection, path: string) { return this.withContent(input, async (session, record) => { const absolute = await this.filePath(session, record, path, true); const snapshot = await this.inspect(session.path); if (!snapshot.entries.some(entry => entry.path === path) && snapshot.entries.length >= limits.maxEntries) fail('QUOTA_EXCEEDED', 'Workspace entry limit exceeded'); await safeDirectory(absolute, true); return { path, kind: 'directory' }; }); }
}
