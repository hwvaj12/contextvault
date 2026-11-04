import type { BindingScope, Manifest, PrivateLocator, RevisionId, Sha256 } from "../domain";

export type ByteStream = AsyncIterable<Uint8Array>;
export interface StreamOptions { signal?: AbortSignal }
export interface SnapshotSource {
  manifest: Manifest;
  /** Each call opens a new bounded byte stream; callers must consume it completely. */
  openFile(path: string, options?: StreamOptions): Promise<ByteStream>;
}
export interface RevisionReference {
  scope: BindingScope;
  revisionId: RevisionId;
  manifestDigest: Sha256;
  privateReference: PrivateLocator;
}
