# ContextVault workspace implementation verification

Date: 2026-11-04, America/Chicago.
Status: verified locally.
Later [GitHub-hosted Linux verification](hosted-linux-release.md) is recorded separately.
Branch: `codex/contextvault-completion`.
Tested product commit: `b38c51264ac352a0a3ed76fcdc85956e48584dba`.
Planning baseline: `7f46cd7a1aedb38a09477b9fd949bbecf35e9e61`.

ContextVault owns access checks, accepted revisions, finalize, abort, and recovery.
Git and S3 store content through interchangeable ports.
Existing agents use temporary files beside their existing processes.

## Independent release result

A fresh checker ran every required gate from a clean checkout.
The command exited 0: **31 of 31 gates passed, with zero skipped tests**.
Build commands have no assertion count.
Executable documentation receipts separately record their runtime assertions.

```sh
npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks
```

| Gate | Reported tests | Result |
|---|---:|---|
| server-build | Command / runtime receipt | Passed |
| typescript-build | Command / runtime receipt | Passed |
| mcp-build | Command / runtime receipt | Passed |
| vault-browser-build | Command / runtime receipt | Passed |
| secondary-ui-build | Command / runtime receipt | Passed |
| no-git-s3 | 1 | Passed |
| release-selftests | 36 | Passed |
| docs-selftests | 45 | Passed |
| core | 299 | Passed |
| contracts | 74 | Passed |
| revisions-s3 | 25 | Passed |
| adapters-git | 26 | Passed |
| acceptance-git | 2 | Passed |
| recovery-git | 45 | Passed |
| legacy-git | 34 | Passed |
| mcp-git | 22 | Passed |
| faults-git | 6 | Passed |
| hosts-git | 44 | Passed |
| docs-git | Command / runtime receipt | Passed |
| adapters-s3 | 32 | Passed |
| acceptance-s3 | 2 | Passed |
| recovery-s3 | 45 | Passed |
| legacy-s3 | 34 | Passed |
| mcp-s3 | 22 | Passed |
| faults-s3 | 6 | Passed |
| hosts-s3 | 44 | Passed |
| docs-s3 | Command / runtime receipt | Passed |
| sdk-typescript | 43 | Passed |
| sdk-python | 62 | Passed |
| sdk-php | 4 | Passed |
| migration | 35 | Passed |

## Acceptance outcomes

| ID | Required outcome | Result |
|---|---|---|
| A01 | HTTP lifecycle, exact bytes, deletion, restart and reopen | Passed |
| A02 | Abort, expiry and accepted-content preservation | Passed |
| A03 | Competing publication, stale bases and expired fences | Passed |
| A04 | Idempotent retries and lost responses | Passed |
| A05 | Customer scope, revocation, destination authority and webhooks | Passed |
| A06 | Canonical manifests, binary integrity, safe paths and streaming | Passed |
| A07 | Git/S3 history, restore, bundles and no-change publication | Passed |
| A08 | Workers, containers, CLI and remote-machine boundaries | Passed |
| A09 | Installed SDK packages and MCP entrypoint parity | Passed |
| A10 | Supported legacy behavior and truthful browser representations | Passed |
| A11 | Inventory, interrupted migration, aliases, cutover and reverse migration | Passed |
| A12 | Crash recovery, outbox, cleanup failures and collection races | Passed |

## Environment and boundary evidence

The controller used macOS ARM64, Node 22.12.0, Docker 28.0.4, Python 3.9.6, and PHP 8.4.1.
S3 checks used the selected LocalStack 4.14.0 service and dummy credentials.
The selected test prefix remained unchanged.

All 18 language/backend/host cells passed.
Minimum container clients used Node 18.20.8, Python 3.8.20, and PHP 8.0.30.
Separate CLI and supplied-launcher checks also passed.
Worker checks use cooperating host processes.
Container and remote-machine checks prove Linux filesystem and network boundaries through isolated Docker environments.

