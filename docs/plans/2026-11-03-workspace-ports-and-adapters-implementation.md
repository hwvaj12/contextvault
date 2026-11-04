# ContextVault ports-and-adapters implementation plan

Date: 2026-11-03, America/Chicago.
Status: build-ready implementation plan; independent review passed on 2026-11-03.
Scope: implementation approved in this chat; execution proceeds by dependency wave.
Approved design: [workspace ports and adapters](2026-11-03-workspace-ports-and-adapters-design.md).

## 1. Repository baseline and evidence

Repository: `/Users/hwvaj/PhpstormProjects/contextvault`.
Inspected branch: `main`.
Inspected HEAD: `7f46cd7a1aedb38a09477b9fd949bbecf35e9e61`.
Verified GitHub `main`: `bd8e448d46077a4a102460fdb413c5f886a0e04e`.
The two newer commits change documentation only.
They update `README.md`, `mcp/README.md`, `docs/PHASE_11_PLAN.md`, and `docs/SUMMARY_LAYER_IDEAS.md`.

The local checkout contains a user edit to `sdk/python/pyproject.toml` and untracked Python build artifacts.
Preserve that edit, especially `build-backend = "setuptools.build_meta"`.
Do not pull, reset, clean, or move those artifacts during implementation setup.
Create implementation worktrees from a recorded integration commit after reconciling the documentation-only branch delta.
Carry approved user changes deliberately; never stage unrelated files.

No repository `AGENTS.md` appeared in the inspected source tree or inspected ancestor paths.
The chat's AGENTS instructions and `.team-lead/PROJECT.md` govern this plan.

### Current source facts

| Surface | Inspected evidence | Required change |
|---|---|---|
| Storage composition | `src/storage/index.ts:7-18` returns concrete GitStorage | Inject domain ports |
| Existing interface | `src/storage/interfaces.ts:35-45` covers metadata, rather than snapshot streaming | Separate catalog, revision, and submission responsibilities |
| Accepted head | `workspace.service.ts:67-81` falls back from SQLite to JSON/Git; `git-workspace.ts:110-125` derives Git HEAD | Backfill one catalog; retire silent runtime fallback |
| Existing repository layout | `git-workspace.ts:87-95` creates checked-out repositories | Detect actual layout during migration |
| Finalize and abort | `src/routes/runs.ts:161-178,207-224` change run state only | Implement complete application use cases |
| Concurrent transitions | `run.service.ts:131-186` updates by ID after an in-memory state check | Add atomic expected-state/version predicates |
| Sandbox identity | `sandbox.service.ts:14-30` keys paths by workspace | Use run-scoped client directories |
| Independent publication | REST push, sandbox commit, rollback, Git receive-pack, and MCP mutate storage | Converge every accepted write |
| Legacy push | `git-workspace.ts:183-195` deletes previous files before writing submitted files | Preserve full-replacement behavior |
| Authorization | `tenant.ts:7-9,22-23` conflates absent identity with its admin sentinel | Require explicit authenticated principal variants |
| Git authentication | `git-remote.ts:12-25` uses a separate API_KEY path | Unify authorization and prevent canonical-ref bypass |
| Webhooks | `webhook.service.ts:98-105` selects active subscriptions without customer filtering | Carry customer scope through outbox delivery |
| Leases | `lock.service.ts:38-92,134-146` has check-then-insert and unchecked renewal | Use transactional leases and fencing |
| Bundle export | `workspace.service.ts:333-342` lists bundle files without copying workspace bytes | Prove byte-level export/import round trips |
| Bundle manifests | `manifest.service.ts:95-110` includes repository internals | Share canonical content validation |
| File safety | `utils/path-safety.ts:7-42` checks lexical containment only | Validate filesystem objects and symlink ancestry |
| MCP | Both `mcp/src/index.ts` and `index.mjs` implement direct Git storage | Maintain one authenticated client implementation |
| MCP packaging | Development runs index.mjs; production expects dist/index.js | Align tools and build output |
| SDKs | All three return server sandbox responses and use JSON-only transports | Add streaming and agent-local materialization |
| Python package | Tests import `src`; documentation imports `contextvault` | Test and repair installed package behavior |
| Root test command | `vitest.config.ts:7` excludes `.mjs` HTTP suites | Add explicit release commands |

Source inspection establishes these planning obligations.
It does not establish live exploitation, current customer data state, production usage, or successful runtime checks.

## 2. Observable acceptance contract

The primary acceptance test belongs in `tests/acceptance/lifecycle.test.ts`.
It uses public HTTP and a separate client process with no shared server data directory.
The same assertions run against real Git and the user-selected LocalStack S3 service.

1. Create customer A and a workspace containing text and binary files.
2. Open a run and materialize its exact base revision beside the agent.
3. Add, change, and delete files through ordinary filesystem operations.
4. Capture, upload, seal, and finalize the submission.
5. Reopen the workspace from another process and verify exact accepted bytes.
6. Open another run, change files, and abort it.
7. Reopen again and verify that aborted changes never became authoritative.
8. Attempt access as customer B and verify that contents remain inaccessible.
9. Remove temporary directories and verify that accepted contents still survive.

Write this acceptance test before product implementation.
First observe failure at the documented missing lifecycle outcome.
A missing test import, dependency, server startup, or credential is a harness failure, rather than acceptance evidence.

### Acceptance IDs

| ID | Required outcome |
|---|---|
| A01 | Complete HTTP lifecycle, exact bytes, deletion, restart, and reopen |
| A02 | Abort, expiry, and cleanup preserve accepted contents |
| A03 | Competing publication, stale bases, and expired fences cannot overwrite accepted state |
| A04 | Idempotent retries and lost responses preserve one durable outcome |
| A05 | Customer isolation, revoked permission, destination authorization, and tenant webhook delivery |
| A06 | Canonical manifests, binary integrity, safe paths, sealed uploads, and bounded streaming |
| A07 | Git/S3 parity, no-change finalization, history, restore, and bundles |
| A08 | Workers, containers, local CLI, separate machines, and client-local paths |
| A09 | Installed TypeScript, Python, PHP packages and MCP entrypoint parity |
| A10 | Legacy replacement, checkpoint sessions, field/status aliases, and Git protocol boundaries |
| A11 | Inventory, interrupted migration, preserved aliases, verified cutover, and reverse migration |
| A12 | Crash recovery, tenant outbox, cleanup failure, GC races, and independent closure evidence |

## 3. Domain and port contracts

### Domain records

Use opaque `workspaceId`, `revisionId`, `runId`, `submissionId`, and `operationId` values.
Keep adapter references private and scoped by customer, workspace, and binding generation.

