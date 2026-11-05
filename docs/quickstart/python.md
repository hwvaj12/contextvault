# Python client quickstart

The installed `contextvault` wheel requires Python 3.8 or later and `requests>=2.20,<3`.
Local workspace materialization requires POSIX primitives, including `O_NOFOLLOW`, directory fsync, and `flock`.

## Install

1. Create a private consumer virtual environment.

```sh
python3 -m venv .venv
```

2. Install the repository-built wheel.

```sh
.venv/bin/python -m pip install /absolute/artifacts/contextvault-0.2.0-py3-none-any.whl
```

3. Activate that environment.

```sh
. .venv/bin/activate
```

4. Configure the environment described in the [common quickstart](clients.md).

Installed code imports `contextvault`.
The repository-local `src` compatibility shim is excluded from the wheel.
Registry publication is separate from local installation.

## Open, write, and finalize

```python
import os
from pathlib import Path
from contextvault import Client

cv = Client(
    api_key=os.environ["CV_API_KEY"],
    base_url=os.environ["CV_API_URL"],
)
handle = cv.create_workspace(
    os.environ["CV_CUSTOMER_ID"],
    "client-example",
    agent_label="existing-agent",
    task="Write the requested result",
    reason="Nonproduction example",
)
recovery_path = handle.private_state_path
Path(handle.path, "result.bin").write_bytes(bytes([0, 255, 128]))
# Stop every agent writer before this call.
operation = handle.finalize(writers_stopped=True)
handle.cleanup(writers_stopped=True)
cv.close()
```

`handle.path` is an absolute path on the client host.
Private state stays outside submitted content and excludes API credentials.
A chosen `private_state_path` must not exist; its parent must already exist safely.
The application should retain that identity in its external job record.

`cv.open_workspace(workspace_id, **options)` opens an existing workspace.
`mode="read-only"` selects a pinned reader without a submission.
`handle.heartbeat()` provides explicit lease renewal.

## Recovery and cleanup

1. Stop every competing controller for the retained session.
2. Stop every agent writer using its local workspace.
3. Resume the retained identity with current credentials.

```python
recovery_client = Client(
    api_key=os.environ["CV_API_KEY"],
    base_url=os.environ["CV_API_URL"],
)
recovered = recovery_client.resume_workspace(saved_private_state_path)
operation = recovered.reconcile()
recovery_client.close()
```

A fresh process supplies current credentials and the original server origin.
Reconciliation uses the original request, key, and captured bytes.
It does not automatically retry mutations with a fresh identity.

`checkpoint` publishes one run and opens the next over the same local path.
An incomplete reopen retains `published-needs-reopen` progress and the accepted publication receipt.
A generic exception or access denial does not authorize abort or deletion.

Abort applies to a known active run.
Cleanup requires a known terminal outcome and caller-stopped writers.
Closing the client only closes HTTP connections.

Run the maintained [installed example](clients.md#run-the-installed-client-examples) for executable lifecycle checks.
See the [SDK reference](../../sdk/python/README.md#local-workspace-lifecycle) for durable provisioning and client-specific abandonment rules.
