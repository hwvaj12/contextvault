# Workspace contracts v1

These files freeze the approved target contract.
They do not prove that HTTP routes, storage adapters, clients, or release outcomes exist.

`manifest.v1.schema.json` defines structural JSON validation.
`src/domain/manifest.ts` adds portable paths, collisions, canonical serialization, limits, and byte verification.
The independent `tests/fixtures/workspaces/canonical.v1.json` fixture records exact UTF-8 bytes, binary payloads, and SHA-256 values.
Only regular files and explicit directories belong in complete snapshots.
An omitted path means deletion.

`http.v1.json` lists routes, statuses, required idempotency keys, polling, headers, and version semantics.
`http.v1.schema.json` defines language-neutral request and response shapes.
`src/domain/http.ts` mirrors those wire shapes for server composition.
`X-Content-SHA256` contains exactly 64 lowercase hexadecimal characters.
The server independently checks uploaded bytes before it registers an immutable receipt.

Run versions change only with lifecycle transitions.
Uploads and sealing change submission versions; heartbeat changes the lease version.
Processing claims use independent versions and monotonically increasing fences.
The run version returned at open remains valid through uploads, sealing, and heartbeat.

`lifecycle.v1.json` and `errors.v1.json` define states, transitions, and machine error codes.
Cleanup has its own state machine and cannot overwrite a terminal run outcome.
A read-only run finalizes without a submission.
A changed workspace head or content version cannot conflict read-only completion; current authorization, status, binding, and processing checks still apply.
A stale read-write run conflicts even when its complete submission has unchanged contents.
Unknown publication outcomes require reconciliation before cleanup, retry with a new key, or abort.

Canonical request digests hash UTF-8 JSON without whitespace or a trailing newline.
Object keys sort by unsigned UTF-8 bytes; array order and string values remain exact.
Numbers use ECMAScript JSON serialization; unsupported values and invalid Unicode fail validation.
Scope, authenticated actor, credential ID, command kind, resource IDs, and payload participate in the digest.
The idempotency key remains separately stored and scoped; it does not participate in its request digest.

`src/ports/index.ts` exports all five ports without framework or storage-backend types.
Revision preparation returns durable candidate identity, digest, and a private locator.
Only catalog acceptance changes accepted state; revision preparation cannot publish a workspace.
`claimWorkspaceCreation` persists the original request, draft metadata, empty manifest, and candidate identity before storage I/O.
`acceptWorkspaceCreation` accepts the workspace and initial revision atomically with its result, audit, and outbox.
Unaccepted drafts remain invisible to workspace reads.
Normal creation returns `201`; an in-progress retry returns `202` with the original operation.
Acceptance rechecks catalog-backed authorization, ownership, versions, binding generation, and finalizer fence in one transaction.
Receipt registration and sealing share catalog CAS boundaries, so late uploads cannot replace selected bytes.
Collection permits fence only eligible orphan candidates; accepted history has no general deletion method.
Workspace listing, status CAS, immutable revision aliases, and resumable binding migration also pass through `ControlStore`.
Binding cutover requires drained mutable runs, verified copies of every retained revision, matching catalog versions, and a current migration fence.
Cutover preserves workspace IDs, revision IDs, history, and aliases in one transaction.

`compatibility.v1.json` records representative consumer recipes and minimum client runtimes.
These fixtures do not establish cross-repository runtime compatibility.
Node 18, Python 3.8, and PHP 8.0 remain minimum SDK targets until package tests establish support.
Existing agents continue running independently and receive client-local directories.

`recovery.v1.schema.json` defines server operation intents and separate private client state.
A finalization claim persists its original request and selected sealed submission ID, version, and manifest digest before preparation.
Recovery uses that persisted source and candidate identity, including after a crash before storage preparation.
Creation recovery likewise uses its persisted request and original candidate identity.
These schemas and fixtures establish the contract; later catalog and client tests must prove runtime durability.

Client session IDs exist before server workspace, run, or operation IDs become known.
Pending commands retain their kind, original idempotency key, exact request, selected submission, and any known operation ID.
The materializer durably saves pending commands before HTTP dispatch, outside submitted contents and without API credentials.
After restart or a lost response, clients reuse the persisted command and key.
Materializer creation uses public run identity from `RunView`; clients receive no catalog binding IDs or generations.

Internal expiry scans select only active runs whose client lease has expired.
Expiry atomically compares lifecycle and lease versions, checks the stored expiry time, and records audit, outbox, and cleanup state.
A heartbeat or finalization claim that wins the race prevents expiry.
Processing finalizations remain recovery work and never become active-run expiry candidates.

Tenant-scoped run and operation resolvers accept IDs without requiring a workspace ID.
Verified customer and service principals resolve only their own tenant.
Verified administrators must select one tenant using `X-ContextVault-Customer-Id` and obtain a current scoped lookup permit.
Resolvers check catalog-backed credential and grant policy; handlers need no raw database query or workspace scan.
