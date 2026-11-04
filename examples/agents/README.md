# Existing agents and temporary workspaces

ContextVault owns access, publication, finalize, abort, and audit. The owner launches the existing agent.
Agents read and write ordinary client-local files. Git and S3 use the same HTTP lifecycle.
No AgentCore execution environment is required.

## Application workers

Install the matching SDK into your application's normal dependencies.
Copy `worker.cjs`, `worker.py`, or `worker.php` into that application.
Set `CV_API_URL`, `CV_API_KEY`, and either `CV_WORKSPACE_ID` or `CV_CUSTOMER_ID`.
The TypeScript and Python examples also require a new absolute `CV_STATE_DIR` with an existing private parent.
The PHP example requires an existing private `CV_LOCAL_PARENT`; its generated recovery path appears in the ready event.
Set `CV_PHP_AUTOLOAD` when Composer's autoloader is outside the PHP example's directory.

Set `AGENT_COMMAND_JSON` to the existing agent's argument array. The example runs it with the workspace as its working directory.
For example, `["/bin/sh","-c","printf 'agent result' > result.txt"]` demonstrates ordinary file access.
No shell parses the argument array in the controller.
`AGENT_ENV_NAMES` selects additional environment names from the owner process. The examples exclude ContextVault and storage credentials.
Configure model credentials through the agent owner's provider. Do not copy server storage credentials into an agent.

Use a foreground agent that exits after all its file writers stop.
The controller renews its lease while the agent runs. `CV_HEARTBEAT_SECONDS` sets the interval; choose it below the server lease duration.
The controller observes the agent's exit before finalization. A failed agent leaves its workspace available for inspection.
An uncertain publication retains the original session and capture. The examples never automatically abort that uncertainty.
Successful finalization permits local cleanup; its result remains separate from the publication receipt.
Use one controller for each session. Do not run an SDK example and CLI controller concurrently over the same journal.

## Container agents

Build the supplied Dockerfile from a minimal context containing `Dockerfile`, `worker.cjs`, and the SDK/CLI npm archives.
The client image runs the CLI by default. It contains client packages, not server source or storage credentials.

1. Configure an API-only client network.
2. Keep canonical storage on a separate network.
3. Build the client image from the supplied Dockerfile.
4. Set `CV_CLIENT_IMAGE`, `CV_CLIENT_NETWORK`, `AGENT_IMAGE`, and the scoped API environment.
5. Run `container.sh` with your existing agent command arguments.

The script mounts the private client parent into the client container.
It prints that recovery parent and a container-run label before making its first API request.
It mounts only the materialized workspace into the agent container.
Both containers use the owner's UID/GID for shared file access. The agent image must support that unprivileged foreground command.
The agent receives no ContextVault credential. The default agent network is `none`.
If the agent needs model access, supply an explicit route that keeps canonical storage unreachable.
Do not pass a Docker socket, server data volume, or storage credentials into either client or agent containers.
The script retains local recovery state when agent work or publication fails.
The owner renews the lease while the foreground container runs.
`CV_HEARTBEAT_SECONDS` sets the renewal interval below the server lease duration.
If renewal fails, the owner stops that agent container and retains recovery state.

## Separate machines

Install a matching SDK or CLI on the agent machine. Configure only its authenticated API origin and scoped credential.
Materialize the workspace on that machine's own disk. A path returned there does not exist beside a remote caller.
Use HTTPS outside isolated local tests and configure network policy so the agent cannot reach canonical storage directly.
Preserve local recovery state across process restarts. Reconcile the original command before deciding whether to abort or clean up.

## Verification

```sh
npm run test:hosts -- --backend git
npm run test:hosts -- --backend s3 --s3-provider localstack
```

The gates install actual npm, wheel, and Composer artifacts.
Each SDK runs in a native worker, a shared-volume container, and an isolated remote-container boundary.
Every cell kills a controller after an accepted response is truncated, then resumes the original command and verifies binary bytes and deletions.
Container cells check mount inventories, an inaccessible host sentinel, and relay destination rejection.
S3 container cells also prove direct storage-IP denial and actual host-endpoint denial.
Native worker and CLI cells cooperate within the host user account; they do not prove hostile same-user isolation.
Remote cells prove container/filesystem/network boundaries. They do not claim physical remote hardware or production AWS IAM verification.
The test controller requires Node22+, Docker, Python3 with venv, PHP8+, and Composer2. Client minimum versions are reported separately.
For mapped LocalStack, set `CV_TEST_S3_CONTAINER` if its container differs from `cv-localstack-01a1a255`.
