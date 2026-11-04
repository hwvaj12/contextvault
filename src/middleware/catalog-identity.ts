import { createHash } from "node:crypto";
import { initSchema } from "../db";
import type Database from "better-sqlite3";
import { WorkspaceError } from "../domain";
import type { Action, CustomerId, Principal } from "../domain";
import { CONFIGURED_ADMINISTRATOR_ACTOR, configurationForVerifiedAdministrator, registerConfiguredAdministratorProvenance } from "../db/configured-administrator";
export { synchronizeConfiguredAdministrator } from "../db/configured-administrator";
export type { ConfiguredAdministratorConfiguration } from "../db/configured-administrator";
import type { CredentialAuthority } from "../ports/control-store";
import { bootstrapAuthority, SqliteControlStore } from "../adapters/control/sqlite-control-store";
import { CatalogAccessPolicy } from "../adapters/access/catalog-access-policy";
const tenantActions: readonly Action[] = ["workspace:create", "workspace:read", "workspace:write", "workspace:delete", "workspace:restore", "workspace:export", "workspace:admin", "workspace:migrate", "credential:manage", "run:open-read", "run:open-write", "run:read", "run:upload", "run:finalize", "run:abort", "run:heartbeat", "operation:read"];
/** The composition root supplies one open SQLite connection to both catalog and policy. */
export function createCatalogServices(database: Database.Database) {
    const controlStore = new SqliteControlStore(database);
    return { controlStore, accessPolicy: new CatalogAccessPolicy(controlStore), verifyCollectionPermit: controlStore.verifyCollectionPermit.bind(controlStore), listOutboxRecipients: controlStore.listOutboxRecipients.bind(controlStore) };
}
/** Called only after verifyKey proves this existing legacy credential. Never recreates revoked authority. */
export async function principalForVerifiedApiKey(database: Database.Database, key: {
    id: string;
    customerId: string;
}, authenticatedAt: string): Promise<Principal | null> {
    const current = database.prepare("SELECT customer_id FROM api_keys WHERE id=?").get(key.id) as {
        customer_id: string;
    } | undefined;
    if (!current || current.customer_id !== key.customerId)
        return null;
    const services = createCatalogServices(database);
    const initial: Principal = { kind: "customer", actorId: `api-key:${key.id}` as Principal["actorId"], customerId: key.customerId as CustomerId, credential: { id: key.id as Principal["credential"]["id"], kind: "api-key", version: 1 }, permissionEpoch: 1, authenticatedAt };
    const stored = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(key.id) as {
        data: string;
    } | undefined;
    if (!stored)
        bootstrapAuthority(database, { credentialId: initial.credential.id, actorId: initial.actorId, customerId: initial.customerId, credentialVersion: 1, permissionEpoch: 1, policyVersion: 1, revokedAt: null, grants: tenantActions.map(action => ({ action, customerId: initial.customerId, workspaceId: null })) });
    const authority = await services.controlStore.getAuthority({ customerId: initial.customerId }, initial);
    if (!authority || authority.revokedAt)
        return null;
    return { ...initial, actorId: authority.actorId, credential: { ...initial.credential, version: authority.credentialVersion }, permissionEpoch: authority.permissionEpoch };
}
/** A verified configured master key produces an explicit administrator. A selected tenant gets its own scoped authority. */
export function principalForVerifiedAdministrator(database: Database.Database, verifiedMasterKey: string, selectedCustomerId: string | null, authenticatedAt: string): Principal {
    initSchema(database);
    return database.transaction(() => {
        const configuration = configurationForVerifiedAdministrator(database, verifiedMasterKey, authenticatedAt);
        const credentialId = `administrator:${createHash("sha256").update(configuration.fingerprint!).update("\0").update(String(configuration.epoch)).update("\0").update(selectedCustomerId ?? "").digest("hex")}` as Principal["credential"]["id"];
        const principal: Principal = { kind: "administrator", actorId: CONFIGURED_ADMINISTRATOR_ACTOR as Principal["actorId"], credential: { id: credentialId, kind: "external", version: 1 }, permissionEpoch: 1, authenticatedAt };
        const authority: CredentialAuthority = { credentialId, actorId: principal.actorId, customerId: null, credentialVersion: 1, permissionEpoch: 1, policyVersion: 1, revokedAt: null, grants: selectedCustomerId ? tenantActions.map(action => ({ action, customerId: selectedCustomerId as CustomerId, workspaceId: null })) : [] };
        const existing = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(credentialId) as {
            data: string;
        } | undefined;
        if (!existing)
            bootstrapAuthority(database, authority);
        else {
            const current = JSON.parse(existing.data) as CredentialAuthority;
            if (current.revokedAt || current.actorId !== principal.actorId || current.customerId !== null)
                throw new WorkspaceError("CREDENTIAL_REVOKED", "Configured administrator credential is revoked or mismatched");
            principal.credential.version = current.credentialVersion;
            principal.permissionEpoch = current.permissionEpoch;
        }
        registerConfiguredAdministratorProvenance(database, credentialId, configuration);
        return principal;
    }).immediate();
}
