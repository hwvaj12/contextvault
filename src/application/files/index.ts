import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdtemp, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceError } from "../../domain/errors";
import { canonicalizeManifest, verifyFileStream, workspaceLimits, type FileEntry, type ManifestEntry, type WorkspaceLimits } from "../../domain/manifest";
import type { ByteStream, StreamOptions } from "../../ports/streams";
import type { CapturedSnapshot } from "../../ports/workspace-materializer";
import { assertSafeDirectory, containedPath, createSafeDirectory, openRegularFile, removeWorkspace, syncDirectory, walkWorkspace } from "./secure-files";
import { checkAbort, persistByteStream, StreamLimiter } from "./streams";

export * from "./secure-files";
export * from "./streams";

export async function* descriptorBytes(handle: FileHandle, chunkBytes: number, signal?: AbortSignal): ByteStream {
  let position = 0;
  while (true) {
    checkAbort(signal);
    const chunk = Buffer.allocUnsafe(chunkBytes);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
  checkAbort(signal);
}

export function readWorkspaceFile(root: string, entry: FileEntry, limits: Partial<WorkspaceLimits> = {}, options?: StreamOptions, limiter?: StreamLimiter): ByteStream {
  return readVerifiedFile(root, entry.path, entry, limits, options, limiter);
}

/** Adapters select physicalPath; the logical entry controls workspace path and content limits. */
export function readVerifiedFile(root: string, physicalPath: string, entry: FileEntry, limits: Partial<WorkspaceLimits> = {}, options?: StreamOptions, limiter?: StreamLimiter): ByteStream {
  const configured = workspaceLimits(limits);
  canonicalizeManifest({ schemaVersion: 1, entries: [entry] }, configured);
  return (async function* () {
    const release = limiter ? await limiter.acquire(options?.signal) : () => {};
    let handle: FileHandle | undefined;
    try {
      checkAbort(options?.signal);
      handle = await openRegularFile(root, physicalPath);
      yield* verifyFileStream(entry, descriptorBytes(handle, configured.maxChunkBytes, options?.signal), configured);
    } finally { await handle?.close(); release(); }
  })();
}

/** Extract exactly one verified file without replacing an existing destination. */
export async function writeWorkspaceFile(root: string, entry: FileEntry, bytes: ByteStream, overrides: Partial<WorkspaceLimits> = {}, options?: StreamOptions): Promise<void> {
  const limits = workspaceLimits(overrides);
  canonicalizeManifest({ schemaVersion: 1, entries: [entry] }, limits);
  await assertSafeDirectory(root);
  const destination = containedPath(root, entry.path);
  const parent = dirname(destination);
  await createSafeDirectory(parent);
  const temporary = join(parent, `.cv-upload-${randomUUID()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await persistByteStream(handle, bytes, { byteLength: entry.byteLength, sha256: entry.sha256 }, limits, options?.signal);
    await handle.close();
    await assertSafeDirectory(parent);
    await link(temporary, destination);
    await unlink(temporary);
    await syncDirectory(parent);
  } finally {
    await handle.close().catch(() => {});
    await assertSafeDirectory(parent);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

const stamp = (stat: Awaited<ReturnType<typeof lstat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/** Capture uses private immutable copies, and detects changed source identities before returning. */
export async function captureWorkspace(root: string, overrides: Partial<WorkspaceLimits> = {}): Promise<CapturedSnapshot> {
  const limits = workspaceLimits(overrides);
  const listed = await walkWorkspace(root, false, limits);
  const stamps = new Map<string, string>();
  const entries: ManifestEntry[] = [];
  let total = 0;
  // Check portable collisions and all quotas before opening any bytes.
  for (const entry of listed) {
    const stat = await lstat(containedPath(root, entry.path));
    stamps.set(entry.path, stamp(stat));
    if (entry.kind === "directory") entries.push({ path: entry.path, kind: "directory" });
    else {
      total += stat.size;
      if (stat.size > limits.maxFileBytes || total > limits.maxTotalBytes) throw new WorkspaceError("QUOTA_EXCEEDED", "Capture byte limit exceeded");
      entries.push({ path: entry.path, kind: "file", byteLength: stat.size, sha256: "0".repeat(64) });
    }
  }
  canonicalizeManifest({ schemaVersion: 1, entries }, limits);
  const captureId = randomUUID();
  const staging = await mkdtemp(join(await realpath(tmpdir()), "contextvault-capture-"));
  const limiter = new StreamLimiter(limits.maxConcurrentStreams);
  try {
    await syncDirectory(dirname(staging));
    for (const entry of entries) {
      if (entry.kind === "directory") { await createSafeDirectory(containedPath(staging, entry.path)); continue; }
      const handle = await openRegularFile(root, entry.path);
      const hash = createHash("sha256"); let size = 0;
      try {
        for await (const bytes of descriptorBytes(handle, limits.maxChunkBytes)) {
          size += bytes.byteLength;
          if (size > entry.byteLength) throw new WorkspaceError("CAPTURE_CHANGED", "Source changed during capture");
          hash.update(bytes);
        }
      } finally { await handle.close(); }
      if (size !== entry.byteLength) throw new WorkspaceError("CAPTURE_CHANGED", "Source changed during capture");
      entry.sha256 = hash.digest("hex");
      try { await writeWorkspaceFile(staging, entry, readWorkspaceFile(root, entry, limits), limits); }
      catch (error) { if (error instanceof WorkspaceError && error.code === "RECEIPT_MISMATCH") throw new WorkspaceError("CAPTURE_CHANGED", "Source changed during capture"); throw error; }
    }
    const after = await walkWorkspace(root, false, limits);
    if (JSON.stringify(after) !== JSON.stringify(listed)) throw new WorkspaceError("CAPTURE_CHANGED", "Workspace entries changed during capture");
    for (const entry of after) {
      if (stamp(await lstat(containedPath(root, entry.path))) !== stamps.get(entry.path)) throw new WorkspaceError("CAPTURE_CHANGED", "Workspace changed during capture");
    }
    const manifest = canonicalizeManifest({ schemaVersion: 1, entries }, limits);
    await syncDirectory(staging);
    let released = false;
    return {
      captureId, manifest,
      async openFile(path, options) {
        if (released) throw new WorkspaceError("INVALID_TRANSITION", "Capture was released");
        const entry = manifest.entries.find((item): item is FileEntry => item.path === path && item.kind === "file");
        if (!entry) throw new WorkspaceError("INVALID_MANIFEST", "Path is not a captured regular file");
        return readWorkspaceFile(staging, entry, limits, options, limiter);
      },
      async release() { if (!released) { await removeWorkspace(staging); released = true; } },
    };
  } catch (error) { await removeWorkspace(staging); throw error; }
}