Workspace contains `customerId`, `currentRevisionId`, `version`, `status`, and `storageBindingId`.
StorageBinding contains backend kind, validated location, configuration reference, and generation.
Revision contains parent revision, canonical manifest digest, binding, private reference, and originating operation.
Run contains verified actor/key identity, agent label, task, reason, base revision, binding, version, lease, and outcome.
Operation contains idempotency key, caller scope, canonical request digest, phase, candidate reference, fencing token, and persisted result.
Cleanup state is independent from terminal outcome.
V1 run states are `active`, `finalizing`, `finalized`, `aborted`, `conflicted`, `failed`, and `expired`.
Client materialization separately reports `provisioning`, `ready`, or `failed`; those states do not claim agent execution.
Only `active` accepts uploads, heartbeat renewal, abort, or a new finalize claim.
Cleanup states are `pending`, `running`, `complete`, and `failed` with their own retries.

Every new workspace starts with an accepted empty revision.
No-change finalization records one completed run without creating duplicate content history.
A stale read-write base still conflicts, including no-change submissions.
Read-only completion never advances the workspace head.

### Port invariants

| Port | Mandatory operations and guarantees |
|---|---|
| ControlStore | Atomic command claim, run creation, lease renewal, revision acceptance, abort, audit/outbox insertion, and operation lookup |
| RevisionStore | Read manifest, stream accepted/candidate files internally, prepare immutable revision, and delete only fenced collectible content |
| SubmissionStore | Begin upload session, store immutable file attempts, register completed receipts, seal a manifest, stream sealed bytes, expire submissions |
| AccessPolicy | Decide explicit actions for a verified principal; publication rechecks catalog-backed authorization inside acceptance |
| WorkspaceMaterializer | Create local root, hydrate and verify files, capture stable content, maintain private handle state, and clean local files |

Clock, identifier, and fault hooks remain injectable test dependencies.
Avoid creating a general agent execution platform or arbitrary-code runner.

### Manifest v1

Use a complete, deterministically sorted manifest with `schemaVersion`, relative paths, kinds, byte lengths, and lowercase SHA-256 digests.
Canonical serialization defines encoding, sort order, and digest input in shared fixtures.
File payloads remain byte streams, without JSON text conversion.

Accept regular files and explicitly represented directories.
Reject symlinks, hard-link entries, device files, sockets, FIFOs, absolute paths, traversal, NULs, duplicate normalized paths, and reserved metadata components.
Reject names that collide on supported case-insensitive filesystems and unsupported portable Windows names.
Validate existing filesystem ancestry before reading or creating paths.
Do not follow symlinks while capturing, extracting, hashing, or cleaning.

Reserve `.git` components and `.contextvault` client-control components.
Keep credentials and private handle data outside submitted workspace roots.
Do not silently honor `.gitignore`, filters, hooks, or newline conversion differently across adapters.
Complete-manifest omission means deletion; sparse submissions remain unsupported in v1.

Apply configurable file-count, path-length, per-file, total-size, and stream-concurrency limits.
Initial defaults are 10,000 manifest entries, 1,024 path bytes, 255 component bytes, 64 MiB per file, and 512 MiB per workspace.
Allow four concurrent file streams by default, using bounded chunks rather than whole-file buffering.
Tests inject smaller limits to prove enforcement without large allocations.
Legacy-history inventory checks compatibility with every new rule before migration.
Deployments may lower limits; limits never permit partial publication.

## 4. HTTP and client contract

Add `/v1` routes without silently changing existing unversioned wire formats.
All routes require verified identity, except explicitly public health/documentation endpoints.
Authentication precedes authorization; missing identity never implies administrator access.

| Method and route | Contract |
|---|---|
| POST `/v1/workspaces` | Create an authorized workspace and empty initial revision |
| POST `/v1/workspaces/:id/runs` | Open a scoped read-only or read-write run; return base revision, expiry, and transfer links |
| GET `/v1/runs/:id` | Return durable run outcome, operation state, revisions, and independent cleanup status |
| GET `/v1/runs/:id/workspace/manifest` | Return the pinned base manifest |
| GET `/v1/runs/:id/workspace/files?path=...` | Stream one authorized base file |
| POST `/v1/runs/:id/submissions` | Create an unpublished upload session |
| PUT `/v1/runs/:id/submissions/:sid/files?path=...` | Stream one file attempt and return an immutable upload receipt |
| POST `/v1/runs/:id/submissions/:sid/seal` | Validate a complete manifest against registered receipts and seal it atomically |
| POST `/v1/runs/:id/finalize` | Claim the sealed submission and return its durable operation reference |
| POST `/v1/runs/:id/abort` | Abort an active run and invalidate further submission/publication access |
| POST `/v1/runs/:id/heartbeat` | Renew a still-valid lease under the documented policy |
| GET `/v1/operations/:id` | Reconcile a known operation after interruption or a lost response |
| GET `/v1/workspaces/:id/revisions` | List accepted history; omit unpublished candidates |
| GET `/v1/workspaces/:id/revisions/:rid/manifest` | Read an authorized accepted revision manifest |
| POST `/v1/workspaces/:id/restore` | Publish earlier contents as a new accepted revision |

Use query parameters or encoded identifiers for paths; never concatenate agent-selected storage locations.
File downloads return bytes and explicit metadata headers.
JSON errors use `{ error: { code, message, operationId?, retryable? } }`.

Require `Idempotency-Key` on create-run, submission creation, finalize, restore, and other retried mutations.
Bind keys to customer, authenticated actor, operation kind, and canonical request digest.
Same-key/same-input returns the persisted result; changed input returns `IDEMPOTENCY_KEY_REUSED`.

Finalize returns `202` with the recorded operation while processing continues.
Run and operation polling exposes `finalized`, `conflicted`, or a recorded terminal failure.
Repeated finalize returns the same operation, including a completed result.
Read-only finalize accepts no submission and completes without changing the head.
Read-write finalize requires a sealed submission, including an empty manifest when deleting all contents.
Known conflicts use `409`; expired runs use `410`; invalid manifests use `422`; quota failures use `413`.
Unauthorized callers receive `401`; forbidden actions use `403`, or scoped `404` where existence must remain private.
Document codes including `REVISION_CONFLICT`, `FINALIZATION_IN_PROGRESS`, `RUN_EXPIRED`, `INVALID_MANIFEST`, and `PUBLICATION_OUTCOME_UNKNOWN`.

The SDK's `openWorkspace` helper invokes HTTP, downloads files, and returns a client-local `path`.
Low-level HTTP run records contain no usable server-path claim.
The caller launches its existing agent separately.
Finalize, abort, and checkpoint remain explicit caller actions.

Default lease policy preserves the existing five-minute TTL initially, with one-minute client renewal.
Expired leases cannot be revived through a stale heartbeat.
Finalization uses a separate renewable processing claim; it does not depend on a continuously connected client.
Transient processing expiry enables fenced recovery rather than a competing publication.

## 5. Publication, abort, and recovery algorithm

### Upload sealing

