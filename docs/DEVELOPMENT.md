# Development and verification

The service uses TypeScript, Fastify, native `better-sqlite3`, Git, and a transactional SQLite catalog.
Separate packages provide installed TypeScript, Python, PHP, CLI, and MCP clients.

## Prerequisites

The current service and test controller are verified on Node.js 22.
Use Node.js 22.12 or a later Node.js 22 release for the repository's test toolchain.
Native SQLite dependencies must match the selected Node ABI.
Use the project's lockfiles when installing dependencies.

Host and package checks also require Docker, Git, Python, PHP, cURL support, Composer, and the selected S3 service.
The observed local controller uses Python 3.9.6, PHP 8.4.1, and Composer 2.8.12.
Actual minimum client containers use Node18, Python3.8, and PHP8.0.
Those client minima do not lower the service test-controller requirement.

On the maintained macOS environment, this PATH selects the verified tools:

```sh
export PATH=/usr/local/bin:/Users/hwvaj/.config/herd-lite/bin:$PATH
```

Other hosts must select their own equivalent executable locations.
Avoid reusing native dependencies installed under another Node major version.

## Start an isolated service

Run these commands from the repository root.
Use a new private directory, rather than an existing customer data directory.

1. Install the locked service dependencies.

```sh
npm ci
```

The native SQLite package requires its installation build step or a matching prebuilt binary.
This differs from the Postman tooling installation, which disables install scripts.

2. Configure an absolute private data path.

```sh
export CV_DATA_DIR=/absolute/private/contextvault-development
export CV_STORAGE_BACKEND=git
export HOST=127.0.0.1
export PORT=3000
```

3. Load a private administrator key through your credential provider.

```sh
export CONTEXTVAULT_API_KEY
```

4. Build the service.

```sh
npm run build
```

5. Start the compiled service.

```sh
npm start
```

6. Read the public health endpoint.

```sh
curl http://127.0.0.1:3000/health
```

