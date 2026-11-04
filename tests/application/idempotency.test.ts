import { expect, it, vi } from "vitest";
import { finalInput, principal, scopeOf, setup } from "./helpers";

function barrier() {
  let release!: () => void; let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  let preparations = 0;
  return { ready, release, count: () => preparations, async afterPrepare() { preparations++; if (preparations === 1) { reached(); await held; } } };
}
function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> { return promise.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })); }
const retries = ["same instance", "separate connection with same owner", "separate connection with different owner"] as const;

async function expectSinglePublicationEvents(context: Awaited<ReturnType<typeof setup>>, scope: ReturnType<typeof scopeOf>) {
  const events = (await context.control.listAudit(scope)).events;
  expect(events.map(event => event.type).sort()).toEqual(["run.finalized", "run.started", "workspace.created"]);
  expect(new Set(events.map(event => event.id)).size).toBe(3);
  const outbox = await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 });
  expect(outbox.map(event => event.type).sort()).toEqual(["run.finalized", "run.started", "workspace.created"]);
  expect(new Set(outbox.map(event => event.id)).size).toBe(3);
  expect(new Set(outbox.map(event => event.operationId))).toEqual(new Set(events.map(event => event.operationId)));
}

it.each(retries)("returns one pending creation identity for a concurrent retry through %s", async mode => {
  const gate = barrier();
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "workspace:create") await gate.afterPrepare(); } });
  const input = { principal, idempotencyKey: "concurrent-creation", request: { customerId: "tenant-a", name: "Concurrent creation" } };
  const owner = settle(context.app.createWorkspace(input));
  await Promise.race([gate.ready, owner.then(result => { throw new Error(`Creation stopped before its real preparation barrier: ${result.status}`); })]);
  const peer = mode === "same instance" ? context.app : context.peer(mode === "separate connection with same owner" ? "lifecycle-test-worker" : "other-worker");
  if (peer !== context.app) expect(peer.runtime.control).not.toBe(context.control);
  const storage = vi.spyOn(peer.runtime.dependencies, "revisionStore");
  let retry!: PromiseSettledResult<Awaited<ReturnType<typeof peer.createWorkspace>>>;
  let complete!: Awaited<typeof owner>;
  let visibleBeforeRelease: unknown;
  try {
    retry = await settle(peer.createWorkspace(input));
    if (retry.status === "fulfilled") {
      visibleBeforeRelease = await context.control.getWorkspace(retry.value.operation.scope);
      if (mode === "separate connection with different owner") await expect(peer.processOperation({ scope: retry.value.operation.scope, operationId: retry.value.operation.id, processingFence: retry.value.operation.claim!.fence })).rejects.toMatchObject({ code: "STALE_FENCE" });
    }
  } finally { gate.release(); complete = await owner; }
  expect(retry.status).toBe("fulfilled");
  if (retry.status !== "fulfilled") throw retry.reason;
  expect(retry.value.operation.state).toBe("processing");
  expect(retry.value.status).toBe("pending");
  expect(retry.value.workspace).toBeNull();
  expect(visibleBeforeRelease).toBeNull(); expect(storage).not.toHaveBeenCalled(); expect(gate.count()).toBe(1);
  expect(complete.status).toBe("fulfilled");
  if (complete.status !== "fulfilled") throw complete.reason;
  expect(complete.value.operation.id).toBe(retry.value.operation.id);
  expect(complete.value.operation.state).toBe("succeeded");
  expect(complete.value.status).toBe("accepted");
  const scope = complete.value.operation.scope;
  const replay = await peer.createWorkspace(input);
  expect(replay.operation.id).toBe(complete.value.operation.id); expect(replay.workspace).toEqual(complete.value.workspace);
  expect((await context.control.listWorkspaces({ customerId: scope.customerId })).workspaces).toHaveLength(1);
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(1);
  expect((await context.control.listAudit(scope)).events).toHaveLength(1);
  expect(await context.control.listPendingOutbox({ now: context.clock.value, limit: 10 })).toHaveLength(1);
});

