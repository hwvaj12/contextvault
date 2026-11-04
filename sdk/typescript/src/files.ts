import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { localError } from "./errors";
import { canonicalizeManifest, validatePortablePath, verifyFileStream, type Manifest, type ManifestEntry, type ManifestFile, type WorkspaceLimits } from "./manifest";

const unsafe = (message: string): never => { throw localError("INVALID_MANIFEST", message); };
const control = (name: string) => [".git", ".contextvault"].includes(name.normalize("NFKC").toUpperCase().toLowerCase());
const identity = (value: { dev: number; ino: number }) => `${value.dev}:${value.ino}`;
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

export async function safeDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) unsafe("Local roots must be absolute");
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe("Filesystem ancestry contains a link or non-directory");
  }
}
export async function syncDirectory(path: string) {
  await safeDirectory(path); const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function createDirectory(path: string) {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await safeDirectory(current); await syncDirectory(dirname(current));
  }
}
export function inside(root: string, path: string): string {
  if (!path || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === "..")) unsafe("Unsafe local component");
  const result = resolve(root, path); const rel = relative(root, result);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) unsafe("Local path escapes its root");
  return result;
}
export async function regular(root: string, path: string): Promise<FileHandle> {
  const absolute = inside(root, path); await safeDirectory(dirname(absolute));
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) unsafe("Only unlinked regular files are accepted");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat(); await safeDirectory(dirname(absolute)); const after = await lstat(absolute);
    if (!opened.isFile() || opened.nlink !== 1 || identity(before) !== identity(opened) || identity(opened) !== identity(after)) unsafe("File changed identity while opening");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function* descriptorBytes(handle: FileHandle, chunkBytes: number): AsyncIterable<Uint8Array> {
  let position = 0;
  for (;;) { const bytes = Buffer.allocUnsafe(chunkBytes); const { bytesRead } = await handle.read(bytes, 0, bytes.length, position); if (!bytesRead) return; position += bytesRead; yield bytes.subarray(0, bytesRead); }
}
export async function* readVerified(root: string, entry: ManifestFile, limits: WorkspaceLimits): AsyncIterable<Uint8Array> {
  const handle = await regular(root, entry.path);
  try { yield* verifyFileStream(entry, descriptorBytes(handle, limits.maxChunkBytes), limits); } finally { await handle.close(); }
}
export async function writeVerified(root: string, entry: ManifestFile, source: AsyncIterable<Uint8Array>, limits: WorkspaceLimits) {
  validatePortablePath(entry.path, limits); const absolute = inside(root, entry.path); await createDirectory(dirname(absolute));
  const handle = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    for await (const bytes of verifyFileStream(entry, source, limits)) {
      const owned = Buffer.from(bytes); let offset = 0;
      while (offset < owned.length) { const { bytesWritten } = await handle.write(owned, offset, owned.length - offset, null); if (!bytesWritten) throw localError("STORAGE_UNAVAILABLE", "File write made no progress"); offset += bytesWritten; }
    }
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(absolute));
}
export async function walk(root: string, limits: WorkspaceLimits): Promise<{ path: string; kind: "file" | "directory" }[]> {
  const result: { path: string; kind: "file" | "directory" }[] = [];
  async function visit(parent: string, prefix: string) {
    await safeDirectory(parent);
    for await (const { name } of await opendir(parent)) {
      if (control(name)) continue;
      const path = prefix ? prefix + "/" + name : name; validatePortablePath(path, limits);
      const absolute = inside(root, path); const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) unsafe("Workspace contains a link or special file");
      result.push({ path, kind: stat.isDirectory() ? "directory" : "file" });
      if (result.length > limits.maxEntries) throw localError("QUOTA_EXCEEDED", "Workspace entry limit exceeded");
      if (stat.isDirectory()) await visit(absolute, path);
    }
  }
  await visit(root, ""); result.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  canonicalizeManifest({ schemaVersion: 1, entries: result.map(e => e.kind === "directory" ? e : { ...e, byteLength: 0, sha256: "0".repeat(64) }) }, limits);
  return result;
}
export interface CapturedWorkspace { captureId: string; path: string; manifest: Manifest }
export const captureOwnersPath = (captureParent: string) => join(dirname(captureParent), "capture-owners");
export const captureManifestsPath = (captureParent: string) => join(dirname(captureParent), "capture-manifests");
export const MAX_PRIVATE_JSON_BYTES = 32 * 1024 * 1024;
export interface CaptureManifestReference { path: string; byteLength: number; sha256: string }
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const captureManifestFile = (parent: string, captureId: string) => {
  if (!new RegExp(`^${uuid}$`).test(captureId)) throw localError("INVALID_REQUEST", "Invalid private capture identity");
  return join(captureManifestsPath(parent), captureId + ".json");
};

