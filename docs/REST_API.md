# HTTP API reference

The `/v1` API exposes backend-neutral workspace lifecycle and accepted revision operations.
The service owns authority and publication.
Clients own temporary files on their own hosts.

Interactive documentation is available at `/docs`.
The registered handlers and strict validation schemas remain authoritative.
Relevant sources are [lifecycle routes](../src/routes/v1/index.ts), [revision routes](../src/routes/v1/revisions.ts), and [administration routes](../src/routes/v1/admin.ts).

## Authentication and command identity

Protected requests use `X-API-Key`.
Customer credentials select their own customer.
Administrator workspace requests require `X-ContextVault-Customer-Id`.
`customerId` in workspace creation must match the authenticated selection.

Every v1 mutation requires a nonempty `Idempotency-Key` of at most 256 characters.
Retain that key and the exact request before dispatch.
A lifecycle command identity binds the customer, actor, operation kind, resource, and canonical request digest.
Reusing a lifecycle key with changed input returns `IDEMPOTENCY_KEY_REUSED`.
A new key represents a new command, not reconciliation.

A configured administrator can bootstrap a customer key with `POST /api-keys` and `{customerId,name}`.
The response contains `plainKey`; store it through your credential provider.
`GET /api-keys` and `DELETE /api-keys/:id` require current credential-management authority.
Agents should use the resulting scoped key instead of the administrator key.

## Workspace and run routes

| Method | Path | Request or result |
|---|---|---|
| `POST` | `/v1/workspaces` | `{customerId,name}`; `201` workspace or `202` creation operation |
| `GET` | `/v1/workspaces` | `offset`, `limit`; scoped workspace page |
| `GET` | `/v1/workspaces/:id` | Workspace metadata |
| `DELETE` | `/v1/workspaces/:id` | Optional `{expectedWorkspaceVersion,reason}`; `204` tombstone |
| `POST` | `/v1/workspaces/:id/runs` | `{mode,agentLabel,task,reason}`; `201` pinned run |
| `GET` | `/v1/runs/:id` | Current run, lease, outcome, and cleanup metadata |
| `GET` | `/v1/runs/:id/workspace/manifest` | Pinned base manifest |
| `GET` | `/v1/runs/:id/workspace/files?path=...` | Exact pinned file stream |
| `POST` | `/v1/runs/:id/heartbeat` | `{expectedLeaseVersion}`; renewed run view |
| `POST` | `/v1/runs/:id/finalize` | `{expectedRunVersion,submissionId?}`; `202` operation |
| `POST` | `/v1/runs/:id/abort` | `{expectedRunVersion,reason}`; aborted run |
| `GET` | `/v1/operations/:id` | Durable operation status and result |

`mode` is `read-only` or `read-write`.
The run records its actor context, task, agent label, and reason.
A read-write finalization requires a sealed submission.
A read-only finalization omits `submissionId` and does not publish content.

Run responses contain `baseRevisionId`, `version`, `leaseVersion`, `expiresAt`, `operationId`, `outcome`, `cleanup`, and `_links`.
They contain no server filesystem path, storage credential, private locator, or processing fence.
Action links reflect lifecycle availability; server authorization still checks every request.

## Submission routes

| Method | Path | Request or result |
|---|---|---|
| `POST` | `/v1/runs/:id/submissions` | `{}`; `201` upload session |
| `GET` | `/v1/runs/:id/submissions/:sid` | Submission state and version |
| `PUT` | `/v1/runs/:id/submissions/:sid/files?path=...` | Binary file stream; `201` receipt |
| `POST` | `/v1/runs/:id/submissions/:sid/seal` | Complete manifest and exact receipt selections |

Uploads use `Content-Type: application/octet-stream` and lowercase `X-Content-SHA256`.
An optional `Content-Length` must contain the exact nonnegative byte count.
Each upload command needs its own stable idempotency key.
A completed receipt contains `id`, `path`, `byteLength`, `sha256`, and `completedAt`.

