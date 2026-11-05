# ContextVault MCP

This stdio server gives MCP clients authenticated access to ContextVault workspaces.
ContextVault owns permissions, accepted revisions, finalize, abort, and recovery.
Existing agents run independently and use ordinary files or the workspace file tools.

The MCP server requires Node.js 20 or later.
The bundled ContextVault TypeScript SDK retains its separate Node.js 18 minimum.
Development and production use the same TypeScript implementation.
The development loader requires the package's local development dependencies.

## Local development

1. Install the locked dependencies.

```sh
npm --prefix mcp ci --ignore-scripts
```

2. Configure an API origin, scoped credential, and private state directory.

```sh
export CV_API_URL=http://127.0.0.1:3000
export CV_API_KEY=your-scoped-customer-key
export CV_MCP_STATE_DIR=/absolute/private/contextvault-mcp
```

3. Start the development entrypoint.

```sh
npm --prefix mcp run dev
```

Use an absolute state path with real directory ancestors.
MCP creates a missing private directory with mode 0700.
An existing private directory must belong to the current user and have mode 0700.
Symlink ancestors are rejected; on macOS, `/private/tmp` is the real ancestor behind `/tmp`.
Use durable storage for this directory when recovery must survive host replacement.

Administrator credentials also require `CV_CUSTOMER_ID` to select one customer explicitly.
Customer credentials should leave that variable unset.
Tools cannot supply another API origin or credential.
The MCP state namespace binds the configured origin, credential, and selected customer.
Changing credentials never grants access to another credential's retained local handles.

Optional `CV_MCP_REQUEST_TIMEOUT_MS` and `CV_MCP_OPERATION_TIMEOUT_MS` set bounded deadlines from 1 through 120000 milliseconds.
Both default to 30000 milliseconds.
An elapsed deadline preserves uncertainty; it does not authorize cleanup.

## Standalone production package

The ContextVault SDK is currently supplied from this repository rather than an npm registry release.
The package includes a reproducible SDK archive and bundles its installed runtime dependency.
A packaged MCP consumer needs no source checkout, sibling SDK directory, or install scripts.

1. Build the maintained implementation.

```sh
npm --prefix mcp run build
```

2. Pack the production artifact.

```sh
cd mcp
npm pack --ignore-scripts
```

3. Install that artifact in the consuming application.

```sh
npm install --ignore-scripts /absolute/path/contextvault-mcp-0.1.0.tgz
```

4. Launch the installed executable with the configuration above.

```sh
./node_modules/.bin/contextvault-mcp
```

For an MCP host configuration, use the installed executable's absolute path and pass the three required environment variables.
The transport is stdio. This package does not start a public HTTP MCP listener.

`npm --prefix mcp run vendor:sdk` rebuilds the archive from the adjacent approved SDK source.
It compiles an isolated copy and leaves the SDK source unchanged.
`vendor/sdk-provenance.json` records source hashes, the source lockfile hash, compiler version, archive hash, and original MIT license metadata.
Both the SDK archive and MCP artifact include the repository's MIT copyright and permission notice.
The bundled SDK retains its original package metadata.
After an approved SDK change, regenerate the archive, refresh its lockfile integrity, and verify a fresh install before packing.
Use `npm --prefix mcp update @contextvault/sdk --package-lock-only --ignore-scripts`, followed by `npm --prefix mcp ci --ignore-scripts`.
The packaging acceptance test checks deterministic regeneration and a cold MCP-only install.

## Workspace tools

`checkout_workspace` and `open_workspace` return a durable `workspaceHandle`.
Pass a stable `requestId` when retrying the same checkout.
Reusing that ID with another exact request fails.
A fresh independent run needs a fresh `requestId`.

```json
{
  "workspaceId": "workspace-opaque-id",
  "requestId": "task-123-checkout",
  "mode": "read-write",
  "access": "remote",
  "agentLabel": "existing-agent",
  "task": "Prepare the requested customer report",
  "reason": "Authorized customer workflow"
}
```

`access:local` returns `path` and `sandboxPath` on the MCP host.
Those paths belong to that host, including its container when MCP runs inside one.
`access:remote` returns an opaque handle without host paths.
Use file tools when the calling agent cannot access the MCP host's filesystem.

| Tool | Behavior |
|---|---|
| `workspace_status`, `get_sandbox_status` | Read current scoped run status |
| `heartbeat_workspace` | Renew the run lease |
| `list_workspace_files` | List ordinary workspace files and directories |
| `read_workspace_file` | Read a bounded base64 chunk at an offset |
| `write_workspace_file` | Write a base64 chunk at an explicit offset |
| `delete_workspace_file` | Remove one regular workspace file |
| `make_workspace_directory` | Create an ordinary workspace directory |
| `commit_workspace`, `checkpoint_workspace` | Publish and reopen the same local workspace |
| `finalize_workspace` | Publish the final complete snapshot |
| `abort_workspace` | Abort a known active run without publication |
| `cleanup_workspace` | Remove owned local workspace files after a known terminal result |
| `destroy_workspace` | Explicitly abort an active run, then clean its owned local files |
| `reconcile_workspace` | Reconcile the SDK's original durable command |