Each upload attempt writes a unique immutable object or local file.
Register its completed receipt only while the upload session and run remain writable.
Seal selects exact registered receipts in one catalog transaction.
Late uploads cannot replace selected objects or become registered after sealing.
Unregistered completed bytes remain unpublished cleanup candidates.

The client stops agent writes before capture and reports changed-during-capture files as a retryable capture failure.
The server validates submitted bytes independently from client claims.
Sealing defines the submission boundary even if the agent later edits its local directory.

### Finalization

1. Authorize the caller and load the sealed submission.
2. Atomically claim the active run and persist the operation digest and fencing token.
3. Validate submitted contents and prepare a durable candidate revision.
4. Recheck publication preconditions inside the catalog transaction.
5. Accept the revision and persist the run result, audit event, and outbox event together.
6. Return the recorded result and enqueue cleanup.

The acceptance transaction checks current ownership, workspace status, expected revision, workspace version, binding generation, run version, and finalizer fence.
It also rechecks the authenticated key/grant and relevant policy version.
Revocation committed before acceptance prevents publication.
External identity providers require a catalog-backed revocation/permission epoch before they can satisfy this guarantee.

Git and S3 reject stale publication equally.
Keep optional exclusive-writer coordination separate from authoritative compare-and-set checks.
Two writers may prepare candidates, but only an eligible expected-head transaction accepts one.
Version one does not add automatic content merging.

### Abort and failures

| Boundary | Result |
|---|---|
| Abort claims an active run first | Abort succeeds; finalize cannot claim or publish |
| Finalize claims first | Abort returns `FINALIZATION_IN_PROGRESS`; finalization resolves |
| Abort repeats | Return the recorded aborted outcome |
| Abort follows accepted publication | Return conflict; restore is a separate authorized command |
| Preparation fails transiently | Preserve recoverable operation and unchanged authoritative head |
| Failure becomes terminal | Record failure only after proving acceptance did not commit |
| Process dies after candidate preparation | Recovery reuses the persisted operation and candidate identity |
| Process dies after acceptance | Retry returns the accepted result without another revision |
| Old finalizer resumes | Its stale fence prevents publication and outcome mutation |
| Client loses finalize response | Reconcile operation status; do not generate a new key or automatically abort |
| Cleanup fails | Preserve outcome and retry cleanup independently |

Persist enough operation data to discover candidates after a crash between storage preparation and catalog bookkeeping.
Candidate timestamps and identity derive from persisted operation data, preventing retry-induced content drift.
Use operation-derived candidate IDs and nonreplaceable adapter objects.
Never infer acceptance from an S3 listing or Git branch alone.

## 6. Adapter implementation details

### Git

Create a private object database for new storage bindings.
Use isolated indexes or temporary repositories for candidate construction.
Store binary files through blob/tree operations rather than string-oriented `git show` parsing.
Protect every prepared candidate with a private ref before reporting durable preparation.
Reject replacement of an existing candidate with a different digest.

Disable repository hooks, external filters, user configuration effects, and automatic line-ending conversion.
Avoid invoking tools on agent-controlled `.git` state.
Any convenient default-branch projection follows catalog acceptance and remains repairable.
Accepted reads resolve the catalog reference directly, even if that projection lags.

### S3

Use the existing AWS credential chain on the server only.
Use a validated customer/workspace/binding prefix and revision-local immutable keys.
Write file objects first and the complete manifest last.
Use conditional creation and verify digest/length when an operation retries an existing key.
Do not treat multipart ETags as SHA-256 values.

Preparation succeeds only after every referenced object and manifest has completed successfully.
Persist candidate metadata needed for recovery before returning.
Configure encryption, TLS, bounded concurrency, multipart abort, and least-privilege access for the adapter.
Keep published objects outside agent write permissions.
Use direct S3 APIs initially; S3 Files export synchronization does not enter this contract.