A seal body has this shape:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "entries": [
      { "path": "empty-directory", "kind": "directory" },
      {
        "path": "result.bin",
        "kind": "file",
        "byteLength": 3,
        "sha256": "replace-with-the-exact-lowercase-sha256"
      }
    ]
  },
  "receipts": [
    { "path": "result.bin", "receiptId": "receipt-from-the-upload-response" }
  ]
}
```

The digest placeholder above is explanatory, not a valid submission.
Every file entry must select its completed matching receipt.
Directories do not have file receipts.
The manifest describes the entire resulting workspace.
Omitted paths are deleted, and an empty manifest removes all previous contents.

Sealing selects immutable registered attempts atomically.
Later uploads cannot alter the sealed source.
The [installed client examples](quickstart/clients.md) perform capture, upload, and sealing for ordinary files.

## Versions and outcomes

| Field | Meaning |
|---|---|
| Workspace `version` | Accepted workspace administration and current-head concurrency |
| Run `version` | Run lifecycle transitions |
| Run `leaseVersion` | Heartbeat concurrency |
| Submission `version` | Upload and seal progress |
| Operation `version` | Durable command progress |

A heartbeat changes lease state without changing the run lifecycle version.
Upload and seal progress do not substitute for a run version.
The service defaults active leases to five minutes.
An expired run cannot be revived by heartbeat.

Run states are `active`, `finalizing`, `finalized`, `aborted`, `conflicted`, `failed`, and `expired`.
Operation states are `pending`, `processing`, `succeeded`, and `failed`.
Operation phases are `claimed`, `preparing`, `prepared`, `accepting`, and `complete`.
Cleanup states are `pending`, `running`, `complete`, and `failed`.
Cleanup cannot change a recorded terminal run outcome.

`202` means the operation remains inspectable through its returned ID.
Poll `GET /v1/operations/:id` until the operation reaches a known terminal state.
Inspect the result's `kind`, run state, revision ID, and `changed` value.
An operation reaching `succeeded` is distinct from an HTTP request merely returning successfully.

A transport failure or `PUBLICATION_OUTCOME_UNKNOWN` requires reconciliation.
Retain the original key, exact request, and immutable captured source.
Read a known operation ID, or replay the original command when its ID remains unknown.
Do not infer failure from a timeout, disconnect, or later authorization denial.

## Accepted revision routes

| Method | Path | Request or result |
|---|---|---|
| `GET` | `/v1/workspaces/:id/revisions` | `cursor`, `limit`; ancestry page and `nextCursor` |
| `GET` | `/v1/workspaces/:id/revisions/:rid/manifest` | Exact accepted manifest |
| `GET` | `/v1/workspaces/:id/revisions/:rid/files?path=...` | Accepted binary file stream |
| `GET` | `/v1/workspaces/:id/diff` | Required `from` and `to` revision IDs |
| `GET` | `/v1/workspaces/:id/search` | `q`, optional `revisionId` and `limit` |
| `POST` | `/v1/workspaces/:id/restore` | `{revisionId,expectedRevisionId,expectedWorkspaceVersion,reason}`; `202` operation |

Revision IDs are opaque on every backend.
Workspace-scoped retained aliases can resolve older Git identifiers.
Restore publishes selected accepted contents through a new operation with current-head checks.
Search is a bounded text operation over selected accepted contents, not semantic memory retrieval.

File responses use `application/octet-stream`, `Content-Length`, and `X-Content-SHA256`.
A consumer must finish and verify the stream before treating the download as complete.

## Clone and bundles

| Method | Path | Request or result |
|---|---|---|
| `POST` | `/v1/workspaces/:id/clone` | `{targetCustomerId,name?,targetWorkspaceId?}`; workspace or pending operation |
| `POST` | `/v1/workspaces/:id/export` | Optional `{revisionId}`; opaque bundle metadata |
| `POST` | `/v1/bundles` | `{}`; customer-scoped upload handle |
| `PUT` | `/v1/bundles/:bid` | `application/vnd.contextvault.bundle` stream |
| `GET` | `/v1/bundles/:bid` | Signed bundle stream |
| `POST` | `/v1/workspaces/import` | `{bundlePath,customerId?,name?,targetWorkspaceId?}`; import result or pending operation |

`bundlePath` names a customer-scoped opaque handle, not a server filesystem path.
The binary bundle begins with `CVBNDL1` plus newline, a four-byte big-endian header length, a signed JSON header, and selected file bytes.
Configured Ed25519 signing keys, exact hashes, limits, and secret scanning gate bundle readiness.
`skipHashVerification:true` is rejected.

Clone requires source read authority and destination create authority.
Import handles require the destination customer scope.
Tombstoning retains accepted history and denies ordinary content access.
The initial orphan collector does not purge retained accepted history.

## Errors

V1 domain failures use this envelope:

```json
{
  "error": {
    "code": "PUBLICATION_OUTCOME_UNKNOWN",
    "message": "The operation requires reconciliation",
    "operationId": "opaque-operation-id",
    "retryable": true
  }
}
```

| HTTP | Representative codes |
|---|---|
| `400` | `INVALID_REQUEST` |
| `401` | `UNAUTHENTICATED` |
| `403` | `FORBIDDEN`, `CREDENTIAL_REVOKED` |
| `404` | `WORKSPACE_NOT_FOUND`, `RUN_NOT_FOUND`, `SUBMISSION_NOT_FOUND`, `OPERATION_NOT_FOUND`, `REVISION_NOT_FOUND` |
| `409` | `IDEMPOTENCY_KEY_REUSED`, `REVISION_CONFLICT`, `VERSION_CONFLICT`, `STALE_FENCE`, `STORAGE_BINDING_CHANGED`, `WORKSPACE_INACTIVE`, `FINALIZATION_IN_PROGRESS`, `INVALID_TRANSITION`, `SUBMISSION_SEALED`, `CAPTURE_CHANGED`, `UNSUPPORTED_CAPABILITY` |
| `410` | `RUN_EXPIRED` |
| `413` | `QUOTA_EXCEEDED` |
| `422` | `INVALID_MANIFEST`, `RECEIPT_MISMATCH` |
| `503` | `PUBLICATION_OUTCOME_UNKNOWN`, `STORAGE_UNAVAILABLE` |

An error's `retryable` field does not authorize a new idempotency key or automatic cleanup.
Public messages may omit internal failure details.
Legacy routes retain selected different status and field shapes.
See the [compatibility guide](api/compatibility.md) before migrating an existing consumer.
