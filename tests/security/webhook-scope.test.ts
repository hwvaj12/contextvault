import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ database: null as Database.Database | null }));
vi.mock("../../src/db", async importOriginal => ({ ...await importOriginal<typeof import("../../src/db")>(), getDb: () => state.database! }));
import { createTestDb } from "../../src/db";
import { webhookRoutes } from "../../src/routes/webhooks";
import { createApiKey, verifyKey } from "../../src/services/apikey.service";
import { principalForVerifiedAdministrator, principalForVerifiedApiKey } from "../../src/middleware/catalog-identity";
import { SqliteControlStore } from "../../src/adapters/control/sqlite-control-store";
import { CatalogAccessPolicy } from "../../src/adapters/access/catalog-access-policy";
import { WorkspaceError } from "../../src/domain";
import { deliver, registerWebhook } from "../../src/services/webhook.service";

let app: FastifyInstance;
let keyA: string;
let keyB: string;
const master = "cv-webhook-test-only-master";
const now = "2026-11-04T08:00:00.000Z";
const registration = (customerId: string) => ({ customerId, url: "http://127.0.0.1:1/not-contacted", events: ["workspace.created"], secret: "test-only-signing-secret" });

beforeEach(async () => {
  state.database = createTestDb();
  keyA = createApiKey("tenant-a", "a").plainKey;
  keyB = createApiKey("tenant-b", "b").plainKey;
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof WorkspaceError ? reply.code(error.statusCode).send(error.toJSON()) : reply.code(500).send({ error: String(error) }));
  app.addHook("onRequest", async request => {
    const key = request.headers["x-api-key"];
    if (key === master) {
      request.principal = principalForVerifiedAdministrator(state.database!, master, null, now);
      request.isAdmin = true;
    } else if (typeof key === "string") {
      const verified = verifyKey(key);
      if (verified) {
        request.principal = await principalForVerifiedApiKey(state.database!, verified, now) ?? undefined;
        request.customerId = verified.customerId;
      }
    }
  });
  await app.register(webhookRoutes);
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); state.database?.close(); state.database = null; });

it("keeps tenant webhook registration, listing and deletion within current customer authority", async () => {
  const headers = { "x-api-key": keyA };
  const own = await app.inject({ method: "POST", url: "/webhooks", headers, payload: registration("tenant-a") });
  expect(own.statusCode).toBe(201);
  expect((await app.inject({ method: "GET", url: "/webhooks?customerId=tenant-a", headers })).json().data).toHaveLength(1);
  expect((await app.inject({ method: "POST", url: "/webhooks", headers, payload: registration("tenant-b") })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: "/webhooks?customerId=tenant-b", headers })).statusCode).toBe(403);
  const foreign = await app.inject({ method: "POST", url: "/webhooks", headers: { "x-api-key": keyB }, payload: registration("tenant-b") });
  expect(foreign.statusCode).toBe(201);
  expect((await app.inject({ method: "DELETE", url: `/webhooks/${foreign.json().id}`, headers })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/webhooks?customerId=tenant-b", headers: { "x-api-key": keyB } })).json().data).toHaveLength(1);
  expect((await app.inject({ method: "DELETE", url: `/webhooks/${own.json().id}`, headers })).statusCode).toBe(204);
});

it("requires an explicit principal and retains configured administrator management", async () => {
  expect((await app.inject({ method: "POST", url: "/webhooks", payload: registration("tenant-a") })).statusCode).toBe(401);
  const created = await app.inject({ method: "POST", url: "/webhooks", headers: { "x-api-key": master }, payload: registration("tenant-b") });
  expect(created.statusCode).toBe(201);
  expect((await app.inject({ method: "DELETE", url: `/webhooks/${created.json().id}`, headers: { "x-api-key": master } })).statusCode).toBe(204);
});

it("uses refreshed current grants rather than successful authentication alone", async () => {
  await app.inject({ method: "GET", url: "/webhooks?customerId=tenant-a", headers: { "x-api-key": keyA } });
  const verified = verifyKey(keyA)!;
  const principal = (await principalForVerifiedApiKey(state.database!, verified, now))!;
  const control = new SqliteControlStore(state.database!);
  const policy = new CatalogAccessPolicy(control);
  const scope = { customerId: principal.kind === "administrator" ? "" as never : principal.customerId };
  const authorization = await policy.evaluate(principal, "credential:manage", scope);
  if (!authorization.allowed) throw new Error(authorization.message);
  const authority = (await control.getAuthority(scope, principal))!;
  await control.updateAuthority({ scope, principal, authorization: authorization.precondition, authority: { ...authority, credentialVersion: 2, permissionEpoch: 2, grants: authority.grants.filter(grant => grant.action !== "workspace:admin") }, expectedCredentialVersion: 1, expectedPermissionEpoch: 1 });
  expect((await app.inject({ method: "POST", url: "/webhooks", headers: { "x-api-key": keyA }, payload: registration("tenant-a") })).statusCode).toBe(403);
});

it("keeps legacy delivery within the recorded workspace customer", async () => {
  state.database!.prepare("INSERT INTO workspaces(id,customer_id,name,repo_location,created_at,updated_at,last_accessed_at) VALUES(?,?,?,?,?,?,?)").run("workspace-a", "tenant-a", "fixture", "private", now, now, now);
  registerWebhook("tenant-a", "https://tenant-a.example/hook", ["workspace.deleted"]);
  registerWebhook("tenant-b", "https://tenant-b.example/hook", ["workspace.deleted"]);
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  await deliver("workspace.deleted", { workspaceId: "workspace-a" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe("https://tenant-a.example/hook");
});

it("keeps legacy-only catalogs customer-scoped before the catalog records table exists", async () => {
  state.database!.prepare("INSERT INTO workspaces(id,customer_id,name,repo_location,created_at,updated_at,last_accessed_at) VALUES(?,?,?,?,?,?,?)").run("legacy-workspace", "tenant-a", "legacy fixture", "private", now, now, now);
  state.database!.exec("DROP TABLE catalog_records");
  registerWebhook("tenant-a", "https://tenant-a.example/hook", ["run.completed"]);
  registerWebhook("tenant-b", "https://tenant-b.example/hook", ["run.completed"]);
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  await expect(deliver("run.completed", { workspaceId: "legacy-workspace" })).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).toBe("https://tenant-a.example/hook");
});

it("retains in-flight signing material after deletion while hiding the retired subscription", async () => {
  const headers = { "x-api-key": keyA };
  const created = await app.inject({ method: "POST", url: "/webhooks", headers, payload: registration("tenant-a") });
  expect(created.statusCode).toBe(201);
  const before = state.database!.prepare("SELECT secret_hash FROM webhooks WHERE id=? AND customer_id=?").get(created.json().id, "tenant-a");
  expect((await app.inject({ method: "DELETE", url: `/webhooks/${created.json().id}`, headers })).statusCode).toBe(204);
  expect(state.database!.prepare("SELECT secret_hash FROM webhooks WHERE id=? AND customer_id=?").get(created.json().id, "tenant-a")).toEqual(before);
  expect((await app.inject({ method: "GET", url: "/webhooks?customerId=tenant-a", headers })).json().data).toHaveLength(0);
  expect((await app.inject({ method: "DELETE", url: `/webhooks/${created.json().id}`, headers })).statusCode).toBe(404);
});
