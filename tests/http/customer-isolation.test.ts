import { expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { getRequestCustomerId } from "../../src/middleware/tenant";
import { create, fixture, hash, json, open, submit, finalize } from "./helpers";

it("denies foreign credential creation and revocation while retaining tenant-owned management", async () => {
  const context = await fixture(); const a = await context.key(); const b = await context.key("tenant-b");
  const own = await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "own" }, a), 201);
  const foreign = await json(await context.request("POST", "/api-keys", { customerId: "tenant-b", name: "foreign" }, b), 201);
  expect((await context.request("POST", "/api-keys", { customerId: "tenant-b", name: "forged" }, a)).status).toBe(403);
  expect((await context.request("DELETE", `/api-keys/${foreign.id}`, undefined, a)).status).toBe(404);
  expect((await context.request("DELETE", `/api-keys/${own.id}`, undefined, a)).status).toBe(204);
  expect((await context.request("GET", "/api-keys", undefined, own.plainKey)).status).toBe(401);
  expect((await context.request("GET", "/api-keys", undefined, foreign.plainKey)).status).toBe(200);
});

it("requires verified identity instead of treating an absent principal as administrator", () => {
  expect(() => getRequestCustomerId({} as FastifyRequest)).toThrowError(expect.objectContaining({ code: "UNAUTHENTICATED" }));
});

it("scopes every public run, transfer, submission, lease, operation and publication route", async () => {
  const context = await fixture(); const a = await context.key(); const b = await context.key("tenant-b");
  const workspace = await create(context, a); const run = await open(context, workspace.id, a);
  const submission = await submit(context, run, a, { "private.bin": Buffer.from([0, 255]) });
  const routes: [string, string, unknown?][] = [
    ["GET", `/v1/workspaces/${workspace.id}`], ["POST", `/v1/workspaces/${workspace.id}/runs`, { mode: "read-only", agentLabel: "foreign", task: "test", reason: "test" }],
    ["GET", `/v1/runs/${run.id}`], ["GET", `/v1/runs/${run.id}/workspace/manifest`], ["GET", `/v1/runs/${run.id}/workspace/files?path=private.bin`],
    ["POST", `/v1/runs/${run.id}/submissions`, {}], ["GET", `/v1/runs/${run.id}/submissions/${submission.id}`],
    ["PUT", `/v1/runs/${run.id}/submissions/${submission.id}/files?path=foreign.bin`, Buffer.from("foreign")],
    ["POST", `/v1/runs/${run.id}/submissions/${submission.id}/seal`, { manifest: { schemaVersion: 1, entries: [] }, receipts: [] }],
    ["POST", `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }],
    ["POST", `/v1/runs/${run.id}/abort`, { expectedRunVersion: run.version, reason: "foreign" }],
    ["POST", `/v1/runs/${run.id}/heartbeat`, { expectedLeaseVersion: run.leaseVersion }],
  ];
  for (const [method, route, body] of routes) expect([403, 404], route).toContain((await context.request(method, route, body, b)).status);
  const operation = await finalize(context, run, a, submission.id); expect(operation.state).toBe("succeeded");
  expect((await context.request("GET", `/v1/operations/${operation.id}`, undefined, b)).status).toBe(404);
  const next = await open(context, workspace.id, a); const response = await context.request("GET", `/v1/runs/${next.id}/workspace/files?path=private.bin`, undefined, a);
  expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(hash(Buffer.from([0, 255])));
});

it("does not widen public path exceptions or permit run borrowing by another credential", async () => {
  const context = await fixture(); const key = await context.key(); const sibling = await context.key();
  const workspace = await create(context, key); const run = await open(context, workspace.id, key);
  for (const path of ["/health-other", "/docs-other", "/vault-other", "/v1/workspaces"]) expect((await context.request("GET", path, undefined, "")).status).toBe(401);
  expect((await context.request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, sibling)).status).toBe(403);
  expect((await context.request("POST", `/v1/runs/${run.id}/abort`, { expectedRunVersion: run.version, reason: "borrow" }, sibling)).status).toBe(403);
});
