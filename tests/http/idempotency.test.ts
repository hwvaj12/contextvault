import { expect, it } from "vitest";
import { create, fixture, json, open, submit } from "./helpers";

it("replays exact creation/open/heartbeat/finalize commands and rejects changed input", async () => {
  const context = await fixture(); const key = await context.key(); const header = { "Idempotency-Key": "one-create" };
  const body = { customerId: "tenant-a", name: "idempotent" };
  const first = await json(await context.request("POST", "/v1/workspaces", body, key, header), 201);
  expect(await json(await context.request("POST", "/v1/workspaces", body, key, header), 201)).toEqual(first);
  expect((await context.request("POST", "/v1/workspaces", { ...body, name: "different" }, key, header)).status).toBe(409);
  const openBody = { mode: "read-write", agentLabel: "one-agent", task: "task", reason: "reason" }; const openHeader = { "Idempotency-Key": "one-open" };
  const run = await json(await context.request("POST", `/v1/workspaces/${first.id}/runs`, openBody, key, openHeader), 201);
  expect((await json(await context.request("POST", `/v1/workspaces/${first.id}/runs`, openBody, key, openHeader), 201)).id).toBe(run.id);
  const heartbeatHeader = { "Idempotency-Key": "one-heartbeat" }; const beat = { expectedLeaseVersion: run.leaseVersion };
  const renewed = await json(await context.request("POST", `/v1/runs/${run.id}/heartbeat`, beat, key, heartbeatHeader), 200);
  expect(renewed.version).toBe(run.version); expect(renewed.leaseVersion).toBe(run.leaseVersion + 1);
  expect((await json(await context.request("POST", `/v1/runs/${run.id}/heartbeat`, beat, key, heartbeatHeader), 200)).leaseVersion).toBe(renewed.leaseVersion);
  const submission = await submit(context, run, key, { "one.txt": Buffer.from("exact") });
  const finalHeader = { "Idempotency-Key": "one-finalize" }; const finalBody = { submissionId: submission.id, expectedRunVersion: run.version };
  const operation = await json(await context.request("POST", `/v1/runs/${run.id}/finalize`, finalBody, key, finalHeader), 202);
  await context.stop(); await context.start();
  const replay = await json(await context.request("POST", `/v1/runs/${run.id}/finalize`, finalBody, key, finalHeader), 202); expect(replay.id).toBe(operation.id);
  expect((await context.request("POST", `/v1/runs/${run.id}/finalize`, { ...finalBody, expectedRunVersion: run.version + 1 }, key, finalHeader)).status).toBe(409);
  const status = await json(await context.request("GET", `/v1/operations/${operation.id}`, undefined, key), 200); expect(status.state).toBe("succeeded");
});

it("requires mutation keys and preserves read-only upload boundaries", async () => {
  const context = await fixture(); const key = await context.key();
  expect((await context.request("POST", "/v1/workspaces", { customerId: "tenant-a", name: "missing" }, key, { "Idempotency-Key": "" })).status).toBe(400);
  const workspace = await create(context, key); const run = await open(context, workspace.id, key, "read-only");
  expect((await context.request("POST", `/v1/runs/${run.id}/submissions`, {}, key)).status).toBe(403);
});

it("expires client leases through normal maintenance and refuses revival", async () => {
  const context = await fixture({ CV_LEASE_TTL_MS: "250", CV_MAINTENANCE_INTERVAL_MS: "20" }); const key = await context.key();
  const workspace = await create(context, key); const run = await open(context, workspace.id, key, "read-only");
  await new Promise(resolve => setTimeout(resolve, 350));
  const heartbeat = await context.request("POST", `/v1/runs/${run.id}/heartbeat`, { expectedLeaseVersion: run.leaseVersion }, key);
  expect([409, 410]).toContain(heartbeat.status);
  expect((await context.request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, key)).status).not.toBe(200);
  let state = "active";
  for (let attempt = 0; attempt < 100 && state !== "expired"; attempt++) { state = (await json(await context.request("GET", `/v1/runs/${run.id}`, undefined, key), 200)).state; if (state !== "expired") await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(state).toBe("expired");
});
