# @contextvault/sdk

Official TypeScript SDK for ContextVault.

## Installation

```bash
npm install --ignore-scripts /absolute/path/contextvault-sdk-0.1.0.tgz
```

Use the reviewed local package archive from the matching ContextVault checkout.
Registry publication is outside this implementation milestone.
The [client quickstart](../../docs/quickstart/clients.md) describes the local build and installation procedure.

Requires Node.js 18+ (uses native `fetch`). The package includes compiled CommonJS files and TypeScript declarations.
No server source, storage SDK, storage credentials, or server filesystem access is required.

## Quickstart

```typescript
import { ContextVaultClient } from "@contextvault/sdk";

const cv = new ContextVaultClient({
  apiKey: "cv-my-api-key",
  baseUrl: "http://localhost:3000", // optional, this is the default
});
```

## Usage

### Create a workspace

```typescript
const workspace = await cv.workspaces.create({
  customerId: "cust_123",
  name: "my-project",
});
console.log(workspace.id); // "ws_01HXY..."
```

### List workspaces

```typescript
// List all workspaces
const all = await cv.workspaces.list();

// Filter by customer
const mine = await cv.workspaces.list({ customerId: "cust_123" });
```

### Get a workspace

```typescript
const workspace = await cv.workspaces.get("ws_01HXY...");
```

### Delete a workspace

```typescript
await cv.workspaces.delete("ws_01HXY...");
```

### Open a durable local workspace

```typescript
const session = await cv.openWorkspace({
  create: { customerId: "cust_123", name: "agent-project" },
  // Alternatively: workspaceId: "ws_..."
  mode: "read-write",
  agentLabel: "my-existing-agent",
  task: "Update the project",
  reason: "Requested change",
});
// Run your existing agent independently against session.path.
// Stop all agent writers before capturing, submitting, checkpointing or cleanup.
const operation = await session.finalize({ writersStopped: true });
console.log(operation.result, session.outcome);
await session.cleanup({ writersStopped: true });
```

`path` and `sandboxPath` name the same new directory on the client's host.
`baseCommit` aliases the run's pinned `baseRevisionId`.
The SDK does not run, isolate or stop an agent.
The host must supply hostile-code isolation.
Filesystem checks do not provide containment against hostile concurrent code with the same user identity.

Private session files and immutable captures live outside submitted contents.
The SDK uses owned directories with mode `0700` and state files with mode `0600`.
State includes the server origin, session identity, run identity, exact commands, keys, operation IDs and capture references.
State never includes API credentials.
Keep private state and captures on persistent local storage when recovery must survive container or machine loss.
The default temporary directory only supports recovery while that filesystem survives.
`stateDirectory` selects a new private session directory; its parent must already exist without symlink ancestry.

Snapshots include regular files and explicit directories.
Omitted paths mean deletion, including an empty snapshot.
The SDK verifies byte lengths and lowercase SHA-256 independently during capture, upload and download.
Streams use bounded chunks, with sequential file transfers and configurable quotas through `limits`.
Portable path validation rejects traversal, case collisions, invalid Unicode, reserved names, links, hardlinks and special files.
Capture excludes `.git` and `.contextvault` names using canonical name matching at every depth.
`.gitignore` remains ordinary submitted content.
Cleanup validates all local entries, including excluded control metadata.

### Resume after a lost response

```typescript
import { OutcomeUnknownError } from "@contextvault/sdk";
try {
  await session.finalize({ writersStopped: true });
} catch (error) {
  if (error instanceof OutcomeUnknownError) {
    // Persist this path in your agent's external job record.
    console.log(error.privateStatePath, error.operationId);
  }
  throw error;
}
// A fresh process supplies current scoped credentials and the same origin.
const recovered = await cv.resumeWorkspace(savedPrivateStatePath);
await recovered.reconcile({ writersStopped: true });
```

Session identity exists before remote workspace, run or operation IDs become known.
Each pending command reaches durable storage before HTTP dispatch.
Reconciliation reuses the original key, request and captured bytes.
Starting a different workflow rejects before changing durable state or sending HTTP requests.
Reconcile the saved workflow before calling submit, finalize or checkpoint for another purpose.
Changing local files after capture cannot change a retried publication.
An unknown outcome retains state, captures and local files.
A retry authorization failure also retains them because it cannot disprove earlier publication.
An actual HTTP 4xx on a command's first attempt settles that rejected command while retaining local files and its capture.
The caller can then explicitly abort the still-active run.
Earlier dispatched attempts, uncertain responses and known operation IDs keep the original command guarded, even when a retry returns 4xx.
Local receipt validation after HTTP success also keeps the command guarded.
The SDK never automatically aborts or deletes after an exception.
`resumeWorkspace` only loads state; `reconcile` performs the saved workflow.
Use one controller per private state file and stop agent writers during reconciliation.
Do not edit private state manually.

