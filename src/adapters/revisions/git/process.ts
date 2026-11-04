import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkspaceError } from "../../../domain";
import type { ByteStream } from "../../../ports/streams";
import { syncObject } from "./durability";

const environment = {
  PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
};
const configuration = [
  "core.hooksPath=/dev/null", "core.attributesFile=/dev/null", "core.autocrlf=false",
  "core.safecrlf=false", "core.logAllRefUpdates=false", "commit.gpgsign=false",
  "gc.auto=0", "maintenance.auto=false", "core.fsync=loose-object,reference", "core.fsyncMethod=fsync",
].flatMap((value) => ["-c", value]);

/** No shell, inherited Git variables, user configuration, worktree, or shared index. */
function start(repository: string | null, args: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const child = spawn("/usr/bin/git", ["--no-replace-objects", "--literal-pathspecs", ...configuration,
    ...(repository ? ["--git-dir", repository] : []), ...args], { cwd: repository ?? "/", env: environment, shell: false, stdio: "pipe" });
  // Git diagnostics can contain private server paths. Never expose them through WorkspaceError DTOs.
  child.stderr.resume();
  const abort = () => { child.kill("SIGTERM"); };
  signal?.addEventListener("abort", abort, { once: true });
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new WorkspaceError("STORAGE_UNAVAILABLE", "Cannot start private Git storage")));
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason ?? new Error("Git operation aborted"));
      else if (code === null) reject(new WorkspaceError("STORAGE_UNAVAILABLE", "Private Git command was interrupted"));
      else resolve(code);
    });
  });
  void done.catch(() => {});
  return { child, done, error: () => new WorkspaceError("STORAGE_UNAVAILABLE", "Private Git storage command failed", { retryable: true }) };
}

export async function gitCommand(repository: string | null, args: string[], input?: ByteStream | Uint8Array, signal?: AbortSignal, allowedCodes = [0]): Promise<{ bytes: Buffer; code: number }> {
  const process = start(repository, args, signal);
  const receive = (async () => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.child.stdout) {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) throw new WorkspaceError("QUOTA_EXCEEDED", "Git metadata exceeds its byte limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();
  const send = input === undefined
    ? Promise.resolve(process.child.stdin.end()).then(() => {})
    : pipeline(Readable.from(input instanceof Uint8Array ? [input] : input, { objectMode: false }), process.child.stdin, { signal });
  try {
    const [bytes, , code] = await Promise.all([receive, send, process.done]);
    if (!allowedCodes.includes(code)) throw process.error();
    if (repository && (args[0] === "hash-object" && args.includes("-w") || args[0] === "mktree")) {
      const objectId = bytes.toString("ascii").trim();
      if (!/^[a-f0-9]{40}$/.test(objectId)) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Git returned an invalid object identity");
      await syncObject(repository, objectId);
    }
    return { bytes, code };
  } catch (error) {
    process.child.kill("SIGTERM");
    await process.done.catch(() => {});
    throw error;
  }
}

export async function* gitBlob(repository: string, objectId: string, signal?: AbortSignal): ByteStream {
  const process = start(repository, ["cat-file", "blob", objectId], signal);
  process.child.stdin.end();
  let complete = false;
  try {
    for await (const chunk of process.child.stdout) { signal?.throwIfAborted(); yield chunk; }
    if (await process.done !== 0) throw process.error();
    complete = true;
  } finally {
    if (!complete) process.child.kill("SIGTERM");
    await process.done.catch(() => {});
  }
}
