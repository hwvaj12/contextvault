import { expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import Database from "better-sqlite3";
import { join } from "node:path";
import { create, fixture, hash, json, open } from "./helpers";

it("streams chunked binary files and rejects digest, path, and quota violations", async () => {
  const context = await fixture({ CV_WORKSPACE_LIMITS: JSON.stringify({ maxFileBytes: 3 * 1024 * 1024 }) }); const key = await context.key();
  const workspace = await create(context, key); const run = await open(context, workspace.id, key);
  const submission = await json(await context.request("POST", `/v1/runs/${run.id}/submissions`, {}, key), 201);
  const route = `/v1/runs/${run.id}/submissions/${submission.id}/files?path=chunked.bin`; const bytes = Buffer.alloc(2 * 1024 * 1024, 255); bytes[0] = 0;
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(context.baseUrl + route, { method: "PUT", headers: { "X-API-Key": key, "Idempotency-Key": randomUUID(), "Content-Type": "application/octet-stream", "X-Content-SHA256": hash(bytes) } }, response => {
      let body = ""; response.on("data", data => { body += data; }); response.once("end", () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
    });
    request.once("error", reject);
    void (async () => { for (let offset = 0; offset < bytes.length; offset += 32768) if (!request.write(bytes.subarray(offset, offset + 32768))) await once(request, "drain"); request.end(); })().catch(reject);
  });
  const received = await response; expect(received.status).toBe(201); expect(received.body.byteLength).toBe(bytes.length); expect(received.body.sha256).toBe(hash(bytes));
  const wrong = await context.request("PUT", route, Buffer.from([1]), key, { "X-Content-SHA256": "0".repeat(64) }); expect(wrong.status).toBe(422);
  for (const path of ["../escape", ".git/config", ".contextvault/token", "NUL"]) expect((await context.request("PUT", route.replace("chunked.bin", encodeURIComponent(path)), Buffer.from([1]), key)).status).toBe(422);
  const large = await context.request("PUT", route, Buffer.alloc(3 * 1024 * 1024 + 1), key); expect(large.status).toBe(413);
});

it("cancels a real interrupted upload, records no receipt, and releases the stream permit", async () => {
  const context = await fixture({ CV_WORKSPACE_LIMITS: JSON.stringify({ maxConcurrentStreams: 1 }) }); const key = await context.key();
  const workspace = await create(context, key); const run = await open(context, workspace.id, key);
  const submission = await json(await context.request("POST", `/v1/runs/${run.id}/submissions`, {}, key), 201);
  const route = `/v1/runs/${run.id}/submissions/${submission.id}/files?path=interrupted.bin`;
  const request = httpRequest(context.baseUrl + route, { method: "PUT", headers: { "X-API-Key": key, "Idempotency-Key": randomUUID(), "Content-Type": "application/octet-stream", "X-Content-SHA256": hash(Buffer.from([0, 1, 2])) } });
  request.on("error", () => {}); request.write(Buffer.from([0]));
  const database = new Database(join(context.directory, "data", "contextvault.db"), { readonly: true });
  const writers = () => (database.prepare("SELECT data FROM catalog_records WHERE kind='submission-writer' AND run_id=?").all(run.id) as { data: string }[]).map(row => JSON.parse(row.data));
  try {
    for (let attempt = 0; attempt < 200 && !writers().length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(writers()).toHaveLength(1); expect(writers()[0].state).toBe("active"); request.destroy();
    for (let attempt = 0; attempt < 200 && writers()[0].state !== "finished"; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    // An interrupted S3 mutation can remain physically uncertain. Local writer completion is observable directly.
    if (process.env.CV_TEST_BACKEND !== "s3") expect(writers()[0].state).toBe("finished");
    else expect(["active", "finished"]).toContain(writers()[0].state);
    expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_records WHERE kind='receipt' AND run_id=?").get(run.id)).toEqual({ count: 0 });
    expect((await context.request("PUT", route.replace("interrupted.bin", "complete.bin"), Buffer.from([0, 1, 2]), key)).status).toBe(201);
    expect((await json(await context.request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, key), 200)).entries).toEqual([]);
    await json(await context.request("POST", `/v1/runs/${run.id}/abort`, { expectedRunVersion: run.version, reason: "interrupted upload" }, key), 200);
    if (writers()[0].state === "active") {
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect((await json(await context.request("GET", `/v1/runs/${run.id}`, undefined, key), 200)).cleanup.state).not.toBe("complete");
    }
  } finally { request.destroy(); database.close(); }
});
