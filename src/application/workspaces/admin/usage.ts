import type { CustomerScope, Principal, Workspace } from '../../../domain';
import type { WorkspaceRuntime } from '../../../config/runtime';
import { acceptedRevision } from '../../revisions/read';

/** Bounded observations of catalog actions and active accepted heads; never HTTP traffic or physical storage estimates. */
export async function workspaceUsage(runtime: WorkspaceRuntime, principal: Principal, scope: CustomerScope, period: '24h' | '7d' | '30d') {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  const now = runtime.now(); const days = period === '24h' ? 1 : period === '7d' ? 7 : 30; const since = new Date(Date.parse(now) - days * 86400000).toISOString();
  const count = await runtime.control.listWorkspaceMetadata(scope, 0, 1); const workspaces: Workspace[] = []; let cursor: string | undefined; let complete = true;
  do { const page = await runtime.control.listWorkspaces(scope, cursor, 1000); workspaces.push(...page.workspaces); cursor = page.nextCursor ?? undefined; if (cursor) { complete = false; break; } } while (cursor);
  let logicalAcceptedBytes: number | null = complete ? 0 : null; let recordedActions: number | null = complete ? 0 : null; const byDay = new Map<string, number>(); let auditBudget = 100000;
  for (const workspace of workspaces) {
    const selected = { ...scope, workspaceId: workspace.id };
    if (logicalAcceptedBytes !== null && workspace.status === 'active') {
      const source = await acceptedRevision(runtime, principal, selected, workspace.currentRevisionId);
      logicalAcceptedBytes += source.manifest.entries.reduce((n, entry) => n + (entry.kind === 'file' ? entry.byteLength : 0), 0);
    }
    if (recordedActions !== null) {
      if (auditBudget === 0) { recordedActions = null; complete = false; continue; }
      const allowed = await runtime.accessPolicy.evaluate(principal, 'operation:read', selected);
      if (!allowed.allowed) { recordedActions = null; complete = false; continue; }
      let auditCursor: string | undefined;
      do {
        const page = await runtime.control.listAudit(selected, auditCursor, Math.min(1000, auditBudget)); auditBudget -= page.events.length;
        for (const event of page.events) if (event.createdAt >= since && event.createdAt <= now) { recordedActions++; const date = event.createdAt.slice(0, 10); byDay.set(date, (byDay.get(date) ?? 0) + 1); }
        auditCursor = page.nextCursor ?? undefined;
        if (auditCursor && auditBudget === 0) { recordedActions = null; complete = false; break; }
      } while (auditCursor);
    }
  }
  for (const workspace of workspaces) {
    const current = await runtime.control.getWorkspace({ ...scope, workspaceId: workspace.id });
    if (!current || current.version !== workspace.version) { logicalAcceptedBytes = null; complete = false; }
  }
  const after = await runtime.control.listWorkspaceMetadata(scope, 0, 1); if (after.total !== count.total) { logicalAcceptedBytes = null; recordedActions = null; complete = false; }
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  const recordedActionsByDay = [];
  if (recordedActions !== null) for (let day = since.slice(0, 10); day <= now.slice(0, 10); day = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10)) recordedActionsByDay.push({ date: day, count: byDay.get(day) ?? 0 });
  return { period, uniqueWorkspaces: count.total, logicalAcceptedBytes, recordedActions, recordedActionsByDay, measurementComplete: complete,
    totalRequests: null, totalStorageBytes: null, activeApiKeys: null, requestsByDay: null,
    metricsUnavailable: ['allHttpRequests', 'physicalStorageBytes', 'activeApiKeys', ...(logicalAcceptedBytes === null ? ['logicalAcceptedBytes'] : []), ...(recordedActions === null ? ['recordedActions'] : [])],
    definitions: { uniqueWorkspaces: 'Non-deleted workspace records in the selected customer scope', logicalAcceptedBytes: 'File lengths in current accepted revisions of active workspaces; directories and physical storage overhead are excluded', recordedActions: 'Catalog audit events in the rolling selected period, grouped by UTC date; these are not all HTTP requests' } };
}
