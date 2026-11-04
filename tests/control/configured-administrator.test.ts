import { afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import * as identities from "../../src/middleware/catalog-identity";
import { SqliteControlStore, bootstrapAuthority } from "../../src/adapters/control/sqlite-control-store";
import { CatalogAccessPolicy } from "../../src/adapters/access/catalog-access-policy";
import { createTestDb } from "../../src/db";
import { canonicalRequestDigest } from "../../src/domain";
import { fixture, scope, principal, authority, now, later, command, events } from "./helpers";
const opened: Database.Database[] = [], directories: string[] = [];
afterEach(() => { for (const db of opened.splice(0))
    if (db.open)
        db.close(); for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true }); });
const rotatedAt = "2026-11-03T14:00:00.000Z";
const newLease = "2026-11-03T15:00:00.000Z";
type Synchronizer = (database: Database.Database, configuredMasterKey: string | null, now: string) => {
    fingerprint: string | null;
    epoch: number;
    synchronizedAt: string;
};
const startup: Synchronizer = identities.synchronizeConfiguredAdministrator;
function scopedCommand(actor: any, kind: string, runId: string | null = null, payload: unknown = {}) {
    const value = command(kind, {}, runId);
    value.idempotencyScope.actorId = actor.actorId;
    value.requestDigest = canonicalRequestDigest({ schemaVersion: 1, customerId: scope.customerId, actorId: actor.actorId, credentialId: actor.credential.id, kind, resource: { workspaceId: scope.workspaceId, ...(runId ? { runId } : {}) }, payload });
    return value;
}
async function permit(policy: CatalogAccessPolicy, actor: any, action: any, target = scope) {
    const decision = await policy.evaluate(actor, action, target);
    if (!decision.allowed)
        throw new Error(decision.message);
    return decision.precondition;
}
it("invalidates recoverable configured-administrator publication at startup before any new authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cv-admin-rotation-"));
    directories.push(directory);
    const filename = join(directory, "catalog.sqlite");
    const database = createTestDb(filename);
    opened.push(database);
    const oldKey = "old-configured-unit-key", newKey = "new-configured-unit-key";
    startup(database, oldKey, now);
    const original = identities.principalForVerifiedAdministrator(database, oldKey, scope.customerId, now);
    const f = await fixture(database, { principal: original });
    const pending = await f.prepare(await f.open());
    const originalAuthority = (await f.store.getAuthority(scope, original))!;
    bootstrapAuthority(database, authority);
    const external: any = { ...principal, kind: "administrator", actorId: "unrelated-external-actor", credential: { id: "unrelated-external", kind: "external", version: 1 } };
    const { customerId: ignored, ...externalPrincipal } = external;
    bootstrapAuthority(database, { ...authority, credentialId: externalPrincipal.credential.id, actorId: externalPrincipal.actorId, customerId: null }, "external");
    database.close();
    const reopened = createTestDb(filename);
    opened.push(reopened);
    const configuration = startup(reopened, newKey, rotatedAt);
    const store = new SqliteControlStore(reopened), policy = new CatalogAccessPolicy(store);
    expect((await store.getOperation(scope, pending.operation.id))?.state).toBe("processing");
    const recovered = await store.claimRecovery({ scope, operationId: pending.operation.id, expectedVersion: pending.operation.version, ownerId: "startup-recovery", now: rotatedAt, expiresAt: newLease });
    await expect(store.acceptRevision({ ...pending.accept, expectedOperationVersion: recovered.version, processingFence: recovered.claim!.fence, acceptedAt: rotatedAt })).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" });
    expect((await store.getWorkspace(scope))?.currentRevisionId).toBe("revision-initial");
    expect(typeof (identities as any).synchronizeConfiguredAdministrator).toBe("function");
    expect(configuration?.epoch).toBe(2);
    expect(await policy.evaluate(principal, "workspace:read", scope)).toMatchObject({ allowed: true });
    expect(await policy.evaluate(externalPrincipal, "workspace:read", scope)).toMatchObject({ allowed: true });
    expect(() => identities.principalForVerifiedAdministrator(reopened, oldKey, scope.customerId, rotatedAt)).toThrow();
    expect(() => bootstrapAuthority(reopened, originalAuthority)).toThrow();
    expect(startup(reopened, newKey, rotatedAt)).toEqual(configuration);
    const next = identities.principalForVerifiedAdministrator(reopened, newKey, scope.customerId, rotatedAt);
    expect(next.credential.id).not.toBe(original.credential.id);
    expect((await store.resolveOperation({ kind: "administrator", principal: next, scope: { customerId: scope.customerId }, authorization: await permit(policy, next, "operation:read", { customerId: scope.customerId }) as any }, pending.operation.id))?.intent).toEqual(pending.operation.intent);
    const openCommand = scopedCommand(next, "run:open", null, { mode: "read-only", agentLabel: "admin", task: "verify current key", reason: "rotation" });
    const openedRun = await store.openRun({ scope, principal: next, authorization: await permit(policy, next, "run:open-read"), command: openCommand, runId: "new-admin-run" as any, cleanupId: "new-admin-cleanup" as any, mode: "read-only", agentLabel: "admin", task: "verify current key", reason: "rotation", expiresAt: newLease, createdAt: rotatedAt });
    const runScope: any = { ...openedRun.value.scope, runId: openedRun.value.id };
    const finalizeCommand = scopedCommand(next, "finalize", openedRun.value.id, { expectedRunVersion: 1 });
    const claimed = await store.claimFinalization({ scope: runScope, principal: next, authorization: await permit(policy, next, "run:finalize"), command: finalizeCommand, expectedRunVersion: 1, intent: { schemaVersion: 1, kind: "finalize", mode: "read-only", request: { method: "POST", path: `/v1/runs/${openedRun.value.id}/finalize`, body: { expectedRunVersion: 1 } }, source: null, candidateIdentity: null }, claim: { ownerId: "new-admin", fence: 1, expiresAt: newLease }, now: rotatedAt });
    const publicationEvents = events(finalizeCommand.operationId, openedRun.value.id);
    publicationEvents.audit.actorId = next.actorId;
    publicationEvents.outbox.actorId = next.actorId;
    await expect(store.completeReadOnly({ scope: runScope, operationId: claimed.operation.id, expectedRunVersion: claimed.value.version, expectedOperationVersion: claimed.operation.version, expectedBindingGeneration: 1, processingFence: 1, authorization: await permit(policy, next, "run:finalize"), events: publicationEvents, completedAt: rotatedAt })).resolves.toMatchObject({ run: { state: "finalized" } });
    const persisted = JSON.stringify(reopened.prepare("SELECT data FROM catalog_records").all());
    expect(persisted).not.toContain(oldKey);
    expect(persisted).not.toContain(newKey);
});
it("does not resurrect an old configured identity when startup deliberately reuses an earlier key", async () => {
    const database = createTestDb();
    opened.push(database);
    startup(database, "first-configuration-key", now);
    const original = identities.principalForVerifiedAdministrator(database, "first-configuration-key", scope.customerId, now);
    startup(database, "second-configuration-key", rotatedAt);
    const current = startup(database, "first-configuration-key", newLease);
    const next = identities.principalForVerifiedAdministrator(database, "first-configuration-key", scope.customerId, newLease);
    expect(next.credential.id).not.toBe(original.credential.id);
    expect(current?.epoch).toBe(3);
    const store = new SqliteControlStore(database);
    expect((await store.getAuthority(scope, original))?.revokedAt ?? "revoked").not.toBeNull();
    expect(await new CatalogAccessPolicy(store).evaluate(original, "workspace:create", { customerId: scope.customerId })).toMatchObject({ allowed: false, code: "CREDENTIAL_REVOKED" });
    expect(await new CatalogAccessPolicy(store).evaluate(next, "workspace:create", { customerId: scope.customerId })).toMatchObject({ allowed: true });
});
it("upgrades legacy configured provenance without revoking unrelated external identities", async () => {
    const database = createTestDb();
    opened.push(database);
    const legacy: any = { ...authority, credentialId: `administrator:${"a".repeat(64)}`, actorId: "administrator:configured-master-key", customerId: null };
    const unrelated: any = { ...authority, credentialId: `administrator:${"b".repeat(64)}`, actorId: "unrelated-external-provider", customerId: null };
    bootstrapAuthority(database, legacy, "external");
    bootstrapAuthority(database, unrelated, "external");
    bootstrapAuthority(database, authority);
    startup(database, "current-startup-key", now);
    const row = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(legacy.credentialId) as {
        data: string;
    };
    expect(JSON.parse(row.data)).toMatchObject({ revokedAt: now, credentialVersion: 2, permissionEpoch: 2 });
    const store = new SqliteControlStore(database);
    const external: any = { kind: "administrator", actorId: unrelated.actorId, credential: { id: unrelated.credentialId, kind: "external", version: 1 }, permissionEpoch: 1, authenticatedAt: now };
    expect(await new CatalogAccessPolicy(store).evaluate(external, "workspace:create", { customerId: scope.customerId })).toMatchObject({ allowed: true });
    expect(await store.getAuthority(scope, principal)).toEqual(authority);
});
it("preserves explicit revocation on unchanged startup and supports disabling the configured key", async () => {
    const database = createTestDb();
    opened.push(database);
    const configuration = startup(database, "configured-key", now);
    const original = identities.principalForVerifiedAdministrator(database, "configured-key", scope.customerId, now);
    const store = new SqliteControlStore(database), policy = new CatalogAccessPolicy(store);
    const current = (await store.getAuthority(scope, original))!;
    await store.updateAuthority({ scope: { customerId: scope.customerId }, principal: original, authorization: await permit(policy, original, "credential:manage", { customerId: scope.customerId }), authority: { ...current, credentialVersion: current.credentialVersion + 1, permissionEpoch: current.permissionEpoch + 1, revokedAt: rotatedAt }, expectedCredentialVersion: current.credentialVersion, expectedPermissionEpoch: current.permissionEpoch });
    expect(startup(database, "configured-key", rotatedAt)).toEqual(configuration);
    expect(() => identities.principalForVerifiedAdministrator(database, "configured-key", scope.customerId, rotatedAt)).toThrow();
    const disabled = startup(database, null, newLease);
    expect(disabled).toMatchObject({ fingerprint: null, epoch: 2 });
    expect(() => identities.principalForVerifiedAdministrator(database, "new-unconfigured-key", scope.customerId, newLease)).toThrow();
    expect(startup(database, null, newLease)).toEqual(disabled);
    expect(startup(database, "replacement-key", newLease)).toMatchObject({ epoch: 3 });
    const replacement = identities.principalForVerifiedAdministrator(database, "replacement-key", scope.customerId, newLease);
    expect(await policy.evaluate(replacement, "workspace:create", { customerId: scope.customerId })).toMatchObject({ allowed: true });
});
it("invalidates every selected-tenant configured identity during one startup rotation", async () => {
    const database = createTestDb();
    opened.push(database);
    startup(database, "old-tenants-key", now);
    const first = identities.principalForVerifiedAdministrator(database, "old-tenants-key", "tenant-a", now);
    const second = identities.principalForVerifiedAdministrator(database, "old-tenants-key", "tenant-b", now);
    const unscoped = identities.principalForVerifiedAdministrator(database, "old-tenants-key", null, now);
    startup(database, "new-tenants-key", rotatedAt);
    const store = new SqliteControlStore(database), policy = new CatalogAccessPolicy(store);
    for (const [actor, customerId] of [[first, "tenant-a"], [second, "tenant-b"], [unscoped, "tenant-a"]] as const)
        expect(await policy.evaluate(actor, "workspace:create", { customerId: customerId as any })).toMatchObject({ allowed: false, code: "CREDENTIAL_REVOKED" });
});