Use `workspaceHandle` to identify the exact session.
Legacy `workspaceId` selection works only when one uncleaned local session matches.
Every file operation checks current server authority.
File tools require current workspace content authority before accessing local files, even when run metadata remains readable.
Deleted and suspended workspaces deny content access under the server policy.
Read-only runs reject file writes.
Paths must satisfy the shared portable-path rules.
File tools reject symlinks, hardlinks, special files, traversal, and reserved metadata names.

Read and write chunks contain at most 64 KiB.
Use `offset` for subsequent chunks and `truncate:true` only for the first chunk at offset 0.
An empty base64 value with truncation creates an empty file.
File tools enforce the shared entry, per-file, and total-byte limits before additional writes.
Ordinary agent files receive the same validation before publication.
Large snapshots can use ordinary local files or repeated remote chunks.

## Publication and recovery

Stop every agent writer before capture, checkpoint, finalize, reconciliation, abort, or cleanup.
Pass `writersStopped:true` on those calls.
MCP never infers stopped writers from a terminal server state.
Uncertain publication keeps the original key, capture, accepted receipt, and workspace available for reconciliation.
Never discard that state to start a new publication.

MCP uses a cooperative single-controller marker per handle.
It does not take over a marker from a PID, elapsed time, or lease age.
After a controller crash:

1. Stop every controller for the affected handle.
2. Call `recover_workspace_controller` with `controllersStopped:true`.
3. If recovery returns `initializationIncomplete:true`, retry the original checkout with its original `requestId`.
4. Otherwise, stop every agent writer for that workspace.
5. For initialized workspaces, call `reconcile_workspace` with `writersStopped:true` and the original handle.
6. Inspect the authoritative outcome before continuing or cleaning local files.

If recovery returns `initializationIncomplete:true`, retry the original request with its original `requestId`.
For checkout recovery before its first journal, supply both `workspaceHandle` and the existing `workspaceId`.
An acquisition error includes the opaque handle needed for recovery.
Retain any existing SDK state when its MCP journal is unavailable.

These assertions are owner preconditions, not containment against hostile processes sharing the same user identity.
Current authorization still gates recovery and retained file reads.
API credentials stay outside workspace content and tool responses.

## Retained administration

| Tool | Behavior |
|---|---|
| `create_workspace`, `list_workspaces`, `get_workspace` | Authenticated canonical workspace administration |
| `delete_workspace` | Tombstone while retaining accepted history |
| `push_to_workspace` | Complete replacement through ContextVault's canonical compatibility bridge |
| `pull_from_workspace` | Accepted small snapshot, with base64 for binary files |
| `get_workspace_history` | Current-head ancestry with opaque revision IDs |
| `diff_workspace` | Canonical diff with retained added/removed/modified aliases |
| `rollback_workspace` | Durable restore with an optimistic current-head check |
| `reconcile_command` | Reconcile the original administration request or known operation ID |

Pass a stable `requestId` to create, delete, push, and rollback.
MCP saves the exact request and stable server key before dispatch.
Reusing an ID with different input fails.
Mutations do not retry automatically.
An uncertain administration result includes `commandHandle` for explicit reconciliation.
A crashed administration controller requires `recover_command_controller` with `controllersStopped:true` before reconciliation.
If that recovery returns `initializationIncomplete:true`, retry the original administration request with its original `requestId`.

Direct requests are limited to 512 KiB and small snapshot responses to 2 MiB.
Use workspace file chunks for larger contents.
History defaults to 20 revisions and accepts a cursor and limit up to 1000.
List defaults to 100 workspaces and accepts an offset and limit up to 1000.
Revision IDs remain opaque; no Git hash format is required.
Errors use MCP `isError:true` with a stable ContextVault code when available.

## Verification

```sh
npm --prefix mcp run build
npm run test:mcp
CV_TEST_BACKEND=s3 npm run test:mcp
```

S3 tests require the explicit nonproduction LocalStack settings documented by the root test harness.
The package acceptance test requires Docker and the official `node:20-bookworm-slim` image locally.
It fails if required targets are unavailable.
The gate exercises actual stdio, normal HTTP, customer isolation, revocation, binary files, current authority, restart recovery, and installed packaging.
It checks current Node.js 22 development/production and an actual standalone Node.js 20 installation.
The minimum-runtime image has no Git executable.
This evidence does not establish AWS IAM, physical remote hardware, Windows, or hosted CI behavior.