it.each(retries)("returns one pending finalization identity for a concurrent retry through %s", async mode => {
  const gate = barrier();
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "finalize") await gate.afterPrepare(); } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const payload = Buffer.from([0, 255, 128]);
  const submission = await context.upload(run, { "once.bin": payload });
  const input = finalInput(run, submission.id, "concurrent-finalization");
  const owner = settle(context.app.finalize(input));
  await Promise.race([gate.ready, owner.then(result => { throw new Error(`Finalization stopped before its real preparation barrier: ${result.status}`); })]);
  const peer = mode === "same instance" ? context.app : context.peer(mode === "separate connection with same owner" ? "lifecycle-test-worker" : "other-worker");
  if (peer !== context.app) expect(peer.runtime.control).not.toBe(context.control);
  const storage = vi.spyOn(peer.runtime.dependencies, "revisionStore");
  let retry!: PromiseSettledResult<Awaited<ReturnType<typeof peer.finalize>>>;
  let complete!: Awaited<typeof owner>;
  let headBeforeRelease: string | undefined;
  try {
    retry = await settle(peer.finalize(input));
    headBeforeRelease = (await context.control.getWorkspace(scope))?.currentRevisionId;
    if (mode === "separate connection with different owner" && retry.status === "fulfilled") await expect(peer.processOperation({ scope, operationId: retry.value.id, processingFence: retry.value.claim!.fence })).rejects.toMatchObject({ code: "STALE_FENCE" });
  } finally { gate.release(); complete = await owner; }
  expect(retry.status).toBe("fulfilled");
  if (retry.status !== "fulfilled") throw retry.reason;
  expect(retry.value.state).toBe("processing"); expect(headBeforeRelease).toBe(run.baseRevisionId);
  expect(storage).not.toHaveBeenCalled(); expect(gate.count()).toBe(1);
  expect(complete.status).toBe("fulfilled");
  if (complete.status !== "fulfilled") throw complete.reason;
  expect(complete.value.id).toBe(retry.value.id); expect(complete.value.state).toBe("succeeded");
  expect(await peer.finalize(input)).toEqual(complete.value);
  expect((await context.read(scope)).files["once.bin"]).toEqual(payload);
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
  await expectSinglePublicationEvents(context, scope);
});

