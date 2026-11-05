# Workspace documentation checks

The full gate starts a private Linux API and disposable scoped tenants.
It executes the published TypeScript, Python, and PHP examples from separate consumer directories.
Each consumer installs its SDK artifact and uses ordinary local files.
Independent HTTP reads verify binary bytes, deletions, abort isolation, and the accepted workspace version.

1. Install root Node dependencies and the TypeScript SDK compiler dependencies.
2. Select Node.js 22.12 or later for the test controller.
3. Provide Python 3.9 or later, PHP with cURL, and Composer.
4. Start Docker and pull `node:22-bookworm-slim` and `python:3.8-slim`.
5. Run the deterministic harness self-tests.

```sh
npm run test:docs -- --self-test
```

6. Run the complete Git documentation gate.

```sh
npm run test:docs -- --backend git
```

Without arguments, the command selects Git and starts its own isolated fixture.
S3 requires an explicit selected nonproduction target.

7. Start the LocalStack service and create its disposable bucket.
8. Set `CV_TEST_S3_PROVIDER`, `CV_TEST_S3_BUCKET`, `CV_TEST_S3_REGION`, `CV_TEST_S3_PREFIX`, and `CV_TEST_S3_ENDPOINT`.
9. Set `CV_TEST_S3_CONTAINER` when its container name differs from the configured fixture default.
10. Run the complete LocalStack documentation gate.

```sh
npm run test:docs -- --backend s3 --s3-provider localstack
```

The prefix must match `contextvault-tests/<unique-run-id>/`.
The controller verifies the selected mapped endpoint and dedicated backend network.
LocalStack uses synthetic `test` credentials; client processes receive scoped API credentials.
See [development](../../docs/DEVELOPMENT.md) for the other release prerequisites.

## Maintained checks

`workspace-docs.json` lists every maintained Markdown target and three exact `cv-check` command blocks.
The harness checks local links and anchors before running those displayed relative commands.
Inline code spans open and close on one physical line.
Multiline examples use fenced code blocks.
The checker validates links between unmatched backticks on different lines.
Setup copies each script into the consumer directory and installs its package outside the repository.
Each example invocation has a 30-second limit; package setup has separate bounded timeouts.
External URL availability remains outside the local link check.

The official Postman CLI is pinned in `tooling/package-lock.json`.
Its image builds from four explicit inputs and a digest-addressed Node base.
Installation scripts stay disabled, including its global agent-instruction hook.
Build setup downloads packages; collection execution uses an owned internal network with the API.
The runtime mounts one private working directory and receives no account profiles or canonical storage credentials.
Its `--no-report-events` option disables report dispatch.
Network-free runtime probes use their own loopback fixture.

The collection runs real prerequest and response scripts through the official engine.
The gate rejects nonzero exits, transport or script failures, skipped assertions, zero coverage, missing reports, and wall-timeout kills.
Eight actual runtime probes verify those outcomes, including cases where the CLI itself exits successfully.
Private environment and raw report files disappear after each run.
The final sanitized `verification-<backend>.log` records counts, versions, artifact hashes, and boundary evidence.
The npm audit covers the wrapper dependency tree; it does not inventory the embedded binary.

## Component development

`components.test.mts` exercises installed examples and the collection while narrative drafts remain separate.
It uses temporary Markdown fixtures and therefore cannot certify published guidance.
The normal `npm run test:docs` command always runs the published-guide gate and actual runtime probes.
Missing tools, selected storage, documents, or required assertions fail that command.

```sh
node node_modules/vitest/vitest.mjs run tests/docs/components.test.mts --config tests/docs/vitest.config.mjs
```

## Other gates

Named backend, SDK, MCP, migration, recovery, and release commands remain separate.
Documentation checks establish the selected local Git and LocalStack behavior.
Physical remote hardware, other operating systems, actual AWS, and hosted CI require their own evidence.
