import type { Timestamp } from "../../domain";
import type { ControlStore } from "../../ports/control-store";
import type { RevisionWriterTracking } from "../../ports/revision-store";

/** Bind one server worker incarnation. Reusing a worker ID after restart cannot establish physical stop proof. */
export function createRevisionWriterTracking(control: ControlStore, ownerId: string, now: () => Timestamp = () => new Date().toISOString()): RevisionWriterTracking {
  return {
    begin: (identity, writerId) => control.beginCandidateWrite({ identity, writerId, ownerId, now: now() }),
    finish: (identity, writerId) => control.finishCandidateWrite({ identity, writerId, now: now() }),
    stopped: identity => control.areCandidateWritersStopped(identity, ownerId),
  };
}
