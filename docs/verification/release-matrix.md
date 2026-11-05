# Workspace release verification

The release command checks the selected Git and LocalStack behavior through real storage, HTTP, installed packages, and isolated host boundaries.
It does not close the milestone by itself.
CV-28 requires fresh review and independent reproduction.

1. Select a dedicated macOS controller with Node.js 22.12 or later and Docker Desktop.
2. Install the controller dependencies described in [development](../DEVELOPMENT.md).
3. Provide Python 3.9 or later, PHP with cURL and JSON, and Composer 2.
4. Provide `/usr/local/bin/composer` for the existing installed PHP acceptance fixture.
5. Select the documented nonproduction LocalStack target and unique test prefix.
6. Run every required matrix cell.

```sh
npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks
```

The command requires all three selectors.
Unknown options, duplicate options, missing services, missing suites, and partial matrices fail.
`--require-real-s3` rejects LocalStack.
The current installed SDK and host fixtures require LocalStack, so this full runner cannot certify AWS.

## Required gates

| Gates | Required observations |
|---|---|
| Server, TypeScript SDK, MCP, both browser builds | Current source compiles before package installation |
| Release and documentation self-tests | Failures, empty reports, skipped assertions, missing coverage, and deadlines remain failures |
| Core and contracts | Application, control, HTTP, revisions, security, submissions, legacy unit and integration checks |
| Git and S3 adapters | Actual immutable revisions and sealed upload behavior |
| Production S3 without Git | Normal installed production dependencies and Node20 entrypoint; actual binary finalize, reopen, and abort |
| Revisions on S3 | History, restore, bundles, clone, and tombstone checks supplement the Git core gate |
| Public lifecycle, both backends | Separate HTTP client, exact bytes, deletion, restart, reopen, and abort isolation |
| Recovery and compatibility, both backends | Current authority, stale fences, idempotency, outbox, GC races, and supported legacy contracts |
| Physical server faults, both backends | Five actual `SIGKILL` boundaries, exact durable outcomes, and revoked authority |
| Host matrix, both backends | Three installed SDKs across workers, containers, and separate-machine simulations |
| CLI and launchers, both backends | Installed executable, foreground agent, minimum Node18 client, Node24 example, recovery, and cleanup |
| SDK packages | Each language gate runs once and internally checks Git and S3 on its minimum runtime |
| MCP, both backends | Development, installed production, and Node20 share all complete tool definitions and lifecycle behavior |
| Executable documentation, both backends | Three installed examples and actual Postman assertions, scripts, and failure probes |
| Migration | Explicit Git-to-S3-to-Git history transfer, aliases, interruption, and cutover |

The complete matrix contains 31 sequential gates.
Vitest reports must cover every discovered required test file and every named matrix cell.
The runner also checks emitted host, MCP, documentation, and physical fault receipts.
Python and PHP gates produce JUnit reports, which the Python standard library parses.
Any nonzero exit, failed assertion, missing report, zero tests, skipped test, or absent required cell stops verification.

Physical fault evidence preserves the difference between acceptance and cleanup.
An interrupted S3 upload can leave a fenced writer uncertain and cleanup pending.
The required test checks retained data and prevents publication from changing during cleanup.
The runner does not interpret pending cleanup as failed accepted publication.

## Evidence and ownership

Each run creates a private directory with a unique identity and an ownership receipt.
The sanitized summary appears in `tests/acceptance/release-evidence.log`.
It records the command, source identity, controller versions, provider, endpoint, bucket, exact selected prefix, passed gates, and explicit exclusions.
Detailed reporter output stays in the private diagnostics directory.
Commands have bounded runtime and output.
The runner replaces selected environment secrets before writing command logs.
The CI workflow uploads only the summary.

The runner preserves `CV_TEST_S3_PREFIX` exactly.
Each fixture creates and cleans only its owned UUID child namespace.
Host and documentation receipts identify their exact `http-<UUID>/` child prefixes.
Other fixtures do not emit a complete namespace ledger.
The report states that evidence limit.
The runner never deletes a whole selected prefix or unrelated Docker resources.
After a killed or failed gate, operators inspect private diagnostics and recorded ownership before cleanup.

Package receipts distinguish the host, documentation, and MCP build recipes.
Different build recipes can produce different archive hashes from the same source.
Installed SDK language gates create their own artifacts; the host matrix supplies retained per-language package fingerprints.
The source digest covers maintained product, package, test, and documentation inputs.
Lead status and run records do not affect that digest.

## Historical HTTP scripts

The historical `tests/e2e/api.test.mjs` and `webhooks.test.mjs` scripts do not run in this matrix.
They assume implicit administrator customer selection, development defaults, and colocated sandbox paths.
Those assumptions differ from the supported [compatibility contract](../api/compatibility.md).
Their supported outcomes remain required through maintained checks.

| Historical sections | Required maintained coverage |
|---|---|
| Health, workspace creation, reads, listing, deletion, and customer denial | Public lifecycle; `tests/http/`; `tests/compat/admin.test.ts`; `tests/security/` |
| Push replacement, history, pull, rollback, and revision diffs | `tests/compat/legacy-push.test.ts`; frozen compatibility snapshots; `tests/revisions/` |
| Workspace clone and destination authorization | `tests/revisions/clone-delete.test.ts` on Git and S3 |
| Runs, sandbox capture, sequential commits, abort, and cleanup | `tests/compat/legacy-runs.test.ts`; sandbox sessions; capture recovery; installed host journeys |
| Webhook CRUD, creation and deletion delivery, event payloads, signatures, and customer isolation | `tests/acceptance/legacy-webhooks.test.ts`; compatibility representations; recovery outbox and webhook scope checks |

This exclusion does not waive the supported legacy outcomes.
The runner requires compatibility and recovery checks on both backends.

## CI controller boundary

The automatic CI workflow runs on GitHub-hosted Ubuntu for pushes and pull requests.
It validates workflow semantics with pinned actionlint, builds the server and packages, and runs the default Git tests.
The custom release-runner label is declared in `.github/actionlint.yaml`.
This automatic gate does not run the full LocalStack and Docker Desktop release matrix.

The manual workflow uses a dedicated self-hosted runner labeled `macOS`, `ARM64`, and `contextvault-docker`.
It accepts only the trusted default branch.
It grants read-only repository access and disables persisted checkout credentials and global safe-directory changes.
The pinned GitHub actions require a current runner supporting their Node24 action runtime.
Actions Runner 2.329.0 or later covers the documented checkout runtime requirement.
Controller Node remains independently selected through the runner's `PATH`.

The CI helper creates one labeled LocalStack container, network, disposable bucket, and unique test prefix.
The workflow derives its state directory from runner environment variables in its first step and persists it through `GITHUB_ENV`.
Cleanup verifies the ownership receipt and Docker labels before removing those resources.
The helper exposes the verified container endpoint and dedicated network for the existing Node20 no-Git runtime gate.
It does not restart Docker or inspect customer buckets.
The workflow definition does not prove a hosted run occurred.

Existing controller fixtures use `host.docker.internal` and Docker Desktop port forwarding.
See the official [Docker Desktop networking guidance](https://docs.docker.com/desktop/features/networking/networking-how-tos/).
The matrix proves Linux clients and a Linux API through those boundaries.
It does not certify a native Linux controller, Windows, physical remote hardware, or production AWS IAM.
