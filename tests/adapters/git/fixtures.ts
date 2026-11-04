import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CandidateIdentity, Manifest, PreparedRevision } from "../../../src/domain";
import type { ByteStream, RevisionReference, SnapshotSource } from "../../../src/ports/streams";

export const scope = { customerId: "tenant-a", workspaceId: "workspace-a", storageBindingId: "binding-a", bindingGeneration: 1 } as CandidateIdentity["scope"];
export const identity = (suffix = "a"): CandidateIdentity => ({
  candidateId: `candidate-${suffix}` as CandidateIdentity["candidateId"],
  revisionId: `revision-${suffix}` as CandidateIdentity["revisionId"],
  operationId: `operation-${suffix}` as CandidateIdentity["operationId"], scope,
  parentRevisionId: null, createdAt: "2026-11-03T12:00:00.000Z",
});
export const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const reference = (prepared: PreparedRevision): RevisionReference => prepared;
export async function bytes(stream: ByteStream): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export function source(files: Record<string, Buffer>, directories: string[] = []): SnapshotSource {
  const manifest: Manifest = { schemaVersion: 1, entries: [
    ...Object.entries(files).map(([path, data]) => ({ path, kind: "file" as const, byteLength: data.length, sha256: hash(data) })),
    ...directories.map((path) => ({ path, kind: "directory" as const })),
  ] };
  return { manifest, async openFile(name) { return (async function* () { yield files[name].subarray(0, 2); yield files[name].subarray(2); })(); } };
}
export async function canonicalSource(): Promise<{ source: SnapshotSource; canonical: string; digest: string; files: Record<string, Buffer> }> {
  const fixture = JSON.parse(await readFile(new URL("../../fixtures/workspaces/canonical.v1.json", import.meta.url), "utf8"));
  const files = Object.fromEntries(Object.entries(fixture.files).map(([name, raw]) => [name, Buffer.from((raw as { hex: string }).hex, "hex")]));
  return { source: { ...source(files, ["empty"]), manifest: fixture.input }, canonical: fixture.canonical, digest: fixture.sha256, files };
}
