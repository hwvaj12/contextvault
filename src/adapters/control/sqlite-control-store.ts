import { acquireCompatibilityLock } from "../../storage/compatibility-lock";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as D from "../../domain";
import type { ControlStore, CredentialAuthority, CatalogSubscription, CollectionWork, CommandResult, PublicationEvents, ResourceLookupContext, ProcessingCAS } from "../../ports/control-store";
import { initSchema } from "../../db";
import { isCurrentConfiguredAdministrator } from "../../db/configured-administrator";
import { canonicalRepresentation, legacyRepresentations, representationRecipient } from "../../compat/webhook";
import { decideAccess } from "../access/catalog-access-policy";
type Input<K extends keyof ControlStore> = Parameters<ControlStore[K]>[0];
type MigrationGuards = {
    workspaceVersion: number;
    sourceReferences: readonly {
        scope: D.BindingScope;
        privateReference: D.PrivateLocator;
    }[];
};
type CandidateRecord = {
    identity: D.CandidateIdentity;
    prepared: D.PreparedRevision | null;
    collection: D.CollectionPermit | null;
    collectedAt?: D.Timestamp;
};
type SubmissionCollectionState = { permit: D.SubmissionCollectionPermit; collectedAt: D.Timestamp | null; cursor?: string };
const same = (left: unknown, right: unknown) => D.canonicalJson(left) === D.canonicalJson(right);
// Catalog pagination uses SQLite's UTF-8 BINARY ordering, which differs from JavaScript UTF-16 string ordering.
const compareCursor = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
function fail(code: D.ErrorCode, message: string): never { throw new D.WorkspaceError(code, message); }
const scopeOf = (workspace: D.Workspace): D.WorkspaceScope => ({ customerId: workspace.customerId, workspaceId: workspace.id });
const bindingOf = (workspace: D.Workspace): D.BindingScope => ({ ...scopeOf(workspace), storageBindingId: workspace.storageBindingId, bindingGeneration: workspace.bindingGeneration });
const identityOf = (principal: D.Principal) => ({ kind: principal.kind, actorId: principal.actorId, credential: principal.credential, permissionEpoch: principal.permissionEpoch, ...(principal.kind === "administrator" ? {} : { customerId: principal.customerId }) });
const digest = (value: unknown) => createHash("sha256").update(D.canonicalJson(value)).digest("hex");
/** Migration digests cover sorted immutable revision IDs/digests and sorted complete verified-copy records. */
export const retainedRevisionSetDigest = (revisions: readonly D.Revision[]) => digest([...revisions].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).map(r => ({ revisionId: r.id, manifestDigest: r.manifestDigest })));
export const verifiedCopySetDigest = (copies: readonly D.VerifiedRevisionCopy[]) => digest([...copies].sort((a, b) => Buffer.compare(Buffer.from(a.revisionId), Buffer.from(b.revisionId))));
function bindCredentialSource(db: Database.Database, authority: CredentialAuthority, kind?: D.CredentialIdentity["kind"]): void {
    if (db.prepare("SELECT id FROM catalog_records WHERE kind='credential-source' AND id=?").get(authority.credentialId))
        return;
    const legacy = db.prepare("SELECT id FROM api_keys WHERE id=?").get(authority.credentialId);
    const source = { kind: legacy ? "api-key" : kind ?? (authority.customerId === null ? "external" : "service") };
    db.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES('credential-source',?,?,NULL,NULL,?)").run(authority.credentialId, authority.customerId ?? "", JSON.stringify(source));
}
/** Trust-root provisioning is explicit and insert-only. Ordinary requests must use updateAuthority. */
export function bootstrapAuthority(db: Database.Database, authority: CredentialAuthority, credentialKind?: D.CredentialIdentity["kind"]): void {
    initSchema(db);
    db.transaction(() => {
        const row = db.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(authority.credentialId) as {
            data: string;
        } | undefined;
        bindCredentialSource(db, authority, credentialKind);
        if (row) {
            if (!same(JSON.parse(row.data), authority))
                fail("VERSION_CONFLICT", "Authority already exists; use a scoped authority update");
            return;
        }
        db.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES('authority',?,?,NULL,NULL,?)").run(authority.credentialId, authority.customerId ?? "", JSON.stringify(authority));
    }).immediate();
}
/** All mutations take SQLite's writer reservation before reading their CAS predicates. No backend bytes live here. */
export class SqliteControlStore implements ControlStore {
    constructor(readonly database: Database.Database) { initSchema(database); }
    acquireCompatibilityLock(scope: D.WorkspaceScope, resource: string) { return acquireCompatibilityLock(this.database, scope, resource); }
    private transaction<T>(work: () => T): T { return this.database.transaction(work).immediate(); }
    private load<T>(kind: string, id: string, scope?: D.CustomerScope | D.WorkspaceScope): T | null {
        let sql = "SELECT data FROM catalog_records WHERE kind=? AND id=?";
        const args: unknown[] = [kind, id];
        if (scope) {
            sql += " AND customer_id=?";
            args.push(scope.customerId);
            if ("workspaceId" in scope) {
                sql += " AND workspace_id=?";
                args.push(scope.workspaceId);
            }
        }
        const row = this.database.prepare(sql).get(...args) as {
            data: string;
        } | undefined;
        return row ? JSON.parse(row.data) as T : null;
    }
    private all<T>(kind: string, scope?: D.CustomerScope | D.WorkspaceScope): T[] {
        let sql = "SELECT data FROM catalog_records WHERE kind=?";
        const args: unknown[] = [kind];
        if (scope) {
            sql += " AND customer_id=?";
            args.push(scope.customerId);
            if ("workspaceId" in scope) {
                sql += " AND workspace_id=?";
                args.push(scope.workspaceId);
            }
        }
        return (this.database.prepare(sql + " ORDER BY id").all(...args) as {
            data: string;
        }[]).map(row => JSON.parse(row.data) as T);
    }
    private write(kind: string, id: string, scope: D.CustomerScope | D.WorkspaceScope, data: unknown, insert = false, runId: string | null = null): void {
        const existing = this.database.prepare("SELECT customer_id,workspace_id FROM catalog_records WHERE kind=? AND id=?").get(kind, id) as {
            customer_id: string;
            workspace_id: string | null;
        } | undefined;
        const workspaceId = "workspaceId" in scope ? scope.workspaceId : null;
        if (existing && (existing.customer_id !== scope.customerId || existing.workspace_id !== workspaceId))
            fail("FORBIDDEN", "Record identity belongs to another scope");
        if (existing && insert)
            fail("VERSION_CONFLICT", "Immutable identity already exists");
        this.database.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,run_id=excluded.run_id").run(kind, id, scope.customerId, workspaceId, runId, JSON.stringify(data));
    }
    private authority(scope: D.CustomerScope, principal: D.Principal): CredentialAuthority | null {
        if (!principal?.credential || !principal.actorId)
            return null;
        const authority = this.load<CredentialAuthority>("authority", principal.credential.id);
        if (!authority || (authority.customerId !== null && authority.customerId !== scope.customerId))
            return null;
        if (!isCurrentConfiguredAdministrator(this.database, authority))
            return null;
        const source = this.load<{
            kind: D.CredentialIdentity["kind"];
        }>("credential-source", principal.credential.id);
        if (!source || source.kind !== principal.credential.kind)
            return null;
        if (source.kind === "api-key") {
            const key = this.database.prepare("SELECT customer_id FROM api_keys WHERE id=?").get(principal.credential.id) as {
                customer_id: string;
            } | undefined;
            if (!key || key.customer_id !== scope.customerId || authority.customerId !== key.customer_id)
                return null;
        }
        return authority;
    }
    private permit(principal: D.Principal, action: D.Action, scope: D.CustomerScope | D.WorkspaceScope, precondition?: D.AuthorizationPrecondition): void {
        const result = decideAccess(this.authority(scope, principal), principal, action, scope);
        if (!result.allowed)
            fail(result.code, result.message);
        if (precondition && (!same(identityOf(precondition.principal), identityOf(principal)) || !same(precondition.scope, scope) || precondition.action !== action || result.precondition.policyVersion !== precondition.policyVersion || result.precondition.permissionEpoch !== precondition.permissionEpoch || result.precondition.credentialVersion !== precondition.credentialVersion))
            fail("CREDENTIAL_REVOKED", "Authorization precondition no longer matches current authority");
    }
    private workspace(scope: D.WorkspaceScope, active = true): D.Workspace {
        const workspace = this.load<D.Workspace>("workspace", scope.workspaceId, scope);
        if (!workspace)
            fail("WORKSPACE_NOT_FOUND", "Workspace does not exist in this customer scope");
        if (active && workspace.status !== "active")
            fail("WORKSPACE_INACTIVE", "Workspace is not active");
        return workspace;
    }
    private run(scope: D.RunScope, principal?: D.Principal, action?: D.Action): D.Run {
        this.workspace(scope);
        const run = this.load<D.Run>("run", scope.runId, scope);
        if (!run)
            fail("RUN_NOT_FOUND", "Run does not exist in this customer scope");
        if (!same(run.scope, { customerId: scope.customerId, workspaceId: scope.workspaceId, storageBindingId: scope.storageBindingId, bindingGeneration: scope.bindingGeneration }))
            fail("STORAGE_BINDING_CHANGED", "Run binding does not match scope");
        const workspace = this.workspace(scope);
        if (workspace.storageBindingId !== scope.storageBindingId || workspace.bindingGeneration !== scope.bindingGeneration)
            fail("STORAGE_BINDING_CHANGED", "Current binding changed");
        if (principal) {
            if (!same(identityOf(principal), identityOf(run.principal)))
                fail("FORBIDDEN", "Run belongs to another authenticated identity");
            if (action)
                this.permit(principal, action, { customerId: scope.customerId, workspaceId: scope.workspaceId });
        }
        return run;
    }
    private active(run: D.Run, now: D.Timestamp): void {
        if (run.state !== "active")
            fail(run.state === "finalizing" ? "FINALIZATION_IN_PROGRESS" : "INVALID_TRANSITION", "Run is not active");
        if (run.lease.expiresAt <= now)
            fail("RUN_EXPIRED", "Run client lease expired");
    }
    private command(command: D.CommandIdentity, principal: D.Principal, scope: D.CustomerScope | D.WorkspaceScope, kind: D.OperationKind, runId: D.RunId | null = null): void {
        if (!principal?.credential || !command.idempotencyKey || !command.requestDigest || !command.operationId)
            fail("INVALID_REQUEST", "Command identity is required");
        const expected = { customerId: scope.customerId, actorId: principal.actorId, kind, workspaceId: "workspaceId" in scope ? scope.workspaceId : null, runId };
        if (!same(command.idempotencyScope, expected))
            fail("FORBIDDEN", "Command scope does not match authenticated identity and resource");
    }
    private replay<T>(command: D.CommandIdentity, principal: D.Principal): CommandResult<T> | null {
        const row = this.database.prepare("SELECT digest,operation_id,value FROM catalog_commands WHERE scope=? AND key=?").get(D.canonicalJson(command.idempotencyScope), command.idempotencyKey) as {
            digest: string;
            operation_id: string;
            value: string | null;
        } | undefined;
        if (!row)
            return null;
        if (row.digest !== command.requestDigest)
            fail("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with different input");
        const operation = this.load<D.Operation>("operation", row.operation_id);
        if (!operation)
            throw new Error("Catalog command references an absent operation");
        if (!same(identityOf(operation.principal), identityOf(principal)))
            fail("FORBIDDEN", "Idempotent command belongs to another credential");
        return { operation, value: row.value === null ? null as T : JSON.parse(row.value) as T, replayed: true };
    }
    private operation(command: D.CommandIdentity, principal: D.Principal, scope: D.WorkspaceScope, runId: D.RunId | null, result: D.OperationResult | null = null): D.Operation {
        return { id: command.operationId, kind: command.idempotencyScope.kind, scope: { customerId: scope.customerId, workspaceId: scope.workspaceId }, runId, principal, command, state: result ? "succeeded" : "processing", phase: result ? "complete" : "claimed", version: 1, claim: null, candidate: null, result, error: null, intent: { kind: "command", candidateIdentity: null }, createdAt: command.requestedAt, updatedAt: command.requestedAt } as D.Operation;
    }
    private saveCommand<T>(operation: D.Operation, value: T): CommandResult<T> {
        this.write("operation", operation.id, operation.scope, operation, true, operation.runId);
        this.database.prepare("INSERT INTO catalog_commands(scope,key,digest,operation_id,value) VALUES(?,?,?,?,?)").run(D.canonicalJson(operation.command.idempotencyScope), operation.command.idempotencyKey, operation.command.requestDigest, operation.id, JSON.stringify(value));
        return { operation, value, replayed: false };
    }
    private saveOutcome(operation: D.Operation, value: unknown): void {
        this.write("operation", operation.id, operation.scope, operation, false, operation.runId);
        this.database.prepare("UPDATE catalog_commands SET value=? WHERE operation_id=?").run(JSON.stringify(value), operation.id);
    }
    private events(events: PublicationEvents, operation: Pick<D.Operation, "id" | "scope" | "runId"> & {
        principal: Pick<D.Principal, "actorId">;
    }): void {
        for (const event of [events.audit, events.outbox]) {
            if (!same(event.scope, operation.scope) || event.operationId !== operation.id || event.runId !== operation.runId || event.actorId !== operation.principal.actorId)
                fail("FORBIDDEN", "Event identity does not match operation");
        }
        if (events.outbox.deliveryState !== "pending" || events.outbox.claim !== null || events.outbox.version !== 1 || events.outbox.attempts !== 0)
            fail("INVALID_REQUEST", "New outbox events must be unclaimed and pending");
        this.write("audit", events.audit.id, operation.scope, events.audit, true, operation.runId);
        this.write("outbox", events.outbox.id, operation.scope, events.outbox, true, operation.runId);
    }
    private cleanup(run: D.Run, now: D.Timestamp): D.CleanupStatus {
        const existing = this.load<D.CleanupStatus>("cleanup", run.cleanupId, run.scope);
        if (existing) {
            if (existing.runId !== run.id)
                fail("VERSION_CONFLICT", "Cleanup identity belongs to another run");
            return existing;
        }
        const cleanup: D.CleanupStatus = { id: run.cleanupId, scope: { customerId: run.scope.customerId, workspaceId: run.scope.workspaceId }, runId: run.id, state: "pending", version: 1, attempts: 0, claim: null, nextAttemptAt: now, lastError: null };
        this.write("cleanup", cleanup.id, cleanup.scope, cleanup, true, run.id);
        return cleanup;
    }
    private processing(input: ProcessingCAS): D.Operation {
        const operation = this.load<D.Operation>("operation", input.operationId, input.scope);
        if (!operation)
            fail("OPERATION_NOT_FOUND", "Operation does not exist");
        if (operation.claim?.fence !== input.processingFence)
            fail("STALE_FENCE", "Processing fence is stale");
        if (operation.state !== "processing" || !operation.claim || operation.claim.expiresAt <= input.now)
            fail("STALE_FENCE", "Processing claim is absent or expired");
        if (operation.version !== input.expectedOperationVersion)
            fail("VERSION_CONFLICT", "Operation version changed");
        return operation;
    }
    private matchCandidate(identity: D.CandidateIdentity, candidate: D.PreparedRevision, manifestDigest: string): void {
        const expected = { candidateId: identity.candidateId, revisionId: identity.revisionId, scope: identity.scope, parentRevisionId: identity.parentRevisionId, operationId: identity.operationId };
        const actual = { candidateId: candidate.candidateId, revisionId: candidate.revisionId, scope: candidate.scope, parentRevisionId: candidate.parentRevisionId, operationId: candidate.operationId };
        if (!same(expected, actual) || candidate.manifestDigest !== manifestDigest || !candidate.privateReference.storeId || !candidate.privateReference.opaqueKey)
            fail("RECEIPT_MISMATCH", "Prepared revision does not match persisted candidate and manifest");
        const registered = this.load<CandidateRecord>("candidate", candidate.candidateId, candidate.scope);
        if (!registered || registered.collection)
            fail("STALE_FENCE", "Candidate is absent or fenced for collection");
        if (registered.prepared && !same(registered.prepared, candidate))
            fail("RECEIPT_MISMATCH", "Prepared revision identity is immutable");
    }
    private candidate(identity: D.CandidateIdentity): void { this.write("candidate", identity.candidateId, identity.scope, { identity, prepared: null, collection: null } satisfies CandidateRecord, true); }
    private prepared(candidate: D.PreparedRevision): void {
        const record = this.load<CandidateRecord>("candidate", candidate.candidateId, candidate.scope)!;
        record.prepared = candidate;
        this.write("candidate", candidate.candidateId, candidate.scope, record);
    }
    private revision(candidate: D.PreparedRevision, createdAt: D.Timestamp): D.Revision { return { id: candidate.revisionId, scope: candidate.scope, parentRevisionId: candidate.parentRevisionId, manifestDigest: candidate.manifestDigest, privateReference: candidate.privateReference, originatingOperationId: candidate.operationId, createdAt }; }
    private scan<T>(kind: string, predicate: string, parameters: unknown[], limit: number): T[] {
        return (this.database.prepare(`SELECT data FROM catalog_records WHERE kind=? AND ${predicate} ORDER BY id LIMIT ?`).all(kind, ...parameters, this.limit(limit)) as {
            data: string;
        }[]).map(row => JSON.parse(row.data) as T);
    }
    private page<T extends {
        id: string;
    }>(kind: string, scope: D.CustomerScope | D.WorkspaceScope, cursor?: string, limit = 100): {
        values: T[];
        nextCursor: string | null;
    } {
        this.limit(limit);
        const workspace = "workspaceId" in scope;
        const parameters: unknown[] = [kind, scope.customerId];
        if (workspace)
            parameters.push(scope.workspaceId);
        parameters.push(cursor ?? "", limit + 1);
        const values = (this.database.prepare(`SELECT data FROM catalog_records WHERE kind=? AND customer_id=? ${workspace ? "AND workspace_id=?" : ""} AND id>? ORDER BY id LIMIT ?`).all(...parameters) as {
            data: string;
        }[]).map(row => JSON.parse(row.data) as T);
        const more = values.length > limit;
        if (more)
            values.pop();
        return { values, nextCursor: more ? values[values.length - 1].id : null };
    }
    async getWorkspace(scope: D.WorkspaceScope) { return this.load<D.Workspace>("workspace", scope.workspaceId, scope); }
    async listWorkspaces(scope: D.CustomerScope, cursor?: string, limit?: number) { const page = this.page<D.Workspace>("workspace", scope, cursor, limit); return { workspaces: page.values, nextCursor: page.nextCursor }; }
    async getBinding(scope: D.WorkspaceScope, id: D.StorageBindingId) { return this.load<D.StorageBinding>("binding", id, scope); }
    async getRevision(scope: D.WorkspaceScope, id: D.RevisionId) { return this.load<D.Revision>("revision", id, scope); }
    async listRevisions(scope: D.WorkspaceScope, cursor?: string, limit?: number) { const page = this.page<D.Revision>("revision", scope, cursor, limit); return { revisions: page.values, nextCursor: page.nextCursor }; }
    async listRuns(scope: D.WorkspaceScope, cursor?: string, limit?: number) { const page = this.page<D.Run>("run", scope, cursor, limit); return { runs: page.values, nextCursor: page.nextCursor }; }
    async getRun(scope: D.WorkspaceScope, id: D.RunId) { return this.load<D.Run>("run", id, scope); }
    async getOperation(scope: D.WorkspaceScope, id: D.OperationId) { return this.load<D.Operation>("operation", id, scope); }
    private resolve<T extends D.Run | D.Operation>(kind: "run" | "operation", context: ResourceLookupContext, id: string): T | null {
        return this.transaction(() => {
            if (!context?.principal?.credential)
                return null;
            const customerScope: D.CustomerScope = context.kind === "tenant" ? { customerId: context.principal.customerId } : context.scope;
            if (context.kind === "tenant" && (context.principal as D.Principal).kind === "administrator")
                return null;
            if (context.kind === "administrator" && context.principal.kind !== "administrator")
                return null;
            const resource = this.load<T>(kind, id, customerScope);
            if (!resource)
                return null;
            const action = kind === "run" ? "run:read" : "operation:read";
            try {
                if (context.kind === "administrator")
                    this.permit(context.principal, action, customerScope, context.authorization);
                this.permit(context.principal, action, { customerId: resource.scope.customerId, workspaceId: resource.scope.workspaceId });
            }
            catch (error) {
                if (error instanceof D.WorkspaceError)
                    return null;
                throw error;
            }
            return resource;
        });
    }
    async resolveRun(context: ResourceLookupContext, id: D.RunId) { return this.resolve<D.Run>("run", context, id); }
    async resolveOperation(context: ResourceLookupContext, id: D.OperationId) { return this.resolve<D.Operation>("operation", context, id); }
    async findOperation(scope: D.IdempotencyScope, key: string) {
        const row = this.database.prepare("SELECT operation_id FROM catalog_commands WHERE scope=? AND key=?").get(D.canonicalJson(scope), key) as {
            operation_id: string;
        } | undefined;
        return row ? this.load<D.Operation>("operation", row.operation_id) : null;
    }
    async getAuthority(scope: D.CustomerScope, principal: D.Principal) { return this.authority(scope, principal); }
    async updateAuthority(input: Input<"updateAuthority">) {
        return this.transaction(() => {
            this.permit(input.principal, "credential:manage", { customerId: input.scope.customerId }, input.authorization);
            const existing = this.load<CredentialAuthority>("authority", input.authority.credentialId);
            if ((existing?.credentialVersion ?? null) !== input.expectedCredentialVersion || (existing?.permissionEpoch ?? 0) !== input.expectedPermissionEpoch)
                fail("VERSION_CONFLICT", "Authority version changed");
            if (input.authority.customerId !== input.scope.customerId && !(input.principal.kind === "administrator" && input.authority.customerId === null))
                fail("FORBIDDEN", "Authority belongs to another customer");
            if (existing && (existing.actorId !== input.authority.actorId || existing.customerId !== input.authority.customerId))
                fail("FORBIDDEN", "Authority identity is immutable");
            if (input.authority.credentialVersion !== (input.expectedCredentialVersion ?? 0) + 1 || input.authority.permissionEpoch !== input.expectedPermissionEpoch + 1 || input.authority.policyVersion < (existing?.policyVersion ?? 1))
                fail("INVALID_REQUEST", "Authority updates must advance credential and permission epochs");
            if (input.authority.grants.some(g => g.customerId !== input.scope.customerId))
                fail("FORBIDDEN", "Grant customer does not match update scope");
            bindCredentialSource(this.database, input.authority);
            this.write("authority", input.authority.credentialId, { customerId: (input.authority.customerId ?? "") as D.CustomerId }, input.authority);
            return input.authority;
        });
    }
    async claimWorkspaceCreation(input: Input<"claimWorkspaceCreation">) {
        return this.transaction(() => {
            const { intent, principal, command } = input;
            const scope = scopeOf(intent.workspace);
            const customer = { customerId: scope.customerId };
            this.command(command, principal, customer, "workspace:create");
            this.permit(principal, "workspace:create", customer, input.authorization);
            const replay = this.replay<D.Workspace | null>(command, principal);
            if (replay) {
                if (replay.operation.kind !== "workspace:create" || !same(replay.operation.intent.request, intent.request))
                    fail("IDEMPOTENCY_KEY_REUSED", "Creation retry must preserve the original request");
                return { operation: replay.operation, replayed: true };
            }
            if (intent.schemaVersion !== 1 || intent.kind !== "workspace:create" || intent.request.method !== "POST" || intent.request.path !== "/v1/workspaces" || intent.request.body.customerId !== scope.customerId || intent.request.body.name !== intent.workspace.name || intent.workspace.status !== "active" || intent.workspace.version !== 1 || !same(intent.binding.scope, scope) || intent.binding.id !== intent.workspace.storageBindingId || intent.binding.generation !== intent.workspace.bindingGeneration || intent.binding.status !== "active" || !same(intent.candidateIdentity.scope, bindingOf(intent.workspace)) || intent.candidateIdentity.parentRevisionId !== null || intent.candidateIdentity.revisionId !== intent.workspace.currentRevisionId || intent.candidateIdentity.operationId !== command.operationId || intent.initialManifest.entries.length !== 0 || D.manifestDigest(intent.initialManifest) !== intent.initialManifestDigest)
                fail("INVALID_REQUEST", "Creation intent does not match request, draft binding, and empty candidate");
            if (this.load("workspace", scope.workspaceId) || this.all<D.WorkspaceCreationOperation>("operation", scope).some(o => o.kind === "workspace:create" && o.state === "processing"))
                fail("VERSION_CONFLICT", "Workspace identity is already claimed");
            this.validClaim(input.claim, input.now);
            const operation = { ...this.operation(command, principal, scope, null), kind: "workspace:create", runId: null, intent, claim: input.claim } as D.WorkspaceCreationOperation;
            this.candidate(intent.candidateIdentity);
            this.saveCommand(operation, null);
            return { operation, replayed: false };
        });
    }
    private validClaim(claim: D.ProcessingClaim, now: string): void {
        if (!claim.ownerId || !Number.isSafeInteger(claim.fence) || claim.fence < 1 || claim.expiresAt <= now)
            fail("INVALID_REQUEST", "Processing claim must have a positive fence and future expiry");
    }
    async acceptWorkspaceCreation(input: Input<"acceptWorkspaceCreation">) {
        return this.transaction(() => {
            const existing = this.load<D.Operation>("operation", input.operationId, input.scope);
            if (existing && existing.kind !== "workspace:create")
                fail("INVALID_TRANSITION", "Operation is not workspace creation");
            if (existing?.state === "succeeded") {
                if (existing.claim?.fence !== input.processingFence)
                    fail("STALE_FENCE", "Completed creation fence does not match");
                if (!same(existing.candidate, input.initialRevision))
                    fail("RECEIPT_MISMATCH", "Creation replay candidate does not match");
                this.permit(existing.principal, "workspace:create", { customerId: existing.scope.customerId }, input.authorization);
                return this.replay<D.Workspace>(existing.command, existing.principal) as CommandResult<D.Workspace, D.WorkspaceCreationOperation>;
            }
            const operation = this.processing(input);
            if (operation.kind !== "workspace:create")
                fail("INVALID_TRANSITION", "Operation is not workspace creation");
            this.permit(operation.principal, "workspace:create", { customerId: input.scope.customerId }, input.authorization);
            this.matchCandidate(operation.intent.candidateIdentity, input.initialRevision, operation.intent.initialManifestDigest);
            if (!same(operation.scope, input.scope))
                fail("FORBIDDEN", "Creation scope changed");
            const workspace = operation.intent.workspace;
            this.prepared(input.initialRevision);
            this.write("workspace", workspace.id, scopeOf(workspace), workspace, true);
            this.write("binding", operation.intent.binding.id, operation.scope, operation.intent.binding, true);
            const revision = this.revision(input.initialRevision, input.now);
            this.write("revision", revision.id, operation.scope, revision, true);
            operation.candidate = input.initialRevision;
            operation.state = "succeeded";
            operation.phase = "complete";
            operation.version++;
            operation.updatedAt = input.now;
            operation.result = { kind: "workspace:create", workspaceId: workspace.id, revisionId: revision.id };
            this.saveOutcome(operation, workspace);
            this.events(input.events, operation);
            return { value: workspace, operation, replayed: false };
        });
    }
    async failWorkspaceCreation(input: Input<"failWorkspaceCreation">) {
        return this.transaction(() => {
            const operation = this.processing(input);
            if (operation.kind !== "workspace:create")
                fail("INVALID_TRANSITION", "Operation is not creation");
            if (this.load("workspace", operation.scope.workspaceId, operation.scope))
                fail("PUBLICATION_OUTCOME_UNKNOWN", "Workspace already exists; reconcile acceptance");
            if (!same(input.cleanup.scope, operation.scope) || input.cleanup.runId !== null || input.cleanup.state !== "pending" || input.cleanup.claim !== null)
                fail("INVALID_REQUEST", "Creation cleanup must be independent pending work");
            if (this.database.prepare("SELECT id FROM catalog_records WHERE kind='run' AND json_extract(data,'$.cleanupId')=?").get(input.cleanup.id))
                fail("VERSION_CONFLICT", "Cleanup identity is reserved by an existing run");
            operation.state = "failed";
            operation.phase = "complete";
            operation.version++;
            operation.updatedAt = input.now;
            operation.error = { code: input.code, message: input.message, retryable: false };
            this.saveOutcome(operation, null);
            this.write("cleanup", input.cleanup.id, operation.scope, input.cleanup, true);
            this.write("cleanup-owner", input.cleanup.id, operation.scope, { operationId: operation.id }, true);
            this.events(input.events, operation);
            return operation;
        });
    }
    async openRun(input: Input<"openRun">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "run:open");
            this.permit(input.principal, input.mode === "read-only" ? "run:open-read" : "run:open-write", input.scope, input.authorization);
            const replay = this.replay<D.Run>(input.command, input.principal);
            if (replay)
                return replay;
            const workspace = this.workspace(input.scope);
            if (input.expiresAt <= input.createdAt)
                fail("INVALID_REQUEST", "Run lease must expire in the future");
            if (input.mode === "read-write" && this.all<D.StorageMigration>("migration", input.scope).some(m => !["complete", "failed"].includes(m.state)))
                fail("FINALIZATION_IN_PROGRESS", "Storage migration is draining mutable runs");
            const run: D.Run = { id: input.runId, scope: bindingOf(workspace), principal: input.principal, agentLabel: input.agentLabel, task: input.task, reason: input.reason, mode: input.mode, baseRevisionId: workspace.currentRevisionId, workspaceVersionAtOpen: workspace.version, version: 1, state: "active", lease: { version: 1, expiresAt: input.expiresAt, lastHeartbeatAt: input.createdAt }, operationId: null, outcome: null, cleanupId: input.cleanupId, createdAt: input.createdAt, updatedAt: input.createdAt };
            if (this.load("cleanup", run.cleanupId) || this.database.prepare("SELECT id FROM catalog_records WHERE kind='run' AND json_extract(data,'$.cleanupId')=?").get(run.cleanupId))
                fail("VERSION_CONFLICT", "Cleanup identity is already used");
            this.write("run", run.id, input.scope, run, true, run.id);
            const operation = this.operation(input.command, input.principal, input.scope, run.id, { kind: "run:open", runId: run.id });
            const event = { scope: input.scope, runId: run.id, operationId: operation.id, actorId: input.principal.actorId, type: "run.started", payload: { agentId: run.agentLabel }, createdAt: input.createdAt };
            this.events({ audit: { ...event, id: `audit-${operation.id}` as D.EventId }, outbox: { ...event, id: `outbox-${operation.id}` as D.EventId, deliveryState: "pending", version: 1, attempts: 0, nextAttemptAt: input.createdAt, claim: null } }, operation);
            return this.saveCommand(operation, run);
        });
    }
    async transitionWorkspaceStatus(input: Input<"transitionWorkspaceStatus">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "workspace:status");
            const action = input.transition.to === "deleted" ? "workspace:delete" : "workspace:admin";
            this.permit(input.principal, action, input.scope, input.authorization);
            const replay = this.replay<D.Workspace>(input.command, input.principal);
            if (replay)
                return replay;
            const workspace = this.workspace(input.scope, false);
            if (workspace.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Workspace version changed");
            if (workspace.status !== input.transition.from || input.transition.from === input.transition.to)
                fail("INVALID_TRANSITION", "Workspace transition is invalid");
            workspace.status = input.transition.to;
            workspace.version++;
            workspace.updatedAt = input.now;
            const operation = this.operation(input.command, input.principal, input.scope, null, { kind: "workspace:status", workspaceId: workspace.id, status: workspace.status });
            this.write("workspace", workspace.id, input.scope, workspace);
            const result = this.saveCommand(operation, workspace);
            this.events(input.events, operation);
            if (workspace.status === "deleted")
                this.write("cleanup", `workspace:${workspace.id}:${workspace.version}`, input.scope, { id: `workspace:${workspace.id}:${workspace.version}`, scope: input.scope, runId: null, state: "pending", version: 1, attempts: 0, claim: null, nextAttemptAt: input.now, lastError: null }, true);
            return result;
        });
    }
    async renewRunLease(input: Input<"renewRunLease">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "run:heartbeat", input.scope.runId);
            const replay = this.replay<D.Run>(input.command, input.principal);
            if (replay) {
                this.permit(input.principal, "run:heartbeat", { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId });
                return replay;
            }
            const run = this.run(input.scope, input.principal, "run:heartbeat");
            this.active(run, input.now);
            if (run.lease.version !== input.expectedLeaseVersion)
                fail("VERSION_CONFLICT", "Run lease version changed");
            if (input.expiresAt <= input.now || input.expiresAt < run.lease.expiresAt)
                fail("INVALID_REQUEST", "Heartbeat cannot shorten or revive a lease");
            run.lease = { version: run.lease.version + 1, expiresAt: input.expiresAt, lastHeartbeatAt: input.now };
            run.updatedAt = input.now;
            this.write("run", run.id, run.scope, run, false, run.id);
            return this.saveCommand(this.operation(input.command, input.principal, { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId }, run.id, { kind: "run:heartbeat", runId: run.id, leaseVersion: run.lease.version }), run);
        });
    }
    async recordLegacyPush(input: Input<"recordLegacyPush">) {
        this.transaction(() => {
            const scope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
            this.command(input.command, input.principal, input.scope, "finalize", input.scope.runId);
            this.permit(input.principal, "run:finalize", scope, input.authorization);
            const id = D.canonicalJson([input.command.idempotencyScope, input.command.idempotencyKey]);
            const value = { kind: "legacy-push", runId: input.scope.runId, requestDigest: input.command.requestDigest };
            const run = this.run(input.scope, input.principal);
            const existing = this.load("compatibility-publication", id, scope);
            if (existing) {
                if (!same(existing, value)) fail("IDEMPOTENCY_KEY_REUSED", "Legacy publication metadata differs from the original command");
                return;
            }
            this.active(run, input.command.requestedAt);
            this.write("compatibility-publication", id, scope, value, true, input.scope.runId);
        });
    }
    async claimFinalization(input: Input<"claimFinalization">) {
        return this.transaction(() => {
            const workspaceScope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
            this.command(input.command, input.principal, input.scope, "finalize", input.scope.runId);
            this.permit(input.principal, "run:finalize", workspaceScope, input.authorization);
            const replay = this.replay<D.Run>(input.command, input.principal);
            if (replay) {
                if (replay.operation.kind !== "finalize" || !same(replay.operation.intent.request, input.intent.request))
                    fail("IDEMPOTENCY_KEY_REUSED", "Finalization retry must preserve the original request");
                return replay as CommandResult<D.Run, D.FinalizationOperation>;
            }
            const run = this.run(input.scope, input.principal);
            this.active(run, input.now);
            if (run.version !== input.expectedRunVersion)
                fail("VERSION_CONFLICT", "Run lifecycle version changed");
            const intent = input.intent;
            if (intent.schemaVersion !== 1 || intent.kind !== "finalize" || intent.mode !== run.mode || intent.request.method !== "POST" || intent.request.path !== `/v1/runs/${run.id}/finalize` || intent.request.body.expectedRunVersion !== input.expectedRunVersion)
                fail("INVALID_REQUEST", "Finalization request does not match the run and lifecycle version");
            if (intent.mode === "read-write") {
                const submission = this.load<D.Submission>("submission", intent.source.submissionId, input.scope);
                if (!submission || !same(submission.scope, input.scope))
                    fail("SUBMISSION_NOT_FOUND", "Selected submission does not belong to this run");
                if (submission.state !== "sealed" || submission.expiresAt <= input.now || submission.version !== intent.source.submissionVersion || submission.manifestDigest !== intent.source.manifestDigest || submission.id !== intent.request.body.submissionId || !submission.manifest || D.manifestDigest(submission.manifest) !== submission.manifestDigest)
                    fail("RECEIPT_MISMATCH", "Finalization must select the exact current sealed submission");
                if (!same(intent.candidateIdentity.scope, run.scope) || intent.candidateIdentity.parentRevisionId !== run.baseRevisionId || intent.candidateIdentity.operationId !== input.command.operationId)
                    fail("RECEIPT_MISMATCH", "Candidate identity does not match run base, operation, and binding");
                this.candidate(intent.candidateIdentity);
            }
            else if (intent.source !== null || intent.candidateIdentity !== null || "submissionId" in intent.request.body)
                fail("INVALID_REQUEST", "Read-only finalization cannot select a submission");
            this.validClaim(input.claim, input.now);
            const operation = { ...this.operation(input.command, input.principal, workspaceScope, run.id), kind: "finalize", runId: run.id, intent, claim: input.claim } as D.FinalizationOperation;
            run.state = "finalizing";
            run.version++;
            run.operationId = operation.id;
            run.updatedAt = input.now;
            this.write("run", run.id, run.scope, run, false, run.id);
            return this.saveCommand(operation, run) as CommandResult<D.Run, D.FinalizationOperation>;
        });
    }
    async abortRun(input: Input<"abortRun">) {
        return this.transaction(() => {
            const scope = { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId };
            this.command(input.command, input.principal, input.scope, "abort", input.scope.runId);
            this.permit(input.principal, "run:abort", scope, input.authorization);
            const replay = this.replay<D.Run>(input.command, input.principal);
            if (replay)
                return replay;
            const run = this.run(input.scope, input.principal);
            this.active(run, input.now);
            if (run.version !== input.expectedRunVersion)
                fail("VERSION_CONFLICT", "Run lifecycle version changed");
            const operation = this.operation(input.command, input.principal, scope, run.id, { kind: "abort", runState: "aborted", revisionId: null, changed: false });
            run.state = "aborted";
            run.version++;
            run.operationId = operation.id;
            run.updatedAt = input.now;
            run.outcome = { state: "aborted", revisionId: null, changed: false, completedAt: input.now };
            this.write("run", run.id, run.scope, run, false, run.id);
            this.cleanup(run, input.now);
            const result = this.saveCommand(operation, run);
            this.events(input.events, operation);
            return result;
        });
    }
    async recordPreparedRevision(input: Input<"recordPreparedRevision">) {
        return this.transaction(() => {
            const operation = this.processing(input);
            if (operation.kind !== "finalize" && operation.kind !== "workspace:create")
                fail("INVALID_TRANSITION", "Operation cannot prepare a revision");
            if (operation.kind === "finalize" && operation.intent.mode !== "read-write")
                fail("INVALID_TRANSITION", "Read-only operations have no candidate");
            const identity = operation.kind === "workspace:create" ? operation.intent.candidateIdentity : operation.intent.candidateIdentity;
            const manifest = operation.kind === "workspace:create" ? operation.intent.initialManifestDigest : operation.intent.source?.manifestDigest;
            if (!identity || !manifest)
                fail("INVALID_TRANSITION", "Operation does not have a candidate");
            this.matchCandidate(identity, input.candidate, manifest);
            if (operation.candidate && !same(operation.candidate, input.candidate))
                fail("RECEIPT_MISMATCH", "Prepared revision is immutable");
            if (operation.candidate)
                return operation;
            this.prepared(input.candidate);
            operation.candidate = input.candidate;
            operation.phase = "prepared";
            operation.version++;
            operation.updatedAt = input.now;
            this.write("operation", operation.id, operation.scope, operation, false, operation.runId);
            return operation;
        });
    }
    private finalizer(input: Input<"acceptRevision"> | Input<"completeReadOnly">, now: string): {
        operation: D.FinalizationOperation;
        run: D.Run;
        workspace: D.Workspace;
    } {
        const operation = this.processing({ scope: input.scope, operationId: input.operationId, expectedOperationVersion: input.expectedOperationVersion, processingFence: input.processingFence, now });
        if (operation.kind !== "finalize" || operation.runId !== input.scope.runId)
            fail("INVALID_TRANSITION", "Operation does not finalize this run");
        this.permit(operation.principal, "run:finalize", { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId }, input.authorization);
        const run = this.run(input.scope, operation.principal);
        if (run.state !== "finalizing" || run.operationId !== operation.id)
            fail("INVALID_TRANSITION", "Run is not owned by this finalization");
        if (run.version !== input.expectedRunVersion)
            fail("VERSION_CONFLICT", "Run lifecycle version changed");
        if (input.expectedBindingGeneration !== run.scope.bindingGeneration)
            fail("STORAGE_BINDING_CHANGED", "Finalizer binding changed");
        return { operation, run, workspace: this.workspace(input.scope) };
    }
    private publicationReplay(input: Input<"acceptRevision"> | Input<"completeReadOnly">): {
        run: D.Run;
        revision: D.Revision;
        operation: D.Operation;
    } | null {
        const operation = this.load<D.Operation>("operation", input.operationId, input.scope);
        if (operation?.state !== "succeeded")
            return null;
        if (operation.kind !== "finalize" || operation.runId !== input.scope.runId || operation.claim?.fence !== input.processingFence)
            fail("STALE_FENCE", "Completed finalizer identity does not match");
        this.permit(operation.principal, "run:finalize", operation.scope, input.authorization);
        if ("candidate" in input && !same(operation.candidate, input.candidate))
            fail("RECEIPT_MISMATCH", "Replay candidate does not match the accepted operation");
        const replay = this.replay<D.Run>(operation.command, operation.principal)!;
        if (replay.value.version !== input.expectedRunVersion + 1 || !replay.value.outcome?.revisionId)
            fail("VERSION_CONFLICT", "Completed finalizer lifecycle does not match");
        const revision = this.load<D.Revision>("revision", replay.value.outcome.revisionId, operation.scope);
        if (!revision)
            throw new Error("Accepted revision is absent");
        return { run: replay.value, revision, operation };
    }
    private completeFinalization(operation: D.FinalizationOperation, run: D.Run, revision: D.Revision, changed: boolean, events: PublicationEvents, now: string) {
        run.state = "finalized";
        run.version++;
        run.updatedAt = now;
        run.outcome = { state: "finalized", revisionId: revision.id, changed, completedAt: now };
        operation.state = "succeeded";
        operation.phase = "complete";
        operation.version++;
        operation.updatedAt = now;
        operation.result = { kind: "finalize", runState: "finalized", revisionId: revision.id, changed };
        this.write("run", run.id, run.scope, run, false, run.id);
        this.cleanup(run, now);
        this.saveOutcome(operation, run);
        this.events(events, operation);
        return { run, revision, operation };
    }
    async acceptRevision(input: Input<"acceptRevision">) {
        return this.transaction(() => {
            const replay = this.publicationReplay(input);
            if (replay)
                return replay;
            const { operation, run, workspace } = this.finalizer(input, input.acceptedAt);
            if (run.mode !== "read-write" || operation.intent.mode !== "read-write")
                fail("INVALID_TRANSITION", "Only read-write runs publish revisions");
            if (input.expectedHeadRevisionId !== run.baseRevisionId || input.expectedWorkspaceVersion !== run.workspaceVersionAtOpen || workspace.currentRevisionId !== run.baseRevisionId || workspace.version !== run.workspaceVersionAtOpen)
                fail("REVISION_CONFLICT", "Accepted workspace changed since run open");
            if (input.submissionId !== operation.intent.source.submissionId)
                fail("RECEIPT_MISMATCH", "Selected submission changed");
            const submission = this.load<D.Submission>("submission", input.submissionId, input.scope);
            if (!submission || !same(submission.scope, input.scope) || submission.state !== "sealed" || submission.version !== operation.intent.source.submissionVersion || submission.manifestDigest !== operation.intent.source.manifestDigest)
                fail("RECEIPT_MISMATCH", "Sealed source no longer matches persisted finalization intent");
            this.matchCandidate(operation.intent.candidateIdentity, input.candidate, operation.intent.source.manifestDigest);
            if (!operation.candidate || !same(operation.candidate, input.candidate))
                fail("RECEIPT_MISMATCH", "Acceptance must use the exact recorded prepared revision");
            const base = this.load<D.Revision>("revision", run.baseRevisionId, run.scope);
            if (!base)
                fail("REVISION_NOT_FOUND", "Pinned base revision does not exist");
            const changed = base.manifestDigest !== input.candidate.manifestDigest;
            const revision = changed ? this.revision(input.candidate, input.acceptedAt) : base;
            if (changed) {
                this.write("revision", revision.id, run.scope, revision, true);
                workspace.currentRevisionId = revision.id;
                workspace.version++;
                workspace.updatedAt = input.acceptedAt;
                this.write("workspace", workspace.id, run.scope, workspace);
            }
            return this.completeFinalization(operation, run, revision, changed, input.events, input.acceptedAt);
        });
    }
    async completeReadOnly(input: Input<"completeReadOnly">) {
        return this.transaction(() => {
            const replay = this.publicationReplay(input);
            if (replay)
                return replay;
            const { operation, run } = this.finalizer(input, input.completedAt);
            if (run.mode !== "read-only" || operation.intent.mode !== "read-only")
                fail("INVALID_TRANSITION", "Only read-only runs use pinned read completion");
            const revision = this.load<D.Revision>("revision", run.baseRevisionId, run.scope);
            if (!revision)
                fail("REVISION_NOT_FOUND", "Pinned base revision does not exist");
            return this.completeFinalization(operation, run, revision, false, input.events, input.completedAt);
        });
    }
    async failFinalization(input: Input<"failFinalization">) {
        return this.transaction(() => {
            const operation = this.processing(input);
            if (operation.kind !== "finalize")
                fail("INVALID_TRANSITION", "Operation is not finalization");
            const run = this.load<D.Run>("run", operation.runId, operation.scope);
            if (!run || run.state !== "finalizing" || run.operationId !== operation.id)
                fail("PUBLICATION_OUTCOME_UNKNOWN", "Finalization outcome requires reconciliation");
            if (this.all<D.Revision>("revision", operation.scope).some(r => r.originatingOperationId === operation.id))
                fail("PUBLICATION_OUTCOME_UNKNOWN", "Candidate already has an accepted revision");
            const state = input.code === "REVISION_CONFLICT" ? "conflicted" : "failed";
            run.state = state;
            run.version++;
            run.updatedAt = input.now;
            run.outcome = { state, revisionId: null, changed: false, completedAt: input.now, errorCode: input.code };
            operation.state = "failed";
            operation.phase = "complete";
            operation.version++;
            operation.updatedAt = input.now;
            operation.error = { code: input.code, message: input.message, retryable: false };
            operation.result = { kind: "finalize", runState: state, revisionId: null, changed: false };
            this.write("run", run.id, run.scope, run, false, run.id);
            this.cleanup(run, input.now);
            this.saveOutcome(operation, run);
            this.events(input.events, operation);
            return operation;
        });
    }
    async listRecoverableOperations(input: Input<"listRecoverableOperations">) {
        const limit = this.limit(input.limit);
        const kinds = [...new Set(input.kinds ?? ["workspace:create", "finalize"])];
        if (!kinds.length) return [];
        if (kinds.length > 64 || kinds.some(kind => typeof kind !== "string" || !/^[a-z][a-z:-]{0,63}$/.test(kind))) fail("INVALID_REQUEST", "Recovery kinds must be bounded use-case names");
        return (this.database.prepare(`SELECT data FROM catalog_records WHERE kind='operation' AND json_extract(data,'$.kind') IN (${kinds.map(() => "?").join(",")}) AND json_extract(data,'$.state')='processing' AND json_extract(data,'$.claim.expiresAt')<=? ORDER BY id LIMIT ?`).all(...kinds, input.now, limit) as {
            data: string;
        }[]).map(row => JSON.parse(row.data) as D.Operation);
    }
    private limit(limit: number): number {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            fail("INVALID_REQUEST", "Scan limit must be between 1 and 1000");
        return limit;
    }
    async claimRecovery(input: Input<"claimRecovery">) {
        return this.transaction(() => {
            const operation = this.load<D.Operation>("operation", input.operationId, input.scope);
            if (!operation)
                fail("OPERATION_NOT_FOUND", "Operation does not exist");
            if (input.kind ? operation.kind !== input.kind : operation.kind !== "workspace:create" && operation.kind !== "finalize")
                fail("INVALID_TRANSITION", "Operation requires its explicitly registered recovery kind");
            if (operation.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Operation version changed");
            if (operation.state !== "processing" || !operation.claim || operation.claim.expiresAt > input.now)
                fail("STALE_FENCE", "Operation is not recoverable");
            const candidate = operation.intent.candidateIdentity;
            if (candidate && this.load<CandidateRecord>("candidate", candidate.candidateId, candidate.scope)?.collection)
                fail("STALE_FENCE", "Candidate is fenced for collection");
            const claim = { ownerId: input.ownerId, fence: operation.claim.fence + 1, expiresAt: input.expiresAt };
            this.validClaim(claim, input.now);
            operation.claim = claim;
            operation.version++;
            operation.updatedAt = input.now;
            this.write("operation", operation.id, operation.scope, operation, false, operation.runId);
            return operation;
        });
    }
    async renewProcessingClaim(input: Input<"renewProcessingClaim">) {
        return this.transaction(() => {
            const operation = this.processing(input);
            if (!operation.claim || input.expiresAt <= operation.claim.expiresAt || input.expiresAt <= input.now)
                fail("INVALID_REQUEST", "Processing renewal must extend an active claim");
            operation.claim.expiresAt = input.expiresAt;
            operation.version++;
            operation.updatedAt = input.now;
            this.write("operation", operation.id, operation.scope, operation, false, operation.runId);
            return operation;
        });
    }
    async listExpiredActiveRuns(input: Input<"listExpiredActiveRuns">) {
        const limit = this.limit(input.limit);
        const runs = (this.database.prepare("SELECT data FROM catalog_records WHERE kind='run' AND json_extract(data,'$.state')='active' AND json_extract(data,'$.lease.expiresAt')<=? AND id>? ORDER BY id LIMIT ?").all(input.now, input.cursor ?? "", limit + 1) as {
            data: string;
        }[]).map(row => JSON.parse(row.data) as D.Run);
        const more = runs.length > limit;
        if (more)
            runs.pop();
        return { runs: runs.map(run => ({ scope: { ...run.scope, runId: run.id }, expectedState: "active" as const, expectedRunVersion: run.version, expectedLeaseVersion: run.lease.version, expectedLeaseExpiresAt: run.lease.expiresAt })), nextCursor: more ? runs[runs.length - 1].id : null };
    }
    async expireActiveRun(input: Input<"expireActiveRun">) {
        return this.transaction(() => {
            const run = this.load<D.Run>("run", input.scope.runId, input.scope);
            if (!run || !same(run.scope, { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId, storageBindingId: input.scope.storageBindingId, bindingGeneration: input.scope.bindingGeneration }))
                fail("RUN_NOT_FOUND", "Run does not exist in this binding scope");
            if (input.expectedState !== "active" || run.state !== "active" || run.version !== input.expectedRunVersion || run.lease.version !== input.expectedLeaseVersion || run.lease.expiresAt !== input.expectedLeaseExpiresAt)
                fail("VERSION_CONFLICT", "Active run or lease changed before expiry");
            if (run.lease.expiresAt > input.now)
                fail("INVALID_TRANSITION", "Run lease has not expired");
            const eventOperation = { id: input.events.audit.operationId, scope: { customerId: run.scope.customerId, workspaceId: run.scope.workspaceId }, runId: run.id, principal: { actorId: input.events.audit.actorId } };
            run.state = "expired";
            run.version++;
            run.updatedAt = input.now;
            run.outcome = { state: "expired", revisionId: null, changed: false, completedAt: input.now, errorCode: "RUN_EXPIRED" };
            this.write("run", run.id, run.scope, run, false, run.id);
            const cleanup = this.cleanup(run, input.now);
            this.events(input.events, eventOperation);
            return { run, cleanup };
        });
    }
    async createSubmission(input: Input<"createSubmission">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "submission:create", input.scope.runId);
            const replay = this.replay<D.Submission>(input.command, input.principal);
            if (replay) {
                this.permit(input.principal, "run:upload", { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId });
                return replay;
            }
            const run = this.run(input.scope, input.principal, "run:upload");
            this.active(run, input.command.requestedAt);
            if (run.mode !== "read-write")
                fail("FORBIDDEN", "Read-only runs cannot upload");
            if (input.expiresAt <= input.command.requestedAt)
                fail("INVALID_REQUEST", "Submission must expire in the future");
            const submission: D.Submission = { id: input.submissionId, scope: input.scope, state: "uploading", version: 1, expiresAt: input.expiresAt, manifest: null, manifestDigest: null, receipts: [], createdAt: input.command.requestedAt, sealedAt: null };
            this.write("submission", submission.id, run.scope, submission, true, run.id);
            return this.saveCommand(this.operation(input.command, input.principal, { customerId: run.scope.customerId, workspaceId: run.scope.workspaceId }, run.id, { kind: "submission:create", submissionId: submission.id }), submission);
        });
    }
    async getSubmission(scope: D.RunScope, id: D.SubmissionId) { const submission = this.load<D.Submission>("submission", id, scope); return submission && same(submission.scope, scope) ? submission : null; }
    async getReceipt(scope: D.RunScope, submissionId: D.SubmissionId, id: D.ReceiptId) { const receipt = this.load<D.UploadReceipt>("receipt", id, scope); return receipt && receipt.submissionId === submissionId && same(receipt.scope, scope) ? receipt : null; }
    async isUploadReceiptRetired(receipt: D.UploadReceipt, storageMarker?: unknown): Promise<boolean> {
        return this.transaction(() => {
            const recorded = this.load<D.UploadReceipt>("receipt", receipt.id, receipt.scope);
            const submission = this.load<D.Submission>("submission", receipt.submissionId, receipt.scope);
            const collection = this.load<SubmissionCollectionState>("submission-collection", receipt.submissionId, receipt.scope);
            if (!recorded || !same(recorded, receipt) || !submission || submission.state !== "expired" || !same(submission.scope, receipt.scope)
                || !collection || !same(collection.permit.scope, receipt.scope) || collection.permit.submissionId !== receipt.submissionId || collection.permit.submissionVersion !== submission.version) return false;
            if (collection.cursor && compareCursor(collection.cursor, `receipt:${receipt.id}`) >= 0) return true;
            // A completed deletion can precede its catalog acknowledgment. Permanent fencing survives permit expiry.
            return storageMarker !== undefined && same(storageMarker, { scope: receipt.scope, submissionId: receipt.submissionId, attemptKey: receipt.privateReference.opaqueKey, storeId: receipt.privateReference.storeId });
        });
    }
    private writableSubmission(scope: D.RunScope, id: D.SubmissionId, expectedVersion: number, now: string): D.Submission {
        const submission = this.load<D.Submission>("submission", id, scope);
        if (!submission || !same(submission.scope, scope))
            fail("SUBMISSION_NOT_FOUND", "Submission does not belong to this run");
        if (submission.state !== "uploading")
            fail(submission.state === "sealed" ? "SUBMISSION_SEALED" : "RUN_EXPIRED", "Submission is no longer writable");
        if (submission.expiresAt <= now)
            fail("RUN_EXPIRED", "Submission expired");
        if (submission.version !== expectedVersion)
            fail("VERSION_CONFLICT", "Submission version changed");
        return submission;
    }
    async registerUploadReceipt(input: Input<"registerUploadReceipt">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "submission:file", input.scope.runId);
            const replay = this.replay<D.UploadReceipt>(input.command, input.principal);
            if (replay) {
                this.permit(input.principal, "run:upload", { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId });
                return replay;
            }
            const run = this.run(input.scope, input.principal, "run:upload");
            this.active(run, input.now);
            if (run.mode !== "read-write")
                fail("FORBIDDEN", "Read-only runs cannot upload");
            const receipt = input.receipt;
            if (!same(receipt.scope, input.scope))
                fail("FORBIDDEN", "Receipt scope does not match run");
            const submission = this.writableSubmission(input.scope, receipt.submissionId, input.expectedSubmissionVersion, input.now);
            D.canonicalizeManifest({ schemaVersion: 1, entries: [{ path: receipt.path, kind: "file", byteLength: receipt.byteLength, sha256: receipt.sha256 }] });
            if (!receipt.privateReference.opaqueKey || !receipt.privateReference.storeId)
                fail("INVALID_REQUEST", "Receipt requires immutable storage identity");
            if (this.all<D.UploadReceipt>("receipt", input.scope).some(r => same(r.privateReference, receipt.privateReference)))
                fail("RECEIPT_MISMATCH", "Each upload attempt must have distinct immutable bytes");
            this.write("receipt", receipt.id, run.scope, receipt, true, run.id);
            submission.version++;
            this.write("submission", submission.id, run.scope, submission, false, run.id);
            return this.saveCommand(this.operation(input.command, input.principal, { customerId: run.scope.customerId, workspaceId: run.scope.workspaceId }, run.id, { kind: "submission:file", receiptId: receipt.id }), receipt);
        });
    }
    async sealSubmission(input: Input<"sealSubmission">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "submission:seal", input.scope.runId);
            const replay = this.replay<D.Submission>(input.command, input.principal);
            if (replay) {
                this.permit(input.principal, "run:upload", { customerId: input.scope.customerId, workspaceId: input.scope.workspaceId });
                return replay;
            }
            const run = this.run(input.scope, input.principal, "run:upload");
            this.active(run, input.now);
            if (run.mode !== "read-write")
                fail("FORBIDDEN", "Read-only runs cannot seal");
            const submission = this.writableSubmission(input.scope, input.submissionId, input.expectedSubmissionVersion, input.now);
            const manifest = D.canonicalizeManifest(input.manifest);
            if (D.manifestDigest(manifest) !== input.manifestDigest)
                fail("RECEIPT_MISMATCH", "Manifest digest does not match canonical manifest");
            const files = manifest.entries.filter(entry => entry.kind === "file");
            if (files.length !== input.receipts.length || new Set(input.receipts.map(r => r.path)).size !== files.length || new Set(input.receipts.map(r => r.receiptId)).size !== files.length)
                fail("RECEIPT_MISMATCH", "Every manifest file needs exactly one distinct receipt");
            for (const entry of files) {
                const selected = input.receipts.find(r => r.path === entry.path);
                const receipt = selected ? this.load<D.UploadReceipt>("receipt", selected.receiptId, input.scope) : null;
                if (!receipt || !same(receipt.scope, input.scope) || receipt.submissionId !== submission.id || receipt.path !== entry.path || receipt.byteLength !== entry.byteLength || receipt.sha256 !== entry.sha256)
                    fail("RECEIPT_MISMATCH", "Selected receipt does not match exact file metadata and submission");
            }
            submission.state = "sealed";
            submission.version++;
            submission.manifest = manifest;
            submission.manifestDigest = input.manifestDigest;
            submission.receipts = [...input.receipts];
            submission.sealedAt = input.now;
            this.write("submission", submission.id, run.scope, submission, false, run.id);
            return this.saveCommand(this.operation(input.command, input.principal, { customerId: run.scope.customerId, workspaceId: run.scope.workspaceId }, run.id, { kind: "submission:seal", submissionId: submission.id, manifestDigest: input.manifestDigest }), submission);
        });
    }
    async expireSubmission(input: Input<"expireSubmission">) {
        return this.transaction(() => {
            const submission = this.load<D.Submission>("submission", input.submissionId, input.scope);
            if (!submission || !same(submission.scope, input.scope))
                fail("SUBMISSION_NOT_FOUND", "Submission does not exist in this run scope");
            if (submission.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Submission version changed");
            if (this.all<D.Operation>("operation", input.scope).some(o => o.kind === "finalize" && o.runId === input.scope.runId && o.state === "processing" && o.intent.mode === "read-write" && o.intent.source.submissionId === submission.id))
                fail("FINALIZATION_IN_PROGRESS", "Recoverable finalization retains its selected sealed source");
            if (submission.expiresAt > input.now || submission.state === "expired")
                fail("INVALID_TRANSITION", "Submission cannot expire");
            submission.state = "expired";
            submission.version++;
            this.write("submission", submission.id, input.scope, submission, false, input.scope.runId);
            return submission;
        });
    }
    async beginSubmissionWrite(input: Input<"beginSubmissionWrite">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "submission:file", input.scope.runId);
            const run = this.run(input.scope, input.principal, "run:upload");
            this.active(run, input.now);
            if (run.mode !== "read-write") fail("FORBIDDEN", "Read-only runs cannot upload");
            const submission = this.load<D.Submission>("submission", input.submissionId, input.scope);
            if (!submission || !same(submission.scope, input.scope)) fail("SUBMISSION_NOT_FOUND", "Submission does not belong to this run");
            this.writableSubmission(input.scope, submission.id, submission.version, input.now);
            if (this.load("submission-collection", submission.id, input.scope)) fail("STALE_FENCE", "Submission is permanently fenced for collection");
            if (!input.writerId || input.writerId.length > 255 || !input.storeId || input.storeId.length > 1024 || input.attemptKey !== digest({ scope: input.command.idempotencyScope, key: input.command.idempotencyKey })) fail("INVALID_REQUEST", "Upload writer requires exact server-owned identity");
            const writer: D.SubmissionWriter = { id: input.writerId, scope: input.scope, submissionId: input.submissionId, attemptKey: input.attemptKey, storeId: input.storeId, state: "active", startedAt: input.now, finishedAt: null };
            this.write("submission-writer", writer.id, input.scope, writer, true, input.scope.runId);
            return writer;
        });
    }
    async finishSubmissionWrite(input: Input<"finishSubmissionWrite">) {
        return this.transaction(() => {
            const writer = this.load<D.SubmissionWriter>("submission-writer", input.writerId, input.scope);
            if (!writer || writer.submissionId !== input.submissionId || !same(writer.scope, input.scope)) fail("FORBIDDEN", "Upload writer does not belong to this submission");
            if (writer.state === "finished") return writer;
            writer.state = "finished"; writer.finishedAt = input.now;
            this.write("submission-writer", writer.id, writer.scope, writer, false, writer.scope.runId);
            return writer;
        });
    }
    private submissionCollectable(submission: D.Submission, now: D.Timestamp): boolean {
        const run = this.load<D.Run>("run", submission.scope.runId, submission.scope);
        if (!run || !same(run.scope, { customerId: submission.scope.customerId, workspaceId: submission.scope.workspaceId, storageBindingId: submission.scope.storageBindingId, bindingGeneration: submission.scope.bindingGeneration })) return false;
        if (submission.expiresAt > now && ["active", "finalizing"].includes(run.state)) return false;
        if (this.database.prepare("SELECT id FROM catalog_records WHERE kind='submission-writer' AND customer_id=? AND workspace_id=? AND run_id=? AND json_extract(data,'$.submissionId')=? AND json_extract(data,'$.state')='active' LIMIT 1").get(submission.scope.customerId, submission.scope.workspaceId, submission.scope.runId, submission.id)) return false;
        return !this.all<D.Operation>("operation", submission.scope).some(operation => operation.kind === "finalize" && operation.state === "processing" && operation.intent.mode === "read-write" && operation.intent.source.submissionId === submission.id);
    }
    async claimSubmissionCollection(input: Input<"claimSubmissionCollection">) {
        return this.transaction(() => {
            const submission = this.load<D.Submission>("submission", input.submissionId, input.scope);
            if (!submission || !same(submission.scope, input.scope)) fail("SUBMISSION_NOT_FOUND", "Submission does not belong to this run");
            if (!this.submissionCollectable(submission, input.now)) fail("FORBIDDEN", "Active or uncertain writers and recoverable sources retain submission bytes");
            const existing = this.load<SubmissionCollectionState>("submission-collection", submission.id, input.scope);
            if (existing && existing.permit.expiresAt > input.now) fail("STALE_FENCE", "Submission already has a collection claim");
            if (input.expiresAt <= input.now) fail("INVALID_REQUEST", "Collection permit must expire in the future");
            if (submission.state !== "expired") { submission.state = "expired"; submission.version++; this.write("submission", submission.id, submission.scope, submission, false, submission.scope.runId); }
            const permit: D.SubmissionCollectionPermit = { scope: input.scope, submissionId: submission.id, submissionVersion: submission.version, collectionFence: (existing?.permit.collectionFence ?? 0) + 1, expiresAt: input.expiresAt };
            this.write("submission-collection", submission.id, submission.scope, { permit, collectedAt: existing?.collectedAt ?? null, ...(existing?.cursor ? { cursor: existing.cursor } : {}) } satisfies SubmissionCollectionState, false, submission.scope.runId);
            return permit;
        });
    }
    private submissionPermitValid(permit: D.SubmissionCollectionPermit, now: D.Timestamp): boolean {
        const collection = this.load<SubmissionCollectionState>("submission-collection", permit.submissionId, permit.scope);
        const submission = this.load<D.Submission>("submission", permit.submissionId, permit.scope);
        return !!collection && !!submission && same(collection.permit, permit) && same(submission.scope, permit.scope) && permit.expiresAt > now && submission.version === permit.submissionVersion && submission.state === "expired" && this.submissionCollectable(submission, now);
    }
    async verifySubmissionCollectionPermit(permit: D.SubmissionCollectionPermit, now: D.Timestamp) { return this.transaction(() => this.submissionPermitValid(permit, now)); }
    async completeSubmissionCollection(permit: D.SubmissionCollectionPermit, now: D.Timestamp): Promise<void> {
        this.transaction(() => {
            if (!this.submissionPermitValid(permit, now)) fail("STALE_FENCE", "Submission collection fence changed");
            const state = this.load<SubmissionCollectionState>("submission-collection", permit.submissionId, permit.scope)!;
            if (this.submissionAttemptRows(permit, state.cursor ?? "", 1).length) fail("INVALID_TRANSITION", "Submission cleanup still has unacknowledged attempts");
            this.write("submission-collection", permit.submissionId, permit.scope, { ...state, collectedAt: now }, false, permit.scope.runId);
        });
    }
    private submissionAttemptRows(permit: D.SubmissionCollectionPermit, cursor: string, limit: number) {
        const { scope, submissionId } = permit;
        return this.database.prepare("SELECT kind || ':' || id AS cursor,kind,data FROM catalog_records WHERE kind IN ('submission-writer','receipt') AND customer_id=? AND workspace_id=? AND run_id=? AND json_extract(data,'$.submissionId')=? AND kind || ':' || id > ? ORDER BY cursor LIMIT ?").all(scope.customerId, scope.workspaceId, scope.runId, submissionId, cursor, limit) as { cursor: string; kind: string; data: string }[];
    }
    async listSubmissionCollectionAttempts(input: Input<"listSubmissionCollectionAttempts">) {
        return this.transaction(() => {
            if (!this.submissionPermitValid(input.permit, input.now)) fail("STALE_FENCE", "Submission collection fence changed");
            const limit = this.limit(input.limit);
            const state = this.load<SubmissionCollectionState>("submission-collection", input.permit.submissionId, input.permit.scope)!;
            const rows = this.submissionAttemptRows(input.permit, input.cursor ?? state.cursor ?? "", limit + 1);
            const more = rows.length > limit; if (more) rows.pop();
            const attempts: D.SubmissionCollectionAttempt[] = rows.map(row => {
                if (row.kind === "submission-writer") { const writer = JSON.parse(row.data) as D.SubmissionWriter; return { id: row.cursor, attemptKey: writer.attemptKey, storeId: writer.storeId, writerId: writer.id, receipt: null }; }
                const receipt = JSON.parse(row.data) as D.UploadReceipt;
                return { id: row.cursor, attemptKey: receipt.privateReference.opaqueKey, storeId: receipt.privateReference.storeId, writerId: null, receipt };
            });
            return { attempts, nextCursor: more ? rows.at(-1)!.cursor : null };
        });
    }
    async recordSubmissionCollectionProgress(input: Input<"recordSubmissionCollectionProgress">): Promise<void> {
        this.transaction(() => {
            if (!this.submissionPermitValid(input.permit, input.now)) fail("STALE_FENCE", "Submission collection fence changed");
            const state = this.load<SubmissionCollectionState>("submission-collection", input.permit.submissionId, input.permit.scope)!;
            if (state.cursor && compareCursor(input.attemptId, state.cursor) <= 0) return;
            const next = this.submissionAttemptRows(input.permit, state.cursor ?? "", 1)[0];
            if (!next || next.cursor !== input.attemptId) fail("INVALID_REQUEST", "Collection progress must acknowledge the next exact owned attempt");
            state.cursor = input.attemptId;
            this.write("submission-collection", input.permit.submissionId, input.permit.scope, state, false, input.permit.scope.runId);
        });
    }
    async listSubmissionCollectionTargets(input: Input<"listSubmissionCollectionTargets">) {
        const limit = this.limit(input.limit);
        const rows = this.database.prepare("SELECT s.id,s.data FROM catalog_records s WHERE s.kind='submission' AND s.id>? AND NOT EXISTS (SELECT 1 FROM catalog_records c WHERE c.kind='submission-collection' AND c.id=s.id AND json_extract(c.data,'$.collectedAt') IS NOT NULL) ORDER BY s.id LIMIT ?").all(input.cursor ?? "", limit + 1) as { id: string; data: string }[];
        const more = rows.length > limit; if (more) rows.pop();
        return { submissions: rows.map(row => JSON.parse(row.data) as D.Submission).filter(submission => this.submissionCollectable(submission, input.now)).map(submission => this.submissionTarget(submission)), nextCursor: more ? rows.at(-1)!.id : null };
    }
    async getLegacyRevisionAlias(scope: D.WorkspaceScope, alias: string) { return this.load<D.LegacyRevisionAlias>("alias", this.aliasId(scope, alias), scope); }
    private aliasId(scope: D.WorkspaceScope, alias: string): string { return D.canonicalJson([scope.customerId, scope.workspaceId, alias]); }
    async registerLegacyRevisionAliases(input: Input<"registerLegacyRevisionAliases">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "revision:alias");
            this.permit(input.principal, "workspace:admin", input.scope, input.authorization);
            const replay = this.replay<readonly D.LegacyRevisionAlias[]>(input.command, input.principal);
            if (replay)
                return replay;
            const workspace = this.workspace(input.scope);
            if (workspace.version !== input.expectedWorkspaceVersion)
                fail("VERSION_CONFLICT", "Workspace version changed");
            if (new Set(input.aliases.map(a => a.alias)).size !== input.aliases.length)
                fail("INVALID_REQUEST", "Alias request contains duplicate names");
            for (const alias of input.aliases) {
                if (!alias.alias || !this.load("revision", alias.revisionId, input.scope))
                    fail("REVISION_NOT_FOUND", "Alias target must be accepted history");
                const id = this.aliasId(input.scope, alias.alias);
                const existing = this.load<D.LegacyRevisionAlias>("alias", id, input.scope);
                if (existing && !same(existing, alias))
                    fail("VERSION_CONFLICT", "Revision aliases are immutable");
                if (!existing)
                    this.write("alias", id, input.scope, alias, true);
            }
            const operation = this.operation(input.command, input.principal, input.scope, null, { kind: "revision:alias", workspaceId: input.scope.workspaceId, aliases: input.aliases });
            const result = this.saveCommand(operation, input.aliases);
            this.events(input.events, operation);
            return result;
        });
    }
    async getStorageMigration(scope: D.WorkspaceScope, id: D.MigrationId) { return this.load<D.StorageMigration>("migration", id, scope); }
    async claimStorageMigration(input: Input<"claimStorageMigration">) {
        return this.transaction(() => {
            this.command(input.command, input.principal, input.scope, "storage:migrate");
            this.permit(input.principal, "workspace:migrate", input.scope, input.authorization);
            const replay = this.replay<unknown>(input.command, input.principal);
            if (replay) {
                const result = replay.operation.result;
                let migration: D.StorageMigration | null = null;
                if (result?.kind === "storage:migrate")
                    migration = this.load<D.StorageMigration>("migration", result.migrationId, input.scope);
                else {
                    const row = this.database.prepare("SELECT data FROM catalog_records WHERE kind='migration' AND customer_id=? AND workspace_id=? AND json_extract(data,'$.command.operationId')=?").get(input.scope.customerId, input.scope.workspaceId, replay.operation.id) as {
                        data: string;
                    } | undefined;
                    if (row)
                        migration = JSON.parse(row.data) as D.StorageMigration;
                }
                if (!migration || migration.command.operationId !== replay.operation.id)
                    throw new Error("Migration operation has no matching migration identity");
                return migration;
            }
            const workspace = this.workspace(input.scope);
            if (workspace.version !== input.expectedWorkspaceVersion || workspace.currentRevisionId !== input.expectedHeadRevisionId)
                fail("REVISION_CONFLICT", "Workspace changed before migration claim");
            if (workspace.bindingGeneration !== input.expectedSourceBindingGeneration)
                fail("STORAGE_BINDING_CHANGED", "Source binding changed");
            const target = input.targetBinding;
            if (!same(target.scope, input.scope) || target.id === workspace.storageBindingId || target.generation <= workspace.bindingGeneration || target.status !== "active")
                fail("INVALID_REQUEST", "Migration target must have a new identity and higher generation");
            if (this.load("binding", target.id))
                fail("VERSION_CONFLICT", "Target binding identity already exists");
            if (this.all<D.StorageMigration>("migration", input.scope).some(m => !["complete", "failed"].includes(m.state)))
                fail("FINALIZATION_IN_PROGRESS", "Workspace migration is already in progress");
            if (retainedRevisionSetDigest(this.all<D.Revision>("revision", input.scope)) !== input.retainedRevisionSetDigest)
                fail("REVISION_CONFLICT", "Retained revision set does not match catalog history");
            this.validClaim(input.claim, input.now);
            const migration: D.StorageMigration = { id: input.migrationId, scope: input.scope, command: input.command, sourceBindingId: workspace.storageBindingId, sourceBindingGeneration: workspace.bindingGeneration, targetBinding: target, expectedHeadRevisionId: workspace.currentRevisionId, retainedRevisionSetDigest: input.retainedRevisionSetDigest, state: "draining", version: 1, claim: input.claim, copies: [], lastError: null, createdAt: input.now, updatedAt: input.now, switchedAt: null };
            this.write("migration-guards", migration.id, input.scope, { workspaceVersion: workspace.version, sourceReferences: this.all<D.Revision>("revision", input.scope).map(revision => ({ scope: revision.scope, privateReference: revision.privateReference })) } satisfies MigrationGuards, true);
            this.write("migration", migration.id, input.scope, migration, true);
            const operation = this.operation(input.command, input.principal, input.scope, null);
            operation.claim = input.claim;
            this.saveCommand(operation, migration);
            return migration;
        });
    }
    private migration(scope: D.WorkspaceScope, id: D.MigrationId, version: number, fence: number, now: string): D.StorageMigration {
        const migration = this.load<D.StorageMigration>("migration", id, scope);
        if (!migration)
            fail("OPERATION_NOT_FOUND", "Storage migration does not exist");
        if (migration.claim.fence !== fence || migration.claim.expiresAt <= now || ["complete", "failed"].includes(migration.state))
            fail("STALE_FENCE", "Migration fence is expired or stale");
        if (migration.version !== version)
            fail("VERSION_CONFLICT", "Migration version changed");
        return migration;
    }
    private drained(scope: D.WorkspaceScope): void {
        if (this.all<D.Run>("run", scope).some(r => r.mode === "read-write" && ["active", "finalizing"].includes(r.state)))
            fail("FINALIZATION_IN_PROGRESS", "Mutable runs have not drained");
    }
    private saveMigration(migration: D.StorageMigration): void { this.write("migration", migration.id, migration.scope, migration); this.database.prepare("UPDATE catalog_commands SET value=? WHERE operation_id=?").run(JSON.stringify(migration), migration.command.operationId); }
    async recordVerifiedRevisionCopy(input: Input<"recordVerifiedRevisionCopy">) {
        return this.transaction(() => {
            const migration = this.migration(input.scope, input.migrationId, input.expectedMigrationVersion, input.migrationFence, input.now);
            this.drained(input.scope);
            const revision = this.load<D.Revision>("revision", input.copy.revisionId, input.scope);
            if (!revision)
                fail("REVISION_NOT_FOUND", "Verified copy source is not retained history");
            const target = input.copy.target;
            const targetScope = { ...input.scope, storageBindingId: migration.targetBinding.id, bindingGeneration: migration.targetBinding.generation };
            if (input.copy.sourceManifestDigest !== revision.manifestDigest || target.manifestDigest !== revision.manifestDigest || target.revisionId !== revision.id || target.parentRevisionId !== revision.parentRevisionId || !same(target.scope, targetScope) || target.operationId !== migration.command.operationId)
                fail("RECEIPT_MISMATCH", "Verified copy does not match retained source and target binding");
            const existing = migration.copies.find(c => c.revisionId === input.copy.revisionId);
            if (existing) {
                if (!same(existing, input.copy))
                    fail("RECEIPT_MISMATCH", "Verified copy checkpoint is immutable");
                return migration;
            }
            const identity: D.CandidateIdentity = { candidateId: target.candidateId, revisionId: target.revisionId, operationId: target.operationId, scope: target.scope, parentRevisionId: target.parentRevisionId, createdAt: target.preparedAt };
            this.candidate(identity);
            this.matchCandidate(identity, target, revision.manifestDigest);
            this.prepared(target);
            migration.copies = [...migration.copies, input.copy];
            migration.state = migration.copies.length === this.all<D.Revision>("revision", input.scope).length ? "verified" : "copying";
            migration.version++;
            migration.updatedAt = input.now;
            this.saveMigration(migration);
            return migration;
        });
    }
    async claimStorageMigrationRecovery(input: Input<"claimStorageMigrationRecovery">) {
        return this.transaction(() => {
            const migration = this.load<D.StorageMigration>("migration", input.migrationId, input.scope);
            if (!migration)
                fail("OPERATION_NOT_FOUND", "Migration does not exist");
            if (migration.version !== input.expectedMigrationVersion)
                fail("VERSION_CONFLICT", "Migration version changed");
            if (["complete", "failed"].includes(migration.state) || migration.claim.expiresAt > input.now)
                fail("STALE_FENCE", "Migration is not recoverable");
            const claim = { ownerId: input.ownerId, fence: migration.claim.fence + 1, expiresAt: input.expiresAt };
            this.validClaim(claim, input.now);
            migration.claim = claim;
            migration.version++;
            migration.updatedAt = input.now;
            this.saveMigration(migration);
            return migration;
        });
    }
    async renewStorageMigrationClaim(input: Input<"renewStorageMigrationClaim">) {
        return this.transaction(() => {
            const migration = this.migration(input.scope, input.migrationId, input.expectedMigrationVersion, input.migrationFence, input.now);
            if (input.expiresAt <= migration.claim.expiresAt)
                fail("INVALID_REQUEST", "Migration renewal must extend the claim");
            migration.claim.expiresAt = input.expiresAt;
            migration.version++;
            migration.updatedAt = input.now;
            this.saveMigration(migration);
            return migration;
        });
    }
    async switchStorageBinding(input: Input<"switchStorageBinding">) {
        return this.transaction(() => {
            this.permit(input.principal, "workspace:migrate", input.scope, input.authorization);
            const stored = this.load<D.StorageMigration>("migration", input.migrationId, input.scope);
            if (!stored)
                fail("OPERATION_NOT_FOUND", "Migration does not exist");
            const operation = this.load<D.Operation>("operation", stored.command.operationId, input.scope);
            if (!operation || !same(identityOf(operation.principal), identityOf(input.principal)))
                fail("FORBIDDEN", "Migration belongs to another identity");
            if (stored.state === "complete") {
                if (stored.claim.fence !== input.migrationFence)
                    fail("STALE_FENCE", "Migration fence changed");
                return this.replay<D.Workspace>(stored.command, input.principal)!;
            }
            const migration = this.migration(input.scope, input.migrationId, input.expectedMigrationVersion, input.migrationFence, input.now);
            const workspace = this.workspace(input.scope);
            this.drained(input.scope);
            const guards = this.load<MigrationGuards>("migration-guards", migration.id, input.scope);
            if (!guards || input.expectedWorkspaceVersion !== guards.workspaceVersion || workspace.version !== input.expectedWorkspaceVersion || workspace.currentRevisionId !== input.expectedHeadRevisionId || workspace.currentRevisionId !== migration.expectedHeadRevisionId)
                fail("REVISION_CONFLICT", "Workspace changed during migration");
            if (workspace.storageBindingId !== migration.sourceBindingId || workspace.bindingGeneration !== migration.sourceBindingGeneration || input.expectedSourceBindingGeneration !== migration.sourceBindingGeneration)
                fail("STORAGE_BINDING_CHANGED", "Migration source binding changed");
            const revisions = this.all<D.Revision>("revision", input.scope);
            const retained = retainedRevisionSetDigest(revisions);
            if (retained !== migration.retainedRevisionSetDigest || retained !== input.expectedRetainedRevisionSetDigest || verifiedCopySetDigest(migration.copies) !== input.expectedVerifiedCopySetDigest || migration.copies.length !== revisions.length || migration.state !== "verified")
                fail("RECEIPT_MISMATCH", "Retained revisions and verified copy sets do not match exactly");
            for (const revision of revisions) {
                const copy = migration.copies.find(c => c.revisionId === revision.id);
                if (!copy || copy.sourceManifestDigest !== revision.manifestDigest || copy.target.manifestDigest !== revision.manifestDigest)
                    fail("RECEIPT_MISMATCH", "Missing or mismatched verified copy");
                const candidate = this.load<CandidateRecord>("candidate", copy.target.candidateId, input.scope);
                if (!candidate || candidate.collection || !same(candidate.prepared, copy.target))
                    fail("STALE_FENCE", "Verified migration candidate is no longer protected");
                revision.scope = copy.target.scope;
                revision.privateReference = copy.target.privateReference;
                this.write("revision", revision.id, input.scope, revision);
            }
            const source = this.load<D.StorageBinding>("binding", workspace.storageBindingId, input.scope);
            if (!source)
                fail("STORAGE_BINDING_CHANGED", "Source binding is absent");
            source.status = "retired";
            this.write("binding", source.id, input.scope, source);
            this.write("binding", migration.targetBinding.id, input.scope, migration.targetBinding, true);
            workspace.storageBindingId = migration.targetBinding.id;
            workspace.bindingGeneration = migration.targetBinding.generation;
            workspace.version++;
            workspace.updatedAt = input.now;
            this.write("workspace", workspace.id, input.scope, workspace);
            migration.state = "complete";
            migration.version++;
            migration.updatedAt = input.now;
            migration.switchedAt = input.now;
            this.write("migration", migration.id, input.scope, migration);
            operation.state = "succeeded";
            operation.phase = "complete";
            operation.version++;
            operation.updatedAt = input.now;
            operation.claim = migration.claim;
            operation.result = { kind: "storage:migrate", migrationId: migration.id, storageBindingId: workspace.storageBindingId, bindingGeneration: workspace.bindingGeneration };
            this.saveOutcome(operation, workspace);
            this.events(input.events, operation);
            return { value: workspace, operation, replayed: false };
        });
    }
    async failStorageMigration(input: Input<"failStorageMigration">) {
        return this.transaction(() => {
            const migration = this.migration(input.scope, input.migrationId, input.expectedMigrationVersion, input.migrationFence, input.now);
            const workspace = this.workspace(input.scope, false);
            if (migration.switchedAt || workspace.storageBindingId !== migration.sourceBindingId || workspace.bindingGeneration !== migration.sourceBindingGeneration)
                fail("PUBLICATION_OUTCOME_UNKNOWN", "Migration cutover may already have committed");
            migration.state = "failed";
            migration.version++;
            migration.updatedAt = input.now;
            migration.lastError = input.message;
            this.saveMigration(migration);
            const operation = this.load<D.Operation>("operation", migration.command.operationId, input.scope)!;
            operation.state = "failed";
            operation.phase = "complete";
            operation.version++;
            operation.updatedAt = input.now;
            operation.error = { code: "STORAGE_UNAVAILABLE", message: input.message, retryable: false };
            this.write("operation", operation.id, input.scope, operation);
            return migration;
        });
    }
    async getCleanup(scope: D.WorkspaceScope, id: D.CleanupId) { return this.load<D.CleanupStatus>("cleanup", id, scope); }
    private collectionTarget(candidate: CandidateRecord): D.CandidateCollectionTarget {
        let binding = this.load<D.StorageBinding>("binding", candidate.identity.scope.storageBindingId, candidate.identity.scope);
        if (!binding) {
            const operation = this.load<D.Operation>("operation", candidate.identity.operationId, candidate.identity.scope);
            if (operation?.kind === "workspace:create" && same(operation.intent.candidateIdentity, candidate.identity)) binding = operation.intent.binding;
        }
        return { identity: candidate.identity, prepared: candidate.prepared, binding, collection: candidate.collection };
    }
    private submissionTarget(submission: D.Submission): D.SubmissionCollectionTarget {
        return { submission, binding: this.load<D.StorageBinding>("binding", submission.scope.storageBindingId, submission.scope), collection: this.load<SubmissionCollectionState>("submission-collection", submission.id, submission.scope)?.permit ?? null };
    }
    async getCleanupTargets(scope: D.WorkspaceScope, cleanupId: D.CleanupId, limit = 50, cursor = ""): Promise<D.CleanupTargets | null> {
        this.limit(limit);
        const cleanup = this.load<D.CleanupStatus>("cleanup", cleanupId, scope);
        if (!cleanup) return null;
        const owner = cleanup.runId ? null : this.load<{ operationId: D.OperationId }>("cleanup-owner", cleanupId, scope);
        if (!cleanup.runId && !owner) fail("STORAGE_UNAVAILABLE", "Cleanup creation ownership is unknown; retain its bytes");
        if (cleanup.runId && !this.load<D.Run>("run", cleanup.runId, scope)) fail("STORAGE_UNAVAILABLE", "Cleanup run ownership is unknown; retain its bytes");
        const rows = this.database.prepare("SELECT 'candidate:' || c.id AS cursor,c.data FROM catalog_records c JOIN catalog_records o ON o.kind='operation' AND o.id=json_extract(c.data,'$.identity.operationId') AND o.customer_id=c.customer_id AND o.workspace_id=c.workspace_id WHERE c.kind='candidate' AND c.customer_id=? AND c.workspace_id=? AND 'candidate:' || c.id>? AND json_extract(c.data,'$.collectedAt') IS NULL AND (? IS NOT NULL AND o.run_id=? OR ? IS NOT NULL AND o.id=?) AND NOT EXISTS (SELECT 1 FROM catalog_records r WHERE r.kind='revision' AND r.customer_id=c.customer_id AND r.workspace_id=c.workspace_id AND r.id=json_extract(c.data,'$.identity.revisionId')) ORDER BY c.id LIMIT ?").all(scope.customerId, scope.workspaceId, cursor, cleanup.runId, cleanup.runId, owner?.operationId ?? null, owner?.operationId ?? null, limit) as { cursor: string; data: string }[];
        const submissions = cleanup.runId ? this.database.prepare("SELECT 'submission:' || s.id AS cursor,s.data FROM catalog_records s WHERE s.kind='submission' AND s.customer_id=? AND s.workspace_id=? AND s.run_id=? AND 'submission:' || s.id>? AND NOT EXISTS (SELECT 1 FROM catalog_records c WHERE c.kind='submission-collection' AND c.id=s.id AND json_extract(c.data,'$.collectedAt') IS NOT NULL) ORDER BY s.id LIMIT ?").all(scope.customerId, scope.workspaceId, cleanup.runId, cursor, limit) as { cursor: string; data: string }[] : [];
        const page = [...rows, ...submissions].sort((a, b) => compareCursor(a.cursor, b.cursor)).slice(0, limit);
        return { candidates: page.filter(row => row.cursor.startsWith("candidate:")).map(row => this.collectionTarget(JSON.parse(row.data))), submissions: page.filter(row => row.cursor.startsWith("submission:")).map(row => this.submissionTarget(JSON.parse(row.data))), nextCursor: page.at(-1)?.cursor ?? null };
    }
    async nextCollectionWork(input: Input<"nextCollectionWork">): Promise<CollectionWork | null> {
        return this.transaction(() => {
            const state = this.load<{ lane: number; cursors: string[] }>("maintenance", "collection-scan") ?? { lane: 0, cursors: ["", "", ""] };
            const lane = state.lane; const kind = ["cleanup", "candidate", "submission"][lane];
            const predicate = lane === 0 ? "json_extract(data,'$.state')!='complete' AND json_extract(data,'$.nextAttemptAt')<=? AND (json_extract(data,'$.claim') IS NULL OR json_extract(data,'$.claim.expiresAt')<=?)" : lane === 1 ? "json_extract(data,'$.collectedAt') IS NULL" : "NOT EXISTS (SELECT 1 FROM catalog_records c WHERE c.kind='submission-collection' AND c.id=s.id AND json_extract(c.data,'$.collectedAt') IS NOT NULL)";
            const parameters = lane === 0 ? [input.now, input.now] : [];
            const query = this.database.prepare(`SELECT id,data FROM catalog_records s WHERE kind=? AND ${predicate} AND id>? ORDER BY id LIMIT 1`);
            const row = (query.get(kind, ...parameters, state.cursors[lane]) ?? (state.cursors[lane] ? query.get(kind, ...parameters, "") : undefined)) as { id: string; data: string } | undefined;
            state.cursors[lane] = row?.id ?? ""; state.lane = (lane + 1) % 3;
            this.write("maintenance", "collection-scan", { customerId: "" as D.CustomerId }, state);
            if (!row) return null;
            if (lane === 0) return { kind: "cleanup", cleanup: JSON.parse(row.data) };
            if (lane === 1) { const candidate = JSON.parse(row.data) as CandidateRecord; return this.collectable(candidate) ? { kind: "candidate", candidate: this.collectionTarget(candidate) } : null; }
            const submission = JSON.parse(row.data) as D.Submission;
            return this.submissionCollectable(submission, input.now) ? { kind: "submission", submission: this.submissionTarget(submission) } : null;
        });
    }
    async listCandidateCollectionTargets(input: Input<"listCandidateCollectionTargets">) {
        const limit = this.limit(input.limit);
        const rows = this.database.prepare("SELECT id,data FROM catalog_records WHERE kind='candidate' AND id>? AND json_extract(data,'$.collectedAt') IS NULL ORDER BY id LIMIT ?").all(input.cursor ?? "", limit + 1) as { id: string; data: string }[];
        const more = rows.length > limit; if (more) rows.pop();
        return { candidates: rows.map(row => JSON.parse(row.data) as CandidateRecord).filter(candidate => this.collectable(candidate)).map(candidate => this.collectionTarget(candidate)), nextCursor: more ? rows.at(-1)!.id : null };
    }
    async listDueCleanup(input: Input<"listDueCleanup">) { return this.scan<D.CleanupStatus>("cleanup", "json_extract(data,'$.state')!='complete' AND json_extract(data,'$.nextAttemptAt')<=? AND (json_extract(data,'$.claim') IS NULL OR json_extract(data,'$.claim.expiresAt')<=?)", [input.now, input.now], input.limit); }
    async claimCleanup(input: Input<"claimCleanup">) {
        return this.transaction(() => {
            const cleanup = this.load<D.CleanupStatus>("cleanup", input.cleanupId, input.scope);
            if (!cleanup)
                fail("OPERATION_NOT_FOUND", "Cleanup does not exist");
            if (cleanup.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Cleanup version changed");
            if (cleanup.state === "complete" || cleanup.nextAttemptAt > input.now || (cleanup.claim && cleanup.claim.expiresAt > input.now))
                fail("STALE_FENCE", "Cleanup is not claimable");
            const claim = { ownerId: input.ownerId, fence: (cleanup.claim?.fence ?? 0) + 1, expiresAt: input.expiresAt };
            this.validClaim(claim, input.now);
            cleanup.claim = claim;
            cleanup.state = "running";
            cleanup.version++;
            cleanup.attempts++;
            this.write("cleanup", cleanup.id, input.scope, cleanup, false, cleanup.runId);
            return cleanup;
        });
    }
    async completeCleanup(input: Input<"completeCleanup">) {
        return this.transaction(() => {
            const cleanup = this.load<D.CleanupStatus>("cleanup", input.cleanupId, input.scope);
            if (!cleanup)
                fail("OPERATION_NOT_FOUND", "Cleanup does not exist");
            if (cleanup.claim?.fence !== input.fence || cleanup.claim.expiresAt <= input.now || cleanup.state !== "running")
                fail("STALE_FENCE", "Cleanup claim is stale");
            if (cleanup.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Cleanup version changed");
            cleanup.state = input.error === null ? "complete" : "failed";
            cleanup.lastError = input.error;
            if (input.targetCursor !== undefined) cleanup.targetCursor = input.targetCursor;
            cleanup.nextAttemptAt = input.nextAttemptAt;
            if (input.error !== null && cleanup.claim)
                cleanup.claim.expiresAt = input.now;
            cleanup.version++;
            this.write("cleanup", cleanup.id, input.scope, cleanup, false, cleanup.runId);
            return cleanup;
        });
    }
    async releaseCleanupClaim(input: Input<"releaseCleanupClaim">) {
        return this.transaction(() => {
            const cleanup = this.load<D.CleanupStatus>("cleanup", input.cleanupId, input.scope);
            if (!cleanup) fail("OPERATION_NOT_FOUND", "Cleanup does not exist");
            if (cleanup.claim?.fence !== input.fence || cleanup.claim.expiresAt <= input.now || cleanup.state !== "running") fail("STALE_FENCE", "Cleanup claim is stale");
            if (cleanup.version !== input.expectedVersion) fail("VERSION_CONFLICT", "Cleanup version changed");
            if (input.nextAttemptAt < input.now) fail("INVALID_REQUEST", "Cleanup cannot be scheduled in the past");
            cleanup.state = "pending"; cleanup.lastError = null; cleanup.claim.expiresAt = input.now; cleanup.nextAttemptAt = input.nextAttemptAt; cleanup.version++;
            if (input.targetCursor !== undefined) cleanup.targetCursor = input.targetCursor;
            this.write("cleanup", cleanup.id, cleanup.scope, cleanup, false, cleanup.runId);
            return cleanup;
        });
    }
    private collectable(candidate: CandidateRecord): boolean {
        const { scope, operationId, revisionId } = candidate.identity;
        if (this.all<D.Revision>("revision", scope).some(r => r.id === revisionId || (candidate.prepared && same(r.privateReference, candidate.prepared.privateReference))))
            return false;
        if (this.all<D.Run>("run", scope).some(r => ["active", "finalizing"].includes(r.state) && r.baseRevisionId === revisionId))
            return false;
        const operation = this.load<D.Operation>("operation", operationId, scope);
        if (operation && ["pending", "processing"].includes(operation.state))
            return false;
        if (this.database.prepare("SELECT id FROM catalog_records WHERE kind='candidate-writer' AND customer_id=? AND workspace_id=? AND json_extract(data,'$.identity.candidateId')=? AND json_extract(data,'$.state')='active' LIMIT 1").get(scope.customerId, scope.workspaceId, candidate.identity.candidateId)) return false;
        for (const migration of this.all<D.StorageMigration>("migration", scope)) {
            if (migration.copies.some(copy => copy.target.candidateId === candidate.identity.candidateId))
                return false;
            const guards = this.load<MigrationGuards>("migration-guards", migration.id, scope);
            if (!guards && migration.sourceBindingId === scope.storageBindingId)
                return false;
            if (candidate.prepared && guards?.sourceReferences.some(reference => same(reference.scope, scope) && same(reference.privateReference, candidate.prepared!.privateReference)))
                return false;
        }
        return true;
    }
    async claimCandidateCollection(input: Input<"claimCandidateCollection">) {
        return this.transaction(() => {
            const candidate = this.load<CandidateRecord>("candidate", input.candidateId, input.scope);
            if (!candidate || !same(candidate.identity.scope, input.scope))
                fail("REVISION_NOT_FOUND", "Candidate does not exist in this binding scope");
            if (candidate.collection && candidate.collection.expiresAt > input.now)
                fail("STALE_FENCE", "Candidate already has an active collection permit");
            if (!this.collectable(candidate))
                fail("FORBIDDEN", "Candidate is retained by catalog history or recoverable work");
            if (input.expiresAt <= input.now)
                fail("INVALID_REQUEST", "Collection permit must expire in the future");
            const fence = { scope: input.scope, candidateId: input.candidateId, collectionFence: (candidate.collection?.collectionFence ?? 0) + 1, expiresAt: input.expiresAt };
            const binding = this.collectionTarget(candidate).binding;
            if (!candidate.prepared && !binding) fail("STORAGE_UNAVAILABLE", "Partial candidate binding ownership is unknown");
            const permit: D.CollectionPermit = candidate.prepared ? { ...fence, privateReference: candidate.prepared.privateReference } : { ...fence, kind: "partial", privateReference: null, identity: candidate.identity, storeId: binding!.location.storeId };
            candidate.collection = permit;
            this.write("candidate", input.candidateId, input.scope, candidate);
            return permit;
        });
    }
    /** Wire this predicate into storage collection. A mark remains terminal even after its permit expires. */
    async verifyCollectionPermit(permit: D.CollectionPermit, now: D.Timestamp): Promise<boolean> {
        return this.transaction(() => {
            const candidate = this.load<CandidateRecord>("candidate", permit.candidateId, permit.scope);
            return !!candidate && !!candidate.collection && permit.expiresAt > now && same(candidate.identity.scope, permit.scope) && same(candidate.collection, permit) && this.collectable(candidate) && (permit.kind === "partial" ? !candidate.prepared && same(candidate.identity, permit.identity) : !!candidate.prepared && same(candidate.prepared.privateReference, permit.privateReference));
        });
    }
    async completeCandidateCollection(permit: D.CollectionPermit, now: D.Timestamp): Promise<void> {
        this.transaction(() => {
            const candidate = this.load<CandidateRecord>("candidate", permit.candidateId, permit.scope);
            if (!candidate?.collection || !same(candidate.collection, permit) || permit.expiresAt <= now || !this.collectable(candidate)) fail("STALE_FENCE", "Candidate collection fence changed");
            candidate.collectedAt = now;
            this.write("candidate", permit.candidateId, permit.scope, candidate);
        });
    }
    async beginCandidateWrite(input: Input<"beginCandidateWrite">) {
        return this.transaction(() => {
            const candidate = this.load<CandidateRecord>("candidate", input.identity.candidateId, input.identity.scope);
            if (!candidate || !same(candidate.identity, input.identity)) fail("REVISION_CONFLICT", "Preparation identity does not match its persisted candidate");
            if (candidate.collection) fail("REVISION_CONFLICT", "Candidate is permanently retired");
            const operation = this.load<D.Operation>("operation", input.identity.operationId, input.identity.scope);
            if (!operation || operation.state !== "processing" || !operation.claim || operation.claim.ownerId !== input.ownerId || operation.claim.expiresAt <= input.now) fail("STALE_FENCE", "Candidate writing requires its current processing owner");
            if (!input.writerId || input.writerId.length > 255) fail("INVALID_REQUEST", "Candidate writer identity is required");
            const writer: D.CandidateWriter = { id: input.writerId, identity: input.identity, ownerId: input.ownerId, processingFence: operation.claim.fence, state: "active", startedAt: input.now, finishedAt: null };
            this.write("candidate-writer", writer.id, input.identity.scope, writer, true, operation.runId);
            return writer;
        });
    }
    async finishCandidateWrite(input: Input<"finishCandidateWrite">) {
        return this.transaction(() => {
            const writer = this.load<D.CandidateWriter>("candidate-writer", input.writerId, input.identity.scope);
            if (!writer || !same(writer.identity, input.identity)) fail("FORBIDDEN", "Candidate writer belongs to another identity");
            if (writer.state === "finished") return writer;
            writer.state = "finished"; writer.finishedAt = input.now;
            const operation = this.load<D.Operation>("operation", input.identity.operationId, input.identity.scope);
            this.write("candidate-writer", writer.id, input.identity.scope, writer, false, operation?.runId ?? null);
            return writer;
        });
    }
    async areCandidateWritersStopped(identity: D.CandidateIdentity, ownerId: string): Promise<boolean> {
        return this.transaction(() => {
            const candidate = this.load<CandidateRecord>("candidate", identity.candidateId, identity.scope);
            if (!candidate || !same(candidate.identity, identity)) return false;
            const rows = this.database.prepare("SELECT data FROM catalog_records WHERE kind='candidate-writer' AND customer_id=? AND workspace_id=? AND json_extract(data,'$.identity.candidateId')=?").all(identity.scope.customerId, identity.scope.workspaceId, identity.candidateId) as { data: string }[];
            const writers = rows.map(row => JSON.parse(row.data) as D.CandidateWriter);
            if (writers.some(writer => writer.state !== "finished" || !same(writer.identity, identity))) return false;
            if (writers.length) return true;
            // With mandatory tracking in this incarnation, terminal ownership plus no start proves no storage write began.
            const operation = this.load<D.Operation>("operation", identity.operationId, identity.scope);
            return !!operation && ["succeeded", "failed"].includes(operation.state) && operation.claim?.ownerId === ownerId;
        });
    }
    async listPendingOutbox(input: Input<"listPendingOutbox">) {
        return (this.database.prepare("SELECT data FROM catalog_records WHERE kind='outbox' AND json_extract(data,'$.deliveryState')!='complete' AND json_extract(data,'$.nextAttemptAt')<=? AND (json_extract(data,'$.claim') IS NULL OR json_extract(data,'$.claim.expiresAt')<=?) ORDER BY json_extract(data,'$.nextAttemptAt'),json_extract(data,'$.attempts'),id LIMIT ?").all(input.now, input.now, this.limit(input.limit)) as { data: string }[]).map(row => JSON.parse(row.data) as D.OutboxEvent);
    }
    async claimOutbox(input: Input<"claimOutbox">) {
        return this.transaction(() => {
            const event = this.load<D.OutboxEvent>("outbox", input.eventId, input.scope);
            if (!event)
                fail("OPERATION_NOT_FOUND", "Outbox event does not exist");
            if (event.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Outbox version changed");
            if (event.deliveryState === "complete" || event.nextAttemptAt > input.now || (event.claim && event.claim.expiresAt > input.now))
                fail("STALE_FENCE", "Outbox event is not claimable");
            let snapshot = this.load<{
                subscriptions: CatalogSubscription[];
            }>("outbox-recipients", event.id, input.scope);
            if (!snapshot) {
                let subscriptions = this.subscriptions({ customerId: input.scope.customerId }, event.type);
                const operation = this.load<D.Operation>("operation", event.operationId, input.scope);
                const run = event.runId ? this.load<D.Run>("run", event.runId, input.scope) : null;
                const canonical = canonicalRepresentation(event, operation, run);
                if (canonical) subscriptions = subscriptions.map(recipient => ({ ...recipient, representation: { ...canonical, subscriptionId: recipient.id, deliveryId: event.id } }));
                const compatibility = operation ? this.load<{ kind: string; runId: D.RunId; requestDigest: D.Sha256 }>("compatibility-publication", D.canonicalJson([operation.command.idempotencyScope, operation.command.idempotencyKey]), input.scope) : null;
                const legacyPush = compatibility?.kind === "legacy-push" && compatibility.runId === event.runId && compatibility.requestDigest === operation?.command.requestDigest;
                for (const representation of legacyRepresentations(event, operation, run, legacyPush)) {
                    for (const recipient of this.subscriptions({ customerId: input.scope.customerId }, representation.eventType)) {
                        subscriptions.push(representationRecipient(event, recipient, representation));
                    }
                }
                snapshot = { subscriptions };
                this.write("outbox-recipients", event.id, input.scope, snapshot, true);
            }
            if (snapshot.subscriptions.length === 0) {
                event.deliveryState = "complete";
                event.claim = null;
                event.version++;
                this.write("outbox", event.id, input.scope, event, false, event.runId);
                return event;
            }
            const claim = { ownerId: input.ownerId, fence: (event.claim?.fence ?? 0) + 1, expiresAt: input.expiresAt };
            this.validClaim(claim, input.now);
            event.claim = claim;
            event.deliveryState = "running";
            event.version++;
            event.attempts++;
            this.write("outbox", event.id, input.scope, event, false, event.runId);
            return event;
        });
    }
    private subscriptions(scope: D.CustomerScope, eventType: string): CatalogSubscription[] {
        const subscriptions = this.all<CatalogSubscription>("subscription", scope);
        const legacy = this.database.prepare("SELECT id,customer_id,url,events,secret_hash,active FROM webhooks WHERE customer_id=? AND active=1").all(scope.customerId) as {
            id: string;
            customer_id: string;
            url: string;
            events: string;
            secret_hash: string | null;
            active: number;
        }[];
        for (const row of legacy) {
            if (!subscriptions.some(s => s.id === row.id))
                subscriptions.push({ id: row.id as D.SubscriptionId, customerId: row.customer_id as D.CustomerId, active: true, eventTypes: JSON.parse(row.events), destination: row.url, signingSecretRef: row.secret_hash ? `legacy-webhook:${row.id}` : null });
        }
        return subscriptions.filter(s => s.active && (s.eventTypes.includes(eventType) || s.eventTypes.includes("*")));
    }
    async listSubscriptions(scope: D.CustomerScope, eventType: string) { return this.subscriptions(scope, eventType); }
    /** The worker uses the first-claim snapshot, rather than the current subscription list. */
    async listOutboxRecipients(scope: D.WorkspaceScope, eventId: D.EventId): Promise<readonly CatalogSubscription[]> {
        const snapshot = this.load<{
            subscriptions: CatalogSubscription[];
        }>("outbox-recipients", eventId, scope);
        return snapshot?.subscriptions ?? [];
    }
    async listDeliveredSubscriptions(scope: D.WorkspaceScope, eventId: D.EventId): Promise<readonly D.SubscriptionId[]> {
        return this.all<{ eventId: D.EventId; subscriptionId: D.SubscriptionId; delivered: boolean }>("delivery", scope).filter(receipt => receipt.eventId === eventId && receipt.delivered).map(receipt => receipt.subscriptionId);
    }
    async listDueOutboxRecipients(input: Input<"listDueOutboxRecipients">) {
        const limit = this.limit(input.limit);
        const rows = this.database.prepare("SELECT s.value AS recipient,COALESCE(json_extract(d.data,'$.attempts'),0) AS attempts FROM catalog_records f,json_each(f.data,'$.subscriptions') s LEFT JOIN catalog_records d ON d.kind='delivery' AND d.customer_id=f.customer_id AND d.workspace_id=f.workspace_id AND json_extract(d.data,'$.eventId')=f.id AND json_extract(d.data,'$.subscriptionId')=json_extract(s.value,'$.id') WHERE f.kind='outbox-recipients' AND f.id=? AND f.customer_id=? AND f.workspace_id=? AND COALESCE(json_extract(d.data,'$.delivered'),0)=0 AND COALESCE(json_extract(d.data,'$.nextAttemptAt'),?)<=? ORDER BY COALESCE(json_extract(d.data,'$.updatedAt'),''),json_extract(s.value,'$.id') LIMIT ?").all(input.eventId, input.scope.customerId, input.scope.workspaceId, input.now, input.now, limit) as { recipient: string; attempts: number }[];
        return rows.map(row => ({ recipient: JSON.parse(row.recipient) as CatalogSubscription, attempts: row.attempts }));
    }
    async releaseOutboxClaim(input: Input<"releaseOutboxClaim">) {
        return this.transaction(() => {
            const event = this.load<D.OutboxEvent>("outbox", input.eventId, input.scope);
            if (!event) fail("OPERATION_NOT_FOUND", "Outbox event does not exist");
            if (event.claim?.fence !== input.fence || event.claim.expiresAt <= input.now || event.deliveryState !== "running") fail("STALE_FENCE", "Outbox claim is stale");
            if (event.version !== input.expectedVersion) fail("VERSION_CONFLICT", "Outbox version changed");
            if (input.nextAttemptAt < input.now) fail("INVALID_REQUEST", "Delivery cannot be scheduled in the past");
            event.deliveryState = "pending";
            event.claim.expiresAt = input.now;
            event.nextAttemptAt = input.nextAttemptAt;
            event.version++;
            this.write("outbox", event.id, input.scope, event, false, event.runId);
            return event;
        });
    }
    /** Explicit subscription registration for composition and administration; never infer a recipient across tenants. */
    registerSubscription(subscription: CatalogSubscription): void { this.transaction(() => { this.write("subscription", subscription.id, { customerId: subscription.customerId }, subscription, true); }); }
    async recordDelivery(input: Input<"recordDelivery">) {
        return this.transaction(() => {
            const event = this.load<D.OutboxEvent>("outbox", input.eventId, input.scope);
            if (!event)
                fail("OPERATION_NOT_FOUND", "Outbox event does not exist");
            if (event.claim?.fence !== input.fence || event.claim.expiresAt <= input.now || event.deliveryState !== "running")
                fail("STALE_FENCE", "Outbox claim is stale");
            if (event.version !== input.expectedVersion)
                fail("VERSION_CONFLICT", "Outbox version changed");
            const snapshot = this.load<{
                subscriptions: CatalogSubscription[];
            }>("outbox-recipients", event.id, input.scope);
            if (!snapshot)
                fail("INVALID_TRANSITION", "Outbox recipient set has not been frozen");
            const subscriptions = snapshot.subscriptions;
            if (!subscriptions.some(s => s.id === input.subscriptionId))
                fail("FORBIDDEN", "Subscription is not an active recipient in this event customer scope");
            const deliveryId = D.canonicalJson([event.id, input.subscriptionId]);
            const previous = this.load<{ delivered: boolean; attempts?: number }>("delivery", deliveryId, input.scope);
            const successful = previous?.delivered === true || input.delivered;
            this.write("delivery", deliveryId, input.scope, { eventId: event.id, subscriptionId: input.subscriptionId, delivered: successful, attempts: (previous?.attempts ?? 0) + 1, nextAttemptAt: successful ? input.now : input.nextAttemptAt, updatedAt: input.now });
            const receipts = this.database.prepare("SELECT data FROM catalog_records WHERE kind='delivery' AND customer_id=? AND workspace_id=? AND json_extract(data,'$.eventId')=?").all(input.scope.customerId, input.scope.workspaceId, event.id) as {
                data: string;
            }[];
            const progress = receipts.map(row => JSON.parse(row.data) as {
                subscriptionId: string;
                delivered: boolean;
                nextAttemptAt?: D.Timestamp;
            });
            const remaining = subscriptions.filter(subscription => !progress.some(receipt => receipt.subscriptionId === subscription.id && receipt.delivered))
                .map(subscription => ({ id: subscription.id, nextAttemptAt: progress.find(receipt => receipt.subscriptionId === subscription.id)?.nextAttemptAt ?? input.now }));
            event.nextAttemptAt = remaining.map(recipient => recipient.nextAttemptAt).sort()[0] ?? input.now;
            const canContinue = remaining.some(recipient => recipient.nextAttemptAt <= input.now && (successful || recipient.id !== input.subscriptionId));
            event.deliveryState = !remaining.length ? "complete" : canContinue ? "running" : "failed";
            if (event.deliveryState === "failed" && event.claim)
                event.claim.expiresAt = input.now;
            event.version++;
            this.write("outbox", event.id, input.scope, event, false, event.runId);
            return event;
        });
    }
    async listAudit(scope: D.WorkspaceScope, cursor?: string, limit?: number) { const page = this.page<D.AuditEvent>("audit", scope, cursor, limit); return { events: page.values, nextCursor: page.nextCursor }; }
}
