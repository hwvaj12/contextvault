export const RUN_STATES = ["active", "finalizing", "finalized", "aborted", "conflicted", "failed", "expired"] as const;
export type RunState = typeof RUN_STATES[number];
export const TERMINAL_RUN_STATES = ["finalized", "aborted", "conflicted", "failed", "expired"] as const;
export type TerminalRunState = typeof TERMINAL_RUN_STATES[number];
export type CleanupState = "pending" | "running" | "complete" | "failed";
export type MaterializationState = "provisioning" | "ready" | "failed";

const runTransitions: Record<RunState, readonly RunState[]> = {
  active: ["finalizing", "aborted", "failed", "expired"],
  finalizing: ["finalized", "conflicted", "failed"],
  finalized: [], aborted: [], conflicted: [], failed: [], expired: [],
};
const cleanupTransitions: Record<CleanupState, readonly CleanupState[]> = {
  pending: ["running"], running: ["complete", "failed"], complete: [], failed: ["running"],
};

/** A processing lease expiry recovers finalizing; it never expires the run. */
export function canTransitionRun(from: RunState, to: RunState): boolean {
  return runTransitions[from].includes(to);
}

/** Cleanup is a separate state machine and cannot change a run's outcome. */
export function canTransitionCleanup(from: CleanupState, to: CleanupState): boolean {
  return cleanupTransitions[from].includes(to);
}
