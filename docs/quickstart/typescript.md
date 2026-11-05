# TypeScript client quickstart

The `@contextvault/sdk` package requires Node.js 18 or later.
It uses authenticated HTTP and creates a new workspace directory on the client host.

## Install

1. Build or obtain `contextvault-sdk-0.1.0.tgz` from the repository package.
2. Install that archive in a separate consumer project.

```sh
npm install --ignore-scripts /absolute/artifacts/contextvault-sdk-0.1.0.tgz
```

3. Configure the API origin, scoped credential, and customer through your environment.

The [common quickstart](clients.md) provides the exact environment names and runnable example.
Registry publication is not required by this installation procedure.

## Open, write, and finalize

```typescript
import { ContextVaultClient } from "@contextvault/sdk";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const cv = new ContextVaultClient({
  baseUrl: process.env.CV_API_URL!,
  apiKey: process.env.CV_API_KEY!,
});
const session = await cv.openWorkspace({
  create: { customerId: process.env.CV_CUSTOMER_ID!, name: "client-example" },
  mode: "read-write",
  agentLabel: "existing-agent",
  task: "Write the requested result",
  reason: "Nonproduction example",
});
const recoveryPath = session.privateStatePath;
await writeFile(join(session.path, "result.bin"), Buffer.from([0, 255, 128]));
// Stop every agent writer before this call.
const operation = await session.finalize({ writersStopped: true });
await session.cleanup({ writersStopped: true });
```

`session.path` belongs to the client host.
`privateStatePath` identifies recovery state outside submitted content.
An application should save that identity before launching agent work.
A supplied `stateDirectory` selects a new private session directory under an existing safe parent.

For an existing workspace, replace `create` with `workspaceId`.
For a pinned reader, select `mode:"read-only"`.
`session.heartbeat()` renews an active run lease.
The application schedules renewals and owns agent shutdown.

## Recover an uncertain command

```typescript
const recovered = await cv.resumeWorkspace(savedPrivateStatePath);
await recovered.reconcile({ writersStopped: true });
```

Resumption uses current credentials and the same server origin.
It preserves the original request, idempotency key, and immutable capture.
A later authorization denial does not prove that the original publication failed.

`checkpoint` publishes and opens the next run over the same local directory.
An incomplete reopen preserves `published-needs-reopen` progress.
`abort` discards a known active run; cleanup removes local files only after a known terminal outcome.

Run the maintained [installed example](clients.md#run-the-installed-client-examples) for executable lifecycle checks.
See the [SDK reference](../../sdk/typescript/README.md#open-a-durable-local-workspace) for exact options and recovery APIs.
