import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { canonicalizeManifest } from "../../src/domain/manifest";

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });
async function schema(name: string) { return JSON.parse(await readFile(new URL(`../../contracts/${name}`, import.meta.url), "utf8")); }

describe("language-neutral v1 wire contracts", () => {
  it("validates canonical manifest fixtures and rejects unsupported file kinds at the JSON boundary", async () => {
    const app = Fastify();
    servers.push(app);
    app.post("/validate", { schema: { body: await schema("manifest.v1.schema.json") } }, async (request) => request.body);
    expect((await app.inject({ method: "POST", url: "/validate", payload: canonicalizeManifest({ schemaVersion: 1, entries: [{ path: "empty", kind: "directory" }] }) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/validate", payload: { schemaVersion: 1, entries: [{ path: "link", kind: "symlink", target: "x" }] } })).statusCode).toBe(400);
  });

  it("requires lifecycle versions and receipt selections while allowing read-only finalize without a submission", async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    servers.push(app);
    const http = await schema("http.v1.schema.json");
    app.addSchema(await schema("manifest.v1.schema.json"));
    app.addSchema(http);
    for (const name of ["FinalizeRequest", "SealRequest", "OpenRunRequest"]) app.post(`/${name}`, { schema: { body: { $ref: `${http.$id}#/definitions/${name}` } } }, async (request) => request.body);
    const validate = (name: string, payload: object) => app.inject({ method: "POST", url: `/${name}`, payload });
    expect((await validate("FinalizeRequest", { expectedRunVersion: 1 })).statusCode).toBe(200);
    expect((await validate("FinalizeRequest", { expectedRunVersion: 1, submissionId: "submission-opaque" })).statusCode).toBe(200);
    expect((await validate("FinalizeRequest", { submissionId: "s" })).statusCode).toBe(400);
    expect((await validate("SealRequest", { manifest: { schemaVersion: 1, entries: [] }, receipts: [] })).statusCode).toBe(200);
    expect((await validate("SealRequest", { manifest: { schemaVersion: 1, entries: [] } })).statusCode).toBe(400);
    expect((await validate("OpenRunRequest", { mode: "read-write", agentLabel: "agent", task: "task", reason: "reason" })).statusCode).toBe(200);
  });

  it("versions every approved route, exact-byte transfer metadata, and the compatibility boundary", async () => {
    const http = await schema("http.v1.json");
    expect(http.routes).toHaveLength(15);
    expect(http.routes.every((route: { path: string; authenticated: boolean }) => route.path.startsWith("/v1/") && route.authenticated)).toBe(true);
    expect(http.fileDownload.headers).toEqual(["Content-Type", "Content-Length", "X-Content-SHA256"]);
    expect(http.runVersionSemantics).toBe("lifecycle-only");
    const create = http.routes.find((route: { method: string; path: string }) => route.method === "POST" && route.path === "/v1/workspaces");
    expect(create.successStatus).toBe(201);
    expect(create.processingStatus).toBe(202);
    expect(create.processingResponseSchema).toBe("Operation");
    expect(http.resourceLookup.administratorTenantHeader).toBe("X-ContextVault-Customer-Id");
    expect(http.mutationIdempotencyScope).toEqual(["customerId", "actorId", "kind", "workspaceId", "runId", "Idempotency-Key"]);
    const compatibility = await schema("compatibility.v1.json");
    expect(compatibility.minimumRuntimes).toEqual({ node: "18", python: "3.8", php: "8.0" });
    expect(compatibility.legacyPush).toBe("complete-replacement");
    expect(compatibility.consumers.map((consumer: { name: string }) => consumer.name)).toEqual(["Highlight Generator", "Agent Creator", "Code Factory"]);
    expect(compatibility.directGit.canonicalReceivePack).toBe("reject-by-default");
    expect(compatibility.evidence).toBe("representative-contract-fixtures-only");
    const consumers = JSON.parse(await readFile(new URL("../fixtures/workspaces/legacy-consumers.v1.json", import.meta.url), "utf8"));
    expect(consumers.examples[0].checkpointOutcome).toBe("published-needs-reopen");
    expect(consumers.examples[2].v1Outcome.state).toBe("finalized");
    expect(consumers.examples[2].v1Cleanup.state).toBe("complete");
  });

  it("validates public response fixtures and rejects private storage locations or server paths", async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    servers.push(app);
    const http = await schema("http.v1.schema.json");
    app.addSchema(http);
    const fixture = JSON.parse(await readFile(new URL("../fixtures/workspaces/http.v1.json", import.meta.url), "utf8"));
    for (const name of ["Run", "Operation", "RunOutcome"]) app.post(`/${name}`, { schema: { body: { $ref: `${http.$id}#/definitions/${name}` } } }, async (request) => request.body);
    expect((await app.inject({ method: "POST", url: "/Run", payload: fixture.run })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/Operation", payload: fixture.operation })).statusCode).toBe(200);
    for (const forbidden of ["path", "sandboxPath", "privateReference", "credential", "processingFence"]) {
      expect((await app.inject({ method: "POST", url: "/Run", payload: { ...fixture.run, [forbidden]: "/server/private" } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/RunOutcome", payload: { state: "failed", revisionId: null, changed: false, completedAt: "2026-11-03T00:00:00.000Z", errorCode: "NOT_A_CONTRACT_CODE" } })).statusCode).toBe(400);
  });
});
