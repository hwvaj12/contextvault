# ContextVault Python SDK

Python 3.8+ HTTP client with durable local workspace sessions. Install the wheel and import `contextvault`:

```bash
python -m pip install contextvault-0.2.0-py3-none-any.whl
```

```python
from contextvault import Client

cv = Client(api_key="cv_key_...", base_url="https://vault.example.com")
```

The wheel declares `requests>=2.20,<3`. It contains the `contextvault` package only.
Repository-local `from src import Client` remains a compatibility shim beside this README.
The shim is excluded from installed packages.

Local materialization currently requires POSIX filesystem primitives, including `O_NOFOLLOW`, directory fsync, and `flock`.
HTTP resource calls use Python 3.8+ without importing server source.

## Local workspace lifecycle

The SDK creates a new owned directory beside the client. `handle.path` is an absolute path on the client's host.
The server sends manifests and binary HTTP streams. The client never receives server storage credentials or server filesystem paths.

```python
import os
from pathlib import Path
from contextvault import Client

cv = Client(os.environ["CV_API_KEY"], os.environ["CV_URL"])

# The private path must not exist; its parent must already exist.
# Save this path with the job so another process can resume it.
state_path = "/home/worker/state/job-123"
handle = cv.open_workspace(
    "workspace-id",
    private_state_path=state_path,
    local_parent="/home/worker/jobs",
    agent_label="analysis-agent",
    task="prepare output",
    reason="customer request",
)

Path(handle.path, "output.bin").write_bytes(b"exact bytes\x00\xff")
handle.heartbeat()

# Stop every agent writer before capture, checkpoint, abort cleanup, or cleanup.
operation = handle.finalize(writers_stopped=True)
assert operation["state"] == "succeeded"
assert operation["result"]["runState"] == "finalized"
handle.cleanup(writers_stopped=True)
cv.close()
```

`cv.create_workspace(customer_id, name, **options)` durably creates and opens a workspace in one local session.
It persists identity before the workspace ID exists. `open_workspace` persists identity before the run ID exists.
For failed initial provisioning, the exception exposes `private_state_path` and `session_id`, including SDK-selected paths.

`mode="read-only"` opens a pinned read-only run. Its finalize command omits a submission.
A newer accepted workspace head does not prevent read-only completion.

`handle.status()` reads the current run. Run, lease, and submission versions have separate meanings.
Heartbeat renews the lease without changing the run version. Uploads and seal change the submission version.
Heartbeat is explicit; callers schedule it while agents work.

## Checkpoints and restart

```python
checkpoint = handle.checkpoint(writers_stopped=True)
# Start writers only after checkpoint returns with handle.recovery_status == "ready".
# handle.path stays the same; handle.run identifies the new pinned run.
```

A checkpoint finalizes one run, then opens the next run with its own durable command.
If reopen fails, `handle.recovery_status` remains `published-needs-reopen`.
Resumption retries the original open key and never republishes the completed checkpoint.
If another writer advances the head, resumption hydrates the new pinned base before returning `ready`.
Incomplete hydration remains `provisioning` in the journal and can resume after process restart.

If the checkpoint succeeded and the first reopen received a proven HTTP rejection, explicit cleanup can abandon that reopen:

```python
handle.cleanup(writers_stopped=True)
```

Cleanup checks the matching rejection proof, current terminal run, and accepted finalize operation under current read authority.
It does not require permission to open another run and does not abort the accepted checkpoint.
The journal preserves the accepted operation, revision, submission, and receipt references.
Abandonment commits before file deletion, so interrupted cleanup can resume without reopening.
After abandonment, `reconcile` and `checkpoint` reject attempts to resume that local session.

If cleanup was not chosen, permission restoration still retries the original reopen key and exact request.
An uncertain reopen or an accepted active new run cannot use this abandonment path.

```python
from contextvault import OutcomeUnknownError

try:
    operation = handle.finalize(writers_stopped=True)
except OutcomeUnknownError:
    # Retain the local path, private state, and captures. Restore current authority/connectivity first.
    recovered = cv.resume_workspace(state_path)
    operation = recovered.reconcile()
```

`resume_workspace` loads state without dispatching. `reconcile` resumes the saved command and subsequent lifecycle steps.
For opening, it materializes the saved run. For publication, it returns the completed operation.
It reuses the original key, exact request, selected submission, and immutable capture.
Changing local files after a lost response does not change the pending publication.
A process crash with a dispatched command also preserves uncertainty, even without a known remote ID.
A later authorization failure cannot establish whether the earlier command succeeded.

