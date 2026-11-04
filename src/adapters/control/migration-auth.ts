import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { WorkspaceError, type CustomerId, type Principal } from '../../domain';
import type { CredentialAuthority } from '../../ports/control-store';
import { principalForVerifiedAdministrator } from '../../middleware/catalog-identity';
import { CONFIGURED_ADMINISTRATOR_ACTOR } from '../../db/configured-administrator';

/** Operator authentication reads existing scoped key authority; it never invents grants for a legacy row. */
export function migrationPrincipal(database: Database.Database, key: string, customerId: CustomerId, now: string, masterKey: string | null = null, readOnly = false): Principal {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  if (masterKey && hash(masterKey) === hash(key)) {
    if (!readOnly) return principalForVerifiedAdministrator(database, key, customerId, now);
    const configured = database.prepare("SELECT data FROM catalog_records WHERE kind='configured-administrator-configuration' AND id='configured-master-key'").get() as { data: string } | undefined;
    const configuration = configured ? JSON.parse(configured.data) : null; const fingerprint = createHash('sha256').update('ContextVault configured administrator v1\0').update(key).digest('hex');
    if (!configuration || configuration.fingerprint !== fingerprint) throw new WorkspaceError('CREDENTIAL_REVOKED', 'Configured administrator trust root is not current');
    const id = `administrator:${createHash('sha256').update(fingerprint).update('\0').update(String(configuration.epoch)).update('\0').update(customerId).digest('hex')}`;
    const stored = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(id) as { data: string } | undefined; const authority = stored ? JSON.parse(stored.data) as CredentialAuthority : null;
    if (!authority || authority.revokedAt || authority.customerId !== null || authority.actorId !== CONFIGURED_ADMINISTRATOR_ACTOR) throw new WorkspaceError('CREDENTIAL_REVOKED', 'Read-only inspection requires existing current administrator authority');
    return { kind: 'administrator', actorId: authority.actorId, credential: { id: id as Principal['credential']['id'], kind: 'external', version: authority.credentialVersion }, permissionEpoch: authority.permissionEpoch, authenticatedAt: now };
  }
  const row = database.prepare('SELECT id,customer_id FROM api_keys WHERE key_hash=?').get(hash(key)) as { id: string; customer_id: string } | undefined;
  if (!row || row.customer_id !== customerId) throw new WorkspaceError('UNAUTHENTICATED', 'A current scoped migration credential is required');
  const stored = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(row.id) as { data: string } | undefined;
  const authority = stored ? JSON.parse(stored.data) as CredentialAuthority : null;
  if (!authority || authority.revokedAt || authority.customerId !== customerId || authority.credentialId !== row.id) throw new WorkspaceError('CREDENTIAL_REVOKED', 'The scoped credential has no current catalog authority');
  return { kind: 'customer', customerId, actorId: authority.actorId, credential: { id: row.id as Principal['credential']['id'], kind: 'api-key', version: authority.credentialVersion }, permissionEpoch: authority.permissionEpoch, authenticatedAt: now };
}
