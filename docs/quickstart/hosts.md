# Agent environments

ContextVault supplies authenticated workspace access and authoritative publication.
Your existing application or host executes the agent.
The same HTTP lifecycle works with Git and S3 storage bindings.

## Choose the boundary

| Environment | Workspace location | Owner responsibilities |
|---|---|---|
| Application worker | Local directory beside the worker | Schedule heartbeat, stop writers, preserve journal, supply host isolation |
| Container agent | Private writable client volume or materialized workspace mount | Separate credentials, networks, volumes, and agent process |
| Local CLI | Directory returned in command JSON on that machine | Retain session path, coordinate one controller, inspect exit codes |
| Separate machine | Agent machine's own filesystem | Reach authenticated API, preserve local state, use TLS and network policy |

The [supplied launchers](../../examples/agents/README.md) cover worker and container integration.
They launch existing foreground commands rather than introducing an agent runtime dependency.

## Application workers

1. Install the matching SDK in the application's dependencies.
2. Copy the supplied language-specific worker launcher into the application.
3. Configure its scoped API environment and new private session location.
4. Set `AGENT_COMMAND_JSON` to the existing foreground agent's argument array.
5. Launch the worker and retain its recovery event with the external job.

TypeScript and Python launchers require a new absolute `CV_STATE_DIR` under an existing private parent.
PHP uses an existing private `CV_LOCAL_PARENT` and reports its generated recovery path.
`CV_PHP_AUTOLOAD` selects an external Composer autoloader when needed.

The launcher renews the lease while the agent runs and waits for the agent's writers to exit before publication.
`CV_HEARTBEAT_SECONDS` must remain below the service's lease duration.
A failed agent or uncertain command preserves local work for inspection and reconciliation.
`AGENT_ENV_NAMES` selects extra owner-provided environment names without forwarding ContextVault or storage credentials.

Native workers share their host user's authority.
Their cooperative controller checks do not isolate hostile same-user processes.

## Container agents

1. Build the supplied client image from its minimal documented build context.
2. Create an API-only client network separate from canonical storage.
3. Configure `CV_CLIENT_IMAGE`, `CV_CLIENT_NETWORK`, `AGENT_IMAGE`, and the scoped API environment.
4. Run the supplied `container.sh` with the existing agent command arguments.

The client image contains installed client artifacts.
The script mounts the private client parent into the client container and only the materialized workspace into the agent container.
The agent receives no ContextVault credential.
The default agent network is `none`.
An agent requiring model access needs an explicit route that keeps canonical storage unreachable.

The owner keeps the Docker socket outside both containers.
The script reports the recovery parent before its first API command and retains it on failure.
Shared file access uses the owner's UID/GID; the chosen agent image must support that unprivileged foreground command.

## Local CLI

The [consumer quickstart](clients.md) installs matching SDK and CLI archives in a separate project.
Local installation provides `./node_modules/.bin/contextvault`.
The following commands use that consumer project as their working directory.

1. Enter the consumer project containing the installed SDK and CLI.

```sh
cd /absolute/contextvault-consumer
```

2. Create a private parent directory for the new session.

```sh
mkdir -m 700 /absolute/private/sessions
```

3. Open a run with a saved `--state-dir`.

```sh
./node_modules/.bin/contextvault open --workspace "$WORKSPACE_ID" --state-dir /absolute/private/sessions/task-1 \
  --agent-label existing-agent --task requested-work --reason authorized-request
```

4. Launch the existing agent against `workspace.path` from the returned JSON.
5. Stop every writer before submission or finalization.
6. Finalize the stopped workspace.

```sh
./node_modules/.bin/contextvault finalize --session /absolute/private/sessions/task-1 --writers-stopped
```

7. Inspect the authoritative terminal outcome.
8. Clean the owned local workspace explicitly.

```sh
./node_modules/.bin/contextvault cleanup --session /absolute/private/sessions/task-1 --writers-stopped
```

After a controller crash:

1. Stop every controller for the session.
2. Stop every agent writer.
3. Reconcile the original command with both assertions.

```sh
./node_modules/.bin/contextvault reconcile --session /absolute/private/sessions/task-1 \
  --controllers-stopped --writers-stopped
```

These flags assert owner preconditions; they do not stop processes themselves.
The [CLI reference](../../cli/README.md) lists commands, JSON behavior, and exit codes.

## Separate machines and MCP

A separate machine installs its own matching SDK or CLI and materializes files on its own disk.
It needs only its authenticated API origin and scoped credential.
A path returned by another host is not a path on the agent machine.

MCP `access:local` returns paths on the MCP host.
MCP `access:remote` returns an opaque handle for bounded file tools.
Use remote handles when the caller cannot access that host filesystem.
See the [MCP guide](../../mcp/README.md) for configuration and controller recovery.

## Verification boundary

The host matrix exercises three installed SDKs across native workers, writable-volume containers, and isolated Docker remote-machine boundaries on both backends.
It checks actual binary contents, deletion, killed-controller recovery, finalize, abort, and cleanup.
Container checks inspect mounts and networks and deny direct canonical-storage access.

This evidence proves the tested Docker boundaries.
It does not prove physical remote hardware, Windows, production AWS IAM, or hostile same-user isolation.
See [verification commands](../DEVELOPMENT.md#verification).
