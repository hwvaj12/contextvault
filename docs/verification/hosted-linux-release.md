# GitHub-hosted Linux release verification

Date: 2026-11-05.
Status: passed on GitHub-hosted Ubuntu24.04 x64.
[Full release run](https://github.com/hwvaj12/contextvault/actions/runs/41982371448).
[Automatic CI](https://github.com/hwvaj12/contextvault/actions/runs/41982367978): 484 tests passed across 90 files.

The manual **Workspace contract release** workflow uses a disposable GitHub-hosted Linux VM.
No dedicated macOS or self-hosted runner is required.

```sh
gh workflow run workspace-contract.yml --repo hwvaj12/contextvault --ref main
```

## Verified result

All 31 required gates passed with zero skipped tests.
The runner checked unchanged HEAD, maintained file paths, bytes, and modes after every gate and at completion.
The artifact upload and owned LocalStack cleanup steps also succeeded.
The full command was:

```sh
npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks
```

| Coverage | Observed result |
|---|---|
| Builds | Server, TypeScript SDK, MCP, and both browser packages passed |
| Production S3 without Git | Actual Node20, installed production dependencies, binary round trip, finalize, and abort passed |
| Release and documentation guards | 38 and 45 tests passed |
| Core, contracts, S3 revisions | 299, 74, and 25 tests passed |
| Git / S3 adapters | 26 / 32 tests passed |
| Git / S3 public lifecycle | 2 / 2 tests passed |
| Git / S3 recovery | 45 / 45 tests passed |
| Git / S3 legacy compatibility | 34 / 34 tests passed |
| Git / S3 MCP | 22 / 22 tests passed; all 29 complete schemas matched across three entrypoints |
| Git / S3 physical faults | 6 / 6 tests passed, including actual SIGKILL and revoked authority |
| Git / S3 host matrix | 44 / 44 tests passed; all 18 language/environment/backend cells completed |
| Executable documentation, each backend | Three installed examples and actual Postman: 22 requests, 45 assertions |
| Installed TypeScript / Python / PHP | 43 / 62 / 4 tests passed on minimum client runtimes, covering both backends |
| Migration | 35 tests passed, including Git-to-S3-to-Git transfer and interruption |

The agent matrix covers TypeScript, Python, and PHP across workers, containers, and separate-machine simulations on both backends.
Local CLI, minimum Node18 clients, Node20 MCP, Python3.8, PHP8.0, and the Node24 launcher remain required.
Isolated agents retain direct API routing and cannot access canonical storage or the controller filesystem.
Workers retain cooperative host-process separation.

## Source and controller

Tested source: `2df2e382282facadcc6fa684f9d3e803f769922f`.
Maintained source: 524 files, SHA-256 `67718a950f076c9f5fded712a7b7b86f96053ab71c52a51421f63e3aa0790c4b`.
Sanitized receipt SHA-256: `e75bc2b0d0346f6e98f671424d83473191dc24e26916b6813b7bbe7267b89e0c`.
The landing commit adds verification documentation after this tested source.

Controller: Linux/x64, Node22.12.0, Docker Engine28.0.4, Python3.12.3, PHP8.3.6.
The owned fixture uses the LocalStack4.14.0 image, a dedicated network, a disposable bucket, and an exact unique test prefix.
The workflow uses dummy test credentials and uploads only the sanitized summary.
Cleanup verifies the ownership receipt and resource labels before deletion.

## Retained failures and corrections

[First attempt](https://github.com/hwvaj12/contextvault/actions/runs/41977063999) passed 27 gates and failed the installed TypeScript SDK gate.
A native Linux reproduction demonstrated root-owned output that the controller user could not remove.
Matching container UID/GID and writable npm cache paths fixed that defect without loosening private permissions.

[Second attempt](https://github.com/hwvaj12/contextvault/actions/runs/41978912221) passed all 31 runtime gates and failed final source integrity.
That run did not retain changed filenames; a Linux-cache reproduction exposed Python bytecode output in source.
The fix prevents bytecode writes and checks source after every gate, with bounded changed-path diagnostics on failure.
The final run passed every gate and every source check.

Production AWS/IAM parity, Windows, and physical remote hardware remain outside this evidence.
The [earlier macOS verification](workspace-release.md) remains a separate historical record.
