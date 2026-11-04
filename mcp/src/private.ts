import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError } from '@contextvault/sdk';

export function fail(code: string, message: string): never { throw new ValidationError(message, 400, { error: { code, message } }); }
export async function safeDirectory(path: string, create = false) {
  if (!isAbsolute(path) || path !== resolve(path)) fail('INVALID_REQUEST', 'Use an absolute normalized private directory');
  let current = parse(path).root;
  for (const component of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Filesystem ancestry contains a link or non-directory');
  }
}
export async function regular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_PATH', 'A private regular file is required');
  return stat;
}
export async function readJson<T>(path: string): Promise<T> {
  await safeDirectory(dirname(path)); const stat = await regular(path);
  if (stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0) fail('UNSAFE_PATH', 'Private metadata exceeds its limit or permissions');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = await handle.stat(); if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) fail('UNSAFE_PATH', 'Private metadata changed'); return JSON.parse(await handle.readFile('utf8')) as T; }
  finally { await handle.close(); }
}
export async function optionalJson<T>(path: string): Promise<T | null> {
  try { return await readJson<T>(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function saveJson(path: string, value: unknown) {
  await safeDirectory(dirname(path));
  try { await regular(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 1024 * 1024) fail('QUOTA_EXCEEDED', 'Private metadata exceeds its limit');
  const temporary = path + '.pending-' + randomUUID(); const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function controller<T>(path: string, id: string, action: () => Promise<T>): Promise<T> {
  const token = randomUUID(); let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('CONTROLLER_ACTIVE', 'A controller owns this handle; stop all controllers before explicit recovery'); throw error; }
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, id, token })); await handle.sync(); } finally { await handle.close(); }
  try { return await action(); }
  finally { const owner = await readJson<{ id: string; token: string }>(path); if (owner.id !== id || owner.token !== token) fail('CONTROLLER_CHANGED', 'Controller ownership changed'); await unlink(path); }
}
export async function recoverController(path: string, id: string) {
  const owner = await optionalJson<{ schemaVersion: number; id: string; token: string }>(path);
  if (!owner) return;
  if (owner.schemaVersion !== 1 || owner.id !== id || typeof owner.token !== 'string') fail('CONTROLLER_CHANGED', 'Controller ownership differs from this handle');
  await unlink(path);
}
