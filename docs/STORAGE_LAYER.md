# Storage and adapter configuration

ContextVault separates authoritative workspace state from immutable content storage.
The catalog selects accepted revisions and storage bindings.
Git and S3 adapters prepare and read the selected bytes.

## Storage contracts

`RevisionStore.prepare` receives a candidate identity already persisted by the catalog.
A retry must preserve that identity and exact contents.
`inspectCandidate` supports recovery; it does not establish publication.
`deleteCollectible` requires a current fenced collection permit.

`SubmissionStore` stores immutable upload attempts and coordinates their catalog receipts.
Sealing chooses exact receipts in one transaction.
Unregistered or late bytes remain unpublished cleanup candidates.

The Git profile pairs Git revision storage with local submission storage.
The S3 profile pairs S3 revision storage with S3 submission storage.
Both profiles use the same domain manifest and application publication rules.

See the [port definitions](../src/ports/index.ts) and [runtime composition](../src/config/runtime.ts).

## Core configuration

Configuration is read from environment variables by [loadConfiguration](../src/config/index.ts).
Explicit private filesystem paths must be absolute.
The default data directory resolves `data` under the service's working directory.
Operators should set an explicit path.

| Variable | Default | Purpose |
|---|---|---|
| `CV_DATA_DIR` | Resolved `./data` | Private service data root |
| `CV_DATABASE_PATH` | `$CV_DATA_DIR/contextvault.db` | Authoritative SQLite catalog |
| `CV_STORAGE_BACKEND` | `git` | Default backend for new workspace bindings |
| `CV_GIT_ROOT` | `$CV_DATA_DIR/revisions/git` | Git revision storage |
| `CV_SUBMISSION_ROOT` | `$CV_DATA_DIR/submissions/git` | Local upload-attempt storage |
| `CV_STORAGE_PROFILES` | None | JSON array of retained Git or S3 profiles; at most 32 extras |
| `CV_WORKSPACE_LIMITS` | Shared v1 limits | JSON object lowering supported ceilings |
| `CV_LEASE_TTL_MS` | `300000` | Active run lease duration |
| `CV_PROCESSING_TTL_MS` | `300000` | Processing claim duration |
| `CV_MAINTENANCE_INTERVAL_MS` | `1000` | Maintenance scheduling interval |
| `CV_REQUEST_TIMEOUT_MS` | `120000` | Service request timeout |

`CONTEXTVAULT_DATA_DIR` is an older name outside this configuration contract.
Use `CV_DATA_DIR` in new deployments and migration commands.
The Git revision root and local submission root must differ.

## S3 configuration

| Variable | Meaning |
|---|---|
| `CV_S3_PROVIDER` | `aws` or `localstack`; defaults to `aws` when configuring S3 |
| `CV_S3_BUCKET` | Explicit bucket |
| `CV_S3_REGION` | Explicit region |
| `CV_S3_PREFIX` | Explicit private prefix ending with `/` |
| `CV_S3_ENDPOINT` | Optional AWS service endpoint; required for LocalStack |
| `CV_S3_KMS_KEY_ID` | Selects `aws:kms`; absence selects `AES256` |

Setting `CV_S3_BUCKET` adds an S3 profile even when Git remains the default backend.
That profile still requires complete valid S3 configuration.

AWS uses the standard server-side AWS credential chain.
LocalStack uses explicit dummy credentials in runtime composition.
Provider validation rejects an AWS hostname selected as LocalStack.
Explicit AWS endpoints require HTTPS and an AWS service hostname.
The runtime ignores ambient configured endpoint overrides.

An S3 prefix must contain nonempty safe components and end with `/`.
A bucket-root prefix is not an acceptable configuration.
Credentials and locations remain private to service configuration.
Agents receive authenticated HTTP access instead.

S3 objects carry configured server-side encryption.
Immutable creation and receipt checks preserve exact candidate contents across retries.
The catalog still decides acceptance.
S3 listings and object presence do not identify the workspace head.

Operators must scope bucket, prefix, listing, cleanup, and KMS permissions to required service operations.
LocalStack evidence does not prove AWS IAM or KMS behavior.

## Retained profiles

A profile's validated physical configuration determines its `configurationRef` and `storeId`.
Changing paths, bucket, prefix, endpoint, provider, or encryption can produce a new identity.
Accepted revisions retain their original binding and profile reference.
Keep those profiles available while retained history needs them.

A retained Git profile has this shape:

```json
{
  "backend": "git",
  "rootDirectory": "/srv/contextvault/revisions/git",
  "submissionRoot": "/srv/contextvault/submissions/git"
}
```

A retained S3 profile has this shape:

```json
{
  "backend": "s3",
  "provider": "aws",
  "bucket": "your-private-bucket",
  "region": "us-east-1",
  "prefix": "contextvault/revisions/",
  "encryption": { "algorithm": "AES256" }
}
```

`CV_STORAGE_PROFILES` contains an array of these objects.
Profiles contain configuration, not embedded access keys.

## Switching versus migration

Changing the default backend affects new workspace bindings.
It does not copy existing revision content or move an accepted workspace head.
The explicit migration command verifies every retained revision before one catalog cutover.
Revision IDs, accepted history, ownership, and aliases remain stable during adapter transfer.

Legacy adoption is a separate operation.
It inventories older Git repositories and metadata before creating catalog authority.
Legacy Git hashes become workspace-scoped aliases of opaque canonical revision IDs.
Ambiguous, dirty, filtered, or incompatible source data stops adoption.

See [migration and recovery](quickstart/operations.md).

## Filesystem and manifest limits

| Limit | Shared v1 ceiling |
|---|---|
| Entries | 10,000 |
| Path bytes | 1,024 UTF-8 bytes |
| Component bytes | 255 UTF-8 bytes |
| File bytes | 64 MiB |
| Total file bytes | 512 MiB |
| Concurrent streams | 4 |
| Chunk bytes | 64 KiB |

The server can lower these ceilings through `CV_WORKSPACE_LIMITS`.
Client limits can be stricter; the server remains authoritative.
Paths require valid Unicode NFC and portable relative names.
Validation rejects traversal, reserved Windows names, case/compatibility collisions, and unsupported characters.
Regular files and directories are supported.
Symlinks, hardlinks, and special files are rejected by materialization and capture checks.

Capture excludes `.git` and `.contextvault` components using canonical name matching.
`.gitignore` is ordinary submitted content and does not control capture selection.
Cleanup validates excluded metadata before removing owned files.

## Retention and backup

Current orphan collection protects accepted history and recoverable operations.
A tombstone denies normal workspace content access while retaining history.
Accepted-history purge requires a separate retention policy.

A useful recovery set includes the catalog, selected immutable content, retained profiles, credentials, signing keys, and legacy secret material.
S3 content alone cannot reconstruct catalog authority or durable operation outcomes.
Operators supply disk encryption, backup encryption, access control, and restoration procedures.
