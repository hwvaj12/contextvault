import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ database: null as Database.Database | null }));
vi.mock("../../src/db", async importOriginal => ({ ...await importOriginal<typeof import("../../src/db")>(), getDb: () => state.database! }));
import { webhookRoutes } from "../../src/routes/webhooks";
import { getWebhookSigningKey } from "../../src/services/webhook.service";
import { createApiKey, verifyKey } from "../../src/services/apikey.service";
import { principalForVerifiedApiKey } from "../../src/middleware/catalog-identity";
import { createWebhookDelivery } from "../../src/adapters/delivery/webhook";
import { WorkspaceMaintenance } from "../../src/application/maintenance";
import { WorkspaceError } from "../../src/domain";
import { finalInput, principal, scopeOf, setup } from "./helpers";

it("registers canonical lifecycle events through HTTP and delivers each authoritative event with the legacy signature", async () => {
  const context = await setup(); state.database = context.control.database;
  const received: { event: string; payload: { eventId: string; runId?: string; operationId?: string }; timestamp: string }[] = [];
  const signatureKey = createHash("sha256").update("public-registration-secret").digest("hex");
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    expect(request.headers["x-contextvault-signature"]).toBe(createHmac("sha256", signatureKey).update(body).digest("hex"));
    const event = JSON.parse(body); expect(request.headers["x-contextvault-event-id"]).toBe(event.payload.eventId);
    received.push(event); response.writeHead(200); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const app = Fastify(); const key = createApiKey("tenant-a", "public-webhook-journey").plainKey;
  app.setErrorHandler((error, _request, reply) => error instanceof WorkspaceError ? reply.code(error.statusCode).send(error.toJSON()) : reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: "Request failed" }));
  app.addHook("onRequest", async request => {
    const presented = request.headers["x-api-key"]; const verified = typeof presented === "string" ? verifyKey(presented) : null;
    if (verified) { request.principal = await principalForVerifiedApiKey(state.database!, verified, context.clock.value) ?? undefined; request.customerId = verified.customerId; }
  });
  await app.register(webhookRoutes);
  try {
    const events = ["workspace.created", "workspace.creation-failed", "run.finalized", "run.aborted", "run.expired", "run.conflicted", "run.failed", "run.completed", "workspace.cloned"];
    const registration = await app.inject({ method: "POST", url: "/webhooks", headers: { "x-api-key": key }, payload: { customerId: "tenant-a", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, events, secret: "public-registration-secret" } });
    expect(registration.statusCode).toBe(201); expect(registration.json().events).toEqual(events);
    const { workspace } = await context.create(); const scope = scopeOf(workspace);
    const first = await context.open(scope); const second = await context.open(scope);
    const selected = await context.upload(first, { "accepted.bin": Buffer.from([0, 255]) });
    const stale = await context.upload(second, { "conflicted.bin": Buffer.from([128, 0]) });
    expect((await context.app.finalize(finalInput(first, selected.id))).state).toBe("succeeded");
    expect((await context.app.finalize(finalInput(second, stale.id))).state).toBe("failed");
    const aborted = await context.open(scope, "read-only");
    await context.app.abort({ scope: { ...aborted.scope, runId: aborted.id }, principal, idempotencyKey: "public-abort", request: { expectedRunVersion: aborted.version, reason: "public event" } });
    await context.open(scope, "read-only");
    context.clock.value = "2026-11-03T12:10:00.000Z";
    const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, deliver: createWebhookDelivery({ resolveSigningKey: getWebhookSigningKey, timeoutMs: 2000 }) });
    expect((await maintenance.runOnce()).errors).toEqual([]);
    expect(received.map(event => event.event).sort()).toEqual(["workspace.created", "run.finalized", "run.completed", "run.conflicted", "run.aborted", "run.expired"].sort());
    expect(new Set(received.map(event => event.payload.eventId)).size).toBe(6);
    const finalized = received.find(event => event.event === "run.finalized")!;
    const completed = received.find(event => event.event === "run.completed")!;
    expect(completed.payload.runId).toBe(finalized.payload.runId);
    expect(completed.payload.operationId).toBe(finalized.payload.operationId);
    const audit = (await context.control.listAudit(scope)).events;
    expect(audit).toHaveLength(9);
    expect(audit.filter(event => event.type === "run.started")).toHaveLength(4);
    expect(new Set(audit.map(event => event.id)).size).toBe(9);
    await maintenance.runOnce(); expect(received).toHaveLength(6);
    expect((await context.read(scope)).files["accepted.bin"]).toEqual(Buffer.from([0, 255]));
  } finally {
    await app.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); state.database = null;
  }
});
