# ContextVault CLI

The CLI materializes ordinary files beside your agent. ContextVault authorizes access and publishes revisions through HTTP.
Agents remain independently launched. Git and S3 use the same client commands.

Requirements: Node18 or later, a running ContextVault API, and a scoped API credential.
Install `@contextvault/cli` with the matching `@contextvault/sdk` package. Local artifacts can be installed together:
The commands below run from the consumer project directory.

```sh
npm install --ignore-scripts ./contextvault-sdk-0.1.0.tgz ./contextvault-cli-0.1.0.tgz
export PATH="$PWD/node_modules/.bin:$PATH"
export CV_API_URL=http://127.0.0.1:3000
export CV_API_KEY
mkdir -m 700 /tmp/my-contextvault-sessions
contextvault open --workspace "$WORKSPACE_ID" --state-dir /tmp/my-contextvault-sessions/task-1 \
  --agent-label my-agent --task summarize-documents --reason requested-investigation
```

Set `CV_API_KEY` through your existing credential provider. Never put its value in arguments or workspace files.
To create a workspace, replace `--workspace` with `--customer "$CUSTOMER_ID" --name investigation`.
Use `--mode read-only` for a pinned reader.

The response is one JSON object. `workspace.path` belongs to this client machine.
`workspace.privateStatePath` identifies its durable SDK journal outside submitted content.
Save the chosen `--state-dir` before opening. Its `state.json` permits recovery when opening dies before stdout.

1. Launch your agent against `workspace.path`.
2. Stop every agent writer before capturing or publishing files.
3. Submit or finalize the stopped workspace.

```sh
contextvault submit --session /tmp/my-contextvault-sessions/task-1 --writers-stopped
contextvault finalize --session /tmp/my-contextvault-sessions/task-1 --writers-stopped
contextvault cleanup --session /tmp/my-contextvault-sessions/task-1 --writers-stopped
```

`submit` captures, uploads, and seals without publication. `finalize` publishes that immutable selection.
`checkpoint` publishes and opens the next run over the same client-local directory.
`status` reads the current run; `heartbeat` renews its lease.
`abort --reason ... --writers-stopped` discards an active run without publishing its edits.
`cleanup --writers-stopped` removes local content only after a known terminal outcome.
Publication and local cleanup have separate results.

## Interruption and controller ownership

Use one controller for each session. An exclusive private marker rejects concurrent CLI invocations.
The CLI never infers controller death from a PID or elapsed time.
Ordinary errors release the marker. A killed process can leave it behind.

1. Stop every controller for the session.
2. Stop every agent writer.
3. Reconcile the original command with both assertions.

```sh
contextvault reconcile --session /tmp/my-contextvault-sessions/task-1 \
  --controllers-stopped --writers-stopped
```

`--controllers-stopped` authorizes retiring only the local controller marker. It does not reset the SDK journal, key, or capture.
`--writers-stopped` is a separate assertion about processes editing workspace files.
Never use either assertion while those processes are active.
If publication is uncertain, retain the session and reconcile. Do not automatically abort or delete files.
An access denial during reconciliation does not establish that earlier publication failed.

| Exit | Meaning |
|---|---|
|0|Success|
|1|Other failure, including an independent local cleanup failure|
|2|Invalid invocation or missing configuration|
|3|Authentication or authorization denial|
|4|Revision conflict or another local controller owns the session|
|5|Publication outcome is unknown; retain and reconcile|

Error JSON preserves the error code and available recovery identity. Credentials are redacted.
The cooperative marker is not a hostile same-user security boundary. Windows behavior is not verified.