`cv.createWorkspace({ customerId, name, stateDirectory? })` creates a workspace without opening a run.
It returns the canonical workspace and `privateStatePath` for creation recovery.
`cv.workspaces.create` wraps the same durable creation and retains the legacy `latestCommitId` alias.
The legacy `/workspaces` listing remains a server compatibility endpoint and does not enumerate canonical v1 workspaces yet.

### Checkpoint an existing agent

```typescript
await session.checkpoint({ writersStopped: true });
// The same path now contains the exact next run's pinned base.
// Resume writers only after checkpoint or reconcile succeeds.
await session.abort({ writersStopped: true, reason: "Task finished" });
await session.cleanup({ writersStopped: true });
```

Checkpoint publishes one run and opens the next run while preserving the local path.
If reopening fails after publication, `sessionStatus` remains `published-needs-reopen`.
Reconciliation retries the saved reopen command and key without publishing the previous checkpoint again.
Hydration refreshes the next pinned base before writers resume, including changes another writer accepted between runs.
An incomplete refresh exposes `materializationState: "failed"` and preserves recovery state.
Initialization errors also expose `privateStatePath` after session state exists, including incomplete or corrupt downloads.
Resume that state and reconcile to hydrate the same pinned run again.
If reopening succeeded but refresh failed, explicit abort can stop that known active run without repeating publication.
An unknown publication or reopen still requires reconciliation before abort.
After a definite first reopen rejection, stopped-writer cleanup can abandon the local session while preserving the accepted checkpoint and receipt.
Cleanup never aborts or undoes that publication.
An uncertain reopen must reconcile first; a known active next run must reach a terminal outcome before cleanup.
`checkpointReceipt` retains the accepted operation, published run ID and parent revision independently of the next run's base.
Another writer can advance that next base without changing the checkpoint's publication receipt.

`capture({ writersStopped: true })` saves immutable bytes without uploading.
`submit({ writersStopped: true })` uploads and seals a complete snapshot without publishing.
`finalize({ writersStopped: true })` publishes and polls the durable operation.
A captured snapshot remains selected for that run; the SDK never silently recaptures newer files during retry.
`heartbeat()` renews the lease using `leaseVersion`; it does not change the run version.
`status()` refreshes the run view without discarding a pending command.
`abort({ reason, writersStopped: true })` requires no uncertain publication.
`cleanup({ writersStopped: true })` requires a known terminal outcome and remains independent of publication.
Cleanup failures expose `cleanupState: "failed"` and preserve the terminal run outcome for retry.
Successful cleanup retains the small private recovery record and removes submitted files and selected captures.
Checkpoint captures remain privately recorded until explicit cleanup removes all captures retained by that session.
Capture ownership reaches a private registry before the SDK copies content.
Terminal cleanup also removes owned captures left by a crash before the session reference was saved.
Ownership records remain outside capture directories until deletion completes.
Cleanup rejects different owners and leaves their files intact.
Completed cleanup closes the session to new workflows and commands before HTTP dispatch.
Open a new session to continue work; status reads and repeated cleanup remain safe.

The private journal stores a length-checked and SHA-256-checked reference to the current immutable capture manifest.
Historical capture ownership remains in the separate registry; the journal does not duplicate past manifests.
Receipt selections use canonical manifest indexes while retaining their original receipt IDs and completion times.
Resume reconstructs receipt paths and byte declarations from the verified manifest, without reading mutable agent files.
Pending commands retain their exact request bodies and original keys.
Private JSON records share a 32 MiB write and read budget, measured in UTF-8 bytes.
The writer rejects overflow before atomic replacement and preserves the previous readable journal.
This control budget does not reduce canonical workspace content limits.
Before cleanup deletes manifest metadata, it durably clears journal references so interrupted cleanup can resume through ownership records.

### Caller-managed run resources

```typescript
// Persist each key and its exact request before sending it.
const run = await cv.runs.open(workspaceId, {
  mode: "read-write", agentLabel: "agent", task: "task", reason: "request",
}, stableOpenKey);
const submission = await cv.submissions.create(run.id, {}, stableSubmissionKey);
const receipt = await cv.submissions.upload(run.id, submission.id,
  { path: "binary.bin", kind: "file", byteLength, sha256 }, byteStream, stableFileKey);
await cv.submissions.seal(run.id, submission.id, {
  manifest,
  receipts: [{ path: receipt.path, receiptId: receipt.id }],
}, stableSealKey);
const pending = await cv.runs.finalize(run.id, {
  expectedRunVersion: run.version, submissionId: submission.id,
}, stableFinalizeKey);
const complete = await cv.operations.wait(pending.id);
```

