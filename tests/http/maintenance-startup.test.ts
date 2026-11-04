import { expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { getDb } from "../../src/db";
import { loadConfiguration } from "../../src/config";
import { createRuntime } from "../../src/config/runtime";
import { principalForVerifiedAdministrator } from "../../src/middleware/catalog-identity";
import { create, fixture, json, master, open, submit, type HttpClient } from "./helpers";

it.each([false, true])("normal startup recovers a persisted finalization and rechecks rotated administrator=%s before publication", async rotated => {
  const received: { path: string; body: string; signature: string }[] = [];
  const receiver = createServer(async (request, response) => { let body = ""; for await (const bytes of request) body += bytes; received.push({ path: request.url!, body, signature: request.headers["x-contextvault-signature"] as string }); response.writeHead(200); response.end(); });
  await new Promise<void>((resolve, reject) => { receiver.once("error", reject); receiver.listen(0, "127.0.0.1", resolve); });
  const context = await fixture({ CV_MAINTENANCE_INTERVAL_MS: "20" });
  const client: HttpClient = { request: (method, route, body, key = master, extra = {}) => context.request(method, route, body, key, { ...extra, "X-ContextVault-Customer-ID": "tenant-a" }) };
  try {
    const endpoint = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
    for (const [customerId, path] of [["tenant-a", "/own"], ["tenant-b", "/foreign"]]) await json(await context.request("POST", "/webhooks", { customerId, url: endpoint + path, events: ["run.finalized"], secret: "startup-test-secret" }), 201);
    const workspace = await create(client, master); const run = await open(client, workspace.id, master);
    const submission = await submit(client, run, master, { "recovered.bin": Buffer.from([0, 255, 128]) });
    await context.stop("SIGKILL");
    // A stopped server worker persists the same typed claim the HTTP route uses. Normal startup owns discovery and processing.
    const configuration = loadConfiguration(context.env); const database = getDb(configuration.databasePath); const runtime = await createRuntime({ ...configuration, processingTtlMs: 200 }, database);
    let operationId: string;
    try {
      const principal = principalForVerifiedAdministrator(database, master, "tenant-a", runtime.now());
      const selected = await runtime.control.getRun({ customerId: "tenant-a" as never, workspaceId: workspace.id }, run.id);
      if (!selected) throw new Error("Expected durable HTTP run");
      const claimed = await runtime.lifecycle.claimFinalization({ scope: { ...selected.scope, runId: selected.id }, principal, idempotencyKey: "restart-owned-finalize", request: { expectedRunVersion: run.version, submissionId: submission.id } });
      operationId = claimed.operation.id; expect(claimed.operation.state).toBe("processing"); expect(claimed.operation.candidate).toBeNull();
    } finally { await runtime.stop(); database.close(); }
    const currentMaster = rotated ? "startup-rotated-master" : master;
    await context.start({ CONTEXTVAULT_API_KEY: currentMaster });
    let outcome: any;
    for (let attempt = 0; attempt < 200; attempt++) {
      outcome = await json(await client.request("GET", `/v1/operations/${operationId}`, undefined, currentMaster), 200);
      if (["succeeded", "failed"].includes(outcome.state)) break; await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(outcome.state).toBe(rotated ? "failed" : "succeeded");
    if (rotated) {
      expect(outcome.error.code).toBe("CREDENTIAL_REVOKED");
      expect((await client.request("GET", `/v1/operations/${operationId}`, undefined, master)).status).toBe(401);
      const read = await open(client, workspace.id, currentMaster, "read-only");
      expect((await json(await client.request("GET", `/v1/runs/${read.id}/workspace/manifest`, undefined, currentMaster), 200)).entries).toEqual([]); expect(received).toEqual([]);
    } else {
      const read = await open(client, workspace.id, currentMaster, "read-only");
      const bytes = await client.request("GET", `/v1/runs/${read.id}/workspace/files?path=recovered.bin`, undefined, currentMaster);
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(Buffer.from([0, 255, 128]));
      for (let attempt = 0; attempt < 200 && !received.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(received).toHaveLength(1); expect(received[0].path).toBe("/own");
      const signingKey = createHash("sha256").update("startup-test-secret").digest("hex"); expect(received[0].signature).toBe(createHmac("sha256", signingKey).update(received[0].body).digest("hex"));
      expect(JSON.parse(received[0].body)).toMatchObject({ event: "run.finalized", payload: { operationId } });
    }
    await context.stop();
    const checked = getDb(configuration.databasePath);
    try {
      expect((checked.prepare("SELECT COUNT(*) AS count FROM catalog_records WHERE kind='revision' AND workspace_id=?").get(workspace.id) as any).count).toBe(rotated ? 1 : 2);
      expect((checked.prepare("SELECT COUNT(*) AS count FROM catalog_records WHERE kind='audit' AND json_extract(data,'$.operationId')=?").get(operationId) as any).count).toBe(1);
      expect((checked.prepare("SELECT COUNT(*) AS count FROM catalog_records WHERE kind='outbox' AND json_extract(data,'$.operationId')=?").get(operationId) as any).count).toBe(1);
    } finally { checked.close(); }
  } finally { await context.stop(); receiver.closeAllConnections(); await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve())); }
}, 60000);
