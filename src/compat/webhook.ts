import { createHash } from 'node:crypto';
import { canonicalJson, type Operation, type OutboxEvent, type Run } from '../domain';
import type { CatalogSubscription } from '../ports/control-store';
export interface WebhookRepresentation { eventType: string; payload: Record<string, unknown> }
/** Represent only accepted catalog outcomes; no provisional preparation or backend object can create a notification. */
export function legacyRepresentations(event: OutboxEvent, operation: Operation | null, run: Run | null, legacyPush = false): WebhookRepresentation[] {
  if (event.type !== 'run.finalized' || operation?.kind !== 'finalize' || operation.state !== 'succeeded' || operation.result?.kind !== 'finalize'
    || operation.result.runState !== 'finalized' || !run || run.state !== 'finalized' || run.id !== event.runId
    || run.scope.customerId !== event.scope.customerId || run.scope.workspaceId !== event.scope.workspaceId || run.operationId !== event.operationId
    || run.outcome?.revisionId !== operation.result.revisionId || run.outcome.changed !== operation.result.changed) return [];
  return [{ eventType: 'run.completed', payload: { agentId: run.agentLabel } },
    ...((operation.result.changed || legacyPush) && operation.result.revisionId ? [{ eventType: 'commit.created', payload: { commitId: operation.result.revisionId } }] : [])];
}
export function representationRecipient(event: OutboxEvent, recipient: CatalogSubscription, representation: WebhookRepresentation): CatalogSubscription {
  const identity = createHash('sha256').update(canonicalJson([event.id, recipient.id, representation.eventType])).digest('hex');
  return { ...recipient, id: `representation-${identity}` as CatalogSubscription['id'], representation: { ...representation, subscriptionId: recipient.id, deliveryId: `delivery-${identity}` } };
}

/** Existing run.failed keeps its name. Freeze legacy fields from its recorded terminal failure, never a conflict or transient error. */
export function canonicalRepresentation(event: OutboxEvent, operation: Operation | null, run: Run | null): WebhookRepresentation | null {
  if (event.type !== 'run.failed' || operation?.kind !== 'finalize' || operation.state !== 'failed' || operation.result?.kind !== 'finalize'
    || operation.result.runState !== 'failed' || run?.state !== 'failed' || run.id !== event.runId || run.operationId !== operation.id
    || run.scope.customerId !== event.scope.customerId || run.scope.workspaceId !== event.scope.workspaceId || !operation.error
    || run.outcome?.errorCode !== operation.error.code) return null;
  return { eventType: event.type, payload: { agentId: run.agentLabel, reason: operation.error.message } };
}
