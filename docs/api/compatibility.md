# Compatibility and consumer migration

Retained routes share ContextVault's catalog-backed publication and access rules.
Their wire shapes and host assumptions differ from the `/v1` API.
The following mappings identify migration work for existing consumers.

## Route and field mapping

| Existing surface | Retained behavior | Preferred new surface |
|---|---|---|
| `POST /workspaces/:id/push` | Complete replacement snapshot through an authorized run | Client upload, seal, and finalize |
| `POST /workspaces/:id/sandbox` | Server-colocated compatibility sandbox | Installed client `openWorkspace` or equivalent |
| `POST /workspaces/:id/sandbox/commit` | Stopped-writer checkpoint, followed by the next run | Client checkpoint |
| `DELETE /workspaces/:id/sandbox` | Explicit stopped-writer cleanup or abandonment checks | Client abort and cleanup |
| `/workspaces/:id/runs`, `/runs/:id` | Legacy fields alongside canonical run information | `/v1` runs and durable operations |
| `GET /workspaces/:id/pull` | Accepted small snapshot; base64 for binary content | Manifest and binary file streams |
| `GET /workspaces/:id/history` | `commits`, `commitId`, and cursor aliases | Accepted revision pages |
| `POST /workspaces/:id/rollback` | Authorized restore through common publication | `/v1/workspaces/:id/restore` |
| Git `upload-pack` | Accepted-history projection for Git-backed workspaces | Backend-neutral revision reads |
| Git `receive-pack` | Rejected for canonical publication | Upload, seal, and finalize |

The legacy push row uses the same new-client upload, seal, and finalize protocol as its preferred replacement.
The endpoint's `files` array describes the complete resulting snapshot.
Omitting a file deletes it; sending an empty array replaces all contents with an empty snapshot.
It is not a partial patch API.
The legacy files array cannot represent standalone empty directories.
Use v1 manifest-based clients when those directories must survive round trips.

Legacy sandbox commit requires `writersStopped:true`.
Its sequential checkpoint behavior differs from a one-shot finalization.
The sandbox path belongs to the server host.
A remote caller cannot use that path as its own local directory.

Legacy run views can expose `status:running`, `merged`, or `cleaned_up`.
Canonical `state`, `outcome`, and `cleanup` preserve their separate meanings.
Legacy run records return `sandboxPath:null`; local materialization requires an installed client or the explicit colocated sandbox route.
`baseCommit`, `workspaceHeadAtStart`, `finalCommit`, and `commitId` can contain opaque canonical revision IDs.
Do not validate those fields as hexadecimal Git hashes.

Unversioned mutation handlers can generate an idempotency key when a caller omits it.
The response may expose the generated key, but a lost first response cannot return that identity to the caller.
Existing consumers should persist an explicit key before dispatch.
V1 mutations require that explicit key.

## Downstream migration recipe

1. Inventory every consumer's route, package version, credential, and filesystem assumptions.
2. Replace server sandbox paths with installed client-local workspace sessions.
3. Persist private recovery identity in the external job record before starting agent work.
4. Launch the existing agent against the returned local path.
5. Schedule heartbeat while the agent uses the run.
6. Stop all writers before capture, checkpoint, finalize, abort cleanup, or cleanup.
7. Replace partial-push assumptions with a complete snapshot or explicit application-side composition.
8. Preserve exact command identities when a response becomes uncertain.
9. Inspect canonical outcome and separate cleanup state before removing local files.
10. Verify the consumer on both configured storage adapters.

PHP, Python, and TypeScript method names differ.
Use their [installed package references](../SDK_PLAN.md#client-api-references).
No consumer repository needs direct access to ContextVault's Git store or S3 prefix.

## Other retained administration

Clone, export, import, deletion, history, diff, and search use canonical accepted content through application services.
`bundlePath` is an opaque customer-scoped handle.
A previous consumer that passed an arbitrary filesystem path must move to bundle upload and download.
Disabling bundle hash verification is unsupported.

Canonical Git reads require current scoped authority and a Git-backed workspace.
S3-backed workspaces return `UNSUPPORTED_CAPABILITY` for the Git wire protocol.
Git ref advertisements do not expose arbitrary unpublished candidate history.
Direct canonical push cannot bypass finalize or current authorization.

## Webhook consumers

Outbox recipients remain customer-scoped and delivery identities support receiver deduplication.
Retained event aliases can differ from canonical event names and payloads.
Receivers should retain the received `X-ContextVault-Event-ID` and accept duplicate delivery safely.

The current legacy signing-key derivation uses the hexadecimal SHA-256 digest of the registration secret as its HMAC key.
Verify the exact received body bytes using that derivation.
See [webhook security](../SECURITY_MODEL.md#webhooks) before changing a deployed receiver.

## Legacy data adoption

Consumer API migration and backend data migration are separate tasks.
Legacy adoption first inventories repositories, JSON metadata, SQLite rows, active work, and retained history.
Conflicting heads or ownership require operator resolution.
Dirty files, ignored unfinished contents, configured Git filters, and surviving sandboxes prevent automatic adoption.
Compatible legacy Git hashes become workspace-scoped revision aliases.

Follow the [inventory and adoption runbook](../quickstart/operations.md#adopt-legacy-data).
Keep the original source offline, backed up, and unchanged while adoption verifies it.
Do not discard uncommitted data or choose an ambiguous head to make the migration pass.
