import { expect, it, vi } from "vitest";
import { finalInput, scopeOf, setup } from "./helpers";
import { WorkspaceMaintenance } from "../../src/application/maintenance";

it.each(["before-prepare", "after-prepare", "after-record-prepared"] as const)("recovers interrupted %s finalization after reopening with one accepted revision and event", async boundary => {
  let interrupted = false;
  const context = await setup({ hook: async (stage, operation) => { if (operation.kind === "finalize" && stage === boundary && !interrupted) { interrupted = true; throw new Error("worker interrupted"); } } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope);
  const payload = Buffer.from([0, 255, 128, 13, 10]);
  const submission = await context.upload(run, { "recovered.bin": payload });
  const command = finalInput(run, submission.id);
  await expect(context.app.finalize(command)).rejects.toMatchObject({ code: "PUBLICATION_OUTCOME_UNKNOWN" });
  const pending = (await context.control.getRun(scope, run.id))!;
  const operation = (await context.control.getOperation(scope, pending.operationId!))!;
  context.clock.value = "2026-11-03T13:10:00.000Z";
  await context.reopen();
  const lifecycle = context.peer("recovery-worker");
  const maintenance = new WorkspaceMaintenance({ lifecycle, now: () => context.clock.value });
  await maintenance.runOnce();
  const accepted = (await context.control.getOperation(scope, operation.id))!;
  expect(accepted.state).toBe("succeeded");
  expect(accepted.claim!.fence).toBeGreaterThan(operation.claim!.fence);
  expect(accepted.intent.candidateIdentity).toEqual(operation.intent.candidateIdentity);
  expect((await context.read(scope)).files["recovered.bin"]).toEqual(payload);
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
  expect((await context.control.listAudit(scope)).events.filter(event => event.operationId === accepted.id)).toHaveLength(1);
  await maintenance.runOnce();
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
  await expect(context.app.processOperation({ scope, operationId: accepted.id, processingFence: operation.claim!.fence })).resolves.toMatchObject({ state: "succeeded" });
});

it("reconciles an accepted publication after its response is lost and keeps one event after restart", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const payload = Buffer.from([0, 255, 128]); const submission = await context.upload(run, { "accepted-response.bin": payload });
  const accept = context.control.acceptRevision.bind(context.control);
  vi.spyOn(context.control, "acceptRevision").mockImplementationOnce(async input => { await accept(input); throw new Error("accepted response lost"); });
  const operation = await context.app.finalize(finalInput(run, submission.id));
  expect(operation.state).toBe("succeeded");
  await context.reopen();
  await new WorkspaceMaintenance({ lifecycle: context.peer("accepted-recovery"), now: () => context.clock.value }).runOnce();
  expect((await context.control.getOperation(scope, operation.id))?.state).toBe("succeeded");
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
  expect((await context.control.listAudit(scope)).events.filter(event => event.operationId === operation.id)).toHaveLength(1);
  expect((await context.read(scope)).files["accepted-response.bin"]).toEqual(payload);
});

it("recovers an unaccepted creation draft and expires active client leases independently", async () => {
  let interrupted = false;
  const context = await setup({ hook: async stage => { if (stage === "after-prepare" && !interrupted) { interrupted = true; throw new Error("creator interrupted"); } } });
  const input = { principal: (await import("../control/helpers")).principal, idempotencyKey: "recover-draft", request: { customerId: "tenant-a", name: "draft" } };
  await expect(context.app.createWorkspace(input)).rejects.toMatchObject({ code: "PUBLICATION_OUTCOME_UNKNOWN" });
  expect((await context.control.listWorkspaces({ customerId: "tenant-a" as never })).workspaces).toHaveLength(0);
  context.clock.value = "2026-11-03T12:10:00.000Z";
  await context.reopen();
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.peer("creation-recovery"), now: () => context.clock.value });
  await maintenance.runOnce();
  const created = await context.app.createWorkspace(input);
  expect(created.status).toBe("accepted");
  if (created.status !== "accepted") throw new Error("Creation must be accepted");
  const scope = scopeOf(created.workspace);
  const run = await context.open(scope);
  context.clock.value = "2026-11-03T12:20:00.000Z";
  await maintenance.runOnce();
  expect((await context.control.getRun(scope, run.id))?.state).toBe("expired");
  expect((await context.read(scope)).manifest.entries).toEqual([]);
});
