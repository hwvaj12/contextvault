import type { CandidateIdentity, CollectionPermit, PreparedRevision, Timestamp } from "../domain";
import type { ByteStream, RevisionReference, SnapshotSource, StreamOptions } from "./streams";

export interface PrepareRevisionInput {
  /** Already persisted by ControlStore. Never generate candidate identity during a retry. */
  identity: CandidateIdentity;
  source: SnapshotSource;
  signal?: AbortSignal;
}
/** Server composition supplies durable catalog-backed tracking. A collection callback alone proves no writer quiescence. */
export interface RevisionWriterTracking {
  begin(identity: CandidateIdentity, writerId: string): Promise<unknown>;
  finish(identity: CandidateIdentity, writerId: string): Promise<unknown>;
  stopped(identity: CandidateIdentity): Promise<boolean>;
}

export interface RevisionStore {
  /** Prepare exact immutable contents. Same identity with different contents must fail. */
  prepare(input: PrepareRevisionInput): Promise<PreparedRevision>;
  /** Read accepted or prepared contents only using an internal catalog-scoped reference. */
  readManifest(reference: RevisionReference): Promise<SnapshotSource["manifest"]>;
  openFile(reference: RevisionReference, path: string, options?: StreamOptions): Promise<ByteStream>;
  /** Never derive acceptance from adapter refs, listings, or object presence. */
  inspectCandidate(identity: CandidateIdentity): Promise<PreparedRevision | null>;
  /** Enforce an unexpired collection fence; no arbitrary-location or accepted-history deletion API exists. */
  deleteCollectible(permit: CollectionPermit, now: Timestamp): Promise<void>;
}
