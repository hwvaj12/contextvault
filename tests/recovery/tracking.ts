import { canonicalJson, WorkspaceError } from "../../src/domain";
import type { RevisionWriterTracking } from "../../src/ports/revision-store";

/** Standalone adapter protocol fixture only. Server/GC acceptance uses actual SQLite writer records. */
export function createTestWriterTracking(): RevisionWriterTracking {
  const active = new Map<string, Set<string>>();
  const seen = new Set<string>();
  return {
    async begin(identity, writerId) { const key = canonicalJson(identity); seen.add(key); const writers = active.get(key) ?? new Set<string>(); writers.add(writerId); active.set(key, writers); },
    async finish(identity, writerId) { const writers = active.get(canonicalJson(identity)); if (!writers?.delete(writerId)) throw new WorkspaceError("FORBIDDEN", "Unknown fixture writer"); },
    async stopped(identity) { const key = canonicalJson(identity); return seen.has(key) && active.get(key)?.size === 0; },
  };
}
