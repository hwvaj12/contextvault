import { expect, it } from "vitest";
import { create, finalize, fixture, hash, json, open, submit } from "./helpers";

it("publishes exact binary snapshots and deletions, restarts, and preserves abort isolation through normal HTTP", async () => {
  const context = await fixture(); const key = await context.key();
  const workspace = await create(context, key); expect(workspace.currentRevisionId).toBeTruthy();
  const run = await open(context, workspace.id, key); expect(run).not.toHaveProperty("path"); expect(run).not.toHaveProperty("storageBindingId");
  const first = await submit(context, run, key, { "binary.bin": Buffer.from([0, 255, 128]), "deleted.txt": Buffer.from("delete") });
  expect((await finalize(context, run, key, first.id)).state).toBe("succeeded");
  const next = await open(context, workspace.id, key);
  const second = await submit(context, next, key, { "binary.bin": Buffer.from([0, 255, 128, 13, 10]), "empty.txt": Buffer.alloc(0) });
  expect((await finalize(context, next, key, second.id)).state).toBe("succeeded");
  await context.stop(); await context.start();
  const reopened = await open(context, workspace.id, key);
  const manifest = await json(await context.request("GET", `/v1/runs/${reopened.id}/workspace/manifest`, undefined, key), 200);
  expect(manifest.entries.map((entry: any) => entry.path)).toEqual(["binary.bin", "empty.txt"]);
  const response = await context.request("GET", `/v1/runs/${reopened.id}/workspace/files?path=binary.bin`, undefined, key);
  expect(response.status).toBe(200); const bytes = Buffer.from(await response.arrayBuffer()); expect(bytes).toEqual(Buffer.from([0, 255, 128, 13, 10]));
  expect(response.headers.get("x-content-sha256")).toBe(hash(bytes));
  await json(await context.request("POST", `/v1/runs/${reopened.id}/abort`, { expectedRunVersion: reopened.version, reason: "discard local changes" }, key), 200);
  const final = await open(context, workspace.id, key, "read-only"); expect(final.baseRevisionId).toBe(reopened.baseRevisionId);
  expect((await finalize(context, final, key)).result.changed).toBe(false);
}, 60000);
