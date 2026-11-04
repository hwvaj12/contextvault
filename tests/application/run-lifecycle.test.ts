import { expect, it } from "vitest";
import { setup, scopeOf, finalInput } from "./helpers";

it("creates an accepted empty revision, publishes exact full snapshots, and reopens added, changed, and deleted bytes", async () => {
  const context = await setup();
  const created = await context.create();
  expect(created.operation.state).toBe("succeeded");
  const scope = scopeOf(created.workspace);
  expect((await context.read(scope)).manifest.entries).toEqual([]);
  const first = await context.open(scope);
  const binary = Buffer.from([0, 255, 128, 13, 10, 0]);
  const submission = await context.upload(first, { "binary.bin": binary, "delete.txt": Buffer.from("delete me"), "change.txt": Buffer.from("before") }, ["empty"]);
  const claimed = await context.app.claimFinalization(finalInput(first, submission.id));
  expect(claimed.operation.state).toBe("processing");
  expect((await context.control.getWorkspace(scope))?.currentRevisionId).toBe(first.baseRevisionId);
  const completed = await context.app.processOperation({ scope, operationId: claimed.operation.id, processingFence: claimed.operation.claim!.fence });
  expect(completed.result).toMatchObject({ kind: "finalize", runState: "finalized", changed: true });
  const second = await context.open(scope);
  const next = await context.upload(second, { "binary.bin": binary, "change.txt": Buffer.from("after"), "new.txt": Buffer.from("added") });
  expect((await context.app.finalize(finalInput(second, next.id))).state).toBe("succeeded");
  await context.reopen();
  expect((await context.read(scope)).files).toEqual({ "binary.bin": binary, "change.txt": Buffer.from("after"), "new.txt": Buffer.from("added") });
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(3);
});

it("completes no-change and read-only runs without duplicate history while stale read-write bases conflict", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const unchanged = await context.open(scope); const empty = await context.upload(unchanged, {});
  expect((await context.app.finalize(finalInput(unchanged, empty.id))).result).toMatchObject({ changed: false, revisionId: workspace.currentRevisionId });
  const stale = await context.open(scope); const staleSubmission = await context.upload(stale, {});
  const reader = await context.open(scope, "read-only");
  const writer = await context.open(scope); const changed = await context.upload(writer, { "content.txt": Buffer.from("new") });
  await context.app.finalize(finalInput(writer, changed.id));
  expect((await context.app.finalize(finalInput(stale, staleSubmission.id))).result).toMatchObject({ runState: "conflicted", changed: false });
  expect((await context.app.finalize(finalInput(reader))).result).toMatchObject({ changed: false, revisionId: workspace.currentRevisionId });
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
});

it("keeps abort and expired runs unpublished and rejects stale lease renewal", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const aborted = await context.open(scope); const submission = await context.upload(aborted, { "unpublished.txt": Buffer.from("no") });
  const result = await context.app.abort({ scope: { ...aborted.scope, runId: aborted.id }, principal: aborted.principal, idempotencyKey: "abort", request: { expectedRunVersion: aborted.version, reason: "cancelled" } });
  expect(result.value.state).toBe("aborted");
  expect((await context.app.abort({ scope: { ...aborted.scope, runId: aborted.id }, principal: aborted.principal, idempotencyKey: "abort", request: { expectedRunVersion: aborted.version, reason: "cancelled" } })).value).toEqual(result.value);
  await expect(context.app.finalize(finalInput(aborted, submission.id))).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  const expired = await context.open(scope); context.clock.value = "2026-11-03T12:10:00.000Z";
  await expect(context.app.heartbeat({ scope: { ...expired.scope, runId: expired.id }, principal: expired.principal, idempotencyKey: "late-heartbeat", request: { expectedLeaseVersion: expired.lease.version } })).rejects.toMatchObject({ code: "RUN_EXPIRED" });
  const targets = await context.control.listExpiredActiveRuns({ now: context.clock.value, limit: 10 });
  expect((await context.app.expireActiveRun(targets.runs[0])).run.state).toBe("expired");
  expect((await context.read(scope)).manifest.entries).toEqual([]);
  expect((await context.control.getRun(scope, aborted.id))?.state).toBe("aborted");
});

it("renews and replays the client lease without advancing the run lifecycle version", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); context.clock.value = "2026-11-03T12:01:00.000Z";
  const input = { scope: { ...run.scope, runId: run.id }, principal: run.principal, idempotencyKey: "heartbeat-once", request: { expectedLeaseVersion: run.lease.version } };
  const renewed = await context.app.heartbeat(input);
  expect(renewed.value.lease.version).toBe(2); expect(renewed.value.version).toBe(run.version);
  expect(renewed.value.lease.expiresAt).toBe("2026-11-03T12:06:00.000Z");
  expect((await context.app.heartbeat(input)).value).toEqual(renewed.value);
});
