import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertSafeDirectory, createSafeDirectory, syncDirectory } from '../application/files';
import { canonicalJson, WorkspaceError, type WorkspaceScope } from '../domain';
import type { ControlStore } from '../ports/control-store';
import type { WorkspaceRuntime } from '../config/runtime';

export const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function journalPath(runtime: WorkspaceRuntime, kind: string, scope: unknown) { return join(runtime.configuration.dataDirectory, 'legacy-compat', kind, `${hash(scope)}.json`); }
export async function loadJournal<T>(file: string): Promise<T | null> {
  let handle;
  try { await assertSafeDirectory(dirname(file)); handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Compatibility state requires a private regular file'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
export async function saveJournal(file: string, value: unknown): Promise<void> {
  await createSafeDirectory(dirname(file));
  const temporary = join(dirname(file), `pending-${randomUUID()}.json`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); await syncDirectory(dirname(file)); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
// Compatibility files describe client sessions and pending commands, never accepted state.
// The local queue avoids redundant contention; the catalog adapter supplies a cross-process OS lock.
const queues = new Map<string, Promise<unknown>>();
export async function serialize<T>(file: string, control: ControlStore, scope: WorkspaceScope, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const lock = await control.acquireCompatibilityLock(scope, `${basename(dirname(file))}/${basename(file)}`);
    try { return await action(); } finally { await lock.release(); }
  }); queues.set(file, next);
  try { return await next; } finally { if (queues.get(file) === next) queues.delete(file); }
}