/** Prepare bounded immutable metadata without replacing the readable journal or writing any file yet. */
export function prepareCaptureManifest(parent: string, captured: CapturedWorkspace, limits: WorkspaceLimits) {
  const bytes = privateJsonBytes(canonicalizeManifest(captured.manifest, limits));
  const reference: CaptureManifestReference = { path: captureManifestFile(parent, captured.captureId), byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { reference, async persist() {
    await createDirectory(dirname(reference.path));
    try {
      const existing = await readPrivateBytes(reference.path);
      if (!existing.equals(bytes)) throw localError("INVALID_REQUEST", "Immutable capture manifest changed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await savePrivateBytes(reference.path, bytes);
    }
  } };
}
export async function readCaptureManifest(parent: string, captureId: string, reference: CaptureManifestReference, limits: WorkspaceLimits): Promise<Manifest> {
  if (!reference || reference.path !== captureManifestFile(parent, captureId) || !Number.isSafeInteger(reference.byteLength)
    || reference.byteLength < 0 || reference.byteLength > MAX_PRIVATE_JSON_BYTES || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    throw localError("INVALID_REQUEST", "Invalid immutable capture manifest reference");
  }
  const bytes = await readPrivateBytes(reference.path);
  if (bytes.byteLength !== reference.byteLength || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw localError("RECEIPT_MISMATCH", "Private capture manifest differs from its durable reference");
  return canonicalizeManifest(JSON.parse(bytes.toString("utf8")), limits);
}
/** Requires stopped writers. Private bytes are retained independently of the writable agent directory. */
export async function capture(root: string, captureParent: string, limits: WorkspaceLimits, sessionId: string): Promise<CapturedWorkspace> {
  const listed = await walk(root, limits); const stamps = new Map<string, string>(); const entries: ManifestEntry[] = []; let total = 0;
  for (const e of listed) {
    const stat = await lstat(inside(root, e.path)); stamps.set(e.path, stamp(stat));
    if (e.kind === "directory") entries.push({ path: e.path, kind: "directory" });
    else { total += stat.size; if (stat.size > limits.maxFileBytes || total > limits.maxTotalBytes) throw localError("QUOTA_EXCEEDED", "Capture byte limit exceeded"); entries.push({ ...e, byteLength: stat.size, sha256: "0".repeat(64) }); }
  }
  canonicalizeManifest({ schemaVersion: 1, entries }, limits); await createDirectory(captureParent);
  const privatePath = await mkdtemp(join(captureParent, "capture-"));
  const captureId = randomUUID();
  const owners = captureOwnersPath(captureParent); const ownerPath = join(owners, basename(privatePath) + ".json");
  try {
    // Ownership reaches disk before any captured content, independently of the session's later reference save.
    // Keep that proof outside the captured tree so interrupted deletion cannot remove proof before bytes.
    await createDirectory(owners);
    await saveJson(ownerPath, { sessionId, captureId });
    for (const e of entries) {
      if (e.kind === "directory") { await createDirectory(inside(privatePath, e.path)); continue; }
      const handle = await regular(root, e.path); const hash = createHash("sha256"); let size = 0;
      try { for await (const bytes of descriptorBytes(handle, limits.maxChunkBytes)) { size += bytes.byteLength; if (size > e.byteLength) throw localError("CAPTURE_CHANGED", "Source changed during capture"); hash.update(bytes); } } finally { await handle.close(); }
      if (size !== e.byteLength) throw localError("CAPTURE_CHANGED", "Source changed during capture");
      e.sha256 = hash.digest("hex");
      try { await writeVerified(privatePath, e, readVerified(root, e, limits), limits); }
      catch (error) { if ((error as { code?: string }).code === "RECEIPT_MISMATCH") throw localError("CAPTURE_CHANGED", "Source changed during capture"); throw error; }
    }
    const after = await walk(root, limits);
    if (JSON.stringify(after) !== JSON.stringify(listed)) throw localError("CAPTURE_CHANGED", "Workspace entries changed during capture");
    for (const e of after) if (stamp(await lstat(inside(root, e.path))) !== stamps.get(e.path)) throw localError("CAPTURE_CHANGED", "Workspace changed during capture");
    await syncDirectory(privatePath); await syncDirectory(captureParent);
    return { captureId, path: privatePath, manifest: canonicalizeManifest({ schemaVersion: 1, entries }, limits) };
  } catch (error) {
    await removeOwnedTree(privatePath);
    await unlink(ownerPath).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
    await syncDirectory(owners); throw error;
  }
}
/** Discover captures from durable ownership markers, including crashes before the session reference was saved. */
export async function ownedCaptures(parent: string, sessionId: string): Promise<string[]> {
  const owners = captureOwnersPath(parent); const verified = new Set<string>(); const captureIds = new Set<string>();
  const names = async (directory: string): Promise<string[]> => {
    try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    await safeDirectory(directory); const result: string[] = [];
    for await (const { name } of await opendir(directory)) result.push(name);
    return result;
  };
  for (const name of await names(owners)) {
    if (!/^capture-[A-Za-z0-9]+\.json$/.test(name)) unsafe("Capture cleanup found unowned ownership metadata");
    let owner: { sessionId?: unknown; captureId?: unknown };
    try { owner = await readJson(join(owners, name)) as typeof owner; }
    catch { return unsafe("Capture cleanup could not verify ownership"); }
    if (owner.sessionId !== sessionId || typeof owner.captureId !== "string" || !owner.captureId) return unsafe("Capture cleanup found a different owner");
    verified.add(name.slice(0, -5));
    captureIds.add(owner.captureId);
  }
  const result: string[] = [];
  for (const name of await names(parent)) {
    if (!/^capture-[A-Za-z0-9]+$/.test(name) || !verified.has(name)) unsafe("Capture cleanup found an unowned entry");
    const path = inside(parent, name); await safeDirectory(path);
    result.push(path);
  }
  for (const name of await names(captureManifestsPath(parent))) {
    const match = new RegExp(`^(${uuid})\\.json(?:\\.pending-${uuid})?$`).exec(name);
    if (!match || !captureIds.has(match[1])) unsafe("Capture cleanup found unowned manifest metadata");
  }
  return result;
}
async function* cleanupEntries(root: string, prefix = ""): AsyncIterable<{ path: string; kind: "file" | "directory" }> {
  const parent = prefix ? inside(root, prefix) : root; await safeDirectory(parent);
  for await (const { name } of await opendir(parent)) {
    const path = prefix ? prefix + "/" + name : name; const stat = await lstat(inside(root, path));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) unsafe("Cleanup found a link or special file");
    if (stat.isDirectory()) yield* cleanupEntries(root, path);
    yield { path, kind: stat.isDirectory() ? "directory" : "file" };
  }
}
/** Requires stopped writers. Validates the entire tree before deleting, including excluded control metadata. */
export async function removeOwnedTree(root: string) {
  for await (const _ of cleanupEntries(root)) { /* Complete safety preflight before mutation. */ }
  for await (const entry of cleanupEntries(root)) {
    const absolute = inside(root, entry.path); await safeDirectory(dirname(absolute)); const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) unsafe("Workspace changed during cleanup");
    if (entry.kind === "directory") await rmdir(absolute); else await unlink(absolute);
  }
  await safeDirectory(root); await rmdir(root); await syncDirectory(dirname(root));
}
/** The exact same byte budget applies before replacement and while reading. Overflow leaves the previous journal intact. */
export function privateJsonBytes(value: unknown): Buffer {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw localError("INVALID_REQUEST", "Private metadata must contain JSON");
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_PRIVATE_JSON_BYTES) throw localError("QUOTA_EXCEEDED", "Private JSON record exceeds the 32 MiB control budget");
  return bytes;
}
async function savePrivateBytes(path: string, bytes: Buffer) {
  if (bytes.byteLength > MAX_PRIVATE_JSON_BYTES) throw localError("QUOTA_EXCEEDED", "Private JSON record exceeds the 32 MiB control budget");
  await safeDirectory(dirname(path)); const temporary = join(dirname(path), basename(path) + ".pending-" + randomUUID());
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
export async function saveJson(path: string, value: unknown) { await savePrivateBytes(path, privateJsonBytes(value)); }
async function readPrivateBytes(path: string): Promise<Buffer> {
  const handle = await regular(dirname(path), path.split(sep).pop()!);
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_PRIVATE_JSON_BYTES || (stat.mode & 0o077) !== 0) throw localError("INVALID_REQUEST", "Private state must be bounded and accessible only to its owner");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_PRIVATE_JSON_BYTES) throw localError("INVALID_REQUEST", "Private state exceeds its readable control budget");
    return bytes;
  } finally { await handle.close(); }
}
export async function readJson(path: string): Promise<unknown> { return JSON.parse((await readPrivateBytes(path)).toString("utf8")); }
