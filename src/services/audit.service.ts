import { getDb } from "../db";
import { ulid } from "ulid";

export interface AuditEvent {
  id: string;
  workspaceId: string;
  runId: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function logAuditEvent(params: {
  workspaceId: string;
  runId?: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): AuditEvent {
  const db = getDb();
  const event: AuditEvent = {
    id: `evt_${ulid()}`,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    actorType: params.actorType,
    actorId: params.actorId,
    eventType: params.eventType,
    payload: params.payload ?? {},
    createdAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO audit_events (id, workspace_id, run_id, actor_type, actor_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.workspaceId,
    event.runId,
    event.actorType,
    event.actorId,
    event.eventType,
    JSON.stringify(event.payload),
    event.createdAt,
  );

  return event;
}

export function getAuditEvents(workspaceId: string, limit = 50): AuditEvent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(workspaceId, limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    runId: r.run_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    eventType: r.event_type,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  }));
}