S3 Versioning may provide additional object recovery, but it does not define a complete accepted workspace revision.
The catalog and canonical manifest define that revision.
AWS documents strong single-object consistency and the absence of atomic updates across object keys.
See [S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel) and [conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

### Submission durability

Local staging uses a persistent service volume when finalization must survive process restart.
S3 staging uses unpublished scoped prefixes with immutable file attempts.
Do not claim machine-loss recovery from ephemeral local staging.
The deployment's chosen SubmissionStore determines that durability boundary.

## 7. Clients, hosts, and compatibility

### Installed SDKs

Add run resources, binary streaming, local materialization, capture, heartbeat, operation reconciliation, finalize, abort, checkpoint, and cleanup to all SDKs.
Preserve declared minimum versions unless implementation obtains an explicit compatibility decision.
Current declarations are Node 18+, Python 3.8+, and PHP 8.0+.

TypeScript needs installed-package tests rather than source imports only.
Python needs a clean wheel install supporting `from contextvault import Client`.
Preserve the existing build-backend edit and isolate any repository-local `src` compatibility shim from installed global packages.
PHP needs Composer-installed acceptance and stream-aware Guzzle transport.
All SDKs expose typed conflicts and unknown-outcome errors.

Keep automatic exception cleanup conservative.
Abort only a definitely active run when policy calls for it.
Unknown publication outcomes preserve reconciliation metadata and local contents.
Cleanup remains explicit or occurs after a proven terminal result.

### CLI and containers

Add a separate `cli/` package with a documented executable.
Provide open, submit, finalize, abort, status, reconcile, heartbeat, and cleanup commands.
Return stable JSON containing client-local paths and run identifiers.
Use exit codes `0` for success, `2` for invalid invocation, `3` for access denial, `4` for conflict, and `5` for uncertainty.
Keep private handle state outside submitted files and redact credentials from output.
Do not place secrets in command arguments or workspace files.

Container examples run the existing agent and client against a writable shared volume.
Separate-machine tests deny server-volume access and transfer files through HTTP.
A separate process alone proves process isolation, rather than a separate host boundary.
The release matrix requires a container/network boundary or actual remote worker for the remote-host cell.

### MCP

Maintain `mcp/src/index.ts` as the implementation and make development use the same source/build path.
Use a thin loader only if compatibility requires `index.mjs`.
Fix module resolution, output directory, and packaged startup.
Remove direct Git authority and implicit `process.cwd()/data` stores.

Local MCP may use the installed client to expose a local workspace handle.
Remote MCP returns scoped handles and file tools, without claiming that its filesystem path exists beside the caller.
Prove tool-schema parity and behavior across development and packaged production launches.

### Existing consumers

| Consumer | Source evidence | Required compatibility recipe |
|---|---|---|
| Highlight Generator | `infrastructure/contextvault/adapter.py` stores sandbox paths and commits multiple pipeline phases | Client-local paths and checkpoint sessions |
| Agent Creator | `designer/contextvault_store.py:274-300` uses checkout/write/commit/destroy | Local-materialization wrapper or explicit consumer migration |
| Code Factory | `src/contextvault/client.ts` and workspace-manager consume sandboxPath, baseCommit, merged, and cleaned_up | Field/status bridge and client-local workspace provisioning |

These consumer repositories remain outside this implementation's write scope.
Add representative compatibility fixtures inside ContextVault and document follow-up consumer changes.
Mocked consumer tests do not establish cross-repository runtime compatibility.

A legacy compatibility session can contain sequential ordinary runs.
Checkpoint seals and finalizes one run, then opens the next while preserving its client-local directory.
Stop local writes during checkpoint and refresh contents before resuming if the new base differs.
Persist `published-needs-reopen` when publication succeeds but reopening fails.
Retry reopening with its original operation key, rather than publishing the checkpoint again.

Legacy HTTP push keeps complete-replacement semantics.
Legacy server-side sandbox paths remain explicitly colocated; they cannot become remote-local paths through a response-field alias.
Legacy status aliases may expose `merged` or `cleaned_up`, while separate v1 outcome fields retain the actual result.
Scope legacy sandbox sessions by customer/workspace and reject competing sessions instead of deleting another run's directory.

Reject canonical Git receive-pack by default after cutover.
If retained, import pushed candidates through an authorized submission/finalize operation.
Upload-pack and ref advertisement must expose accepted, authorized content only.
Do not advertise unpublished refs or let clients request arbitrary private objects.
S3 workspaces need not emulate the Git wire protocol; return a documented capability error.

### Existing administration and reads

Route history, diff, search, restore, clone, export/import, deletion, and bulk deletion through application services.
Diff reports binary changes explicitly; text hunks remain a presentation layer over accepted bytes.
Restore reproduces the exact earlier tree, including removed files, through a new revision.
Clone checks source-read and destination-create permissions independently.
Bundle verification covers canonical bytes and signatures, excluding `.git` and control files.
Import publishes validated contents through normal acceptance.

Deletion first tombstones the catalog and invalidates runs, access, and new publication.
Physical purge requires an explicit policy and retryable jobs.
Do not silently introduce accepted-history deletion during orphan cleanup.
Keep browser wire compatibility and opaque IDs without redesigning the UI.

## 8. Migration, recovery, and rollout

### Legacy authority inventory

Inventory SQLite records, JSON metadata, Git layout, HEADs, retained commits, noncanonical refs, dirty trees, sandbox metadata, and surviving runs.
Record ownership, hashes, counts, and discrepancies without mutating source data.
Check every retained revision for unsupported kinds, reserved names, path collisions, path length, and configured size limits.
Report the exact revision, path, and violated rule while preserving original bytes.
Stop affected cutovers without truncation, renaming, normalization, or silently dropping historical files.
Add oversized, case-collision, reserved-path, and symlink-history migration fixtures.
Do not inspect or print customer file contents unnecessarily.
Back up the catalog and content before authority cutover.

Stop an affected workspace when ownership or accepted-head sources disagree.
Require an operator selection with recorded evidence before migrating that workspace.
Continue independent, unambiguous workspaces.
Archive noncanonical history without silently accepting it or discarding dirty files.

Backfill opaque revision IDs and workspace-scoped legacy commit aliases.
Preserve workspace/customer IDs and consumer mappings.
After verification, use one catalog transaction to establish authority and disable runtime JSON/Git fallback.
Do not leave fallback capable of resurrecting tombstoned workspaces.

### Backend migration

1. Run a read-only inventory and verify backup availability.
2. Stop new mutable runs for the selected workspace.
3. Drain or resolve existing runs without discarding their contents.
4. Copy retained revisions and record resumable checkpoints.
5. Verify every manifest digest, file length, and referenced object.
6. Switch the binding generation through one expected-version catalog transaction.
7. Reopen client access and verify accepted contents through HTTP.
8. Retain old storage until the configured rollback window ends.

Support Git-to-S3 and S3-to-Git transfers with the same verification rules.
Runs remain pinned to their original binding throughout their lifetime.
After new publications, rollback requires transferring newly accepted revisions before switching back.
Never treat a configuration toggle as a data migration.

### Recovery, outbox, and GC

Reclaim finalizer work using an incremented fencing token.
Persist retries and return recorded outcomes after restart.
Outbox event IDs remain stable across attempts; delivery is at least once.
Resolve destinations by customer and event type.
Keep current webhook signing behavior or introduce an explicitly versioned replacement.

Initial GC only removes expired submissions and fenced orphan candidates.
Mark candidates transactionally and exclude them from new publication before deletion begins.
Protect accepted history, active bases, in-progress finalizations, migrations, and exports.
Recheck references before deletion and use a grace period.
Cleanup uses recorded owned paths or prefixes, never arbitrary client-supplied locations.

### Rollout gates

Use a per-workspace protocol/storage capability flag during migration.
Start with verified Git workspaces using catalog authority.
Enable S3 for test workspaces after real-adapter and real-host acceptance passes.
Migrate customer workspaces only after inventory, backup, consumer compatibility, and release evidence pass.
Do not mix bypassing legacy writers with catalog-owned workspaces.

## 9. Team work items and dependency waves

The machine-readable work items are `docs/items/CV-10.md` through `CV-28.md`, plus the discovered security prerequisite `CV-29.md`.
They contain exact dependencies, provided/consumed contracts, allowed paths, acceptance, and checks.
Their states remain `planned` until implementation begins.
Planning items CV-1 through CV-4 describe this planning effort only.

| Dependency wave | Items |
|---|---|
| 0 | CV-10 |
| 1 | CV-11, CV-12, CV-13, CV-29 |
| 2 | CV-14 |
| 3 | CV-15 |
| 4 | CV-17 |
| 5 | CV-16 |
| 6 | CV-18, CV-19, CV-20, CV-23 |
| 7 | CV-21, CV-22, CV-24 |
| 8 | CV-25 |
| 9 | CV-26 |
| 10 | CV-27 |
| 11 | CV-28 |

Critical path: CV-10 → CV-29 → CV-14 → CV-15 → CV-17 → CV-16 → CV-23 → CV-24 → CV-25 → CV-26 → CV-27 → CV-28.
Dispatch at most three writers. Prioritize the critical path and queue other ready items.
Start CV-11, CV-12, and CV-13 after CV-10 closes.
The lead completes CV-29 before CV-14 takes package-file ownership.
The helper computes readiness from dependency closure, rather than the suggested dispatch order.

| Item | Work | Depends on | Acceptance |
|---|---|---|---|
| CV-10 | Freeze domain, transfer, compatibility, and acceptance contracts | None | A01, A06 |
| CV-11 | Add transactional catalog, policy identity, and versioned migrations | CV-10 | A03, A04, A05, A12 |
| CV-12 | Implement canonical validation and sealed local submissions | CV-10 | A06 |
| CV-13 | Implement immutable Git revision storage | CV-10 | A07 |
| CV-14 | Implement S3 revision and submission storage | CV-10, CV-11, CV-12, CV-13, CV-29 | A06, A07 |
| CV-15 | Implement workspace open, finalize, abort, and expiry use cases | CV-11, CV-12, CV-13, CV-14 | A01, A02, A03, A04, A05 |
| CV-16 | Expose authenticated lifecycle and binary transfer over HTTP | CV-15, CV-17 | A01, A05, A06, A08 |
| CV-17 | Implement fenced recovery, tenant outbox, and controlled cleanup | CV-15 | A02, A05, A12 |
| CV-18 | Add TypeScript run resources and local workspace materialization | CV-16 | A08, A09, A10 |
| CV-19 | Add Python run resources and local workspace materialization | CV-16 | A08, A09, A10 |
| CV-20 | Add PHP run resources and local workspace materialization | CV-16 | A08, A09, A10 |
| CV-21 | Deliver local CLI and all agent-host launch examples | CV-18 | A08 |
| CV-22 | Unify MCP tools around authenticated ContextVault clients | CV-18 | A05, A09, A10 |
| CV-23 | Converge legacy mutation routes and direct Git access | CV-16, CV-17 | A05, A10 |
| CV-24 | Move revision reads, workspace administration, and bundles onto ports | CV-23 | A05, A07, A10 |
| CV-25 | Add legacy inventory and resumable backend migration | CV-24, CV-17 | A11 |
| CV-26 | Document the API, installed clients, compatibility, and operations | CV-18, CV-19, CV-20, CV-21, CV-22, CV-24, CV-25 | A08, A09, A10, A11 |
| CV-27 | Prove backend parity, host access, packaging, and failure recovery | CV-17, CV-18, CV-19, CV-20, CV-21, CV-22, CV-24, CV-25, CV-26 | A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12 |
| CV-28 | Independently review and close the workspace milestone | CV-26, CV-27 | A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12 |
| CV-29 | Repair affected runtime dependency advisories | CV-10 | A05, A12 |

### CV-10: Freeze domain, transfer, compatibility, and acceptance contracts

Extract a testable application factory without changing existing route behavior. Define scoped Principal, Workspace, Revision, Run, Submission, Operation, CleanupStatus, StorageBinding, manifest, and stream types. Define all five approved ports. Add package scripts and shared fixtures. Record the existing baseline before changing behavior. Provide the executable documentation-check runner and self-test fixtures before client or documentation tasks consume them.

Allowed paths: `src/domain/**`, `src/ports/**`, `contracts/**`, `tests/contracts/**`, `tests/fixtures/workspaces/**`, `tests/helpers/**`, `tests/acceptance/lifecycle.test.ts`, `src/app.ts`, `src/index.ts`, `package.json`, `package-lock.json`, `vitest.config.ts`, `scripts/verify-workspace-docs.mjs`, `scripts/run-workspace-tests.mjs`, `tests/docs/**`.

Proof: The public lifecycle acceptance fails against current behavior for its missing publication outcome. Canonical manifests, errors, state transitions, and compatibility fixtures are versioned.

Tests to add: tests/contracts/*.test.ts; tests/acceptance/lifecycle.test.ts; tests/fixtures/workspaces/*.

Proving commands: `npm run build; npm test -- tests/contracts; npm run test:docs -- --self-test; npm run test:acceptance -- --backend git`.

### CV-11: Add transactional catalog, policy identity, and versioned migrations

Add versioned SQLite migrations and a ControlStore adapter. Persist explicit principal/key identity, authorization version, revision aliases, binding generations, request digests, finalizer fences, run leases, outbox, and cleanup jobs. Remove ambiguous missing-identity-as-admin semantics. Keep old columns readable until verified migration.

Allowed paths: `src/db/**`, `src/adapters/control/**`, `src/adapters/access/**`, `src/middleware/**`, `tests/control/**`, `tests/security/access-policy.test.ts`.

Proof: Atomic publication updates head, run outcome, audit, and outbox together. Concurrent state claims and revoked or absent principals cannot publish.

Tests to add: tests/control/publication.test.ts; command-races.test.ts; schema-upgrade.test.ts; tests/security/access-policy.test.ts.

Proving commands: `npm test -- tests/control tests/security/access-policy.test.ts`.

### CV-12: Implement canonical validation and sealed local submissions

Implement bounded streaming, per-attempt immutable upload receipts, full-snapshot manifests, quota enforcement, SHA-256 verification, seal compare-and-set, and local staging. Apply the same validator to upload, capture, extraction, import, and export. Do not reuse current .git-inclusive manifest recursion unchanged.

Allowed paths: `src/application/submissions/**`, `src/application/files/**`, `src/adapters/submissions/local/**`, `tests/submissions/**`, `tests/security/workspace-files.test.ts`.

Proof: Sealed manifests reference exact immutable uploaded bytes. Late uploads, traversal, symlink escapes, special files, and portable-name collisions cannot change accepted submissions.

Tests to add: tests/submissions/seal-races.test.ts; manifest.test.ts; streaming.test.ts; tests/security/workspace-files.test.ts.

Proving commands: `npm test -- tests/submissions tests/security/workspace-files.test.ts`.

### CV-13: Implement immutable Git revision storage

Use a private object database and per-operation index or isolated temporary repository. Disable hooks, filters, and newline transformations. Protect candidates with nonreplaceable internal refs before returning. Keep accepted-history aliases and avoid shared checked-out branch mutation.

Allowed paths: `src/adapters/revisions/git/**`, `tests/adapters/git/**`.

Proof: The shared revision contract passes against real Git, including empty and binary snapshots. Preparation preserves private refs without changing catalog authority.

Tests to add: tests/adapters/git/revision-store.test.ts; candidate-retry.test.ts; private-ref-retention.test.ts.

Proving commands: `npm run test:adapters -- --backend git`.

### CV-14: Implement S3 revision and submission storage

Add the server-only AWS SDK dependency. Use scoped revision-local immutable object keys, conditional creation, server-side checksums, manifest-last preparation, streaming, multipart cleanup, and explicit encryption configuration. Distinguish ETags from SHA-256. Use S3 APIs directly; mounts and AgentCore are unnecessary.

Allowed paths: `src/adapters/revisions/s3/**`, `src/adapters/submissions/s3/**`, `tests/adapters/s3/**`, `package.json`, `package-lock.json`.

Proof: The shared contract passes through the AWS SDK against the user-selected LocalStack S3 service. Failed uploads, mismatched retry objects, and interrupted manifests never become accepted workspace contents.

Tests to add: tests/adapters/s3/revision-store.test.ts; submissions.test.ts; retry-and-integrity.test.ts.

Proving commands: `npm run test:adapters -- --backend s3 --s3-provider localstack`.

### CV-15: Implement workspace open, finalize, abort, and expiry use cases

Implement recoverable workspace creation with an accepted empty revision. Orchestrate server-side run creation and base pinning, submission sealing references, finalization claims, candidate preparation, catalog acceptance, and abort invalidation. Store operation intent before I/O. Check authorization and fencing again inside acceptance. Never treat an uncertain publication as failed or automatically abort it.

Allowed paths: `src/application/runs/**`, `src/application/workspaces/open.ts`, `tests/application/**`, `src/application/workspaces/create.ts`.

Proof: Both adapters produce identical open, finalize, abort, no-change, stale-revision, expiry, and same-key retry outcomes. Revocation during preparation prevents acceptance.

Tests to add: tests/application/run-lifecycle.test.ts; finalize-abort-race.test.ts; revocation-during-prepare.test.ts; idempotency.test.ts.

Proving commands: `npm test -- tests/application`.

### CV-16: Expose authenticated lifecycle and binary transfer over HTTP

Compose adapters using validated configuration. Add versioned routes and binary stream handling without whole-workspace JSON buffers. Return local paths only from client materialization, never generic HTTP runs. Add cancellation, range-independent retries, limits, documented 202 polling, and stable machine-readable errors. Wire normal server startup and shutdown to maintenance hooks. Prove restart recovery and tenant-scoped outbox delivery through the normal entrypoint.

Allowed paths: `src/app.ts`, `src/index.ts`, `src/config/**`, `src/routes/v1/**`, `tests/http/**`.

Proof: A client with no server filesystem access completes the lifecycle through HTTP. Every file, submission, heartbeat, operation, and publication route enforces its run scope.

Tests to add: tests/http/lifecycle.test.ts; transfer.test.ts; customer-isolation.test.ts; idempotency.test.ts; tests/http/maintenance-startup.test.ts.

Proving commands: `npm test -- tests/http; npm run build`.

### CV-17: Implement fenced recovery, tenant outbox, and controlled cleanup

Add recoverable operation scanning, fenced worker claims, durable tenant-scoped delivery attempts, cleanup jobs, and mark/fence/sweep orphan collection. Preserve webhook signature compatibility. Retain published history by default. Export start/stop maintenance hooks for CV-16 composition, without running agent code.

Allowed paths: `src/application/maintenance/**`, `src/adapters/delivery/**`, `src/services/webhook.service.ts`, `tests/recovery/**`, `tests/security/webhook-scope.test.ts`.

Proof: Restart recovery preserves one accepted revision and event. Stale workers cannot publish; delivery remains customer-scoped; cleanup protects accepted and pinned content.

Tests to add: tests/recovery/crash-boundaries.test.ts; fences.test.ts; gc-races.test.ts; outbox.test.ts; tests/security/webhook-scope.test.ts.

Proving commands: `npm run test:recovery; npm test -- tests/security/webhook-scope.test.ts`.

### CV-18: Add TypeScript run resources and local workspace materialization

Add binary transport, run/operation resources, local handles, stream verification, lease renewal, capture, explicit finalize/abort, and cleanup. Keep ordinary agent file access. Add checkpoint sessions over sequential runs. Preserve Node 18 compatibility unless an explicit version decision changes it.

Allowed paths: `sdk/typescript/**`, `tests/sdk/typescript/**`.

Proof: An installed TypeScript SDK materializes real local files, finalizes or aborts, reconciles lost responses, and checkpoints without exposing server paths or credentials.

Tests to add: tests/sdk/typescript/lifecycle.test.ts; installed-package.test.ts; checkpoint.test.ts; recovery.test.ts.

Proving commands: `npm --prefix sdk/typescript run build; npm run test:sdk -- --language typescript`.

### CV-19: Add Python run resources and local workspace materialization

Add streaming transport, conflict/uncertainty errors, run resources, local materialization, capture, lease renewal, and explicit cleanup. Preserve the user's setuptools.build_meta fix. Provide the documented package import and a repository-local legacy shim where needed. Keep Python 3.8 compatibility.

Allowed paths: `sdk/python/**`, `tests/sdk/python/**`.

Proof: A clean wheel installation supports documented contextvault imports and the full local workspace lifecycle, including conflicts, checkpoint sessions, and unknown outcomes.

Tests to add: tests/sdk/python/test_lifecycle.py; test_installed_package.py; test_checkpoint.py; test_recovery.py.

Proving commands: `npm run test:sdk -- --language python`.

### CV-20: Add PHP run resources and local workspace materialization

Add stream-aware Guzzle handling, run resources, stable error codes, local handles, safe capture, lease renewal, reconciliation, and cleanup. Preserve existing PHP 8.0 support and public workspace methods through compatibility wrappers.

Allowed paths: `sdk/php/**`, `tests/sdk/php/**`.

Proof: A Composer-installed PHP client supports local workspace files, streaming, finalize, abort, checkpoint, and publication uncertainty against both backends.

Tests to add: tests/sdk/php/WorkspaceLifecycleTest.php; InstalledPackageTest.php; CheckpointTest.php; RecoveryTest.php.

Proving commands: `npm run test:sdk -- --language php`.

### CV-21: Deliver local CLI and all agent-host launch examples

Add open, submit, finalize, abort, status, reconcile, heartbeat, and cleanup commands. Persist private local handle state outside workspace content. Provide stable JSON output and documented exit codes. Container examples mount a writable client volume; existing agents remain separately launched by their owners.

Allowed paths: `cli/**`, `examples/agents/**`, `tests/hosts/**`.

Proof: Workers, containers, local CLI sessions, and separate machines access client-local directories and complete finalize and abort through the common protocol.

Tests to add: tests/hosts/worker.test.ts; container.test.ts; cli.test.ts; remote-machine.test.ts.

Proving commands: `npm run test:hosts -- --backend git; npm run test:hosts -- --backend s3 --s3-provider localstack`.

### CV-22: Unify MCP tools around authenticated ContextVault clients

Use one TypeScript implementation and a thin development loader. Repair module/output configuration and declared dependencies. Replace direct Git engines with authenticated clients. Support local materialization and remote handle/file-tool access without claiming remote paths are local.

Allowed paths: `mcp/**`, `tests/mcp/**`.

Proof: Development and packaged production launch the same tools and lifecycle. Another working directory cannot create a separate authoritative Git store.

Tests to add: tests/mcp/entrypoint-parity.test.ts; lifecycle.test.ts; working-directory.test.ts; authorization.test.ts.

Proving commands: `npm --prefix mcp run build; npm run test:mcp`.

### CV-23: Converge legacy mutation routes and direct Git access

Preserve full-replacement legacy push and sequential checkpoint sessions. Version status/field aliases without destroying v1 outcomes. Legacy server paths remain explicitly colocated. Reject receive-pack to canonical refs by default; any retained push imports through an authorized run. Scope ref advertisements and Git reads.

Allowed paths: `src/routes/runs.ts`, `src/routes/sandbox.ts`, `src/routes/commits.ts`, `src/routes/git-remote.ts`, `src/storage/**`, `src/services/sandbox.service.ts`, `src/services/commit-gateway.service.ts`, `src/services/conflict.service.ts`, `src/services/layout.service.ts`, `src/services/commit.service.ts`, `src/compat/**`, `tests/compat/**`.

Proof: Legacy push, sandbox commit, rollback, and run mutation all use common publication. Direct Git cannot bypass authorization or publish unpublished candidate refs.

Tests to add: tests/compat/legacy-push.test.ts; sandbox-session.test.ts; legacy-runs.test.ts; git-protocol.test.ts.

Proving commands: `npm run test:legacy`.

### CV-24: Move revision reads, workspace administration, and bundles onto ports

Remove runtime JSON/Git authority fallbacks after migration gates. Stream exact accepted snapshots, including binary files and deletions. Keep bundle signing and scanning over canonical content. Require source-read and destination-create permissions for clone. Tombstone first and schedule explicit purge policy.

Allowed paths: `src/services/workspace.service.ts`, `src/services/manifest.service.ts`, `src/services/audit.service.ts`, `src/application/workspaces/admin/**`, `src/application/revisions/**`, `src/routes/workspaces.ts`, `src/routes/v1/revisions.ts`, `src/routes/v1/admin.ts`, `src/routes/vault-browser.ts`, `src/vault-browser/src/api/**`, `src/vault-browser/src/types.ts`, `ui/src/api.ts`, `tests/revisions/**`, `tests/compat/admin.test.ts`.

Proof: History, diff, search, restore, clone, export/import, and deletion work through ports on both backends. Browser fixtures preserve supported reads and opaque revision IDs.

Tests to add: tests/revisions/read-and-diff.test.ts; restore.test.ts; bundles.test.ts; clone-delete.test.ts; tests/compat/admin.test.ts.

Proving commands: `npm test -- tests/revisions tests/compat/admin.test.ts`.

### CV-25: Add legacy inventory and resumable backend migration

Add backup checks, per-workspace inventory, dry-run, drain, checkpoint/resume, verification, and reverse migration. Preserve ambiguous workspaces without choosing a head. Include actual non-bare repositories and JSON-only records. Do not enable remote pushes or discard uncommitted data. Inventory every retained revision against manifest rules and configured limits. Preserve incompatible contents and stop affected cutovers without normalization or truncation.

Allowed paths: `src/application/migrations/**`, `scripts/migrate-workspaces.ts`, `scripts/migrate-storage.ts`, `tests/migrations/**`.

Proof: Dry-run detects conflicting authority, dirty data, and incompatible retained history. Verified transfers preserve IDs, revisions, aliases, and ownership before one atomic binding switch.

Tests to add: tests/migrations/inventory.test.ts; authority-cutover.test.ts; git-s3-roundtrip.test.ts; interrupted-transfer.test.ts; tests/migrations/incompatible-history.test.ts.

Proving commands: `npm run test:migration`.

### CV-26: Document the API, installed clients, compatibility, and operations

Update architecture, API, Postman, package examples, CLI/MCP setup, host guides, limits, least privilege, recovery, backup, and migration runbooks. Preserve minimum runtime claims only when tested. Include downstream migration recipes without modifying consumer repositories.

Allowed paths: `README.md`, `docs/ARCHITECTURE.md`, `docs/STORAGE_LAYER.md`, `docs/SECURITY_MODEL.md`, `docs/REST_API.md`, `docs/SDK_PLAN.md`, `docs/DEVELOPMENT.md`, `docs/api/**`, `docs/quickstart/**`, `docs/examples/**`, `docs/ContextVault-API.postman_collection.json`.

Proof: Documentation and examples match installed clients and the implemented API. Operators can distinguish adapter switching, migration, cleanup, uncertainty, and unsupported legacy host assumptions.

Tests to add: Documentation link checks; executable quickstart and Postman checks provided by the CV-10 documentation harness.

Proving commands: `npm run test:docs`.

### CV-27: Prove backend parity, host access, packaging, and failure recovery

Implement the release matrix and hard gates. Include process kills around acceptance, revoked actors, stale workers, upload/seal races, tenant webhooks, GC races, and migration interruption. Use network requests against the selected LocalStack S3 service and real host boundaries. Keep fixtures inside an explicit test prefix.

Allowed paths: `tests/acceptance/**`, `tests/faults/**`, `tests/hosts/**`, `tests/sdk/**`, `scripts/verify-workspace-release.mjs`, `.github/workflows/workspace-contract.yml`, `docs/verification/**`, `package.json`, `package-lock.json`.

Proof: Required Git, LocalStack S3, host, SDK-package, MCP, compatibility, migration, and fault checks pass. Missing target services or host capacity prevent closure.

Tests to add: tests/acceptance/lifecycle.test.ts; tests/faults/*.test.ts; host/SDK/MCP matrix; migration round-trip.

Proving commands: `npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks`.

### CV-28: Independently review and close the workspace milestone

Audit the integrated diff, public contracts, security boundaries, and exact evidence. Run release checks independently. Classify skipped or unavailable checks as incomplete. Closure never follows from plan validation, compilation, or mocked consumer tests alone.

Allowed paths: `docs/verification/workspace-release.md`.

Proof: A fresh reviewer finds no unresolved contract defects. An independent checker reproduces every required outcome and records exclusions before the lead closes implementation items.

Tests to add: Independent reproduction of release matrix and documentation examples.

Proving commands: `npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks`.


### CV-29: Repair affected runtime dependency advisories

The clean baseline audit found relevant production security advisories.
Use narrow patched dependency updates, preserve API behavior, and prove the affected boundaries before release.
CV-14 follows this item to keep package and lockfile writes sequential.

Allowed paths: `package.json`, `package-lock.json`, `tests/security/runtime-dependencies.test.ts`, the five root source files importing simple-git, and the two existing root integration tests importing simple-git.

Proof: production dependency audit has no relevant Critical or High findings, and baseline, contract, build, and regression checks pass.

Proving commands: `npm audit --omit=dev --audit-level=high`; `npm test`; `npm run test:contracts`; `npm run build`.

Use at most three concurrent writing workers, with separate clean worktrees and a recorded integration base.
Read-only reviewers may inspect explicit checkouts without a separate worktree.
Only the lead changes work-item states and protected records.
Require a fresh analyst review before accepting a builder's changes.
Run each proving check independently before closing its item.

Shared paths have ordered owners.
CV-10 owns initial domain contracts, scripts, and the app-factory extraction.
CV-14 owns subsequent server dependency changes.
CV-17 exports maintenance hooks; CV-16 owns startup/shutdown composition after CV-17 closes.
CV-23 owns legacy bridge files before CV-24 revises administration.
CV-10 owns the executable documentation harness before CV-26 consumes it.
CV-27 owns final release wiring after client, host, migration, and documentation tasks finish.
No parallel worker changes a provider's closed contract without lead review and downstream revalidation.

## 10. Verification commands and evidence

### Existing commands

Run these from the repository root during implementation preflight:

```sh
npm test
npm run build
npm --prefix sdk/typescript run build
npm --prefix mcp run build
```

These commands were inspected, rather than executed for this planning task.
Existing failures need baseline evidence and scoped repair ownership.
Do not report the MCP configuration as passing before running its build.
Root `npm test` does not execute the current `.mjs` HTTP suites.

### Commands implementation must add

CV-10 adds documented scripts, argument parsing, and the executable documentation-check runner with self-test fixtures.
CV-26 uses the closed documentation harness; CV-27 aggregates release evidence after CV-26 closes.
Intermediate tasks may leave acceptance red until their required behavior exists.

```sh
npm run test:contracts
npm run test:adapters -- --backend git
npm run test:adapters -- --backend s3 --s3-provider localstack
npm run test:acceptance -- --backend git
npm run test:acceptance -- --backend s3 --s3-provider localstack
npm run test:hosts -- --backend git
npm run test:hosts -- --backend s3 --s3-provider localstack
npm run test:sdk -- --language typescript
npm run test:sdk -- --language python
npm run test:sdk -- --language php
npm run test:mcp
npm run test:legacy
npm run test:recovery
npm run test:migration
npm run test:docs
npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks
```

Use package tarball installation, isolated Python wheel installation, and Composer installation for SDK proof.
Do not import source directories as a substitute for packaging acceptance.
Use isolated temporary directories and explicit test credentials, rather than current localhost development defaults.

Real S3 verification requires `CV_TEST_S3_BUCKET`, `CV_TEST_S3_REGION`, and a unique nonproduction `CV_TEST_S3_PREFIX`.
Credentials use the standard AWS chain; never put secrets in fixtures or logs.
The runner refuses empty, bucket-root, or unapproved test prefixes.
It removes only objects and multipart uploads that it created inside its recorded prefix.
Missing LocalStack S3 access fails this milestone verification. A separate --require-real-s3 gate requires AWS and rejects emulator targets.

### Host and package matrix

| Environment | Git | Real S3 | Required observation |
|---|---|---|---|
| Application worker | Required | Required | Installed SDK exposes a local directory; ordinary agent code reads and writes it |
| Container | Required | Required | Writable volume; no server-volume or canonical-storage credentials |
| Local CLI | Required | Required | Installed executable, JSON output, interruption, reconciliation, cleanup |
| Separate machine boundary | Required | Required | HTTP-only transfer; no shared filesystem; disconnect and reopen |

Run the lifecycle against all three installed SDKs on both backends.
The host harness selects each supported SDK worker so language-specific local-file behavior is exercised.
CLI cells use the packaged TypeScript client.
MCP development and packaged production must pass the same tool and lifecycle assertions on both backends.

CI reports runtime and operating-system versions explicitly.
Do not infer Windows/macOS support from Linux results or minimum-version support from the newest runtime alone.
Unsupported or unavailable matrix cells remain visible and prevent their corresponding support claim.

### Required fault points

Inject crashes before candidate creation, during file transfer, after candidate durability, immediately before acceptance, and immediately after acceptance.
Also inject lost responses, repeated keys, changed-key payloads, revoked keys, suspended workspaces, expired leases, and stale finalizers.
Test late upload/seal races, outbox retry, tenant recipient filtering, cleanup failure, GC races, and interrupted migration.
Verify deletion, binary integrity, no-change finalization, reserved paths, symlinks, collisions, and exact restore behavior.

Store evidence under `docs/verification/` with command, commit, environment, backend, test prefix, result, and skipped checks.
Never include credentials or customer contents.
Plan validation and compilation do not certify runtime closure.

## 11. Requirements coverage and remaining operational inputs

| User requirement | Coverage | Plan location and items |
|---|---|---|
| Ports and adapters | Covered | Sections 3 and 6; CV-10 through CV-16 |
| Git and S3 swap | Covered | Sections 6 and 8; CV-13, CV-14, CV-25 |
| Existing agents keep executing | Covered | Sections 4 and 7; CV-18 through CV-22 |
| Temporary workspaces beside agents | Covered | Sections 2 and 7; CV-18 through CV-21 |
| Application workers | Covered | Host matrix; CV-18 through CV-21, CV-27 |
| Containers | Covered | Host matrix; CV-21, CV-27 |
| Local CLIs | Covered | Section 7; CV-21 |
| Separate machines | Covered | Sections 2 and 7; CV-16, CV-18 through CV-21, CV-27 |
| Finalize and abort remain in ContextVault | Covered | Sections 3 through 5; CV-11, CV-15, CV-16 |
| Access control remains in ContextVault | Covered | Sections 3 through 5; CV-11, CV-16, CV-17, CV-23, CV-24 |
| Existing consumers remain reviewable | Covered | Section 7; CV-18 through CV-24, CV-26 |
| Recovery, migration, and acceptance | Covered | Sections 5, 8, and 10; CV-17, CV-25, CV-27, CV-28 |

Operational inputs remain required before deployment, rather than before writing or implementing this plan.
They include a nonproduction S3 bucket/prefix, credential permissions, host test capacity, backup locations, and production topology.
Ambiguous legacy workspace authority requires an operator decision when inventory encounters it.
Current direct Git users and deployed webhook receivers need inventory before disabling or versioning their compatibility paths.
Accepted-history purge remains outside initial orphan GC until a retention policy exists.

No product code, customer data, Git branch, commit, remote publication, or deployment is changed by this planning deliverable.

## Selected S3 verification target, 2026-11-04

The user selected LocalStack in response to the S3 verification target question.
This instruction replaces the earlier real-AWS requirement for this milestone.
Git checks use real Git; S3 checks send network requests through the AWS SDK to LocalStack.
Reports record the provider, image version, endpoint, and test prefix.
LocalStack evidence establishes the selected emulator behavior; AWS service parity remains unverified.
The optional --require-real-s3 gate remains strict and cannot accept a LocalStack target.
All application-worker, container, local-CLI, separate-machine, SDK, and recovery gates remain required.
CV-14 owns the launcher and Vitest selection changes needed for explicit provider profiles.

CV-14 consumes the closed catalog, shared file helpers, and backend-neutral Git contract fixtures.
CV-17 owns the additional catalog/submission cleanup seams required by actual byte collection.
CV-16 synchronizes configured administrator authority before automatic recovery starts.

### CV-31: Isolate tenant secret dictionary keys

The HTTP composition probe confirmed that special tenant names could mutate object prototypes and expose another tenant's synthetic key.
This narrowly scoped security prerequisite uses the existing provider API and preserves valid JSON records.
Scope: src/services/secrets.service.ts and tests/security/tenant-secrets-isolation.test.ts.
CV-31 consumes the closed contracts; CV-16 waits for independently verified provider isolation before closure.
No customer data, key rotation, persistence redesign, deployment, or global configuration change is authorized by this repair.
