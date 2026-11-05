# Operations, recovery, and migration

ContextVault keeps authoritative state in SQLite and immutable contents in configured Git or S3 stores.
Operators own deployment, key management, backups, writer coordination, and restoration checks.
The procedures below use explicit private paths and current scoped authority.

## Protect a recovery set

A complete recovery set includes the catalog, retained revision content, storage profiles, credentials, legacy secret material, and signing keys.
Client private journals and captures need separate retention when their jobs must survive local disk or container replacement.
S3 content alone cannot reconstruct catalog authority.

Warning: Do not copy only a live SQLite main file. This can omit WAL state.

1. Stop or coordinate writers for the selected backup procedure.
2. Take a consistent SQLite backup using its backup mechanism or a quiesced snapshot.
3. Preserve the referenced immutable content and retained configuration profiles.
4. Protect credential and signing material through the existing key-management process.
5. Encrypt and restrict access to catalog, secret, content, and client-state backups.
6. Restore the recovery set into an isolated environment.
7. Verify accepted heads, retained history, current authority, and unfinished operations through the API.

A storage migration's backup includes a verified `catalog.sqlite`, retained snapshots, secret backup, and immutable receipt.
That catalog snapshot can contain authority beyond the selected workspace and requires service-private access.
Migration backup verification is not an automatic whole-service disaster-recovery workflow.

## Reconcile an uncertain agent command

1. Stop every controller for the affected client session.
2. Stop every agent writer using its local workspace.
3. Retain the private journal, captures, local workspace, and original server origin.
4. Supply current scoped credentials to a resumed client.
5. Reconcile the original command or known operation ID.
6. Inspect the authoritative terminal outcome before abort or cleanup.

The CLI requires `--controllers-stopped --writers-stopped` when recovering a crashed controller marker.
MCP has corresponding controller-recovery tools and stopped-writer arguments.
The assertions do not establish that a hostile process stopped.

A later `401` or `403` does not prove the first request failed.
Do not replace an uncertain command's key or captured bytes.
A successful checkpoint with incomplete reopen retains its accepted publication and original reopen command.
Client-specific abandonment requires proof that the reopen was never accepted.

## Inspect current storage profiles

Run operator scripts from the repository root with the configured service environment.
`CV_DATA_DIR` must be absolute, and the catalog must already exist.
`CV_MIGRATION_API_KEY` must resolve current authority for the selected customer.

1. Build the service configuration module.

```sh
npm run build
```

2. List available profile identities without printing credentials.

```sh
node -e 'const c=require("./dist/config").loadConfiguration(); console.log(JSON.stringify(c.profiles.map(({backend,configurationRef})=>({backend,configurationRef}))))'
```

Changing a profile's physical location changes its identity.
Keep original profiles while accepted revisions reference them.
Changing `CV_STORAGE_BACKEND` selects a default for new bindings; it does not migrate existing workspaces.

## Move an existing workspace between adapters

Use this procedure only for an already adopted catalog-backed workspace.
Configure both source and destination profiles before starting.
The target profile must differ from the current source profile.

1. Prevent new application work for the selected workspace.
2. Settle every active run, including read-only runs.
3. Settle pending restore, clone, export, and other retained source work.
4. Load `CV_MIGRATION_API_KEY` through the credential provider.
5. Inspect every retained revision using the intended target and stable command inputs.

```sh
node -r ./node_modules/ts-node/register/transpile-only scripts/migrate-storage.ts inspect \
  --customer "$CUSTOMER_ID" --workspace "$WORKSPACE_ID" \
  --target-profile "$TARGET_CONFIGURATION_REF" --backup-root /absolute/private/backups \
  --idempotency-key "$MIGRATION_KEY" --reason "$MIGRATION_REASON"
```

6. Review the accepted head, retained history, target profile, and backup location.
7. Transfer using the same selected customer, workspace, target, key, reason, and backup root.

```sh
node -r ./node_modules/ts-node/register/transpile-only scripts/migrate-storage.ts transfer \
  --customer "$CUSTOMER_ID" --workspace "$WORKSPACE_ID" \
  --target-profile "$TARGET_CONFIGURATION_REF" --backup-root /absolute/private/backups \
  --idempotency-key "$MIGRATION_KEY" --reason "$MIGRATION_REASON"
```

8. Read the returned migration state and verify `complete` before resuming work.
9. Verify current metadata, revision history, aliases, and representative file bytes through the API.
10. Retain source storage and immutable backups until the operator's recovery policy permits removal.

The service records backup ownership before backup writes and candidate ownership before target I/O.
It verifies each copied manifest and file, checkpoints completed copies, then rechecks them before cutover.
One catalog transaction changes the active binding generation after all conditions still hold.
Revision IDs, accepted history, ownership, and aliases remain stable.

## Resume or reverse a transfer

