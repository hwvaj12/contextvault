import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { WorkspaceError } from "../domain";
import type { Timestamp } from "../domain";
import type { CredentialAuthority } from "../ports/control-store";
import { initSchema } from ".";
export const CONFIGURED_ADMINISTRATOR_ACTOR = "administrator:configured-master-key";
const configurationKind = "configured-administrator-configuration";
const credentialKind = "configured-administrator-credential";
const configurationId = "configured-master-key";
export interface ConfiguredAdministratorConfiguration {
    fingerprint: string | null;
    epoch: number;
    synchronizedAt: Timestamp;
}
interface ConfiguredAdministratorProvenance {
    fingerprint: string | null;
    epoch: number;
}
function record<T>(database: Database.Database, kind: string, id: string): T | null {
    const row = database.prepare("SELECT data FROM catalog_records WHERE kind=? AND id=?").get(kind, id) as {
        data: string;
    } | undefined;
    return row ? JSON.parse(row.data) as T : null;
}
function write(database: Database.Database, kind: string, id: string, value: unknown): void {
    database.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES(?,?,'',NULL,NULL,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind, id, JSON.stringify(value));
}
function fingerprint(key: string | null): string | null {
    if (key === null)
        return null;
    if (typeof key !== "string" || key.length === 0)
        throw new WorkspaceError("INVALID_REQUEST", "A configured administrator key must be nonempty, or null to disable it");
    return createHash("sha256").update("ContextVault configured administrator v1\0").update(key).digest("hex");
}
function legacyConfiguredIdentity(authority: CredentialAuthority): boolean {
    return authority.customerId === null && authority.actorId === CONFIGURED_ADMINISTRATOR_ACTOR && /^administrator:[a-f0-9]{64}$/.test(authority.credentialId);
}
function revokePreviousConfiguredCredentials(database: Database.Database, current: ConfiguredAdministratorConfiguration, now: Timestamp): void {
    const rows = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND customer_id=''").all() as {
        data: string;
    }[];
    for (const row of rows) {
        const authority = JSON.parse(row.data) as CredentialAuthority;
        let provenance = record<ConfiguredAdministratorProvenance>(database, credentialKind, authority.credentialId);
        if (!provenance && legacyConfiguredIdentity(authority)) {
            // Pre-provenance configured identities cannot establish a current configuration epoch.
            provenance = { fingerprint: null, epoch: 0 };
            write(database, credentialKind, authority.credentialId, provenance);
        }
        if (!provenance)
            continue;
        if (current.fingerprint !== null && provenance.fingerprint === current.fingerprint && provenance.epoch === current.epoch)
            continue;
        if (authority.revokedAt === null) {
            authority.revokedAt = now;
            authority.credentialVersion++;
            authority.permissionEpoch++;
            database.prepare("UPDATE catalog_records SET data=? WHERE kind='authority' AND id=?").run(JSON.stringify(authority), authority.credentialId);
        }
    }
}
function installConfiguration(database: Database.Database, value: string | null, previous: ConfiguredAdministratorConfiguration | null, now: Timestamp): ConfiguredAdministratorConfiguration {
    const epoch = (previous?.epoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch))
        throw new WorkspaceError("VERSION_CONFLICT", "Configured administrator epoch is exhausted");
    const current = { fingerprint: value, epoch, synchronizedAt: now };
    write(database, configurationKind, configurationId, current);
    revokePreviousConfiguredCredentials(database, current, now);
    return current;
}
/** Call once during trusted startup, before serving requests or starting maintenance. Null disables configured administrators. */
export function synchronizeConfiguredAdministrator(database: Database.Database, configuredMasterKey: string | null, now: Timestamp): ConfiguredAdministratorConfiguration {
    initSchema(database);
    const value = fingerprint(configuredMasterKey);
    return database.transaction(() => {
        const previous = record<ConfiguredAdministratorConfiguration>(database, configurationKind, configurationId);
        if (previous?.fingerprint === value) {
            revokePreviousConfiguredCredentials(database, previous, now);
            return previous;
        }
        return installConfiguration(database, value, previous, now);
    }).immediate();
}
/** Compatibility authentication can initialize an empty catalog, but cannot rotate existing startup configuration. */
export function configurationForVerifiedAdministrator(database: Database.Database, verifiedMasterKey: string, now: Timestamp): ConfiguredAdministratorConfiguration {
    initSchema(database);
    const value = fingerprint(verifiedMasterKey);
    return database.transaction(() => {
        const current = record<ConfiguredAdministratorConfiguration>(database, configurationKind, configurationId) ?? installConfiguration(database, value, null, now);
        if (current.fingerprint === null || current.fingerprint !== value)
            throw new WorkspaceError("CREDENTIAL_REVOKED", "Configured administrator key is no longer current");
        return current;
    }).immediate();
}
/** Register provenance only for the current configuration; a revoked credential stays revoked. */
export function registerConfiguredAdministratorProvenance(database: Database.Database, credentialId: string, configuration: ConfiguredAdministratorConfiguration): void {
    const current = record<ConfiguredAdministratorConfiguration>(database, configurationKind, configurationId);
    if (!current || current.fingerprint === null || current.fingerprint !== configuration.fingerprint || current.epoch !== configuration.epoch)
        throw new WorkspaceError("CREDENTIAL_REVOKED", "Configured administrator configuration changed");
    const authority = record<CredentialAuthority>(database, "authority", credentialId);
    if (!authority || authority.revokedAt || authority.customerId !== null || authority.actorId !== CONFIGURED_ADMINISTRATOR_ACTOR)
        throw new WorkspaceError("CREDENTIAL_REVOKED", "Configured administrator credential is absent or revoked");
    const existing = record<ConfiguredAdministratorProvenance>(database, credentialKind, credentialId);
    if (existing && (existing.fingerprint !== current.fingerprint || existing.epoch !== current.epoch))
        throw new WorkspaceError("CREDENTIAL_REVOKED", "Configured administrator credential belongs to an earlier configuration");
    if (!existing)
        write(database, credentialKind, credentialId, { fingerprint: current.fingerprint, epoch: current.epoch });
}
/** Every catalog authorization check consults current provenance, including finalizers recovered before authentication. */
export function isCurrentConfiguredAdministrator(database: Database.Database, authority: CredentialAuthority): boolean {
    const provenance = record<ConfiguredAdministratorProvenance>(database, credentialKind, authority.credentialId);
    if (!provenance)
        return !legacyConfiguredIdentity(authority);
    const current = record<ConfiguredAdministratorConfiguration>(database, configurationKind, configurationId);
    return authority.customerId === null && authority.actorId === CONFIGURED_ADMINISTRATOR_ACTOR && current !== null && current.fingerprint !== null && provenance.fingerprint === current.fingerprint && provenance.epoch === current.epoch;
}
