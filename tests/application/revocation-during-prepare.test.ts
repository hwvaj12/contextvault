import { expect, it } from "vitest";
import { finalInput, principal, scopeOf, setup } from "./helpers";

it("rechecks current catalog authority after real preparation and prevents revoked publication", async () => {
  let revoke = async () => {};
  const context = await setup({ hook: async (stage, operation) => { if (stage === "after-prepare" && operation.kind === "finalize") await revoke(); } });
  const { workspace } = await context.create(); const scope = scopeOf(workspace);
  const run = await context.open(scope); const submission = await context.upload(run, { "revoked.txt": Buffer.from("never accepted") });
  revoke = async () => {
    const customer = { customerId: scope.customerId }; const current = (await context.control.getAuthority(customer, principal))!;
    const decision = await context.app.runtime.dependencies.accessPolicy.evaluate(principal, "credential:manage", customer);
    if (!decision.allowed) throw new Error(decision.message);
    await context.control.updateAuthority({ scope: customer, principal, authorization: decision.precondition, authority: { ...current, credentialVersion: 2, permissionEpoch: 2, revokedAt: context.clock.value }, expectedCredentialVersion: 1, expectedPermissionEpoch: 1 });
  };
  const operation = await context.app.finalize(finalInput(run, submission.id));
  expect(operation.state).toBe("failed"); expect(operation.error?.code).toBe("CREDENTIAL_REVOKED");
  expect((await context.control.getRun(scope, run.id))?.state).toBe("failed");
  expect((await context.control.getWorkspace(scope))?.currentRevisionId).toBe(workspace.currentRevisionId);
  expect((await context.control.listRevisions(scope)).revisions).toHaveLength(1);
  expect(operation.candidate).not.toBeNull();
  expect((await context.control.getCleanup(scope, run.cleanupId))?.state).toBe("pending");
});