The production Node20 S3 server installed normal production dependencies and ran without Git.
MCP development, production, and minimum-runtime entrypoints matched all 29 complete tool definitions.
Both schema digests equal `8dcc8117b8e92d747df1b7824a13211b96d8fd0491f2db2fb1c96680ef34abe9`.
Each documentation backend verified 89 links, three installed examples, and an actual Postman run containing 22 requests and 45 assertions.

Five physical server-kill boundaries passed on each backend, plus current-revocation recovery checks.
During-transfer cases retain one identified uncertain writer and report failed cleanup on each backend.
They prevent unsafe collection and preserve the accepted outcome.
These cases do not prove automatic production cleanup after an uncertain writer.
Other eligible physical-fault cleanup completed.

The lead used actual browsers against built interfaces and an owned normal Git HTTP fixture.
Both readers identified base64 binary content; ordinary text remained readable.
The vault diff identified binary changes while preserving text diffs.
Both owned browser test services were disposed.

## Repairs and review

CV-34 binds deletion cleanup to its exact status operation without collecting accepted history.
CV-35 recovers interrupted MCP markers and safe initialization while preserving uncertain journals and current authority.
CV-36 closes Python capture output when source open fails.
CV-37 carries binary representation information into both browser readers and the vault diff.

The first full release attempt correctly failed because two S3 compatibility cases skipped Git-only assertions.
Both cases now assert explicit unsupported-protocol responses on S3.
The final compatibility gates pass 34 tests per backend, with zero skips.
The release now requires both browser builds; CI installs both locked browser dependency trees.

Fresh whole-changeset source review found no unresolved confirmed defect or unreviewed source gap.
Security and direct simplification reviews completed.
Production dependency audits returned zero advisories for the server, MCP, and both browsers.
The dependency correction preserves actual Node20 production compatibility.

## Exact evidence and preservation

Maintained-source digest: `731d107f6f1ea0158a4faad927b2980490fc6a6fbdd61a8a5e2dda8404d1b1a3`, covering 521 files.
All 561 tracked files, modes, HEAD, and index remained unchanged in the independent checkout.
The lead independently recomputed the same maintained-source digest in the integration checkout.
Final closure commits change documentation and records only.

Release receipt SHA-256: `34a7b8089c402a9fb185cbaae168b9942b9a977119997fd74a5b04878034fbcc`.
Independent closure receipt SHA-256: `6e0f897a2469c929ee7cbd681829b80c5fab60a97610396ca30996e0fc64a438`.
Local receipts are retained at `tests/acceptance/release-evidence.log` and `.lead/cv28-independent-closure.json` in the integration checkout.
Raw diagnostics remain in the private `cv-release-rZMjMr` directory recorded by the closure receipt.
These generated local receipts are not tracked source.

The checker verified that all 12 named API containers and 12 networks were absent.
Eleven emitted S3 child prefixes contained zero objects and multipart uploads.
Some fixtures do not emit a complete namespace ledger.
The lead then removed only the exact owned LocalStack container and its session-labeled network.
No Docker restart or prune occurred during final verification.

The original checkout remains at `7f46cd7a1aedb38a09477b9fd949bbecf35e9e61`.
Its existing `.gitignore`, Python packaging edit, and untracked build artifacts remain present.
The user’s `build-backend = "setuptools.build_meta"` correction remains preserved.

## Explicit exclusions

This run does not establish production AWS behavior or IAM, Windows, physical remote hardware, hosted CI, or a native Linux release controller.
The remote-machine fixtures use separate Linux containers and isolated networks.
Historical ad-hoc `tests/e2e/api.test.mjs` and `webhooks.test.mjs` remain unrun.
Their supported outcomes remain required through maintained HTTP, compatibility, revision, and security gates.
The release matrix document records that mapping.

Native hook trust was unavailable for direct inspection.
Prepared bindings, observed guards, source audits, and independent checks supplied the recorded verification evidence.
Unavailable telemetry remains unavailable.