Private session directories use `0700`. Journal files and capture files use `0600`.
State and captures stay outside submitted contents. The journal never stores API credentials.
Each resumed process supplies a current API key for the same server origin and tenant authority.
State paths and capture paths must remain available at their original absolute locations.
This provides process restart recovery on retained local storage, without claiming recovery after local disk loss.
A local lock serializes session commands across cooperating processes.
The journal records capture directory ownership before writing captured bytes, so cleanup can recover captures left by process crashes.
Capture manifests identify immutable file names by canonical entry index; pending uploads store their exact absolute source path.
Journal writes and reads share a 64 MiB metadata budget. Prepared commands reserve space for their bounded result before dispatch.
An oversized write preserves the previous readable journal. This includes growth from retained checkpoint captures.
Canonical workspace entry, path, and byte limits remain unchanged.

## Outcomes and explicit cleanup

```python
from contextvault import AuthError, ConflictError, ExpiredError, OutcomeUnknownError

# Abort only a known active run after stopping its writers.
handle.abort("discard this attempt", writers_stopped=True, cleanup=True)
```

- `ConflictError` exposes `code`, such as `REVISION_CONFLICT`, for a known stale publication.
- `ExpiredError` exposes `RUN_EXPIRED` when the run lease expires.
- `OutcomeUnknownError` requires reconciliation of the saved command.
- `AuthError` reports a known authorization rejection; uncertain retries retain `OutcomeUnknownError` instead.
- `ValidationError` reports invalid manifests, unsafe files, changing input declarations, or quotas.
- `ConflictError` with `CAPTURE_CHANGED` reports files that change during capture.

All SDK errors expose `message`, `status_code`, `code`, `operation_id`, and `retryable` where available.
A recorded terminal operation failure remains distinct from an unknown operation outcome.
`cv.operations.get(id)` reads an operation. `cv.operations.wait(id)` polls it and checks its terminal result.
`poll_timeout` and `poll_interval` configure bounded polling on `Client`.
The remaining monotonic polling deadline bounds connection setup, response headers, and response body consumption.
Deadline cancellation closes the lookup's owned socket and retains the durable operation ID.
If system DNS resolution continues after cancellation, the lookup issues no HTTP request after resolution returns.

A known active run can explicitly abort after incomplete hydration, provided no command outcome remains uncertain.
Cleanup requires a known terminal run and caller-stopped writers. It never aborts a run automatically.
An uncertain command blocks abort and cleanup.
A complete first HTTP 4xx rejection can permit explicit abort while retaining the exact rejected key, request, files, and captures.
The journal binds that rejection proof to the pending key and request fingerprint, without storing a duplicate request body.
Every retry clears the proof durably before dispatch. A later rejection cannot resolve an earlier unknown attempt or known operation.
Generic HTTP 5xx responses remain unknown; local validation and receipt mismatches cannot prove an HTTP rejection.
Abort archives one rejected command within the journal budget and persists its replacement abort before dispatch.
Files and captures remain until the abort succeeds and the caller explicitly requests cleanup. Cleanup errors preserve the remote terminal outcome and private journal.
Cleanup releases local workspace files and every retained checkpoint capture. It keeps the small journal for inspection.
Repeated cleanup is safe after successful completion, and interrupted cleanup can resume.
Callers may archive or delete that journal after confirming cleanup.
Closing a client closes HTTP connections; it does not finalize, abort, or delete files.

## Complete snapshot and filesystem rules

The SDK transfers files in bounded chunks, with a default size of 64 KiB.
It independently verifies lowercase SHA-256 and byte length for downloads and upload receipts.
Capture copies verified source bytes into immutable private files before uploading.
No complete workspace passes through JSON or base64.

A manifest includes regular files and explicit directories. Omitting a path deletes it from the next accepted snapshot.
Empty files, binary bytes, Unicode names, and empty directories remain exact.
Manifest entries sort by unsigned UTF-8 path bytes. Serialization follows the shared v1 field order.
Submitted `.gitignore` is ordinary content.
Canonical `.git` and `.contextvault` metadata names are excluded at every capture depth.
Portable paths reject traversal, reserved names, normalization errors, and portable case collisions.
Capture, hydration, and cleanup reject symlinks, hardlinks, special files, and unsafe ancestry.
Capture also detects source identities or bytes that change while it copies them.

Defaults match the shared contract: 10,000 entries, 1,024 path bytes, 255 component bytes,
64 MiB per file, and 512 MiB total bytes. `Client(..., limits={...})` can select stricter limits.
Transfers run sequentially and remain below the shared concurrency limit.

