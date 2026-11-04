import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSafeDirectory } from '../application/files';
import { WorkspaceError, type Principal, type Revision, type WorkspaceScope } from '../domain';
import type { WorkspaceRuntime } from '../config/runtime';
import { acceptedSnapshot } from './publication';

function git(directory: string, args: string[], input?: Buffer, maximum = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'uploadpack.allowAnySHA1InWant=false', '-c', 'uploadpack.allowReachableSHA1InWant=false', '-c', 'uploadpack.allowTipSHA1InWant=false', ...args], {
      cwd: directory, env: { PATH: global.process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'ContextVault', GIT_AUTHOR_EMAIL: 'projection@contextvault.invalid', GIT_COMMITTER_NAME: 'ContextVault', GIT_COMMITTER_EMAIL: 'projection@contextvault.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new WorkspaceError('STORAGE_UNAVAILABLE', 'Git projection timed out'); process.kill('SIGKILL'); }, 30_000);
    process.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximum) { failure = new WorkspaceError('QUOTA_EXCEEDED', 'Git projection exceeds transfer limits'); process.kill('SIGKILL'); } else chunks.push(chunk); });
    process.stderr.resume(); process.stdin.on('error', () => {});
    process.on('error', error => { failure = error; });
    process.on('close', code => { clearTimeout(timer); code === 0 && !failure ? resolve(Buffer.concat(chunks)) : reject(failure ?? new WorkspaceError('INVALID_REQUEST', 'Git request is invalid or requests unavailable objects')); });
    process.stdin.end(input);
  });
}
/** Build a disposable, self-contained object database from accepted catalog history only. Never copy private Git objects or refs. */
export async function gitProjection(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, action: (directory: string, execute: (args: string[], input?: Buffer) => Promise<Buffer>) => Promise<Buffer>) {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  const workspace = await runtime.control.getWorkspace(scope); if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  const binding = await runtime.control.getBinding(scope, workspace.storageBindingId);
  if (binding?.backend !== 'git') throw new WorkspaceError('UNSUPPORTED_CAPABILITY', 'Git wire protocol is unavailable for this workspace backend');
  const history: Revision[] = []; let revisionId: Revision['id'] | null = workspace.currentRevisionId;
  while (revisionId) {
    if (history.length >= 10_000 || history.some(revision => revision.id === revisionId)) throw new WorkspaceError('QUOTA_EXCEEDED', 'Accepted Git history exceeds projection limits');
    const revision = await runtime.control.getRevision(scope, revisionId); if (!revision) throw new WorkspaceError('REVISION_NOT_FOUND', 'Accepted history is incomplete');
    history.push(revision); revisionId = revision.parentRevisionId;
  }
  const root = join(runtime.configuration.dataDirectory, 'legacy-compat', 'git-exports'); await createSafeDirectory(root);
  const directory = await mkdtemp(join(root, 'projection-'));
  const execute = (args: string[], input?: Buffer) => git(directory, args, input, runtime.configuration.limits.maxTotalBytes + 1024 * 1024);
  try {
    await execute(['init', '--bare', '--initial-branch=main', '.']); let parent: string | null = null;
    for (const revision of history.reverse()) {
      const source = await acceptedSnapshot(runtime, principal, scope, revision.id);
      await execute(['read-tree', '--empty']);
      for (const entry of source.manifest.entries) {
        if (entry.kind !== 'file') continue;
        const bytes = Buffer.from(source.files.find(file => file.path === entry.path)!.base64, 'base64');
        const objectId = (await execute(['hash-object', '-w', '--stdin'], bytes)).toString().trim();
        await execute(['update-index', '--add', '--cacheinfo', '100644', objectId, entry.path]);
      }
      const tree = (await execute(['write-tree'])).toString().trim();
      parent = (await execute(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], Buffer.from(`Accepted ContextVault revision ${revision.id}\n`))).toString().trim();
    }
    if (parent) await execute(['update-ref', 'refs/heads/main', parent]);
    await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
    const result = await action(directory, execute);
    await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
