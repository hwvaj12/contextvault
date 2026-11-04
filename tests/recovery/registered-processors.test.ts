import { expect, it } from "vitest";
import type { Operation } from "../../src/domain";
import { WorkspaceMaintenance } from "../../src/application/maintenance";
import { scopeOf, setup } from "./helpers";

it("dispatches explicitly registered recovery kinds and retains work owned by unregistered use cases", async () => {
  const context = await setup(); const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const accepted = (await context.control.listAudit(scope)).events[0];
  const original = (await context.control.getOperation(scope, accepted.operationId))!;
  // Owning use cases will persist these intents. This fixture tests only typed maintenance dispatch and catalog fencing.
  for (const [id, kind] of [["000-unowned-migration", "storage:migrate"], ["001-owned-restore", "restore"]] as const) {
    const operation: Operation = { ...original, id: id as never, kind, command: { ...original.command, operationId: id, idempotencyScope: { ...original.command.idempotencyScope, kind } }, state: "processing", phase: "claimed", version: 1, claim: { ownerId: "interrupted-owner", fence: 1, expiresAt: "2026-11-03T11:59:00.000Z" }, candidate: null, intent: { kind: "command", candidateIdentity: null }, result: null, error: null } as unknown as Operation;
    context.control.database.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES('operation',?,?,?,?,?)").run(operation.id, scope.customerId, scope.workspaceId, null, JSON.stringify(operation));
  }
  const before = (await context.control.getOperation(scope, "001-owned-restore" as never))!;
  const maintenance = new WorkspaceMaintenance({ lifecycle: context.app, now: () => context.clock.value, batchSize: 1 });
  await maintenance.runOnce();
  expect(await context.control.getOperation(scope, before.id)).toEqual(before);
  const received: Operation[] = [];
  const registered = new WorkspaceMaintenance({ lifecycle: context.peer("restore-recovery-owner"), now: () => context.clock.value, batchSize: 1, recoveryProcessors: { restore: async operation => { received.push(operation); return operation; } } });
  await registered.runOnce();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ id: before.id, kind: "restore", state: "processing", claim: { ownerId: "restore-recovery-owner", fence: 2 } });
  expect((await context.control.getOperation(scope, "000-unowned-migration" as never))!.claim!.fence).toBe(1);
  await expect(context.control.claimRecovery({ scope, operationId: before.id, expectedVersion: received[0].version, ownerId: "wrong-kind", now: "2026-11-03T13:00:00.000Z", expiresAt: "2026-11-03T14:00:00.000Z", kind: "finalize" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
});
