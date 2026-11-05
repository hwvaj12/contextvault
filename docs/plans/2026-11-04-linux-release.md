# GitHub-hosted Linux release checks

The user requested the existing full Git/S3/Docker release checks on GitHub-hosted Linux.
This is a bounded portability change; ContextVault storage and authorization contracts remain unchanged.

- [x] Isolate changes and preserve the original dirty checkout.
- [x] Prove the Linux controller acceptance test fails before implementing support.
- [x] Use a disposable Ubuntu24.04 runner, explicit Node runtime, and portable controller tool paths.
- [x] Replace Docker Desktop address assumptions in SDK, MCP, and isolated host fixtures.
- [x] Preserve all 31 gates, installed client minima, actual crashes, isolation assertions, and zero-skip validation.
- [x] Run actionlint, focused fixture checks, and independent source review.
- [ ] Run the complete 31-gate command on GitHub-hosted Linux with owned LocalStack cleanup.
- [ ] Retain the exact run and source identity, update verification evidence, and land reviewed changes.

The full hosted workflow is the acceptance test.
Local macOS checks validate compatibility only.
Windows, physical remote hardware, and production AWS parity remain outside this change.
