# ContextVault PHP SDK

PHP 8.0+ client for authenticated workspace runs and client-local files. Requires `ext-curl`, `ext-json`, and Composer dependencies.
Guzzle uses cURL for bounded resource uploads. Declared Unicode polyfills support installations without `intl` or `mbstring`.

```sh
composer require contextvault/contextvault-php
```

## Local workspace lifecycle

```php
require 'vendor/autoload.php';

use ContextVault\Client;

$client = new Client($apiKey, 'https://contextvault.example');
$session = $client->createWorkspace('customer-id', 'agent-memory', '/absolute/private/parent');
// For an existing workspace:
// $session = $client->openWorkspace($workspaceId, '/absolute/private/parent');
$path = $session->path();
$recoveryPath = $session->recoveryPath();

// Your application launches its existing agent separately against $path.
// Stop every agent writer before capture, reconciliation, checkpoint, or cleanup.
file_put_contents($path . '/memory.bin', "exact\0binary\xff\r\n");
$result = $session->finalize(true); // true confirms that writers have stopped.
$run = $session->status();
$session->cleanup(true); // Explicit local cleanup after a known terminal outcome.
```

The parent directory must already exist. The SDK creates separate owned workspace and private directories with mode `0700`.
`path` and `sandboxPath` refer to this client's filesystem. HTTP run records never supply a server filesystem path.
The SDK does not execute, isolate, monitor, or stop agents. The application supplies process isolation and writer coordination.

`openWorkspace($id, $parent, $runOptions)` accepts `mode`, `agentLabel`, `task`, and `reason`.
The default mode is `read-write`. A `read-only` run finalizes without a submission or a content publication.
`finalize(true)` captures a complete snapshot, uploads files, seals receipt selections, and polls the durable finalization operation.
Omitted files and directories are deleted. An empty complete snapshot deletes all previous contents.
Finalization preserves local files. Cleanup has an independent result and cannot change a publication outcome.

## Lease renewal and abort

```php
// Schedule this call in your application while an active agent uses the path.
$run = $session->heartbeat();
// When the caller chooses to discard a known active run:
$session->abort('caller cancelled');
// Stop writers before removing their files.
$session->cleanup(true);
```

With the server's default five-minute lease, renew approximately once per minute.
The SDK provides synchronous renewal; the application schedules calls. Expired leases cannot be revived.
Run lifecycle versions, submission versions, and lease versions remain separate.

## Recovery and checkpoints

```php
use ContextVault\Exception\ContextVaultException;

try {
    $session->checkpoint(true);
} catch (ContextVaultException $error) {
    // Retain $recoveryPath, local files, and private captures.
    // A failed initial create/open exposes its identity through getRecoveryPath().
    $recoveryPath = $error->getRecoveryPath() ?? $session->recoveryPath();
    throw $error;
}

// A later process supplies current credentials and the same server origin.
$session = $client->resumeWorkspace($recoveryPath); // Loads state without HTTP or file mutation.
$outcome = $session->reconcile(true);              // Requires caller-stopped writers.
```

Each session exists before workspace, run, or operation IDs become known.
The private `session.json` atomically stores a v1 client-state record and its workflow journal.
Pending commands retain the exact request, original idempotency key, dispatch phase, immutable capture reference, and known operation ID.
Credentials never enter that file or submitted contents. Supply credentials again when resuming.
`state()` exposes the client-state record. `recovery()` also exposes workflow progress and independent local cleanup status.

After a lost response, reconciliation reuses the original command and captured bytes.
It does not recapture modified agent files or infer authority from chat history.
Authorization denial during an uncertain retry preserves the command, captured source, and local files.
It cannot prove that the earlier request failed. Restore current authority before reconciling again.
An accepted mutation followed by a denied operation poll also retains its newly known operation ID and original command.
The SDK keeps the typed `AuthError`; later reconciliation reads that operation without sending another mutation.
Corrupt state produces `CORRUPT_LOCAL_STATE`; incomplete hydration retains a recovery identity and prevents `path()` from reporting readiness.

