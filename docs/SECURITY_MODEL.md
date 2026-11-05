# Security model

ContextVault enforces authority at the service boundary and catalog publication transaction.
The agent host supplies process and filesystem isolation.
Downloaded bytes remain under the receiving host's control.

## Identity and customer scope

Protected API routes authenticate `X-API-Key` credentials.
Git HTTP compatibility also accepts its supported Basic authentication form.
The service resolves actor, credential version, current grants, and permission epoch through catalog authority.

Customer credentials bind one customer.
A request cannot select another customer through a body or header.
Administrator workspace requests must select `X-ContextVault-Customer-Id` explicitly.
The configured administrator key comes from `CONTEXTVAULT_API_KEY`.
There is no built-in production master-key value.

Credential creation, listing, and revocation remain available through `/api-keys` under current credential-management authority.
Plain credentials belong in an existing credential provider.
Agents should receive only their scoped API credential.

Current authority gates reads, uploads, sealing, publication, administration, and reconciliation.
The acceptance transaction rechecks authority alongside version and fence preconditions.
Revoked or stale authority cannot publish through an earlier successful upload.

See [authentication code](../src/middleware/auth.ts) and [catalog access policy](../src/adapters/access/catalog-access-policy.ts).

## Authority boundaries

| Resource | Required boundary |
|---|---|
| SQLite catalog and private journals | Service or client owner; private filesystem permissions |
| Canonical Git/S3 contents | ContextVault storage adapters; service-only credentials |
| Client workspace | Agent host and installed client |
| API request | Explicit identity, customer, resource, action, and current grant |
| Accepted revision | Current catalog selection and verified immutable content |
| Cleanup target | Exact ownership, current eligibility, fence, and stopped-writer proof |

Service directories use private ownership and permissions.
Client workspace and private-state directories use mode `0700`; state files use mode `0600`.
Runtime safety checks reject unsafe filesystem ancestry and changed identities.
These checks provide cooperative ownership, rather than containment against hostile code with the same user identity.

Native workers retain their host user's filesystem permissions.
Containers and separate-machine deployments should provide private volumes, network controls, and process isolation.
The client protocol requires no server filesystem mount, catalog access, or canonical-storage credential.

## Publication and revocation

A run binds its base revision, storage generation, actor, credential context, and reason.
A sealed submission selects immutable upload receipts.
Prepared candidate bytes remain unpublished until the catalog accepts them.
Stale revisions, versions, credentials, or fences prevent competing publication.

Deleting or suspending a workspace denies normal content actions.
Authorized run and operation metadata can remain readable for durable outcome inspection.
Inactive workspaces do not acquire general finalize, abort, or cleanup permissions through that metadata access.
MCP file tools recheck current workspace content authority before accessing retained local files.

Revocation controls future service access.
It does not erase copies that an agent already downloaded or independently retained.
Operators must avoid granting direct canonical bucket or catalog access to agents.

## Client recovery and writer coordination

Clients persist the original request, idempotency key, capture identity, and known operation ID before or during dispatch.
Private state excludes API credentials and submitted content excludes private control state.
A resumed client supplies current credentials again.

`writersStopped` confirms an application-owned precondition.
CLI and MCP controller recovery also require explicit stopped-controller assertions.
The service cannot infer that every agent process has stopped from a run's terminal state.
A PID, lease expiry, or elapsed time does not authorize a client controller takeover.

An uncertain command blocks automatic abort and local deletion.
An authorization denial during reconciliation does not prove the original request failed.
Retained immutable captures prevent changed local files from altering an uncertain retry.
Known terminal publication and independent cleanup failures remain separate outcomes.

## Input and file validation

The shared manifest validates exact fields, lengths, lowercase SHA-256, paths, directory entries, and configured quotas.
The service verifies upload and download bytes independently.
Clients validate filesystem identity during hydration, capture, and cleanup.

Portable paths reject traversal, invalid Unicode, reserved names, and case/compatibility collisions.
Materializers reject symlinks, hardlinks, and special files.
File streams use bounded chunks and concurrency.
The API's ordinary JSON body limit is 16 MiB; binary file streams use their dedicated validation path.

File contents remain untrusted input for an agent.
Storage authorization does not make document instructions safe to execute.
The agent host owns tool permissions and treatment of retrieved instructions.

## Credentials, signing, and encryption

The current legacy secrets provider is local.
`CONTEXTVAULT_SECRETS_BACKEND` accepts `local`; other values fail configuration.
`CONTEXTVAULT_SECRETS_PATH` selects its private JSON file or containing directory.
The service protects that file with mode `0600`.

S3 revision and submission objects use configured `AES256` or `aws:kms` encryption.
The current catalog uses ordinary SQLite.
Operators supply local disk and backup encryption.
Tenant secret material is not a promise of SQLCipher catalog encryption.

Bundle signing requires all three signing settings:

| Variable | Format |
|---|---|
| `CONTEXTVAULT_SIGNING_PRIVATE_KEY` | Base64 DER Ed25519 PKCS#8 private key |
| `CONTEXTVAULT_SIGNING_PUBLIC_KEY` | Base64 DER Ed25519 SPKI public key |
| `CONTEXTVAULT_SIGNING_KEY_ID` | Matching bundle key identifier |

Bundle import validates signatures, complete manifests, exact lengths, hashes, and configured limits.
Hash verification cannot be disabled through `skipHashVerification:true`.
Export and import scan known secret patterns and current tenant secret material.
That scanner is a bounded policy check, not a guarantee that every sensitive value was detected.

Backups contain private catalog, credential, and secret material.
They require operator-controlled access and encryption, even when the selected workspace uses S3.

## Webhooks

Outbox delivery selects customer-scoped recipients and stable delivery identities.
Receivers must tolerate duplicate delivery after interruption or a lost acknowledgement.
The adapter rejects redirects and destinations containing embedded credentials.
Operators control allowed webhook destinations and server egress.

Signed delivery uses `X-ContextVault-Signature` over the exact JSON body bytes.
The current legacy registration stores `SHA-256(secret)` as a hexadecimal string.
The delivery adapter uses that stored string as the HMAC-SHA256 key.
Receivers integrating that compatibility route must use the same derivation.
Unsigned registrations do not provide signature authentication.

See [webhook delivery](../src/adapters/delivery/webhook.ts) and [legacy signing-key resolution](../src/services/webhook.service.ts).

## Deployment and evidence limits

Production hosts need TLS termination, private service storage, scoped credentials, controlled egress, backups, and restoration checks.
Public `/health`, `/docs`, and browser shell routes do not grant authenticated workspace access.
Configure network exposure around the intended deployment.

The selected S3 verification target is LocalStack.
Its successful object operations do not verify AWS IAM, KMS policies, production network topology, or physical disaster recovery.
Docker boundary tests do not establish Windows or physical remote-machine support.
A complete release also requires the strict release and independent review gates described in [development](DEVELOPMENT.md#verification).
