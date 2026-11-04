import { manifestDigest, canonicalRequestDigest } from "../../src/domain";
import type { Principal, AuthorizationPrecondition } from "../../src/domain";
import { SqliteControlStore, bootstrapAuthority } from "../../src/adapters/control/sqlite-control-store";
import { CatalogAccessPolicy } from "../../src/adapters/access/catalog-access-policy";
import { createTestDb } from "../../src/db";
export const now = "2026-11-03T12:00:00.000Z";
export const later = "2026-11-03T13:00:00.000Z";
export const expired = "2026-11-03T14:00:00.000Z";
export const scope: any = { customerId: "tenant-a", workspaceId: "workspace-a" };
export const principal: Principal = { kind: "service", customerId: "tenant-a", actorId: "actor-a", credential: { id: "key-a", kind: "service", version: 1 }, permissionEpoch: 1, authenticatedAt: now } as Principal;
export const actions = ["workspace:create", "workspace:read", "workspace:write", "workspace:delete", "workspace:restore", "workspace:export", "workspace:admin", "workspace:migrate", "credential:manage", "run:open-read", "run:open-write", "run:read", "run:upload", "run:finalize", "run:abort", "run:heartbeat", "operation:read"] as const;
export const authority: any = { credentialId: "key-a", actorId: "actor-a", customerId: "tenant-a", credentialVersion: 1, permissionEpoch: 1, policyVersion: 1, revokedAt: null, grants: actions.map(action => ({ action, customerId: "tenant-a", workspaceId: null })) };
let seq = 0;
export function command(kind: string, payload: any = {}, runId: string | null = null, workspaceId: string | null = scope.workspaceId, key?: string): any {
    const operationId = `op-${++seq}`;
    return { idempotencyScope: { customerId: scope.customerId, actorId: principal.actorId, kind, workspaceId, runId }, idempotencyKey: key ?? operationId, requestDigest: canonicalRequestDigest({ schemaVersion: 1, customerId: scope.customerId, actorId: principal.actorId, credentialId: principal.credential.id, kind, resource: { ...(workspaceId ? { workspaceId } : {}), ...(runId ? { runId } : {}) }, payload }), operationId, requestedAt: now };
}
export function events(operationId: string, runId: string | null = null): any {
    const base = { scope, runId, operationId, actorId: principal.actorId, type: "test.changed", payload: {}, createdAt: now };
    return { audit: { ...base, id: `audit-${++seq}` }, outbox: { ...base, id: `outbox-${++seq}`, deliveryState: "pending", version: 1, attempts: 0, nextAttemptAt: now, claim: null } };
}
export async function fixture(db = createTestDb(), options: any = {}) {
    const actor: Principal = options.principal ?? principal;
    bootstrapAuthority(db, { ...authority, credentialId: actor.credential.id, actorId: actor.actorId, customerId: actor.kind === "administrator" ? null : actor.customerId, credentialVersion: actor.credential.version, permissionEpoch: actor.permissionEpoch });
    const ev = (operationId: string, runId: string | null = null) => { const value = events(operationId, runId); value.audit.actorId = actor.actorId; value.outbox.actorId = actor.actorId; return value; };
    const cmd = (kind: string, payload: any = {}, runId: string | null = null, workspaceId: string | null = scope.workspaceId) => { const c = command(kind, payload, runId, workspaceId); c.idempotencyScope.actorId = actor.actorId; c.requestDigest = canonicalRequestDigest({ schemaVersion: 1, customerId: scope.customerId, actorId: actor.actorId, credentialId: actor.credential.id, kind, resource: { ...(workspaceId ? { workspaceId } : {}), ...(runId ? { runId } : {}) }, payload }); return c; };
    const store = new SqliteControlStore(db), policy = new CatalogAccessPolicy(store);
    async function auth(action: any, target: any = scope): Promise<AuthorizationPrecondition> {
        const result = await policy.evaluate(actor, action, target);
        if (!result.allowed)
            throw new Error(result.message);
        return result.precondition;
    }
    const binding: any = { id: "binding-a", scope, backend: "git", generation: 1, location: { storeId: "git", opaqueKey: "private/workspace-a" }, configurationRef: "test", status: "active", createdAt: now };
    const workspace: any = { id: scope.workspaceId, customerId: scope.customerId, name: "test", currentRevisionId: "revision-initial", version: 1, status: "active", storageBindingId: binding.id, bindingGeneration: 1, createdAt: now, updatedAt: now };
    const create = cmd("workspace:create", { customerId: scope.customerId, name: "test" }, null, null);
    const candidateIdentity: any = { candidateId: "candidate-initial", revisionId: workspace.currentRevisionId, operationId: create.operationId, scope: { ...scope, storageBindingId: binding.id, bindingGeneration: 1 }, parentRevisionId: null, createdAt: now };
    const intent: any = { schemaVersion: 1, kind: "workspace:create", request: { method: "POST", path: "/v1/workspaces", body: { customerId: scope.customerId, name: "test" } }, workspace, binding, candidateIdentity, initialManifest: { schemaVersion: 1, entries: [] }, initialManifestDigest: manifestDigest({ schemaVersion: 1, entries: [] }) };
    const creation = await store.claimWorkspaceCreation({ principal: actor, authorization: await auth("workspace:create", { customerId: scope.customerId }), command: create, intent, claim: { ownerId: "worker", fence: 1, expiresAt: later }, now });
    const candidate: any = { ...candidateIdentity, manifestDigest: intent.initialManifestDigest, privateReference: { storeId: "git", opaqueKey: "candidate-initial" }, preparedAt: now };
    delete candidate.createdAt;
    const accepted = options.acceptCreation === false ? null : await store.acceptWorkspaceCreation({ scope, operationId: create.operationId, expectedOperationVersion: creation.operation.version, processingFence: 1, now, authorization: await auth("workspace:create", { customerId: scope.customerId }), initialRevision: candidate, events: ev(create.operationId) });
    async function open(mode: "read-only" | "read-write" = "read-write", id = `run-${++seq}`) {
        return (await store.openRun({ scope, principal: actor, authorization: await auth(mode === "read-only" ? "run:open-read" : "run:open-write"), command: cmd("run:open", { mode }), runId: id as any, cleanupId: `cleanup-${id}` as any, mode, agentLabel: "agent", task: "task", reason: "reason", expiresAt: later, createdAt: now })).value;
    }
    async function prepare(run: any, manifest: any = { schemaVersion: 1, entries: [{ path: "directory", kind: "directory" }] }, shouldClaim = true): Promise<any> {
        const rs: any = { ...run.scope, runId: run.id };
        let submission: any = null;
        if (run.mode === "read-write") {
            submission = (await store.createSubmission({ scope: rs, principal: actor, command: cmd("submission:create", {}, run.id), submissionId: `submission-${run.id}` as any, expiresAt: later })).value;
            submission = (await store.sealSubmission({ scope: rs, principal: actor, command: cmd("submission:seal", {}, run.id), submissionId: submission.id, expectedSubmissionVersion: submission.version, manifest, manifestDigest: manifestDigest(manifest), receipts: [], now })).value;
        }
        const body: any = { expectedRunVersion: run.version, ...(submission ? { submissionId: submission.id } : {}) };
        const finalizeCommand = cmd("finalize", body, run.id);
        const ci: any = submission ? { candidateId: `candidate-${run.id}`, revisionId: `revision-${run.id}`, operationId: finalizeCommand.operationId, scope: run.scope, parentRevisionId: run.baseRevisionId, createdAt: now } : null;
        const fi: any = { schemaVersion: 1, kind: "finalize", mode: run.mode, request: { method: "POST", path: `/v1/runs/${run.id}/finalize`, body }, source: submission ? { submissionId: submission.id, submissionVersion: submission.version, manifestDigest: submission.manifestDigest } : null, candidateIdentity: ci };
        const input: any = { scope: rs, principal: actor, authorization: await auth("run:finalize"), command: finalizeCommand, expectedRunVersion: run.version, intent: fi, claim: { ownerId: "worker", fence: 1, expiresAt: later }, now };
        if (!shouldClaim)
            return { input, submission };
        const claimed = await store.claimFinalization(input);
        const prepared: any = ci ? { ...ci, manifestDigest: submission.manifestDigest, privateReference: { storeId: "git", opaqueKey: ci.candidateId }, preparedAt: now } : null;
        if (prepared)
            delete prepared.createdAt;
        const op = prepared ? await store.recordPreparedRevision({ scope, operationId: finalizeCommand.operationId, expectedOperationVersion: claimed.operation.version, processingFence: 1, now, candidate: prepared }) : claimed.operation;
        return { run: claimed.value, operation: op, candidate: prepared, submission, input, accept: { scope: rs, operationId: finalizeCommand.operationId, expectedRunVersion: claimed.value.version, expectedOperationVersion: op.version, expectedBindingGeneration: 1, processingFence: 1, authorization: await auth("run:finalize"), expectedHeadRevisionId: run.baseRevisionId, expectedWorkspaceVersion: run.workspaceVersionAtOpen, submissionId: submission?.id, candidate: prepared, events: ev(finalizeCommand.operationId, run.id), acceptedAt: now, completedAt: now } };
    }
    return { db, store, policy, auth, open, prepare, accepted, creation, intent, candidate };
}
