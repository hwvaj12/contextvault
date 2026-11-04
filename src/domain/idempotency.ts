import { createHash } from "node:crypto";
import { WorkspaceError } from "./errors";

export interface CanonicalRequest {
  schemaVersion: 1;
  customerId: string;
  actorId: string;
  credentialId: string;
  kind: string;
  resource: { workspaceId?: string; runId?: string; submissionId?: string };
  payload: unknown;
}

/** UTF-8 JSON, sorted object keys, exact string/array values, no trailing newline. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (typeof item === "string" && /[\uD800-\uDFFF]/u.test(item)) throw new WorkspaceError("INVALID_REQUEST", "Canonical strings require valid Unicode");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || ancestors.has(item)) {
      throw new WorkspaceError("INVALID_REQUEST", "Canonical requests require finite JSON values without cycles");
    }
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      // Array.from visits holes, which must not silently turn into JSON nulls.
      result = `[${Array.from(item, encode).join(",")}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new WorkspaceError("INVALID_REQUEST", "Canonical requests require plain JSON objects");
      }
      result = `{${Object.keys(item).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((key) => `${encode(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

/** Idempotency keys are stored separately; their digest binds actor, scope, kind, and input. */
export function canonicalRequestDigest(request: CanonicalRequest): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}
