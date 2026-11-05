# Workspace API guide

New clients should use the backend-neutral `/v1` lifecycle described in the [HTTP reference](../REST_API.md).
Existing unversioned consumers should first read the [compatibility guide](compatibility.md).

## Complete snapshot lifecycle

1. Create or select a workspace under the authenticated customer.
2. Open a read-write run with `agentLabel`, `task`, and `reason`.
3. Hydrate its pinned manifest and file streams on the client host.
4. Stop every agent writer before capture.
5. Create an upload session for the run.
6. Upload each regular file and retain its completed receipt.
7. Seal the complete manifest with exact receipt selections.
8. Finalize using the current run version and sealed submission ID.
9. Inspect the returned durable operation until its outcome is known.
10. Clean the owned local workspace explicitly.

Installed clients perform the upload and seal coordination for ordinary local files.
The [client quickstart](../quickstart/clients.md) contains the maintained executable examples.

## Read-only lifecycle

A read-only run pins an accepted revision and exposes its manifest and files.
It rejects uploads and content publication.
Finalization omits a submission and can complete after another writer advances the workspace head.
The application still renews its lease while using the run.

## Publication authority

The catalog's accepted revision is authoritative.
A prepared Git commit or S3 object is not an accepted workspace change.
Publication checks the original base, workspace version, storage generation, processing fence, and current authorization.
Competing updates produce a recorded conflict rather than automatic merging.

Run versions, lease versions, submission versions, and operation versions serve different concurrency checks.
The [reference](../REST_API.md#versions-and-outcomes) lists their meanings.

## Recovery

The client retains a private session identity before remote IDs exist.
It saves pending commands and immutable captures outside submitted content.
A process restart resumes that journal with current credentials and the same server origin.

A lost response does not prove the command failed.
Reconciliation reads a known operation or replays the original exact command.
It does not assign a fresh key or recapture later local edits.
An authorization denial during reconciliation preserves uncertainty.

Abort discards a known active run without publishing its changes.
It is not a substitute for reconciling finalization.
Cleanup has an independent state and cannot undo accepted publication.

## Accepted revisions and administration

History, manifest, binary-file, diff, search, and restore routes read catalog-selected accepted content.
Revision IDs are opaque; retained Git aliases remain workspace-scoped.
Restore publishes the selected contents with optimistic current-head checks.

Clone requires source read and destination create authority.
Export returns a customer-scoped signed bundle handle.
Import consumes a verified opaque handle, not a server path.
Deleting a workspace tombstones it while retaining accepted history.

See [administration routes](../REST_API.md#clone-and-bundles) and the [operations guide](../quickstart/operations.md).
