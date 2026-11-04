import type { ClientRunIdentity, ClientSessionId, LocalClientSessionState, LocalWorkspaceHandle, Manifest, WorkspaceLimits } from "../domain";
import type { SnapshotSource } from "./streams";

export interface CreateLocalWorkspaceInput {
  session: LocalClientSessionState;
  run: ClientRunIdentity;
  /** The client selects this local parent, never the remote HTTP server. */
  localParent?: string;
}
export interface CapturedSnapshot extends SnapshotSource {
  /** A stable capture must detect changed files rather than publishing a mixed snapshot. */
  captureId: string;
  manifest: Manifest;
  release(): Promise<void>;
}

/** Executes beside an existing agent. This port never launches or supervises agent code. */
export interface WorkspaceMaterializer {
  /** Allocate private session state before create/open dispatch, while all remote IDs may remain unknown. */
  createSession(input: { sessionId: ClientSessionId; serverOrigin: string; privateStateParent?: string }): Promise<LocalClientSessionState>;
  create(input: CreateLocalWorkspaceInput): Promise<LocalWorkspaceHandle>;
  /** Validate all ancestry without following symlinks and verify every downloaded file. */
  hydrate(handle: LocalWorkspaceHandle, source: SnapshotSource, limits?: Partial<WorkspaceLimits>): Promise<LocalWorkspaceHandle>;
  /** Caller stops agent writes first. Exclude control metadata; reject links and special files. */
  capture(handle: LocalWorkspaceHandle, limits?: Partial<WorkspaceLimits>): Promise<CapturedSnapshot>;
  /** Atomically persist and sync the original command/key/request/selection before HTTP dispatch, outside workspace contents. */
  savePrivateState(state: LocalClientSessionState): Promise<void>;
  loadPrivateState(privateStatePath: string): Promise<LocalClientSessionState>;
  /** Explicit cleanup validates ancestry and never follows links or silently aborts uncertain publication. */
  cleanup(handle: LocalWorkspaceHandle): Promise<void>;
}
