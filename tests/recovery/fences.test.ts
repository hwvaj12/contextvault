import { expect, it, vi } from "vitest";
import { WorkspaceError } from "../../src/domain";
import { finalInput, scopeOf, setup } from "./helpers";
import { createRevisionWriterTracking } from "../../src/adapters/control/revision-writers";
import type { RevisionWriterTracking } from "../../src/ports/revision-store";
import type { CandidateIdentity } from "../../src/domain";

it("denies collection when a standalone adapter has only a permissive collection callback", async () => {
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "finalize") throw new WorkspaceError("RECEIPT_MISMATCH", "terminal ownership fixture"); } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const submission = await context.upload(run, { "orphan.bin": Buffer.from([0, 255]) });
  const operation = await context.app.finalize(finalInput(run, submission.id));
  if (operation.kind !== "finalize" || !operation.intent.candidateIdentity) throw new Error("Expected mutable candidate");
  const identity = operation.intent.candidateIdentity;
  const permit = await context.control.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  await expect(context.untrackedStorage().deleteCollectible(permit, context.clock.value)).rejects.toMatchObject({ code: "STALE_FENCE" });
  expect(await context.store.inspectCandidate(identity)).not.toBeNull();
  expect((await context.read(scope)).manifest.entries).toEqual([]);
});

it("preserves prototype tracker methods and their receiver during preparation and collection", async () => {
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "finalize") throw new WorkspaceError("RECEIPT_MISMATCH", "class tracker orphan"); } });
  class Tracker implements RevisionWriterTracking {
    started = 0; finished = 0; checked = 0;
    constructor(private readonly delegate: RevisionWriterTracking) {}
    begin(identity: CandidateIdentity, writerId: string) { this.started++; return this.delegate.begin(identity, writerId); }
    finish(identity: CandidateIdentity, writerId: string) { this.finished++; return this.delegate.finish(identity, writerId); }
    stopped(identity: CandidateIdentity) { this.checked++; return this.delegate.stopped(identity); }
  }
  const tracker = new Tracker(createRevisionWriterTracking(context.control, "lifecycle-test-worker", () => context.clock.value));
  const adapter = context.trackedStorage(tracker);
  context.app.runtime.dependencies.revisionStore = async () => adapter;
  const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const submission = await context.upload(run, { "class.bin": Buffer.from([0, 255]) });
  const operation = await context.app.finalize(finalInput(run, submission.id));
  expect(operation.state).toBe("failed");
  if (operation.kind !== "finalize" || !operation.intent.candidateIdentity) throw new Error("Expected orphan identity");
  const identity = operation.intent.candidateIdentity;
  const permit = await context.control.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
  await adapter.deleteCollectible(permit, context.clock.value);
  expect(tracker.started).toBe(2); expect(tracker.finished).toBe(2); expect(tracker.checked).toBeGreaterThan(0);
  expect(await adapter.inspectCandidate(identity)).toBeNull();
});

it("retains a stale candidate writer until its physical work stops and prevents terminal resurrection", async () => {
  const context = await setup({ processingRenewIntervalMs: 0 });
  const { workspace } = await context.create(); const scope = scopeOf(workspace); const run = await context.open(scope);
  const submission = await context.upload(run, { "held.bin": Buffer.from([0, 255, 128]) });
  const original = context.submissions.openSealedFile.bind(context.submissions);
  let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(context.submissions, "openSealedFile").mockImplementationOnce(async (...args) => {
    const stream = await original(...args);
    return (async function* () { for await (const bytes of stream) { yield bytes; started(); await held; } })();
  });
  const pending = context.app.finalize(finalInput(run, submission.id)); void pending.catch(() => {});
  await Promise.race([ready, pending.then(() => { throw new Error("Preparation must reach held source bytes"); })]);
  try {
    const old = (await context.control.getOperation(scope, (await context.control.getRun(scope, run.id))!.operationId!))!;
    if (old.kind !== "finalize" || !old.intent.candidateIdentity) throw new Error("Expected mutable finalization");
    const identity = old.intent.candidateIdentity;
    context.clock.value = "2026-11-03T12:10:00.000Z";
    const recovered = await context.control.claimRecovery({ scope, operationId: old.id, expectedVersion: old.version, ownerId: "replacement-worker", now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
    const failed = await context.control.failFinalization({ scope, operationId: recovered.id, expectedOperationVersion: recovered.version, processingFence: recovered.claim!.fence, now: context.clock.value, code: "RECEIPT_MISMATCH", message: "replacement rejects source", events: context.app.runtime.events(recovered, "run.failed") });
    expect(failed.state).toBe("failed");
    await expect(context.control.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    release();
    expect((await pending).state).toBe("failed");
    const permit = await context.control.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now: context.clock.value, expiresAt: "2026-11-03T12:11:00.000Z" });
    context.clock.value = "2026-11-03T12:12:00.000Z";
    const newer = await context.control.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now: context.clock.value, expiresAt: "2026-11-03T13:00:00.000Z" });
    expect(newer.collectionFence).toBeGreaterThan(permit.collectionFence);
    await expect(context.store.deleteCollectible(permit, context.clock.value)).rejects.toMatchObject({ code: "STALE_FENCE" });
    await context.store.deleteCollectible(newer, context.clock.value);
    expect(await context.store.inspectCandidate(identity)).toBeNull();
    await expect(context.store.prepare({ identity, source: (await import("./helpers")).source({ "late.bin": Buffer.from("stale") }) })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await context.control.listRevisions(scope)).revisions).toHaveLength(1);
    expect((await context.control.listAudit(scope)).events.filter(event => event.operationId === old.id)).toHaveLength(1);
  } finally { release(); await pending.catch(() => {}); vi.restoreAllMocks(); }
});
