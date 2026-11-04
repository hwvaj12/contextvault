import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { WorkspaceError } from "../../domain/errors";
import { canonicalizeManifest, validatePortablePath, workspaceLimits, type WorkspaceLimits } from "../../domain/manifest";

const unsafe = (message: string): never => { throw new WorkspaceError("INVALID_MANIFEST", message); };
export const isControlMetadata = (name: string) => [".git", ".contextvault"].includes(name.normalize("NFKC").toUpperCase().toLowerCase());
const identity = (value: { dev: number; ino: number }) => `${value.dev}:${value.ino}`;

/** Refuse every link in the absolute ancestry, including the configured root itself. */
export async function assertSafeDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) unsafe("Filesystem roots must be absolute");
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe("Filesystem ancestry contains a link or non-directory");
  }
}

export async function createSafeDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) unsafe("Filesystem roots must be absolute");
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe("Filesystem ancestry contains a link or non-directory");
    // EEXIST can follow an interrupted creator whose parent barrier never completed.
    await syncDirectory(dirname(current));
  }
}

export function containedPath(root: string, path: string): string {
  validatePortablePath(path);
  return filesystemPath(root, path);
}

/** Cleanup paths come from directory entries, rather than portable submission names. */
function filesystemPath(root: string, path: string): string {
  if (!path || path.includes("\0") || path.split("/").some((component) => !component || component === "." || component === "..")) unsafe("Path contains an unsafe filesystem component");
  const destination = resolve(root, path);
  const rel = relative(resolve(root), destination);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) unsafe("Path escapes its root");
  return destination;
}

export async function syncDirectory(path: string): Promise<void> {
  await assertSafeDirectory(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** The descriptor pins regular bytes; O_NONBLOCK prevents a swapped FIFO from hanging open. */
export async function openRegularFile(root: string, path: string): Promise<FileHandle> {
  const destination = containedPath(root, path);
  await assertSafeDirectory(dirname(destination));
  const before = await lstat(destination);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) unsafe("Only unlinked regular file identities are accepted");
  let handle: FileHandle;
  try { handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) unsafe("File changed to an unsafe path"); throw error; }
  try {
    const opened = await handle.stat();
    await assertSafeDirectory(dirname(destination));
    const after = await lstat(destination);
    if (!opened.isFile() || opened.nlink !== 1 || identity(before) !== identity(opened) || identity(opened) !== identity(after)) unsafe("File identity changed during open");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** All traversal validates portable names and rejects links and special files before acting. */
export async function walkWorkspace(root: string, includeControlMetadata = false, overrides: Partial<WorkspaceLimits> = {}): Promise<{ path: string; kind: "file" | "directory" }[]> {
  const limits = workspaceLimits(overrides);
  await assertSafeDirectory(root);
  const entries: { path: string; kind: "file" | "directory" }[] = [];
  async function visit(parent: string, prefix: string): Promise<void> {
    await assertSafeDirectory(parent);
    for await (const { name } of await opendir(parent)) {
      if (isControlMetadata(name) && !includeControlMetadata) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      validatePortablePath(path, limits);
      const destination = containedPath(root, path);
      const stat = await lstat(destination);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) unsafe("Workspace contains a link or special file");
      entries.push({ path, kind: stat.isDirectory() ? "directory" : "file" });
      if (entries.length > limits.maxEntries) throw new WorkspaceError("QUOTA_EXCEEDED", "Workspace entry limit exceeded");
      if (stat.isDirectory()) await visit(destination, path);
    }
  }
  await visit(root, "");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  canonicalizeManifest({ schemaVersion: 1, entries: entries.map((entry) => entry.kind === "directory" ? entry : { ...entry, byteLength: 0, sha256: "0".repeat(64) }) }, limits);
  return entries;
}

interface CleanupEntry { path: string; kind: "file" | "directory" }

/** Cleanup includes local control metadata and keeps filesystem safety checks separate from submission policy. */
async function* cleanupEntries(root: string, prefix = ""): AsyncIterable<CleanupEntry> {
  const parent = prefix ? filesystemPath(root, prefix) : root;
  await assertSafeDirectory(parent);
  for await (const { name } of await opendir(parent)) {
    const path = prefix ? `${prefix}/${name}` : name;
    const destination = filesystemPath(root, path);
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) unsafe("Workspace contains a link or special file");
    if (stat.isDirectory()) yield* cleanupEntries(root, path);
    yield { path, kind: stat.isDirectory() ? "directory" : "file" };
  }
}

/**
 * The caller must stop all agent writers before cleanup, as before capture.
 * Server staging stays private and is never agent-mounted.
 * These checks reject static unsafe paths; they do not provide OS containment against hostile concurrent filesystem mutation.
 */
export async function removeWorkspace(root: string): Promise<void> {
  // Validate the entire stopped tree before deleting any entry, including excluded control metadata.
  for await (const _ of cleanupEntries(root)) { /* Reject links and special files before mutation. */ }
  for await (const entry of cleanupEntries(root)) {
    const destination = filesystemPath(root, entry.path);
    await assertSafeDirectory(dirname(destination));
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) unsafe("Workspace changed during cleanup");
    if (entry.kind === "directory") await rmdir(destination); else await unlink(destination);
  }
  await assertSafeDirectory(root);
  await rmdir(root);
  await syncDirectory(dirname(root));
}
