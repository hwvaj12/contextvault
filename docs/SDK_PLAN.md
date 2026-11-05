# Installed client guide

This file retains its historical name, `SDK_PLAN.md`, but describes the current client contracts.
TypeScript, Python, PHP, CLI, and MCP clients use authenticated ContextVault HTTP operations.
They do not select canonical storage locations.

## Packages and runtime requirements

| Component | Current metadata | Minimum |
|---|---|---|
| TypeScript SDK | `@contextvault/sdk` `0.1.0` | Node.js 18 |
| Python SDK | `contextvault` `0.2.0` | Python 3.8; `requests>=2.20,<3` |
| PHP SDK | `contextvault/contextvault-php` | PHP 8.0, `ext-curl`, `ext-json`, Composer dependencies |
| CLI | `@contextvault/cli` `0.1.0` | Node.js 18; matching SDK |
| MCP | `contextvault-mcp` `0.1.0` | Node.js 20; bundled matching SDK |

Package versions and API versions have separate meanings.
The maintained [installation quickstart](quickstart/clients.md) uses local artifacts.
It does not require registry publication.
PHP's repository metadata does not declare an independent release version.
A local Composer package definition must select an explicit version for its artifact.

The Python wheel contains `contextvault`; repository-local `from src import Client` is a compatibility shim.
Local Python workspace materialization requires POSIX primitives such as `O_NOFOLLOW`, directory fsync, and `flock`.
Windows local materialization has not been verified.

## Shared session behavior

A session identity exists before a remote workspace, run, or operation ID becomes known.
The client allocates a new private local workspace and journal.
`path` and `sandboxPath` refer to that client host's filesystem.

Clients hydrate the run's pinned manifest and exact file streams.
Applications launch their existing agents separately against that path.
The SDK does not supervise those agents or provide hostile-code containment.

A complete capture preserves regular files, explicit directories, bytes, and hashes.
Omitted paths mean deletion.
Private journals and capture metadata remain outside submitted content.
All writers must stop before capture, submission, checkpoint, reconciliation, or cleanup.

The default server lease lasts five minutes.
Applications schedule explicit heartbeat calls while agents work.
A renewal changes lease state without changing the run lifecycle version.

## Durable command and cleanup outcomes

| Action | Meaning |
|---|---|
| Open or create | Persist identity, acquire a scoped run, and hydrate client-local files |
| Submit | Capture, upload, and seal immutable contents without publication |
| Finalize | Publish or complete the selected run through a durable operation |
| Checkpoint | Finalize one run, then open and hydrate the next run over the same local path |
| Abort | Discard a known active run without publishing its edits |
| Reconcile | Recover the original pending command or known operation |
| Cleanup | Remove owned local contents after a known terminal outcome |

Checkpoint publication can succeed while reopening remains incomplete.
The clients retain `published-needs-reopen` progress and the accepted checkpoint receipt.
Reconciliation retries the original reopen command rather than republishing the checkpoint.
A proven never-accepted reopen can support explicit abandonment under the client-specific API.
An uncertain earlier dispatch prevents that inference.

A lost response preserves the original key, exact request, immutable capture, and known operation ID.
A current authorization denial does not prove that earlier publication failed.
Resuming requires retained private state, the same server origin, and current credentials.
Local disk loss requires recovery outside this client journal contract.

Cleanup and remote publication have independent outcomes.
An accepted revision remains accepted when local removal fails.
Clients retain ownership and recovery metadata for incomplete cleanup.
Generic exceptions never authorize automatic abort or file deletion.

## Client API references

| Client | Methods and detailed recovery contract |
|---|---|
| TypeScript | [SDK reference](../sdk/typescript/README.md#open-a-durable-local-workspace) |
| Python | [SDK reference](../sdk/python/README.md#local-workspace-lifecycle) |
| PHP | [SDK reference](../sdk/php/README.md#local-workspace-lifecycle) |
| CLI | [Commands and exit codes](../cli/README.md) |
| MCP | [Tools, handles, and production packaging](../mcp/README.md) |

Language-specific method names differ.
Use the relevant package reference instead of assuming identical call syntax.
The [executable examples](quickstart/clients.md#run-the-installed-client-examples) exercise maintained installed packages.

## CLI and MCP

The CLI exposes open, submit, finalize, checkpoint, abort, status, heartbeat, reconcile, and cleanup commands.
It emits structured JSON and stable exit codes.
A private single-controller marker protects cooperative session access.
After a controller crash, explicit stopped-controller and stopped-writer assertions permit reconciliation.
The marker does not establish a hostile same-user security boundary.

MCP uses one maintained TypeScript implementation for development and production.
It requires `CV_API_URL`, `CV_API_KEY`, and `CV_MCP_STATE_DIR`.
Administrator MCP configuration also requires `CV_CUSTOMER_ID`; customer credentials normally leave that MCP selector unset.
Its production artifact includes a reproducible SDK archive and bundled installed dependency.
A standalone consumer needs no sibling repository checkout or Git store.

MCP local access returns paths on the MCP host.
Remote access returns a durable opaque handle and bounded file tools.
The calling agent must not interpret an MCP-host path as a path on another machine.
File tools check current content authority before reading retained local bytes.

## Evidence boundaries

Installed-package checks cover archive or wheel installation, actual client HTTP behavior, and durable restart recovery.
The host matrix exercises three SDKs across workers, containers, and Docker remote-machine boundaries on Git and LocalStack.
CLI and MCP have separate packaging and lifecycle checks.

Docker remote boundaries do not prove physical remote hardware or Windows support.
Native worker tests provide cooperative process separation.
Minimum runtime claims require the corresponding actual runtime checks.
AWS IAM and hosted CI remain separate from LocalStack and local test evidence.
