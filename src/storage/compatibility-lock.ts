import Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSafeDirectory, syncDirectory } from '../application/files';
import { canonicalJson, WorkspaceError, type WorkspaceScope } from '../domain';
import type { CompatibilityLock } from '../ports/control-store';

const memoryLocks = new WeakMap<Database.Database, Set<string>>();
/** Lock databases hold no domain state. OS locks disappear on process death; no timeout or PID permits takeover. */
export async function acquireCompatibilityLock(catalog: Database.Database, scope: WorkspaceScope, resource: string): Promise<CompatibilityLock> {
  const identity = canonicalJson({ scope, resource });
  if (catalog.name === ':memory:' || catalog.name === '') {
    // Independent in-memory catalogs cannot be shared across processes. Stores sharing one connection share this guard.
    let locks = memoryLocks.get(catalog); if (!locks) { locks = new Set(); memoryLocks.set(catalog, locks); }
    if (locks.has(identity)) throw new WorkspaceError('FINALIZATION_IN_PROGRESS', 'Compatibility state is busy; retry the original command');
    locks.add(identity); let released = false;
    return { async release() { if (!released) { released = true; locks!.delete(identity); } } };
  }
  if (!isAbsolute(catalog.name)) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Compatibility coordination requires an explicit catalog location');
  const authoritativePath = await realpath(catalog.name);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const root = join(dirname(authoritativePath), '.contextvault-compat-locks', digest(authoritativePath)); await createSafeDirectory(root);
  const file = join(root, `${digest(identity)}.sqlite`);
  try { const descriptor = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await descriptor.close(); await syncDirectory(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Compatibility lock requires a private regular file');
  await chmod(file, 0o600);
  const lock = new Database(file, { timeout: 0 }); const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try { lock.exec('BEGIN EXCLUSIVE'); break; }
      catch (error) {
        if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) throw error;
        if (Date.now() >= deadline) throw new WorkspaceError('FINALIZATION_IN_PROGRESS', 'Compatibility state is busy; retry the original command');
        // Yield to the holder's awaited filesystem/network work. Never block Node with a SQLite busy timeout.
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  } catch (error) { lock.close(); throw error; }
  let released = false;
  return { async release() { if (!released) { released = true; try { lock.exec('ROLLBACK'); } finally { lock.close(); } } } };
}