1. Stop the original migration controller before attempting recovery.
2. Preserve the recorded migration key, exact inputs, backups, and target candidates.
3. Inspect current catalog and process ownership before resuming.
4. Rerun `transfer` with the original exact inputs after the processing claim permits recovery.
5. Inspect the recorded terminal outcome before application work resumes.

An expired claim does not prove that a physical writer stopped.
Recovery uses renewed fences and durable writer tracking.
A live or unproved writer prevents unsafe reuse or cleanup.
An acknowledgement lost after cutover can replay the recorded completed result.

To reverse a completed transfer, select the retained original profile and a new migration command identity.
Run the same inspect and transfer procedure in the opposite direction.
Do not point the default backend at an old directory and infer that authority moved.

## Adopt legacy data

Legacy adoption handles older non-bare repositories, JSON metadata, and SQLite records before the catalog becomes authoritative.
It does not guess a head or normalize incompatible retained history.

1. Stop every legacy writer and keep the original source offline.
2. Preserve the original source tree and database in a separate private backup.
3. Inventory the source using explicit absolute paths.

```sh
node -r ./node_modules/ts-node/register/transpile-only scripts/migrate-workspaces.ts inventory \
  --source-root /absolute/legacy-source --database /absolute/legacy-source/contextvault.db --json
```

4. Review each workspace's ownership, selected head, retained revisions, work evidence, and issues.
5. Resolve ambiguous authority and unfinished work through an explicit operator decision.
6. Rerun the nonmutating dry-run and retain its reviewed `sourceFingerprint`.

```sh
node -r ./node_modules/ts-node/register/transpile-only scripts/migrate-workspaces.ts dry-run \
  --source-root /absolute/legacy-source --database /absolute/legacy-source/contextvault.db --json
```

7. Initialize a separate target catalog and configure private storage profiles and current migration authority.
8. Adopt one eligible workspace using the exact reviewed fingerprint.

```sh
node -r ./node_modules/ts-node/register/transpile-only scripts/migrate-workspaces.ts adopt \
  --source-root /absolute/legacy-source --database /absolute/legacy-source/contextvault.db \
  --customer "$CUSTOMER_ID" --workspace "$WORKSPACE_ID" \
  --source-fingerprint "$REVIEWED_SOURCE_FINGERPRINT" \
  --target-profile "$TARGET_CONFIGURATION_REF" --backup-root /absolute/private/legacy-backups \
  --idempotency-key "$ADOPTION_KEY" --reason "$ADOPTION_REASON" --source-offline
```

9. Verify accepted metadata, history, aliases, and exact bytes through the new API.
10. Retain the offline source and immutable backup under the operator's recovery policy.

The target catalog must already exist and recognize the current migration credential.
Normal service startup initializes its catalog before operator scripts use it.
Inventory and dry-run accept `--limits-json`; adoption instead uses configured limits and rejects that option.

`--source-offline` is the operator's assertion, not a process-isolation mechanism.
The target catalog, content roots, and secrets must be outside the original legacy source.
Rerunning adoption with the same exact identity resumes its recorded work.
A changed source fingerprint or incompatible history stops cutover.
Legacy Git hashes remain workspace-scoped aliases of opaque canonical revisions.

## Inventory blockers

| Evidence | Required operator handling |
|---|---|
| Conflicting head, owner, status, name, or repository | Resolve authoritative meaning explicitly |
| Missing or invalid metadata | Recover identity and ownership before adoption |
| Dirty, untracked, or ignored files | Preserve and settle unfinished contents |
| Configured Git content filters | Resolve offline; read-only inventory refuses to invoke those filters |
| Surviving run, lock, or sandbox | Establish ownership and settle the work |
| Invalid path, link, collision, or quota in retained history | Preserve the original history and resolve compatibility |
| Existing catalog authority | Use catalog-aware operations rather than adopting over it |

Inventory reports exact revision, path, and rule diagnostics where applicable.
Expiry timestamps do not prove that legacy writers stopped.
No procedure discards unfinished data, truncates history, or silently chooses one conflicting head.

## Cleanup and retention

Server maintenance recovers registered operations, expires eligible active runs, retries outbox delivery, and collects eligible unpublished bytes.
Collection requires current catalog eligibility, a fence, and proof that relevant writers stopped.
Retained source pins protect restore, clone, export, and migration work.

Client cleanup validates exact local ownership and runs independently from remote publication.
A cleanup failure leaves the accepted outcome intact and retains recovery information.
Workspace deletion first tombstones the workspace.
Accepted history remains outside the initial orphan-GC policy.

Operators must define any future accepted-history purge policy separately.
The current implementation does not provide a general bucket-prefix purge command.

## Verification and operational limits

The migration tests exercise actual Git-to-LocalStack-to-Git transfer, immutable backups, byte verification, process interruption, fenced recovery, and terminal replay.
That evidence does not establish AWS IAM, physical power-loss durability, or an organization's complete restoration procedure.

The [security model](../SECURITY_MODEL.md) describes credentials, signing, current authority, and host isolation.
The [development guide](../DEVELOPMENT.md#verification) lists required gates.
