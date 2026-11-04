import { afterAll, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// The current catalog fixes its location at import. Keep these route tests in memory.
vi.mock("../../src/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/db")>();
  const database = original.createTestDb();
  return { ...original, getDb: () => database, closeDb: () => database.close() };
});

let app: FastifyInstance;
async function testApp() {
  const factory = await import("../../src/app");
  expect(factory, "The application module must export a reusable factory").toHaveProperty("createApp");
  if (!app) app = await (factory as typeof import("../../src/app")).createApp({ logger: false });
  return app;
}
afterAll(async () => { if (app) await app.close(); });

it("constructs the existing HTTP routes without opening a listener", async () => {
  const app = await testApp();
  expect(app.server.listening).toBe(false);
  const health = await app.inject({ method: "GET", url: "/health" });
  expect(health.statusCode).toBe(200);
  expect(health.json()).toMatchObject({ status: "healthy", version: "1.0.0" });
  expect(app.server.listening).toBe(false);
});

it("preserves public API information, Swagger, and the vault redirect", async () => {
  const app = await testApp();
  const info = await app.inject({ method: "GET", url: "/" });
  expect(info.json()).toEqual({ name: "ContextVault", version: "1.0.0", documentation: "https://github.com/lab-rat0212/contextvault" });
  const docs = await app.inject({ method: "GET", url: "/docs/json" });
  expect(docs.statusCode).toBe(200);
  expect(docs.json().paths).toHaveProperty("/workspaces");
  const vault = await app.inject({ method: "GET", url: "/vault" });
  expect(vault.statusCode).toBe(302);
  expect(vault.headers.location).toBe("/vault/");
});

it("preserves the legacy authentication error and paginated workspace response", async () => {
  const app = await testApp();
  const unauthorized = await app.inject({ method: "GET", url: "/workspaces" });
  expect(unauthorized.statusCode).toBe(401);
  expect(unauthorized.json()).toEqual({ error: "Unauthorized", message: "Invalid or missing API key" });
  const authorized = await app.inject({ method: "GET", url: "/workspaces?customerId=cv-factory-isolated", headers: { "X-API-Key": process.env.CONTEXTVAULT_API_KEY || "cv-test-api-key-123" } });
  expect(authorized.statusCode).toBe(200);
  expect(authorized.json()).toEqual({ data: [], pagination: { total: 0, limit: 50, offset: 0, hasMore: false } });
});
