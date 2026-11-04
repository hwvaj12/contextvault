import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { WorkspaceError } from "../../domain/errors";
import { workspaceLimits, type WorkspaceLimits } from "../../domain/manifest";
import type { ByteStream } from "../../ports/streams";

export function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted(); }

/** A permit covers consumption, rather than merely opening the source. */
export class StreamLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly maximum: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          const index = this.waiting.indexOf(ready);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason ?? new Error("Aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.waiting.push(ready);
      });
    } else this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    };
    try { checkAbort(signal); } catch (error) { release(); throw error; }
    return release;
  }
}

export async function persistByteStream(
  handle: FileHandle, source: ByteStream,
  expected: { sha256: string; byteLength?: number }, overrides: Partial<WorkspaceLimits> = {}, signal?: AbortSignal,
): Promise<{ byteLength: number; sha256: string }> {
  const limits = workspaceLimits(overrides);
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) throw new WorkspaceError("INVALID_MANIFEST", "Expected lowercase SHA-256");
  if (expected.byteLength !== undefined && (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0)) throw new WorkspaceError("INVALID_MANIFEST", "Invalid declared byte length");
  if (expected.byteLength !== undefined && expected.byteLength > limits.maxFileBytes) throw new WorkspaceError("QUOTA_EXCEEDED", "Per-file byte limit exceeded");
  const hash = createHash("sha256");
  let byteLength = 0;
  checkAbort(signal);
  for await (const incoming of source) {
    checkAbort(signal);
    if (!(incoming instanceof Uint8Array)) throw new WorkspaceError("RECEIPT_MISMATCH", "Expected byte stream");
    byteLength += incoming.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > limits.maxFileBytes || byteLength > limits.maxTotalBytes) throw new WorkspaceError("QUOTA_EXCEEDED", "Stream byte limit exceeded");
    if (expected.byteLength !== undefined && byteLength > expected.byteLength) throw new WorkspaceError("RECEIPT_MISMATCH", "Stream exceeds declared length");
    for (let offset = 0; offset < incoming.byteLength; offset += limits.maxChunkBytes) {
      checkAbort(signal);
      // Copy a bounded chunk so a producer cannot mutate its shared buffer during asynchronous writes.
      const chunk = Buffer.from(incoming.subarray(offset, offset + limits.maxChunkBytes));
      hash.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await handle.write(chunk, written, chunk.byteLength - written, null);
        if (!result.bytesWritten) throw new WorkspaceError("STORAGE_UNAVAILABLE", "File write made no progress");
        written += result.bytesWritten;
      }
    }
  }
  checkAbort(signal);
  const sha256 = hash.digest("hex");
  if ((expected.byteLength !== undefined && expected.byteLength !== byteLength) || expected.sha256 !== sha256) throw new WorkspaceError("RECEIPT_MISMATCH", "Uploaded bytes differ from declaration");
  await handle.sync();
  return { byteLength, sha256 };
}
