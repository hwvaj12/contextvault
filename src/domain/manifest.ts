import { createHash } from "node:crypto";
import { WorkspaceError } from "./errors";

export interface FileEntry { path: string; kind: "file"; byteLength: number; sha256: string }
export interface DirectoryEntry { path: string; kind: "directory" }
export type ManifestEntry = FileEntry | DirectoryEntry;
export interface Manifest { schemaVersion: 1; entries: readonly ManifestEntry[] }
export interface WorkspaceLimits {
  maxEntries: number;
  maxPathBytes: number;
  maxComponentBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxConcurrentStreams: number;
  maxChunkBytes: number;
}
export const DEFAULT_WORKSPACE_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  maxEntries: 10000, maxPathBytes: 1024, maxComponentBytes: 255,
  maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024,
  maxConcurrentStreams: 4, maxChunkBytes: 64 * 1024,
});
const invalid = (message: string): never => { throw new WorkspaceError("INVALID_MANIFEST", message); };
const quota = (message: string): never => { throw new WorkspaceError("QUOTA_EXCEEDED", message); };
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const portableKey = (value: string) => value.normalize("NFKC").toUpperCase().toLowerCase();

export function workspaceLimits(overrides: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new WorkspaceError("INVALID_REQUEST", "Workspace limits must be positive safe integers");
  }
  return limits;
}

/** Lexical validation only. Materializers and adapters must also reject unsafe filesystem ancestry. */
export function validatePortablePath(value: unknown, overrides: Partial<WorkspaceLimits> = {}): string {
  const limits = workspaceLimits(overrides);
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || /[\uD800-\uDFFF]/u.test(value)) return invalid("Paths must use nonempty valid Unicode NFC relative names");
  if (bytes(value) > limits.maxPathBytes) return quota("Path byte limit exceeded");
  if (/[\\\u0000-\u001f\u007f<>:"|?*]/u.test(value)) return invalid("Path contains a nonportable character");
  for (const component of value.split("/")) {
    if (!component || component === "." || component === ".." || /[. ]$/u.test(component)) return invalid("Path contains an unsafe component");
    if (bytes(component) > limits.maxComponentBytes) return quota("Path component byte limit exceeded");
    if ([".git", ".contextvault"].includes(portableKey(component))) return invalid("Path contains reserved metadata");
    if (/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(component)) return invalid("Path contains a reserved Windows name");
  }
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) invalid("Manifest contains missing or unsupported fields");
}

export function canonicalizeManifest(input: unknown, overrides: Partial<WorkspaceLimits> = {}): Manifest {
  const limits = workspaceLimits(overrides);
  if (!object(input) || input.schemaVersion !== 1 || !Array.isArray(input.entries)) return invalid("Expected a manifest v1 complete snapshot");
  exactKeys(input, ["schemaVersion", "entries"]);
  if (input.entries.length > limits.maxEntries) return quota("Manifest entry limit exceeded");
  const paths = new Map<string, ManifestEntry>();
  const portablePrefixes = new Map<string, string>();
  let total = 0;
  const entries: ManifestEntry[] = input.entries.map((raw: unknown) => {
    if (!object(raw)) return invalid("Manifest entries must be objects");
    const path = validatePortablePath(raw.path, limits);
    if (paths.has(path)) return invalid("Manifest contains duplicate paths");
    const components = path.split("/");
    for (let i = 1; i <= components.length; i++) {
      const prefix = components.slice(0, i).join("/");
      const collision = portablePrefixes.get(portableKey(prefix));
      if (collision !== undefined && collision !== prefix) return invalid("Manifest contains portable-name collisions");
      portablePrefixes.set(portableKey(prefix), prefix);
    }
    let entry: ManifestEntry;
    if (raw.kind === "directory") {
      exactKeys(raw, ["path", "kind"]);
      entry = { path, kind: "directory" };
    } else if (raw.kind === "file") {
      exactKeys(raw, ["path", "kind", "byteLength", "sha256"]);
      if (typeof raw.byteLength !== "number" || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 0) return invalid("File byte length must be a nonnegative safe integer");
      if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) return invalid("File digest must be lowercase SHA-256");
      if (raw.byteLength > limits.maxFileBytes) return quota("Per-file byte limit exceeded");
      total += raw.byteLength;
      if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) return quota("Workspace byte limit exceeded");
      entry = { path, kind: "file", byteLength: raw.byteLength, sha256: raw.sha256 };
    } else {
      return invalid("Only regular files and directories are supported");
    }
    paths.set(path, entry);
    return entry;
  });
  for (const entry of entries) {
    const components = entry.path.split("/");
    for (let i = 1; i < components.length; i++) {
      if (paths.get(components.slice(0, i).join("/"))?.kind === "file") return invalid("A regular file cannot contain another entry");
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  return { schemaVersion: 1, entries };
}

/** UTF-8 JSON uses this exact field order, no whitespace, and no trailing newline. */
export function canonicalManifestBytes(input: unknown, overrides: Partial<WorkspaceLimits> = {}): Uint8Array {
  return Buffer.from(JSON.stringify(canonicalizeManifest(input, overrides)), "utf8");
}
export function manifestDigest(input: unknown, overrides: Partial<WorkspaceLimits> = {}): string {
  return createHash("sha256").update(canonicalManifestBytes(input, overrides)).digest("hex");
}

/** A consumer must finish iteration successfully before treating output as verified. */
export async function* verifyFileStream(entry: FileEntry, source: AsyncIterable<Uint8Array>, overrides: Partial<WorkspaceLimits> = {}): AsyncIterable<Uint8Array> {
  const limits = workspaceLimits(overrides);
  canonicalizeManifest({ schemaVersion: 1, entries: [entry] }, limits);
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new WorkspaceError("RECEIPT_MISMATCH", "File streams must contain bytes");
    length += chunk.byteLength;
    if (length > entry.byteLength) throw new WorkspaceError("RECEIPT_MISMATCH", "File exceeds its declared byte length");
    hash.update(chunk);
    for (let offset = 0; offset < chunk.byteLength; offset += limits.maxChunkBytes) yield chunk.subarray(offset, offset + limits.maxChunkBytes);
  }
  if (length !== entry.byteLength || hash.digest("hex") !== entry.sha256) throw new WorkspaceError("RECEIPT_MISMATCH", "File bytes do not match their declared length and digest");
}
