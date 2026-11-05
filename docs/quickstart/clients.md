# Installed client quickstart

These examples use ordinary client-local files and the authenticated HTTP lifecycle.
ContextVault controls publication; your application owns agent execution.
The examples create disposable workspaces and publish test contents under the selected customer.

## Produce local artifacts

Artifact producers use an isolated checkout of the reviewed ContextVault revision.
The commands write build outputs in that checkout and a new private artifact directory.
The original checkout, existing client sessions, and customer data remain outside this procedure.
Both selected absolute paths need safe existing parents.
The artifact directory must not already exist.

1. Select the isolated checkout containing the reviewed source.

```sh
export CV_DOC_SOURCE=/absolute/private/contextvault-build
```

2. Choose the new artifact directory.

```sh
export CV_DOC_ARTIFACTS=/absolute/artifacts
```

3. Create that private directory.

```sh
mkdir -m 700 "$CV_DOC_ARTIFACTS"
```

4. Verify the selected Node.js 22 producer runtime.

```sh
node --version
```

5. Install locked TypeScript SDK build dependencies in the isolated checkout.

```sh
npm --prefix "$CV_DOC_SOURCE/sdk/typescript" ci --ignore-scripts
```

6. Compile the TypeScript SDK.

```sh
npm --prefix "$CV_DOC_SOURCE/sdk/typescript" run build
```

7. Pack the compiled SDK into the artifact directory.

```sh
npm pack --ignore-scripts --pack-destination "$CV_DOC_ARTIFACTS" "$CV_DOC_SOURCE/sdk/typescript"
```

8. Pack the matching CLI beside the SDK archive.

```sh
npm pack --ignore-scripts --pack-destination "$CV_DOC_ARTIFACTS" "$CV_DOC_SOURCE/cli"
```

9. Select a Python interpreter compatible with the declared build requirements.

```sh
export CV_DOC_PYTHON=/usr/bin/python3
```

10. Create a private Python producer environment.

```sh
"$CV_DOC_PYTHON" -m venv "$CV_DOC_ARTIFACTS/python-builder"
```

11. Install the repository's declared Python build requirements.

```sh
"$CV_DOC_ARTIFACTS/python-builder/bin/python" -m pip install -r "$CV_DOC_SOURCE/tests/sdk/python/requirements.txt"
```

12. Build the Python wheel into the artifact directory.

```sh
"$CV_DOC_ARTIFACTS/python-builder/bin/python" -m build --wheel --no-isolation --outdir "$CV_DOC_ARTIFACTS" "$CV_DOC_SOURCE/sdk/python"
```

13. Pack the PHP metadata and source into the Composer artifact.

```sh
COPYFILE_DISABLE=1 tar -czf "$CV_DOC_ARTIFACTS/contextvault-php.tar.gz" -C "$CV_DOC_SOURCE/sdk/php" composer.json src
```

The outputs are `contextvault-sdk-0.1.0.tgz`, `contextvault-cli-0.1.0.tgz`, `contextvault-0.2.0-py3-none-any.whl`, and `contextvault-php.tar.gz`.
The verified local Python controller uses `/usr/bin/python3`; other hosts select their own compatible interpreter.
The Python producer environment is staging tooling; consumers install the wheel into their own environment.
The PHP archive matches the [local Composer package definition](php.md#install-a-local-composer-artifact).
These commands create local artifacts without publishing them.

## Prepare a consumer

This walkthrough requires a nonproduction API and customer.
Obtain matching local artifacts using the [producer procedure](#produce-local-artifacts) or a maintainer.
The TypeScript SDK and CLI artifacts are `contextvault-sdk-0.1.0.tgz` and `contextvault-cli-0.1.0.tgz`.
The Python artifact is `contextvault-0.2.0-py3-none-any.whl`.
PHP installation uses a local Composer package artifact described in the [PHP guide](php.md#install-a-local-composer-artifact).

1. Create a separate consumer directory.

```sh
mkdir -p /absolute/contextvault-consumer
```

2. Enter that directory.

```sh
cd /absolute/contextvault-consumer
```

3. Configure the nonproduction API origin and matching customer ID.

```sh
export CV_API_URL=http://127.0.0.1:3000
export CV_CUSTOMER_ID=your-nonproduction-customer
```

4. Load the scoped customer credential through your credential provider.

```sh
export CV_API_KEY
```

The credential must authorize the selected customer and lifecycle actions.
Keep credentials outside workspace files and command arguments.
The service operator's administrator key and storage credentials stay with the service.

## Install the clients

1. Install the TypeScript SDK and matching CLI archives.

```sh
npm install --ignore-scripts /absolute/artifacts/contextvault-sdk-0.1.0.tgz /absolute/artifacts/contextvault-cli-0.1.0.tgz
```

2. Create a Python virtual environment.

```sh
python3 -m venv .venv
```

3. Install the Python wheel.

```sh
.venv/bin/python -m pip install /absolute/artifacts/contextvault-0.2.0-py3-none-any.whl
```

4. Activate that environment before running the Python example.

```sh
. .venv/bin/activate
```

5. Install the PHP artifact using the [local Composer recipe](php.md#install-a-local-composer-artifact).

The SDK resolves from the consumer's installed dependencies.
The examples do not import server source or a repository-local SDK shim.
Node18, Python3.8, and PHP8.0 are the declared client minima.
Local Python materialization requires the documented POSIX primitives.

## Run the installed client examples

1. Create the example directory inside the consumer.

```sh
mkdir -p docs/examples
```

2. Copy the maintained example files into that directory.

```sh
cp /absolute/ContextVault/docs/examples/typescript-lifecycle.mjs /absolute/ContextVault/docs/examples/python-lifecycle.py /absolute/ContextVault/docs/examples/php-lifecycle.php docs/examples/
```

3. Run the TypeScript client example from the consumer directory.

```sh cv-check:typescript-lifecycle
node docs/examples/typescript-lifecycle.mjs
```

4. Run the Python client example from the consumer directory.

```sh cv-check:python-lifecycle
python3 docs/examples/python-lifecycle.py
```

5. Run the PHP client example from the consumer directory.

```sh cv-check:php-lifecycle
php docs/examples/php-lifecycle.php
```

Each example uses `CV_API_URL`, `CV_API_KEY`, and `CV_CUSTOMER_ID`.
TypeScript resolves `node_modules`, Python uses its active environment, and PHP loads `vendor/autoload.php` from the consumer.
The documentation harness uses the same layout and displayed commands in private consumer directories.

Successful publication and local cleanup have separate results.
A failed or interrupted command can retain private state for reconciliation.
Keep that state when the remote outcome remains unknown.

## Use an existing agent

1. Open a workspace using the installed client.
2. Save its private recovery identity with your external job record.
3. Launch your existing agent against the returned local path.
4. Schedule heartbeat while the agent works.
5. Stop every writer before checkpoint or finalization.
6. Inspect the authoritative outcome before explicit cleanup.

Use a read-only run for pinned readers.
Abort a known active run when the caller chooses to discard its edits.
Reconcile uncertain finalization before deciding whether to abort or clean up.

See the [TypeScript](typescript.md), [Python](python.md), and [PHP](php.md) guides for language-specific APIs.
See [agent environments](hosts.md) for workers, containers, CLI sessions, and separate-machine deployment.
