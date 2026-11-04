import { afterEach, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { setup } from "./helpers";
import { WorkspaceMaintenance } from "../../src/application/maintenance";
import { createWebhookDelivery } from "../../src/adapters/delivery/webhook";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } });
async function receiver(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const server = createServer(async (request, response) => { let body = ""; for await (const bytes of request) body += bytes; handler(request, response, body); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("delivers stable signed events only to frozen customer recipients and retains successful retry receipts", async () => {
  const calls = new Map<string, { id: string; body: string; signature: string }[]>();
  const url = await receiver((request, response, body) => {
    const route = request.url!; const attempts = calls.get(route) ?? [];
    attempts.push({ id: request.headers["x-contextvault-event-id"] as string, body, signature: request.headers["x-contextvault-signature"] as string }); calls.set(route, attempts);
    response.writeHead(route === "/retry" && attempts.length === 1 ? 500 : 200); response.end();
  });
  const context = await setup();
  const key = createHash("sha256").update("receiver-test-secret").digest("hex");
  for (const [id, customerId, route] of [["a-first", "tenant-a", "/success"], ["a-second", "tenant-a", "/retry"], ["b-foreign", "tenant-b", "/foreign"]]) {
    context.control.registerSubscription({ id: id as never, customerId: customerId as never, active: true, eventTypes: ["workspace.created"], destination: url + route, signingSecretRef: "test-signing-key" });
  }
  await context.create();
  const delivery = createWebhookDelivery({ resolveSigningKey: async (_ref, customerId) => customerId === "tenant-a" ? key : null, timeoutMs: 2000 });
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, deliver: delivery, retryDelayMs: 100 });
  await maintenance.runOnce();
  expect(calls.get("/success")).toHaveLength(1); expect(calls.get("/retry")).toHaveLength(1); expect(calls.get("/foreign")).toBeUndefined();
  context.control.registerSubscription({ id: "a-late" as never, customerId: "tenant-a" as never, active: true, eventTypes: ["workspace.created"], destination: url + "/late", signingSecretRef: null });
  context.clock.value = "2026-11-03T12:00:00.200Z";
  await maintenance.runOnce();
  expect(calls.get("/success")).toHaveLength(1); expect(calls.get("/retry")).toHaveLength(2); expect(calls.get("/foreign")).toBeUndefined(); expect(calls.get("/late")).toBeUndefined();
  const retry = calls.get("/retry")!;
  expect(retry[0]).toEqual(retry[1]);
  expect(retry[0].signature).toBe(createHmac("sha256", key).update(retry[0].body).digest("hex"));
  expect(JSON.parse(retry[0].body)).toMatchObject({ event: "workspace.created", timestamp: "2026-11-03T12:00:00.000Z" });
  expect(await context.control.listPendingOutbox({ now: context.clock.value, limit: 100 })).toHaveLength(0);
});

it("completes zero-recipient events and drains a bounded scheduler without executing agent code", async () => {
  const context = await setup(); await context.create();
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, batchSize: 1, intervalMs: 5 });
  maintenance.start();
  for (let tries = 0; tries < 100 && (await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 })).length; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  await maintenance.stop();
  expect(await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 })).toHaveLength(0);
});

it("limits delivery attempts per tick and advances the claim fence between recipient batches", async () => {
  const received: string[] = [];
  const url = await receiver((request, response) => { received.push(request.url!); response.writeHead(200); response.end(); });
  const context = await setup();
  for (const id of ["first", "second", "third"]) context.control.registerSubscription({ id: id as never, customerId: "tenant-a" as never, active: true, eventTypes: ["workspace.created"], destination: `${url}/${id}`, signingSecretRef: null });
  await context.create();
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, batchSize: 1, deliver: createWebhookDelivery({ timeoutMs: 2000 }) });
  expect((await maintenance.runOnce()).delivered).toBe(1); expect(received).toHaveLength(1);
  const first = (await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 }))[0];
  expect(first.deliveryState).toBe("pending");
  expect((await maintenance.runOnce()).delivered).toBe(1); expect(received).toHaveLength(2);
  const second = (await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 }))[0];
  expect(second.claim!.fence).toBeGreaterThan(first.claim!.fence);
  expect((await maintenance.runOnce()).delivered).toBe(1);
  expect(new Set(received).size).toBe(3);
  expect(await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 })).toEqual([]);
});

it("rejects a late delivery acknowledgment after a replacement worker completes the stable event", async () => {
  let received!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const bodies: string[] = [];
  const url = await receiver((_request, response, body) => {
    bodies.push(body);
    if (bodies.length === 1) { received(); void held.then(() => { response.writeHead(200); response.end(); }); }
    else { response.writeHead(200); response.end(); }
  });
  const context = await setup();
  context.control.registerSubscription({ id: "held" as never, customerId: "tenant-a" as never, active: true, eventTypes: ["workspace.created"], destination: url, signingSecretRef: null });
  const { workspace } = await context.create();
  const first = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, claimTtlMs: 1000, deliver: createWebhookDelivery({ timeoutMs: 5000 }) });
  const pending = first.runOnce();
  try {
    await ready;
    context.clock.value = "2026-11-03T12:00:02.000Z";
    const second = new WorkspaceMaintenance({ lifecycle: context.peer("replacement-delivery"), now: () => context.clock.value, deliver: createWebhookDelivery({ timeoutMs: 2000 }) });
    expect((await second.runOnce()).delivered).toBe(1);
    release(); expect((await pending).delivered).toBe(0);
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    expect(await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 })).toEqual([]);
    expect((await context.control.listRevisions({ customerId: workspace.customerId, workspaceId: workspace.id })).revisions).toHaveLength(1);
  } finally { release(); await pending; }
});