A checkpoint finalizes one run, opens the next, and preserves the local path.
After known publication and failed reopening, recovery reports `published-needs-reopen`.
Reconciliation retries the original open key and never republishes that checkpoint.
The SDK hydrates the next pinned base before it reports readiness, including when another writer advanced the head.
This also applies to a first reopen `401` or `403`: the accepted checkpoint receipt, operation, revision, and original reopen command remain durable.
After permission restoration, reconciliation retries that exact command. `recovery()['workflow']['acceptedCheckpoint']` retains the accepted publication receipt.

`abandonReopen(true)` explicitly abandons only a reopen proven never accepted, with caller-stopped writers.
The SDK requires genuine HTTP authentication/authorization rejection evidence for every attempt; a fabricated typed error cannot supply that proof.
Before every retry, the SDK durably clears the old rejection proof and records that acceptance is possible.
A lost response or uncertain earlier attempt prevents abandonment, even if a later retry receives `403`.
Abandonment preserves the accepted publication and archives the original reopen command. Files remain until explicit `cleanup(true)`.

`OutcomeUnknownError` has code `PUBLICATION_OUTCOME_UNKNOWN` and a recovery path.
Known conflict and expiry use `ConflictError` and `ExpiredError`, with `REVISION_CONFLICT` and `RUN_EXPIRED` codes.
Other errors expose `getErrorCode()`, `getStatusCode()`, and `getResponseBody()`.
If the server reports `INVALID_TRANSITION`, the session confirms an expired run through authenticated status before reporting `RUN_EXPIRED`.
An operation's durable failed state resolves uncertainty as a known failure.
Repeated finalization and reconciliation replay the recorded typed failure, including after process restart or a previous successful checkpoint.
Never abort or delete files merely because a generic exception occurred.

## Streams and filesystem rules

The SDK verifies exact byte length and lowercase SHA-256 for downloads, captures, uploads, and receipts.
Files stream through bounded chunks; no whole-workspace JSON or base64 buffer carries content.
Manifests retain explicit directories and sort paths by unsigned UTF-8 bytes.
Portable paths require NFC and reject case/compatibility collisions, traversal, reserved Windows names, and unsupported characters.
Capture excludes `.git` and `.contextvault` components, including canonical Unicode/case variants.
`.gitignore` remains ordinary submitted content and never controls capture exclusions.
Links, hardlinks, special files, changed identities, and changed source bytes fail validation.
Cleanup validates excluded metadata too, before deleting any entries.

Default limits: 10,000 entries, 1,024 path bytes, 255 component bytes, 64 MiB per file, 512 MiB total, and 64 KiB chunks.
The client processes transfers sequentially, below the default four-stream concurrency limit.
Set client limits with the constructor's fourth argument: `['limits' => ['maxFileBytes' => 1048576]]`.
Server limits remain authoritative.

Private state survives process restart when its local filesystem survives.
The session records capture directory ownership before it writes the first captured payload byte.
Abort and cleanup can remove an interrupted owned capture. Unknown private capture paths require ownership investigation and remain untouched.
Cleanup retains the workspace path and filesystem identity until root removal is known complete.
A retry can finish removal or recognize an already removed owned root without changing publication status.
PHP 8.0 lacks `fsync()`; the SDK uses flushed writes and atomic rename, with `fsync()` where available.
It does not claim physical power-loss durability, machine-loss recovery from ephemeral storage, or hostile same-UID filesystem isolation.

Metadata budgets follow the shared entry and UTF-8 path limits, independently from file-content quotas.
HTTP metadata allows `1 MiB + maxEntries * (maxPathBytes + 192)` bytes.
Private journals allow `4 MiB + 6 * maxEntries * (maxPathBytes + 192)` bytes, with matching read and write bounds.
An oversized save fails before replacing the previous readable journal or dispatching its command.
Base and capture manifests use verified private references; `manifest()` reads the pinned base metadata.
Successful checkpoints release their previous owned captures. Failed private cleanup retains its ownership references and counts against the bounded journal.
No metadata limit silently truncates a manifest or reduces the shared canonical entry/path rules.

