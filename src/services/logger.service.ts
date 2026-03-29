/**
 * Structured logging service for ContextVault.
 * 
 * Key events logged:
 * - workspace.created, workspace.deleted
 * - sandbox.created, sandbox.destroyed
 * - run.created, run.provisioning, run.ready, run.running, run.finalizing
 * - run.merged, run.conflicted, run.failed, run.aborted, run.cleaned_up
 * - lock.acquired, lock.released, lock.expired
 * - commit.created
 * - conflict.detected
 */

export type EventType =
  // Workspace events
  | "workspace.created"
  | "workspace.deleted"
  | "workspace.accessed"
  // Sandbox events
  | "sandbox.created"
  | "sandbox.destroyed"
  | "sandbox.committed"
  // Run events
  | "run.created"
  | "run.provisioning"
  | "run.ready"
  | "run.running"
  | "run.finalizing"
  | "run.merged"
  | "run.conflicted"
  | "run.failed"
  | "run.aborted"
  | "run.cleaned_up"
  // Lock events
  | "lock.acquired"
  | "lock.released"
  | "lock.heartbeat"
  | "lock.expired"
  | "lock.denied"
  // Commit events
  | "commit.created"
  // Conflict events
  | "conflict.detected"
  | "conflict.resolved";

export interface LogEvent {
  event: EventType;
  timestamp: string;
  workspaceId?: string;
  runId?: string;
  agentId?: string;
  customerId?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Structured logger for ContextVault events.
 * 
 * In development/test: logs human-readable to console.
 * In production: would emit structured JSON for log aggregation.
 */
export class CVLogger {
  private readonly service: string;

  constructor(service: string = "contextvault") {
    this.service = service;
  }

  /**
   * Log a structured event.
   */
  log(event: LogEvent): void {
    const entry = {
      service: this.service,
      ...event,
      // Human-readable console output for development
      _display: formatEvent(event),
    };

    // In production this would go to a log aggregation service.
    // For now, output structured JSON that can be parsed by log processors.
    console.log(JSON.stringify(entry));
  }

  // ─── Convenience methods ─────────────────────────────────────────

  workspaceCreated(workspaceId: string, customerId: string, metadata?: Record<string, unknown>): void {
    this.log({
      event: "workspace.created",
      timestamp: new Date().toISOString(),
      workspaceId,
      customerId,
      metadata,
    });
  }

  workspaceDeleted(workspaceId: string, customerId: string): void {
    this.log({
      event: "workspace.deleted",
      timestamp: new Date().toISOString(),
      workspaceId,
      customerId,
    });
  }

  sandboxCreated(workspaceId: string, sandboxPath: string, metadata?: Record<string, unknown>): void {
    this.log({
      event: "sandbox.created",
      timestamp: new Date().toISOString(),
      workspaceId,
      metadata: { sandboxPath, ...metadata },
    });
  }

  sandboxDestroyed(workspaceId: string, reason?: string): void {
    this.log({
      event: "sandbox.destroyed",
      timestamp: new Date().toISOString(),
      workspaceId,
      metadata: reason ? { reason } : undefined,
    });
  }

  sandboxCommitted(workspaceId: string, commitHash: string, fileCount: number, sizeBytes: number): void {
    this.log({
      event: "sandbox.committed",
      timestamp: new Date().toISOString(),
      workspaceId,
      metadata: { commitHash, fileCount, sizeBytes },
    });
  }

  runCreated(runId: string, workspaceId: string, agentId: string): void {
    this.log({
      event: "run.created",
      timestamp: new Date().toISOString(),
      runId,
      workspaceId,
      agentId,
    });
  }

  runTransition(runId: string, workspaceId: string, fromStatus: string, toStatus: EventType, metadata?: Record<string, unknown>): void {
    this.log({
      event: toStatus,
      timestamp: new Date().toISOString(),
      runId,
      workspaceId,
      metadata: { previousStatus: fromStatus, ...metadata },
    });
  }

  lockAcquired(lockId: string, workspaceId: string, ownerRunId: string, lockType: string): void {
    this.log({
      event: "lock.acquired",
      timestamp: new Date().toISOString(),
      workspaceId,
      runId: ownerRunId,
      metadata: { lockId, lockType },
    });
  }

  lockReleased(lockId: string, workspaceId: string, ownerRunId: string): void {
    this.log({
      event: "lock.released",
      timestamp: new Date().toISOString(),
      workspaceId,
      runId: ownerRunId,
      metadata: { lockId },
    });
  }

  lockDenied(workspaceId: string, requestedByRunId: string, owningRunId: string): void {
    this.log({
      event: "lock.denied",
      timestamp: new Date().toISOString(),
      workspaceId,
      runId: requestedByRunId,
      metadata: { owningRunId },
    });
  }

  lockExpired(lockId: string, workspaceId: string, ownerRunId: string): void {
    this.log({
      event: "lock.expired",
      timestamp: new Date().toISOString(),
      workspaceId,
      runId: ownerRunId,
      metadata: { lockId },
    });
  }

  conflictDetected(runId: string, workspaceId: string, baseCommit: string, currentHead: string): void {
    this.log({
      event: "conflict.detected",
      timestamp: new Date().toISOString(),
      runId,
      workspaceId,
      metadata: { baseCommit, currentHead },
    });
  }

  commitCreated(workspaceId: string, commitHash: string, parentId: string | null, agentId?: string, metadata?: Record<string, unknown>): void {
    this.log({
      event: "commit.created",
      timestamp: new Date().toISOString(),
      workspaceId,
      metadata: { commitHash, parentId, agentId, ...metadata },
    });
  }
}

function formatEvent(event: LogEvent): string {
  const parts = [`[${event.event}]`];
  
  if (event.workspaceId) parts.push(`ws=${event.workspaceId}`);
  if (event.runId) parts.push(`run=${event.runId}`);
  if (event.agentId) parts.push(`agent=${event.agentId}`);
  if (event.customerId) parts.push(`cust=${event.customerId}`);
  if (event.durationMs !== undefined) parts.push(`dur=${event.durationMs}ms`);
  
  if (event.metadata) {
    const metaStr = Object.entries(event.metadata)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    parts.push(metaStr);
  }
  
  return parts.join(" ");
}

// Singleton instance
let _logger: CVLogger | null = null;

export function getLogger(): CVLogger {
  if (!_logger) {
    _logger = new CVLogger();
  }
  return _logger;
}
