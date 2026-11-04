import { expect, it, vi } from "vitest";
import { finalInput, principal, scopeOf, setup } from "./helpers";

it("checks run expiry after awaited submission lookup rather than using the earlier command timestamp", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, {});
  const get = context.submissions.get.bind(context.submissions);
  vi.spyOn(context.submissions, "get").mockImplementationOnce(async (...input) => { const stored = await get(...input); context.clock.value = "2026-11-03T12:10:00.000Z"; return stored; });
  await expect(context.app.claimFinalization(finalInput(run, submission.id))).rejects.toMatchObject({ code: "RUN_EXPIRED" });
  expect((await context.control.getRun(scope, run.id))?.state).toBe("active");
});

it("checks heartbeat expiry after an awaited run read", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope);
  const get = context.control.getRun.bind(context.control);
  vi.spyOn(context.control, "getRun").mockImplementationOnce(async (...input) => { const stored = await get(...input); context.clock.value = "2026-11-03T12:10:00.000Z"; return stored; });
  await expect(context.app.heartbeat({ scope: { ...run.scope, runId: run.id }, principal, idempotencyKey: "delayed-heartbeat", request: { expectedLeaseVersion: run.lease.version } })).rejects.toMatchObject({ code: "RUN_EXPIRED" });
  expect((await get(scope, run.id))?.lease).toEqual(run.lease);
});

it("checks the processing fence after awaited authorization immediately before acceptance", async () => {
  let install = () => {};
  const context = await setup({ hook: async (stage, operation) => { if (stage === "before-accept" && operation.kind === "finalize") install(); } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "late.txt": Buffer.from("must wait for recovery") });
  const policy = context.app.runtime.dependencies.accessPolicy;
  const evaluate = policy.evaluate.bind(policy);
  install = () => { vi.spyOn(policy, "evaluate").mockImplementationOnce(async (...input) => { const decision = await evaluate(...input); context.clock.value = "2026-11-03T12:10:00.000Z"; return decision; }); };
  await expect(context.app.finalize(finalInput(run, submission.id))).rejects.toMatchObject({ code: "STALE_FENCE" });
  expect((await context.control.getWorkspace(scope))?.currentRevisionId).toBe(workspace.currentRevisionId);
  expect((await context.control.getRun(scope, run.id))?.state).toBe("finalizing");
});
