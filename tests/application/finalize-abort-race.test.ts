import { expect, it, vi } from "vitest";
import { finalInput, now, principal, scopeOf, setup } from "./helpers";

it("admits exactly one abort or finalize claim and prevents the loser from publishing", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "winner.txt": Buffer.from("winner") });
  const results = await Promise.allSettled([
    context.app.claimFinalization(finalInput(run, submission.id)),
    context.app.abort({ scope: { ...run.scope, runId: run.id }, principal, idempotencyKey: "racing-abort", request: { expectedRunVersion: run.version, reason: "cancelled" } }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const stored = await context.control.getRun(scope, run.id);
  if (stored!.state === "finalizing") {
    const claimed = results[0]; expect(claimed.status).toBe("fulfilled");
    if (claimed.status !== "fulfilled") throw claimed.reason;
    expect((await context.app.processOperation({ scope, operationId: claimed.value.operation.id, processingFence: claimed.value.operation.claim!.fence })).state).toBe("succeeded");
    expect((await context.read(scope)).files["winner.txt"]).toEqual(Buffer.from("winner"));
  } else {
    expect(stored!.state).toBe("aborted");
    expect((await context.read(scope)).manifest.entries).toEqual([]);
  }
});

it("allows one competing head publication and records the held stale writer as conflicted", async () => {
  let target: string; let release!: () => void; let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const context = await setup({ hook: async (stage, operation) => { if (stage === "before-accept" && operation.id === target) { reached(); await held; } } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const first = await context.open(scope); const second = await context.open(scope);
  const a = await context.upload(first, { "winner.txt": Buffer.from("first") });
  const b = await context.upload(second, { "winner.txt": Buffer.from("second") });
  const claimed = await context.app.claimFinalization(finalInput(first, a.id)); target = claimed.operation.id;
  const pending = context.app.processOperation({ scope, operationId: claimed.operation.id, processingFence: 1 });
  try {
    await ready;
    expect((await context.app.finalize(finalInput(second, b.id))).state).toBe("succeeded");
  } finally { release(); }
  expect((await pending).result).toMatchObject({ kind: "finalize", runState: "conflicted" });
  expect((await context.read(scope)).files["winner.txt"]).toEqual(Buffer.from("second"));
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
});

it("renews the processing claim during slow preparation without changing the client lease", async () => {
  const started = Date.now();
  const context = await setup({ processingTtlMs: 180, processingRenewIntervalMs: 30, now: () => new Date(Date.parse(now) + Date.now() - started).toISOString(), hook: async (stage, operation) => { if (stage === "before-prepare" && operation.kind === "finalize") await new Promise(resolve => setTimeout(resolve, 250)); } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "slow.txt": Buffer.from("retained") });
  const renew = vi.spyOn(context.control, "renewProcessingClaim");
  const claimed = await context.app.claimFinalization(finalInput(run, submission.id));
  const operation = await context.app.processOperation({ scope, operationId: claimed.operation.id, processingFence: claimed.operation.claim!.fence });
  expect(operation.state).toBe("succeeded"); expect(renew.mock.calls.length).toBeGreaterThan(1);
  expect(operation.claim!.expiresAt > claimed.operation.claim!.expiresAt).toBe(true);
  expect((await context.control.getRun(scope, run.id))?.lease).toEqual(run.lease);
});
