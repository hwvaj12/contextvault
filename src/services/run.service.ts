import { getDb } from "../db";
import { ulid } from "ulid";
import { logAuditEvent } from "./audit.service";
import { deliver } from "./webhook.service";

export type RunStatus =
  | "created"
  | "provisioning"
  | "ready"
  | "running"
  | "finalizing"
  | "merged"
  | "conflicted"
  | "failed"
  | "aborted"
  | "cleaned_up";

export type MergeStatus = "pending" | "merged" | "conflicted" | "failed";

export interface Run {
  id: string;
  workspaceId: string;
  agentId: string;
  baseCommit: string | null;
  workspaceHeadAtStart: string | null;
  finalCommit: string | null;
  status: RunStatus;
  sandboxPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  executionSummary: string | null;
  mergeStatus: MergeStatus;
  createdAt: string;
  updatedAt: string;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  created: ["provisioning", "failed", "aborted"],
  provisioning: ["ready", "failed", "aborted"],
  ready: ["running", "failed", "aborted"],
  running: ["finalizing", "failed", "aborted"],
  finalizing: ["merged", "conflicted", "failed"],
  merged: ["cleaned_up"],
  conflicted: ["cleaned_up"],
  failed: ["cleaned_up"],
  aborted: ["cleaned_up"],
  cleaned_up: [],
};

function rowToRun(row: any): Run {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    baseCommit: row.base_commit,
    workspaceHeadAtStart: row.workspace_head_at_start,
    finalCommit: row.final_commit,
    status: row.status,
    sandboxPath: row.sandbox_path,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
    executionSummary: row.execution_summary,
    mergeStatus: row.merge_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRun(workspaceId: string, agentId: string): Run {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `run_${ulid()}`;

  db.prepare(`
    INSERT INTO runs (id, workspace_id, agent_id, status, merge_status, created_at, updated_at)
    VALUES (?, ?, ?, 'created', 'pending', ?, ?)
  `).run(id, workspaceId, agentId, now, now);

  logAuditEvent({
    workspaceId,
    runId: id,
    actorType: "agent",
    actorId: agentId,
    eventType: "run.created",
    payload: { runId: id },
  });

  return getRun(id)!;
}

export function getRun(id: string): Run | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
  if (!row) return null;
  return rowToRun(row);
}

export function getActiveRunsForWorkspace(workspaceId: string): Run[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM runs WHERE workspace_id = ? AND status NOT IN ('merged', 'conflicted', 'failed', 'aborted', 'cleaned_up')
    ORDER BY created_at DESC
  `).all(workspaceId) as any[];
  return rows.map(rowToRun);
}

export function listRunsForWorkspace(workspaceId: string, limit = 20): Run[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(workspaceId, limit) as any[];
  return rows.map(rowToRun);
}

export function transitionRun(
  runId: string,
  newStatus: RunStatus,
  updates?: Partial<{
    baseCommit: string;
    workspaceHeadAtStart: string;
    finalCommit: string;
    sandboxPath: string;
    failureReason: string;
    executionSummary: string;
    mergeStatus: MergeStatus;
  }>
): Run {
  const db = getDb();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const allowed = VALID_TRANSITIONS[run.status];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid transition: ${run.status} → ${newStatus}. Allowed: ${allowed.join(", ")}`
    );
  }

  const now = new Date().toISOString();
  const isTerminal = ["merged", "conflicted", "failed", "aborted", "cleaned_up"].includes(newStatus);

  const setClauses: string[] = ["status = ?", "updated_at = ?"];
  const params: any[] = [newStatus, now];

  if (isTerminal && !run.completedAt) {
    setClauses.push("completed_at = ?");
    params.push(now);
  }
  if (newStatus === "running" && !run.startedAt) {
    setClauses.push("started_at = ?");
    params.push(now);
  }
  if (updates?.baseCommit !== undefined) {
    setClauses.push("base_commit = ?");
    params.push(updates.baseCommit);
  }
  if (updates?.workspaceHeadAtStart !== undefined) {
    setClauses.push("workspace_head_at_start = ?");
    params.push(updates.workspaceHeadAtStart);
  }
  if (updates?.finalCommit !== undefined) {
    setClauses.push("final_commit = ?");
    params.push(updates.finalCommit);
  }
  if (updates?.sandboxPath !== undefined) {
    setClauses.push("sandbox_path = ?");
    params.push(updates.sandboxPath);
  }
  if (updates?.failureReason !== undefined) {
    setClauses.push("failure_reason = ?");
    params.push(updates.failureReason);
  }
  if (updates?.executionSummary !== undefined) {
    setClauses.push("execution_summary = ?");
    params.push(updates.executionSummary);
  }
  if (updates?.mergeStatus !== undefined) {
    setClauses.push("merge_status = ?");
    params.push(updates.mergeStatus);
  }

  params.push(runId);
  db.prepare(`UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

  logAuditEvent({
    workspaceId: run.workspaceId,
    runId,
    actorType: "system",
    actorId: "run-service",
    eventType: `run.${newStatus}`,
    payload: { from: run.status, to: newStatus, ...updates },
  });

  // Emit webhooks for key run lifecycle events
  if (newStatus === "running") {
    deliver("run.started", { runId, workspaceId: run.workspaceId, agentId: run.agentId });
  } else if (newStatus === "merged") {
    deliver("run.completed", { runId, workspaceId: run.workspaceId, agentId: run.agentId });
  } else if (newStatus === "failed") {
    deliver("run.failed", { runId, workspaceId: run.workspaceId, agentId: run.agentId, reason: updates?.failureReason });
  }

  return getRun(runId)!;
}
