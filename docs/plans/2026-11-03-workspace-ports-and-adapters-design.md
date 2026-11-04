# ContextVault workspace ports and adapters

Date: 2026-11-03, America/Chicago.
Status: approved design; implementation pending.
Approval: the user approved this design in chat `01a1a255-17c8-7dd0-b1b7-5d4af16d854f`.

## Outcome

ContextVault provides durable, versioned workspaces to existing agents.
Agents continue running in application workers, containers, local CLIs, and separate machines.
ContextVault controls access, accepted revisions, finalize, abort, expiry, and audit.

Git and S3 are interchangeable implementations of immutable revision storage.
A temporary directory beside each agent provides ordinary file access.
AgentCore and S3 Files mounts are optional future integrations.

## Authority

The transactional catalog stores the only authoritative current revision.
Storage adapters prepare durable content before the catalog accepts its reference.
The presence of a Git commit or S3 manifest does not establish acceptance.

Publication updates the workspace head, run outcome, revision reference, audit record, and outbox record together.
Preparation and publication do not require a distributed transaction.
Unpublished content remains inaccessible through accepted-workspace reads and becomes eligible for controlled cleanup.

Keep the current SQLite implementation for one ContextVault service instance.
Multiple independent service replicas require a shared transactional ControlStore implementation before deployment.
S3 object storage alone does not change that deployment constraint.

## Ports

| Port | Responsibility | Initial implementations |
|---|---|---|
| ControlStore | Workspace metadata, runs, revisions, leases, idempotency, atomic publication, audit, outbox | SQLite |
| RevisionStore | Read immutable snapshots and prepare durable candidate revisions | Git; S3 |
| SubmissionStore | Upload, seal, read, and expire unpublished run submissions | Local disk; S3 |
| AccessPolicy | Decide authenticated actor permissions using catalog-backed policy | Customer ownership and explicit action permissions |
| WorkspaceMaterializer | Materialize, capture, and remove agent-local temporary directories | TypeScript, Python, PHP client helpers; CLI |

WorkspaceMaterializer executes beside the agent.
Its local path is a client result, rather than a remote-server path claim.
Every inbound adapter invokes the same application services.
Adapters receive a validated customer/workspace scope, never arbitrary agent-selected storage locations.

## Records

Workspace records contain customer ownership, current revision, version, status, and storage-binding generation.
Revision records contain parent revision, canonical manifest digest, storage binding, and adapter-private location.
Run records contain authenticated actor identity, agent label, task, reason, base revision, state, expiry, and operation references.
Submission records identify completed immutable uploads and their sealed manifest.

Public revision IDs remain opaque.
Git hashes and S3 locations remain private, except explicitly documented legacy aliases.
New workspaces receive an explicit empty initial revision.

Cleanup state remains independent from run outcome.
Cleanup cannot replace a finalized, aborted, conflicted, failed, or expired outcome.

## Files

A canonical manifest lists normalized relative paths, regular-file byte lengths, SHA-256 digests, and supported file kinds.
Preserve binary bytes and line endings without storage-specific transformations.
Reject traversal, symlinks, special files, duplicate paths, reserved metadata paths, and portable-name collisions.
Exclude `.git` and client-control data from agent contents and signed exports.

Version one materializes and submits complete snapshots.
An omitted path in a complete submission means deletion.
Sparse materialization needs a separate protocol before it can safely coexist with deletion.

## Lifecycle

1. Authenticate the caller and authorize workspace access.
2. Pin the current revision and storage binding when opening a run.
3. Download files into a temporary directory beside the agent.
4. Let the existing agent read and write files.
5. Capture, upload, and seal a stable submission.
6. Claim finalization through an atomic state transition.
7. Validate the sealed bytes and prepare durable revision content.
8. Accept the prepared revision through one catalog transaction.
9. Return the persisted result and clean temporary resources.

Finalize checks current authorization, workspace status, expected head, binding generation, run version, and finalizer fencing token.
Middleware authorization alone cannot satisfy publication checks.
Revocation before acceptance prevents publication.

Abort succeeds while a run remains active.
An abort/finalize race has one winning state transition.
Abort returns a conflict after finalization starts.
Successful abort never changes accepted workspace contents.

All adapters reject stale publication consistently.
Version one does not automatically merge content on Git while rejecting the same operation on S3.
An optional exclusive-writer policy may coordinate work, but publication always verifies its expected revision.

Repeated commands use persisted idempotency keys and request digests.
Identical retries return the recorded operation result.
Reusing a key with different input fails.
Unknown publication outcomes require status reconciliation before retry, cleanup, or abort.

## Agent access

| Environment | Local access |
|---|---|
| Application worker | SDK materializes a directory inside the worker environment |
| Container | SDK or CLI materializes into a writable volume shared with the existing agent |
| Local CLI | CLI materializes a directory on the user's computer |
| Separate machine | SDK or CLI transfers files through authenticated HTTP without a shared filesystem |

Version one proxies file streams through ContextVault.
Agents receive no Git credentials, S3 credentials, or canonical-storage write access.
The existing runtime supplies operating-system or container isolation against hostile code.
Downloaded copies cannot be revoked or erased by ContextVault when their host is offline.

## Adapter behavior

The Git adapter prepares commits without mutating a shared checked-out working tree.
Internal refs protect prepared and retained objects from garbage collection.
Disable hooks, filters, and automatic line-ending transformations during preparation.
Convenient branch projections never replace catalog authority.

The S3 adapter writes immutable file objects before its immutable manifest.
Conditional creation prevents replacement; retries verify existing content.
The manifest's SHA-256 digest remains separate from S3 ETags.
Use revision-local object locations initially, avoiding cross-revision deduplication and its deletion complexity.

Neither adapter publishes by changing its own current pointer.
Both satisfy the same observable revision contract.

## Recovery and delivery

Persist finalization intent before preparation begins.
Recovery workers use monotonically increasing fencing tokens.
Expired workers cannot publish or overwrite a newer operation result.
Transient failure leaves a recoverable operation; terminal failure requires evidence that acceptance did not commit.

The outbox delivers events at least once with stable event IDs.
Select subscriptions within the event's customer scope.
Webhook delivery failure never reverses publication.

Initial garbage collection covers expired submissions and orphan candidates only.
Protect accepted history, active bases, recoverable operations, migration copies, and active exports.
Accepted-history deletion requires an explicit retention policy.

## Compatibility and migration

Legacy push remains a complete replacement operation.
Legacy checkout/commit/destroy becomes a compatibility session over one or more normal runs.
A checkpoint finalizes its run and opens the next while preserving the caller's local session path.
Unknown publication or reopen outcomes remain explicit and recoverable.

Both MCP entrypoints converge on authenticated services and one maintained implementation.
Direct Git cannot update authoritative state outside the common publication service.
Git protocol reads, if retained, advertise accepted content only.

Migration inventories SQLite rows, JSON metadata, Git repositories, retained history, refs, and surviving sandbox/run records.
Current repositories must be inspected because existing source initializes checked-out repositories rather than bare repositories.
Ambiguous ownership or accepted heads stop migration for the affected workspace.
Do not silently choose a conflicting source or discard dirty files.

Backend migration drains mutable runs, transfers retained revisions, verifies bytes, and atomically switches the storage binding.
Preserve workspace IDs and workspace-scoped legacy revision aliases.
After new S3 publications, returning to Git requires transferring those accepted revisions first.

## Evidence boundary

This document records the approved target design.
It does not certify existing implementation, deployment, production access control, S3 behavior, or host compatibility.
The implementation plan defines separate proof for those outcomes.