Low-level resources do not persist requests or select automatic mutation retries.
Callers own stable keys, immutable upload sources, restart recovery and same-key reconciliation.
Missing mutation keys fail before transport.
`operations.get(id)` reads a known operation; `operations.wait(id)` polls until terminal state or its deadline.
A polling deadline reports `OutcomeUnknownError`; the operation may still succeed.
`operationTimeoutMs` bounds the complete polling interval, including stalled HTTP headers and response bodies.
`requestTimeoutMs` separately bounds each v1 HTTP request and body, with a default of 30000 milliseconds.
Timeouts retain the known operation ID and pending session command for reconciliation.
A returned failed operation includes its stable error code.
High-level sessions map terminal failures to typed errors.
`ConflictError`, `RunExpiredError` and `OutcomeUnknownError` distinguish conflict, expiry and uncertainty.
`error.code` preserves stable server codes.
Uploads change submission versions, heartbeats change lease versions, and lifecycle transitions change run versions.
`runs.get`, `runs.manifest`, `runs.file`, `runs.abort`, `runs.heartbeat`, `revisions.list`, `revisions.manifest` and `revisions.restore` expose the remaining resources.

### Compatible checkout, commit and destroy

```typescript
const sandbox = await cv.workspaces.checkout(workspaceId);
// Run the agent against sandbox.sandboxPath, then stop its writers.
await cv.workspaces.commit(workspaceId); // Checkpoint; preserve the local path.
await cv.workspaces.destroy(workspaceId); // Abort the next run and clean local files.
```

These wrappers use client-local sessions and reject a competing checkout in the same client instance.
Calling `commit` or `destroy` asserts that the caller stopped local writers.
`commit` preserves sequential checkpoint behavior.
Its returned `commitId` identifies its accepted publication, even when another writer advances the reopened run's base.
Legacy metadata options cannot change the v1 run's immutable opening request.
Use explicit sessions for durable job integration and keep `privateStatePath` in the job record.
The `merged` alias means finalized; `cleaned_up` means local cleanup completed.
The separate v1 outcome preserves publication truth.
Existing text-only pull, history and workspace administration methods keep their server API behavior.
They do not provide binary workspace materialization or remote-local paths.

### Pull files

```typescript
// Pull all files from the latest commit
const result = await cv.workspaces.pull("ws_01HXY...");
for (const file of result.files) {
  console.log(file.path, file.content);
}

// Pull a specific version
const older = await cv.workspaces.pull("ws_01HXY...", "commit_abc");
```

### Get a single file

```typescript
const file = await cv.workspaces.getFile("ws_01HXY...", "profile/summary.md");
console.log(file.content);
```

### View commit history

```typescript
const history = await cv.workspaces.history("ws_01HXY...");
for (const entry of history.commits) {
  console.log(entry.commitId, entry.createdAt);
}

// Limit results
const recent = await cv.workspaces.history("ws_01HXY...", 5);
```

## Error handling

The SDK throws typed errors that you can catch and handle:

```typescript
import {
  NotFoundError,
  AuthError,
  ValidationError,
  NetworkError,
  ConflictError,
  ContextVaultError,
} from "@contextvault/sdk";

try {
  await cv.workspaces.get("ws_nonexistent");
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log("Workspace not found");
  } else if (err instanceof AuthError) {
    console.log("Invalid API key");
  } else if (err instanceof ValidationError) {
    console.log("Bad request:", err.message);
  } else if (err instanceof NetworkError) {
    console.log("Could not reach server:", err.message);
  } else if (err instanceof ConflictError) {
    console.log("Sandbox already exists");
  } else if (err instanceof ContextVaultError) {
    console.log("API error:", err.statusCode, err.message);
  }
}
```

## Auto-retry

Legacy JSON administration methods retain configurable retries. New v1 mutations never generate an automatic replacement command.
High-level sessions use durable reconciliation; caller-managed resources require explicit stable keys.
Configure retries for legacy administration methods with:

```typescript
const cv = new ContextVaultClient({
  apiKey: "cv-my-api-key",
  maxRetries: 5, // retry up to 5 times
});
```

Client errors (4xx) are never retried.

## API reference

### `ContextVaultClient`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | API key for authentication |
| `baseUrl` | `string` | `http://localhost:3000` | Server base URL |
| `maxRetries` | `number` | `3` | Max retries for network/server errors |

### `cv.workspaces`

| Method | Description |
|--------|-------------|
| `create({ customerId, name })` | Create a new workspace |
| `list({ customerId? })` | List workspaces |
| `get(workspaceId)` | Get a workspace by ID |
| `delete(workspaceId)` | Soft-delete a workspace |
| `checkout(workspaceId)` | Materialize a client-local compatibility session |
| `commit(workspaceId, options?)` | Publish a checkpoint and open the next run |
| `destroy(workspaceId)` | Abort and clean the client-local compatibility session |
| `pull(workspaceId, version?)` | Pull files from latest or specific commit |
| `getFile(workspaceId, filePath)` | Get a single file |
| `history(workspaceId, limit?)` | Get commit history |

## License

MIT


SDK verification uses `npm --prefix sdk/typescript run build` and `npm run test:sdk -- --language typescript`.
The explicit SDK gate requires Docker, cached `node:18-bookworm-slim`, and the selected LocalStack target through `CV_TEST_S3_*`.
The tests install a packed package outside the repository with engine-strict installation and execute both Git and LocalStack journeys.
LocalStack evidence does not establish actual AWS compatibility.