it("replays create, open, and finalize after reopening and rejects changed input under the same key", async () => {
  const context = await setup(); const created = await context.create("create-once"); const scope = scopeOf(created.workspace);
  expect((await context.create("create-once")).workspace).toEqual(created.workspace);
  const run = await context.open(scope, "read-write", "open-once");
  expect(await context.open(scope, "read-write", "open-once")).toEqual(run);
  await expect(context.app.openRun({ scope, principal, idempotencyKey: "open-once", request: { mode: "read-write", agentLabel: "existing-agent", task: "changed task", reason: "test reason" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  const submission = await context.upload(run, { "once.bin": Buffer.from([0, 255]) });
  const input = finalInput(run, submission.id, "finalize-once");
  const operation = await context.app.finalize(input);
  await context.reopen();
  expect(await context.app.finalize(input)).toEqual(operation);
  expect((await context.create("create-once")).workspace).toEqual(created.workspace);
  await expect(context.app.claimWorkspaceCreation({ principal, idempotencyKey: "create-once", request: { customerId: "tenant-a", name: "different" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  await expect(context.app.claimFinalization({ ...input, request: { ...input.request, expectedRunVersion: 2 } })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
  await expectSinglePublicationEvents(context, scope);
});

it("reconciles a lost acceptance response without replacing the committed result or duplicating events", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "accepted.bin": Buffer.from([0, 255, 128]) });
  const accept = context.control.acceptRevision.bind(context.control);
  vi.spyOn(context.control, "acceptRevision").mockImplementationOnce(async input => { await accept(input); throw new Error("response lost after real acceptance commit"); });
  const input = finalInput(run, submission.id);
  const result = await context.app.finalize(input);
  expect(result.state).toBe("succeeded");
  expect(await context.app.finalize(input)).toEqual(result);
  expect((await context.control.getRun(scope, run.id))?.state).toBe("finalized");
  await expectSinglePublicationEvents(context, scope);
  expect((await context.read(scope)).files["accepted.bin"]).toEqual(Buffer.from([0, 255, 128]));
});

it("retains unknown publication when acceptance commits but reconciliation is unavailable", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "accepted.txt": Buffer.from("accepted") });
  const accept = context.control.acceptRevision.bind(context.control);
  const read = context.control.getOperation.bind(context.control);
  let committed = false;
  vi.spyOn(context.control, "acceptRevision").mockImplementationOnce(async input => { await accept(input); committed = true; throw new Error("response lost after commit"); });
  const lookup = vi.spyOn(context.control, "getOperation").mockImplementation(async (...input) => { if (committed) throw new Error("catalog temporarily unavailable"); return read(...input); });
  const input = finalInput(run, submission.id);
  await expect(context.app.finalize(input)).rejects.toMatchObject({ code: "PUBLICATION_OUTCOME_UNKNOWN", details: { retryable: true } });
  lookup.mockRestore();
  expect((await context.control.getRun(scope, run.id))?.state).toBe("finalized");
  expect((await context.app.finalize(input)).state).toBe("succeeded");
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
});

it("recovers durable creation and finalization identities after storage interruption and client expiry", async () => {
  let interruptedCreation = false; let interruptedFinalize = false;
  const context = await setup({ hook: async (stage, operation) => {
    if (stage !== "after-record-prepared") return;
    if (operation.kind === "workspace:create" && !interruptedCreation) { interruptedCreation = true; throw new Error("creation worker interrupted"); }
    if (operation.kind === "finalize" && !interruptedFinalize) { interruptedFinalize = true; throw new Error("finalizer interrupted"); }
  } });
  const creation = await context.app.claimWorkspaceCreation({ principal, idempotencyKey: "recover-create", request: { customerId: "tenant-a", name: "recover" } });
  await expect(context.app.processOperation({ scope: creation.operation.scope, operationId: creation.operation.id, processingFence: 1 })).rejects.toMatchObject({ code: "PUBLICATION_OUTCOME_UNKNOWN" });
  expect(await context.control.getWorkspace(creation.operation.scope)).toBeNull();
  const preparedCreation = await context.control.getOperation(creation.operation.scope, creation.operation.id);
  context.clock.value = "2026-11-03T12:10:00.000Z";
  const recoveredCreation = await context.control.claimRecovery({ scope: creation.operation.scope, operationId: creation.operation.id, expectedVersion: preparedCreation!.version, ownerId: "lifecycle-test-worker", now: context.clock.value, expiresAt: "2026-11-03T12:20:00.000Z" });
  expect((await context.app.processOperation({ scope: recoveredCreation.scope, operationId: recoveredCreation.id, processingFence: recoveredCreation.claim!.fence })).state).toBe("succeeded");
  const scope = recoveredCreation.scope; const workspace = (await context.control.getWorkspace(scope))!;
  const run = await context.open(scope); const submission = await context.upload(run, { "recovered.bin": Buffer.from([0, 255]) });
  const claimed = await context.app.claimFinalization(finalInput(run, submission.id));
  await expect(context.app.processOperation({ scope, operationId: claimed.operation.id, processingFence: 1 })).rejects.toMatchObject({ code: "PUBLICATION_OUTCOME_UNKNOWN" });
  const prepared = await context.control.getOperation(scope, claimed.operation.id);
  expect(prepared?.candidate?.candidateId).toBe(claimed.operation.intent.candidateIdentity!.candidateId);
  context.clock.value = "2026-11-03T13:10:00.000Z";
  await context.reopen();
  await expect(context.submissions.expire({ ...run.scope, runId: run.id }, submission.id, submission.version, context.clock.value)).rejects.toMatchObject({ code: "FINALIZATION_IN_PROGRESS" });
  const recovered = await context.control.claimRecovery({ scope, operationId: prepared!.id, expectedVersion: prepared!.version, ownerId: "lifecycle-test-worker", now: context.clock.value, expiresAt: "2026-11-03T13:20:00.000Z" });
  await expect(context.app.processOperation({ scope, operationId: recovered.id, processingFence: 1 })).rejects.toMatchObject({ code: "STALE_FENCE" });
  const complete = await context.app.processOperation({ scope, operationId: recovered.id, processingFence: recovered.claim!.fence });
  expect(complete.state).toBe("succeeded");
  expect(complete.candidate).toEqual(prepared!.candidate);
  expect((await context.control.getWorkspace(scope))?.currentRevisionId).not.toBe(workspace.currentRevisionId);
  expect((await context.read(scope)).files["recovered.bin"]).toEqual(Buffer.from([0, 255]));
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(2);
});