The interactive API description is at `/docs`.
Create a customer-scoped credential through `/api-keys` before running client examples.
The [HTTP reference](REST_API.md#authentication-and-command-identity) describes that boundary.
`npm run dev` loads `.env` through `dotenv-cli`; use current variables from [storage configuration](STORAGE_LAYER.md).

## Client and MCP development

1. Install the TypeScript SDK's locked build dependencies.

```sh
npm --prefix sdk/typescript ci --ignore-scripts
```

2. Build the TypeScript SDK.

```sh
npm --prefix sdk/typescript run build
```

3. Install the MCP package's locked dependencies.

```sh
npm --prefix mcp ci --ignore-scripts
```

4. Build the MCP package.

```sh
npm --prefix mcp run build
```

MCP development requires its declared development dependencies.
Production packaging includes its pinned SDK archive and installed runtime dependency.
See [client artifact installation](quickstart/clients.md) and the [MCP package guide](../mcp/README.md).

## Selected LocalStack target

S3 gates require an explicit nonproduction provider, bucket, region, prefix, and endpoint.
The test prefix must match `contextvault-tests/<unique-run-id>/`.
The harness creates child prefixes and cleans only its owned data.
A missing target fails the gate; Git is not a fallback for a selected S3 check.

```sh
export CV_TEST_S3_PROVIDER=localstack
export CV_TEST_S3_BUCKET=your-test-bucket
export CV_TEST_S3_REGION=us-east-1
export CV_TEST_S3_PREFIX=contextvault-tests/your-unique-run-id/
export CV_TEST_S3_ENDPOINT=http://127.0.0.1:4566
export CV_TEST_S3_CONTAINER=your-localstack-container
```

These are examples, not the current private execution target.
The host-boundary fixture also needs an explicitly mapped LocalStack container and dedicated backend network.
`CV_TEST_S3_CONTAINER` selects that container explicitly.
The fixture selects its dedicated backend network through the `contextvault-s3` alias or its sole attached network.
The default Docker bridge, host network, and none network are unsuitable backend networks.

LocalStack profiles use dummy credentials and block inherited AWS credential selection.
The optional `--require-real-s3` gate requires AWS and rejects emulator targets.
LocalStack verification does not establish AWS IAM, KMS, or production networking behavior.

## Verification

| Purpose | Command |
|---|---|
| Default server and domain tests | `npm test` |
| Service compilation | `npm run build` |
| Shared contracts | `npm run test:contracts` |
| Git adapter | `npm run test:adapters -- --backend git` |
| LocalStack S3 adapter | `npm run test:adapters -- --backend s3 --s3-provider localstack` |
| Public lifecycle | `npm run test:acceptance -- --backend git` |
| Installed host matrix | `npm run test:hosts -- --backend git` |
| Installed S3 host matrix | `npm run test:hosts -- --backend s3 --s3-provider localstack` |
| TypeScript SDK | `npm run test:sdk -- --language typescript` |
| Python SDK | `npm run test:sdk -- --language python` |
| PHP SDK | `npm run test:sdk -- --language php` |
| MCP | `npm run test:mcp` |
| Legacy compatibility | `npm run test:legacy` |
| Recovery and collection | `npm run test:recovery` |
| Migration | `npm run test:migration` |
| Documentation harness fixtures | `npm run test:docs -- --self-test` |
| Real Git documentation examples | `npm run test:docs -- --backend git` |
| Real S3 documentation examples | `npm run test:docs -- --backend s3 --s3-provider localstack` |

`npm test` excludes separately selected acceptance, installed SDK, host, MCP, migration, and S3 adapter suites.
The root runner explicitly selects these suites.
A missing suite or tool cannot become an unrelated baseline pass.

Each language SDK gate exercises both Git and S3 internally.
Every SDK gate therefore requires the selected nonproduction S3 target.
For MCP, compatibility, and recovery checks, `CV_TEST_BACKEND=s3` selects their S3 fixture profile.
Migration tests require the selected S3 target and exercise both stores.
The explicit LocalStack settings above provide that target.

Python SDK controller setup uses a private environment with the declared test requirements.

1. Create the Python controller environment.

```sh
/usr/bin/python3 -m venv sdk/python/.test-env
```

2. Install its declared test requirements.

```sh
sdk/python/.test-env/bin/python -m pip install -r tests/sdk/python/requirements.txt
```

3. Run the Python SDK gate through that environment.

```sh
PATH="$PWD/sdk/python/.test-env/bin:$PATH" npm run test:sdk -- --language python
```

PHP checks require the package's installed PHPUnit runner and Composer dependencies.

1. Install the PHP package's development dependencies.

```sh
composer --working-dir=sdk/php install --no-interaction --no-scripts --no-plugins
```

2. Run the PHP SDK gate.

```sh
npm run test:sdk -- --language php
```

Installed SDK checks build package artifacts and execute actual supported client runtimes.
Host checks require their official runtime images or permission to obtain the required images during setup.
Their test execution does not grant agents storage credentials or server-volume access.

The documentation harness runs actual installed examples and the pinned official Postman CLI.
Its selftests alone do not prove the public quickstarts or Postman scripts.
See [documentation harness setup](../tests/docs/README.md) for its isolated runtime prerequisites.

## Release closure

```sh
npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks
```

Release closure requires every selected backend, package, host, compatibility, migration, documentation, and fault condition.
Missing services, host capacity, required suites, or runtime tools prevent closure.
A skipped or unavailable required cell is incomplete verification.
A source review, compilation, or mock executor test cannot replace runtime evidence.

The current verification boundary includes local Git, selected LocalStack, and isolated Docker client environments.
Physical remote hardware, Windows, AWS IAM, and hosted CI need their own recorded evidence.
Preserve failed runs and distinguish their causes from later successful checks.

## Troubleshooting

| Symptom | Investigation |
|---|---|
| Native SQLite load failure | Check the active Node ABI and rebuild locked native dependencies |
| Original storage profile unavailable | Restore the retained profile; changing the default does not migrate bindings |
| Unknown command outcome | Retain private state and reconcile the original command |
| `REVISION_CONFLICT` | Inspect the accepted head and resolve the application's competing work |
| Cleanup failure | Inspect its separate ownership and cleanup state |
| Migration blocked | Inspect active runs, source pins, history compatibility, and the recorded claim |
| Missing Docker or S3 target | Restore required capacity; preserve the failed gate |

Inspect catalog-backed status and durable operation results before investigating backend files.
Manual Git refs, JSON workspace metadata, or S3 listings do not establish current authority.