## Low-level resources

`runs()`, `submissions()`, and `operations()` expose the HTTP resources without materialization.
Mutation methods require caller-supplied stable keys. Low-level callers must persist their original requests and upload sources before dispatch.
Only high-level `WorkspaceSession` methods own the durable session journal.
Mutations never retry automatically. Read retries have a fixed count.
Constructor options `timeout` and `operationTimeout` bound HTTP and durable-operation waits; each must be positive and at most 120 seconds.

## Existing workspace methods

`workspaces()->create()` uses a durable local session. `get()` reads the authenticated v1 workspace.
`checkout()` returns `path`, `sandboxPath`, `baseCommit`, `runId`, `recoveryPath`, and `handle`.
`commit($id, ['writersStopped' => true])` checkpoints and returns `commitId`, `status: merged`, and the separate v1 `outcome: finalized`.
`destroy($id, true)` explicitly aborts a known active next run and cleans owned files.
`pull()` returns a read-only local `path`, `manifest`, and `handle`; it does not return a complete JSON file buffer.
`getFile()` returns one readable `stream` and its read-only `handle`.
Close that stream, then finalize or abort its handle and explicitly clean up.
If opening the materialized file fails, the exception exposes `getRecoveryPath()` for that owned read-only session.
Resume that identity to inspect pinned files, explicitly abort, and clean up. The failure does not automatically delete files.
Nonportable file paths fail validation before the wrapper opens a session.

Legacy commit metadata and historical `pull($id, $version)` return `UNSUPPORTED_CAPABILITY`.
Listing, administration, clone, diff, history, API-key, and webhook methods retain their existing server endpoint seams.
Their availability depends on server compatibility work; this SDK does not invent fallback authority or local history.
Callers must migrate old JSON-content loops to ordinary local file access.
Compatibility handles are cached in one `Workspaces` object. After process restart, resume through the recorded recovery path.

## Task-local verification

1. Install the declared runner: `composer --working-dir=sdk/php install --no-interaction --prefer-dist`.
2. Set the isolated LocalStack test variables listed below.
3. Run `PATH=/usr/local/bin:$PATH npm run test:sdk -- --language php`.

```sh
export CV_TEST_S3_PROVIDER=localstack
export CV_TEST_S3_ENDPOINT=http://127.0.0.1:51744
export CV_TEST_S3_BUCKET=contextvault-tests-01a1a255
export CV_TEST_S3_REGION=us-east-1
export CV_TEST_S3_PREFIX=contextvault-tests/01a1a255-0856b3941ea1/
```

Those values identify this task's isolated target. Other environments must supply their own nonproduction target.
The runner requires Node 22+ for the normal server/controller, Docker, Composer, and cached `php:8.0-cli` with PHP 8.0.30.
It creates a tar artifact, installs it through Composer outside the repository, then executes its installed autoloader in PHP 8.0.
The consumer receives the artifact, test scripts, HTTP origins, runtime settings, and scoped synthetic credentials.
It receives no server data mount, server source mount, storage locator, administrator key, or storage credentials.
Every required suite executes both real Git and strict selected LocalStack, without skips or fallback.
Correction coverage includes actual Docker `KILL` during capture, fresh-container cleanup, root removal interruptions, repeated terminal failures, and legal large metadata.
Focused controlled-response checks exercise local crash boundaries and checkpoint history separately from the real backend lifecycle assertions.
Run `node tests/sdk/php/installed.mjs --focus-reopen` with the same environment for installed PHP 8.0 reopen-policy checks on both backends.
Those checks cover permission restoration, proven rejection abandonment, fabricated rejection after actual acceptance, and lost accepted retries.
This establishes local installed-package evidence. It does not establish actual AWS or downstream repository compatibility.
