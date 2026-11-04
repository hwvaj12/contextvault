import { open } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "../../../domain";

export async function syncPath(location: string, missingAllowed = false): Promise<void> {
  let handle;
  try { handle = await open(location, "r"); }
  catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new WorkspaceError("STORAGE_UNAVAILABLE", "Cannot durably retain private Git storage", { retryable: true });
  }
  try { await handle.sync(); }
  catch { throw new WorkspaceError("STORAGE_UNAVAILABLE", "Cannot durably retain private Git storage", { retryable: true }); }
  finally { await handle.close(); }
}

/** Flush every ancestry link, including directories left by an interrupted initialization attempt. */
export async function syncDirectoryAncestry(directory: string): Promise<void> {
  for (;;) {
    await syncPath(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Git fsyncs object files; sync their directory entries before publishing retention refs. */
export async function syncObject(repository: string, objectId: string): Promise<void> {
  await syncPath(path.join(repository, "objects", objectId.slice(0, 2)), true);
  await syncPath(path.join(repository, "objects"));
}

export async function syncRefDirectories(repository: string, scoped: string): Promise<void> {
  for (const category of ["candidates", "revisions", "collected"]) {
    const directory = path.join(repository, "refs", "contextvault", category);
    await syncPath(path.join(directory, scoped), true);
    await syncPath(directory, true);
  }
  await syncPath(path.join(repository, "refs", "contextvault"), true);
  await syncPath(path.join(repository, "refs"));
  await syncPath(repository);
}
