import { canonicalJson, canonicalizeManifest, manifestDigest, validatePortablePath, verifyFileStream, WorkspaceError, type Principal, type Revision, type WorkspaceScope } from '../../domain';
import type { WorkspaceRuntime } from '../../config/runtime';

export async function acceptedRevision(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, id?: string) {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  const workspace = await runtime.control.getWorkspace(scope); if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  let revision = await runtime.control.getRevision(scope, (id ?? workspace.currentRevisionId) as Revision['id']);
  if (!revision && id) { const alias = await runtime.control.getLegacyRevisionAlias(scope, id); if (alias) revision = await runtime.control.getRevision(scope, alias.revisionId); }
  if (!revision) throw new WorkspaceError('REVISION_NOT_FOUND', 'Accepted revision not found');
  const binding = await runtime.control.getBinding(scope, revision.scope.storageBindingId);
  if (!binding || binding.generation !== revision.scope.bindingGeneration) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Accepted revision binding is unavailable');
  const store = await runtime.revisionStore(binding); const reference = { ...revision, revisionId: revision.id };
  const manifest = canonicalizeManifest(await store.readManifest(reference), runtime.configuration.limits);
  if (manifestDigest(manifest) !== revision.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Accepted manifest digest differs from the catalog');
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  return { workspace, revision, binding, store, reference, manifest };
}
export async function revisionFile(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, id: string, rawPath: string, signal?: AbortSignal) {
  const path = validatePortablePath(rawPath, runtime.configuration.limits); const selected = await acceptedRevision(runtime, principal, scope, id);
  const entry = selected.manifest.entries.find(e => e.path === path); if (!entry || entry.kind !== 'file') throw new WorkspaceError('REVISION_NOT_FOUND', 'File is absent from the accepted revision');
  const bytes = await selected.store.openFile(selected.reference, path, { signal });
  return { entry, bytes: (async function* () { for await (const chunk of verifyFileStream(entry, bytes, runtime.configuration.limits)) { signal?.throwIfAborted(); await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope); yield chunk; } })() };
}
export async function history(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, cursor?: string, limit = 50) {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  const workspace = await runtime.control.getWorkspace(scope); if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  let id: Revision['id'] | null = workspace.currentRevisionId;
  if (cursor) { const previous = await runtime.control.getRevision(scope, cursor as Revision['id']); if (!previous) throw new WorkspaceError('REVISION_NOT_FOUND', 'History cursor is not an accepted revision'); id = previous.parentRevisionId; }
  const revisions = []; const visited = new Set();
  while (id && revisions.length < limit) {
    if (visited.has(id)) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Accepted history contains a cycle'); visited.add(id);
    const value = await runtime.control.getRevision(scope, id); if (!value) throw new WorkspaceError('REVISION_NOT_FOUND', 'Accepted history is incomplete');
    revisions.push({ id: value.id, parentRevisionId: value.parentRevisionId, manifestDigest: value.manifestDigest, createdAt: value.createdAt, _links: { manifest: { href: `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/revisions/${encodeURIComponent(value.id)}/manifest` } } }); id = value.parentRevisionId;
  }
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  return { revisions, nextCursor: id ? revisions[revisions.length - 1].id : null };
}
async function text(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, id: string, path: string, length: number) {
  if (length > 1024 * 1024) return null;
  const source = await revisionFile(runtime, principal, scope, id, path); const chunks = [];
  for await (const chunk of source.bytes) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); const value = bytes.toString('utf8');
  return !value.includes('\0') && Buffer.from(value).equals(bytes) ? value : null;
}
export async function diff(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, from: string, to: string) {
  const a = await acceptedRevision(runtime, principal, scope, from); const b = await acceptedRevision(runtime, principal, scope, to);
  const before = new Map(a.manifest.entries.map(e => [e.path, e])); const after = new Map(b.manifest.entries.map(e => [e.path, e])); const files = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(path); const right = after.get(path); if (canonicalJson(left ?? null) === canonicalJson(right ?? null)) continue;
    const oldText = !left ? '' : left.kind === 'file' ? await text(runtime, principal, scope, a.revision.id, path, left.byteLength) : null;
    const newText = !right ? '' : right.kind === 'file' ? await text(runtime, principal, scope, b.revision.id, path, right.byteLength) : null;
    const binary = oldText === null || newText === null; let additions = 0; let deletions = 0; const hunks = [];
    if (!binary) {
      // Keep each line terminator in the comparison: an EOF newline changes the accepted bytes.
      const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const oldLines = lines(oldText); const newLines = lines(newText); let prefix = 0; let suffix = 0;
      while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
      while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
      const removed = oldLines.slice(prefix, oldLines.length - suffix); const added = newLines.slice(prefix, newLines.length - suffix); additions = added.length; deletions = removed.length;
      const render = (sign: string, line: string) => line.endsWith('\n') ? [`${sign}${line.slice(0, -1)}`] : [`${sign}${line}`, '\\ No newline at end of file'];
      if (additions || deletions) hunks.push({ header: `@@ -${prefix + 1},${deletions} +${prefix + 1},${additions} @@`, content: [...removed.flatMap(line => render('-', line)), ...added.flatMap(line => render('+', line))].join('\n') });
    }
    files.push({ path, status: !left ? 'added' : !right ? 'deleted' : 'modified', additions, deletions, hunks, binary });
  }
  return { from: a.revision.id, to: b.revision.id, files, summary: { filesChanged: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) } };
}
export async function search(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, query: string, revisionId?: string, limit = 100) {
  const selected = await acceptedRevision(runtime, principal, scope, revisionId); const results: { path: string; lineNumber: number; snippet: string }[] = []; let truncated = false;
  for (const entry of selected.manifest.entries) {
    if (entry.kind !== 'file') continue;
    const source = await revisionFile(runtime, principal, scope, selected.revision.id, entry.path); const decoder = new TextDecoder('utf-8', { fatal: true });
    let tail = ''; let lineNumber = 1; let found = false; let binary = false; const matches: typeof results = [];
    const inspect = (value: string, complete: boolean) => {
      const joined = tail + value; const index = joined.indexOf(query);
      if (!found && index >= 0) { if (results.length + matches.length < limit) matches.push({ path: entry.path, lineNumber, snippet: joined.slice(Math.max(0, index - 128), index + query.length + 128) }); else truncated = true; found = true; }
      tail = complete ? '' : joined.slice(-Math.max(4096, query.length)); if (complete) { lineNumber++; found = false; }
    };
    for await (const chunk of source.bytes) {
      if (binary) continue;
      let decoded: string; try { decoded = decoder.decode(chunk, { stream: true }); } catch { binary = true; continue; }
      if (decoded.includes('\0')) { binary = true; continue; }
      const lines = decoded.split('\n'); for (let i = 0; i < lines.length; i++) inspect(lines[i], i < lines.length - 1);
    }
    try { if (!binary) { inspect(decoder.decode(), false); results.push(...matches); } } catch { /* Binary files are not text-search results. */ }
  }
  return { query, revisionId: selected.revision.id, results, count: results.length, truncated };
}
