import { createHmac } from "node:crypto";
import { WorkspaceError, type CustomerId } from "../../domain";
import type { DeliveryTransport } from "../../application/maintenance";

export interface WebhookDeliveryOptions {
  resolveSigningKey?: (reference: string, customerId: CustomerId) => Promise<string | null>;
  timeoutMs?: number;
}
export function createWebhookDelivery(options: WebhookDeliveryOptions = {}): DeliveryTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new WorkspaceError("INVALID_REQUEST", "Webhook timeout must be positive");
  return async (event, recipient) => {
    if (event.scope.customerId !== recipient.customerId) throw new WorkspaceError("FORBIDDEN", "Webhook recipient does not belong to the event customer");
    let destination: URL;
    try { destination = new URL(recipient.destination); } catch { throw new WorkspaceError("STORAGE_UNAVAILABLE", "Webhook destination is invalid"); }
    if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Webhook destination requires HTTP without embedded credentials");
    const eventType = recipient.representation?.eventType ?? event.type;
    const deliveryId = recipient.representation?.deliveryId ?? event.id;
    const body = JSON.stringify({ event: eventType, payload: { ...event.payload, ...recipient.representation?.payload, workspaceId: event.scope.workspaceId, ...(event.runId ? { runId: event.runId } : {}), operationId: event.operationId, eventId: deliveryId }, timestamp: event.createdAt });
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-ContextVault-Event": eventType, "X-ContextVault-Event-ID": deliveryId };
    if (recipient.signingSecretRef) {
      const key = await options.resolveSigningKey?.(recipient.signingSecretRef, event.scope.customerId);
      if (!key) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Webhook signing key is unavailable");
      headers["X-ContextVault-Signature"] = createHmac("sha256", key).update(body).digest("hex");
    }
    try {
      const response = await fetch(destination, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      await response.body?.cancel();
      if (!response.ok) throw new WorkspaceError("STORAGE_UNAVAILABLE", `Webhook delivery failed with status ${response.status}`);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("STORAGE_UNAVAILABLE", "Webhook destination is unavailable");
    }
  };
}
