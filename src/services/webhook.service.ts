import { getDb } from "../db";
import { ulid } from "ulid";
import * as crypto from "crypto";

export const WEBHOOK_EVENTS = [
  "workspace.created", "workspace.deleted", "workspace.cloned", "workspace.creation-failed",
  "sandbox.checked_out", "sandbox.destroyed",
  "run.started", "run.completed", "run.failed", "run.finalized", "run.aborted", "run.expired", "run.conflicted",
  "commit.created",
] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

export interface Webhook {
  id: string;
  customerId: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  customer_id: string;
  url: string;
  events: string;
  secret_hash: string | null;
  active: number;
  created_at: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    customerId: row.customer_id,
    url: row.url,
    events: JSON.parse(row.events),
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function registerWebhook(
  customerId: string,
  url: string,
  events: WebhookEvent[],
  secret?: string
): Webhook {
  const db = getDb();
  const id = `wh_${ulid()}`;
  const now = new Date().toISOString();
  const secretHash = secret
    ? crypto.createHash("sha256").update(secret).digest("hex")
    : null;

  db.prepare(`
    INSERT INTO webhooks (id, customer_id, url, events, secret_hash, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, customerId, url, JSON.stringify(events), secretHash, now);

  return {
    id,
    customerId,
    url,
    events,
    active: true,
    createdAt: now,
  };
}

export function listWebhooks(customerId: string): Webhook[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM webhooks WHERE customer_id = ? AND active=1 ORDER BY created_at DESC")
    .all(customerId) as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function getWebhook(id: string, customerId?: string): Webhook | null {
  const db = getDb();
  const row = (customerId ? db.prepare("SELECT * FROM webhooks WHERE id=? AND customer_id=? AND active=1").get(id, customerId) : db.prepare("SELECT * FROM webhooks WHERE id=? AND active=1").get(id)) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : null;
}

export function deleteWebhook(id: string, customerId?: string): boolean {
  const db = getDb();
  // Frozen in-flight outbox recipients retain their signing material. New claims see active subscriptions only.
  const result = customerId ? db.prepare("UPDATE webhooks SET active=0 WHERE id=? AND customer_id=? AND active=1").run(id, customerId) : db.prepare("UPDATE webhooks SET active=0 WHERE id=? AND active=1").run(id);
  return result.changes > 0;
}

/** Infrastructure resolver; never accept a signing reference from a webhook HTTP body. */
export async function getWebhookSigningKey(reference: string, customerId: string): Promise<string | null> {
  if (!reference.startsWith("legacy-webhook:")) return null;
  const row = getDb().prepare("SELECT secret_hash FROM webhooks WHERE id=? AND customer_id=?").get(reference.slice("legacy-webhook:".length), customerId) as { secret_hash: string | null } | undefined;
  return row?.secret_hash ?? null;
}

/**
 * Deliver a webhook event to all matching registered endpoints.
 * Retries up to 3 times with exponential backoff on failure.
 */
export async function deliver(
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const db = getDb();
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : null;
  const legacy = workspaceId ? db.prepare("SELECT customer_id FROM workspaces WHERE id=?").get(workspaceId) as { customer_id: string } | undefined : undefined;
  const hasCatalog = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_records'").get();
  const catalog = workspaceId && hasCatalog ? db.prepare("SELECT customer_id FROM catalog_records WHERE kind='workspace' AND id=?").get(workspaceId) as { customer_id: string } | undefined : undefined;
  const declared = typeof payload.customerId === "string" ? payload.customerId : null;
  const owners = new Set([legacy?.customer_id, catalog?.customer_id, declared].filter((id): id is string => !!id));
  // A missing or inconsistent owner cannot authorize any recipient lookup.
  if (owners.size !== 1) return;
  const customerId = [...owners][0];
  const rows = db
    .prepare("SELECT * FROM webhooks WHERE customer_id=? AND active=1")
    .all(customerId) as WebhookRow[];

  const matching = rows.filter((row) => {
    const events: string[] = JSON.parse(row.events);
    return events.includes(event);
  });

  if (matching.length === 0) return;

  const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });

  for (const row of matching) {
    deliverToEndpoint(row, body).catch(() => {
      console.error(`[webhook] delivery failed for ${row.id}`);
    });
  }
}

async function deliverToEndpoint(row: WebhookRow, body: string): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(500 * Math.pow(2, attempt - 1));
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-ContextVault-Event": JSON.parse(body).event,
      };

      // Sign with HMAC-SHA256 if a secret was provided
      if (row.secret_hash) {
        // We stored the hash of the secret at registration time.
        // For signing, we use the stored hash as the HMAC key so
        // the receiver who knows the original secret can verify by
        // HMAC(sha256(secret), body).
        const signature = crypto
          .createHmac("sha256", row.secret_hash)
          .update(body)
          .digest("hex");
        headers["X-ContextVault-Signature"] = signature;
      }

      const response = await fetch(row.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      await response.body?.cancel();

      if (response.ok) {
        console.log(`[webhook] delivered ${JSON.parse(body).event} to ${row.id} (${response.status})`);
        return;
      }

      // 4xx errors are not retryable
      if (response.status >= 400 && response.status < 500) {
        console.error(`[webhook] ${row.id} returned ${response.status}, not retrying`);
        return;
      }

      // 5xx — retry
      console.warn(`[webhook] ${row.id} returned ${response.status}, retrying (${attempt + 1}/${maxRetries})`);
    } catch {
      console.warn(`[webhook] delivery attempt ${attempt + 1}/${maxRetries} to ${row.id} failed`);
    }
  }

  console.error(`[webhook] exhausted retries for ${row.id}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