These checks require stopped cooperative writers for capture and cleanup.
They do not isolate hostile concurrent processes with the same UID. The host supplies agent process isolation.

## Resource calls and compatibility

Low-level resources expose `cv.runs`, `cv.submissions`, `cv.receipts`, `cv.operations`, and `cv.workspaces`.
The server has no receipt GET route; `cv.receipts.verify(receipt, entry)` verifies returned immutable receipts.
Low-level mutations require an explicit `idempotency_key`, except the historical `workspaces.create` convenience.
For durable caller-managed creation, always pass an explicit key and retain the exact creation request before dispatch.
Use high-level sessions for automatic durable recovery.

```python
workspace = cv.workspaces.create(customer_id, "analysis", idempotency_key=saved_create_key)
run = cv.runs.open(workspace["id"], idempotency_key=saved_open_key)
submission = cv.submissions.create(run["id"], idempotency_key=saved_submission_key)
receipt = cv.submissions.upload(run["id"], submission["id"], file_entry, immutable_file_path,
                               idempotency_key=saved_upload_key)
sealed = cv.submissions.seal(run["id"], submission["id"], manifest,
                             [{"path": receipt["path"], "receiptId": receipt["id"]}],
                             idempotency_key=saved_seal_key)
operation = cv.runs.finalize(run["id"], run["version"], submission_id=sealed["id"],
                             idempotency_key=saved_finalize_key)
```

`workspaces.checkout`, `write`, `commit`, and `destroy` wrap local sessions.
Duplicate or concurrent checkout rejects the request while an existing wrapper owns the workspace.
Successful destroy releases wrapper ownership so a later checkout can proceed.
Checkout returns client-local `path` and `sandboxPath`, plus `runId`, `sandboxId`, `baseCommit`, and `privateStatePath`.
Commit checkpoints and returns legacy `status="merged"` alongside its durable operation.
Destroy aborts the current active run and explicitly cleans local files with `status="cleaned_up"`.
`writers_stopped=True` is required for commit and destroy.
Existing metadata, revision, pull, diff, webhook, and API-key methods retain their historical server routes.
In particular, public `workspaces.get` uses legacy `/workspaces/:id` and its legacy DTO.
The server compatibility adapter owns convergence for catalog-created workspaces and legacy metadata aliases.
Pending v1 creation completion instead reads `/v1/workspaces/:id`, so it does not depend on that legacy compatibility seam.
Legacy server HTTP pull results retain their existing wire representation; binary materialization uses v1 streams.

## Acceptance verification

The host test runner requires Python 3.9+, Node 22+, Docker, and repository Node dependencies.
The actual consumer runs the installed wheel on `python:3.8-slim`, currently Python 3.8.20.
Its container receives installed artifacts, scoped synthetic API credentials, and an HTTP origin.
It receives no server source, server data mount, Docker socket mount, or storage credentials.
Each test suite exercises actual Git and the explicitly selected LocalStack target. Missing targets fail; no backend is skipped.
This is installed minimum-runtime evidence, without claiming production network or IAM isolation.
Actual AWS verification remains separate.

1. Create task-local host tooling.

```bash
python3 -m venv sdk/python/.test-env
sdk/python/.test-env/bin/python -m pip install -r tests/sdk/python/requirements.txt
```

2. Select the isolated LocalStack test target.

```bash
export CV_TEST_S3_PROVIDER=localstack
export CV_TEST_S3_ENDPOINT=http://127.0.0.1:51744
export CV_TEST_S3_BUCKET=contextvault-tests-01a1a255
export CV_TEST_S3_REGION=us-east-1
export CV_TEST_S3_PREFIX=contextvault-tests/01a1a255-0856b3941ea1/
export CV_TEST_SERVER_NODE=/usr/local/bin/node
```

3. Run the root SDK gate with task-local pytest tooling.

```bash
PATH="$PWD/sdk/python/.test-env/bin:/usr/local/bin:$PATH" npm run test:sdk -- --language python
```

The root runner executes `python3 -m pytest tests/sdk/python`. The PATH selects the declared host test environment.
The fixture builds a clean wheel, resolves Python 3.8 dependency wheels, and installs them outside the repository.
The controller owns fixture shutdown, unique storage prefixes, and bounded cleanup.
Tests cover binary snapshots, deletion, isolation, stale conflicts, expiry, response loss, subprocess restart,
immutable retry sources, checkpoint reopen recovery, incomplete hydration, unsafe files, and independent cleanup failure.
