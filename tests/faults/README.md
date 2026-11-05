# Physical server crash checks

This gate kills the normal HTTP application process with `SIGKILL`.
It uses real SQLite and the selected Git or S3 adapters.
The approved release selects LocalStack for S3 verification.
Each fixture owns a private catalog and a unique child prefix under the selected nonproduction prefix.
Shared LocalStack stays running.

1. Select Node.js 22.12 or later for the controller.
2. Run every Git crash case.

```sh
CV_TEST_BACKEND=git node node_modules/vitest/vitest.mjs run tests/faults/process-kills.test.ts
```

3. Configure the explicit LocalStack target through the existing `CV_TEST_S3_*` settings.
4. Run every S3 crash case.

```sh
CV_TEST_BACKEND=s3 node node_modules/vitest/vitest.mjs run tests/faults/process-kills.test.ts
```

The suite name is `physical server crashes: <backend>`.
Each publication test uses `recovers SIGKILL at <boundary> with one authoritative publication`.
The five boundary values are `before-candidate`, `during-transfer`, `after-candidate`, `before-acceptance`, and `after-acceptance`.
The sixth test is `rejects revoked authority after SIGKILL before recovery`.

Four boundaries use the existing lifecycle hooks through test-only IPC.
The transfer case declares a 7 MiB binary file and sends its 6 MiB prefix.
Its test-only source observer pauses after the real adapter consumes those bytes.
The catalog must contain that adapter's active writer before the crash.
Independent filesystem reads verify the Git adapter's 6 MiB staging file.
Independent S3 requests verify an unfinished multipart upload, a completed 5 MiB part, and no completed object.
The retry uses the same declared file, length, digest, upload key, and submission.
An unsealed submission must fail finalization before the complete retry.
The child process exposes no crash HTTP route.
The fixture advances the injectable clock by one minute after restart and invokes normal maintenance through IPC.
This tests persisted recovery, fresh fencing, and current authority.
Scheduler startup remains a separate gate.

Every case checks the actual process exit, accepted head, revision count, publication audit, and publication outbox.
Fresh HTTP readback verifies binary bytes and complete-replacement deletion after maintenance.
Operation replay and repeated maintenance must preserve one accepted publication.
The post-acceptance case already has an accepted head before the process dies.
The transfer case has no finalizer fence until its completed retry.
The other three processing interruptions require a larger fence after recovery.

An interrupted upload can retain an uncertain writer record.
Only that identified submission may report the specific guarded collection refusal.
The test requires the retained writer identity, noncomplete cleanup, and unchanged accepted contents.
Every other maintenance error fails the test.
Eligible cleanup receives at most eight additional normal maintenance turns and must reach `complete`.
Pending, running, or failed eligible cleanup cannot pass merely because its error list is empty.
The fixture removes its owned test catalog and storage after checking this state.
This fixture disposal does not claim automatic production cleanup succeeded.

`CV_FAULT_EVIDENCE_PATH` selects an absolute private JSON output path.
The gate creates that file exclusively and fails if it already exists.
Without this setting, it writes a uniquely named ignored log beside the tests.
The schema contains `schemaVersion`, `backend`, five `cases`, and the separate `revocation` result.
Cases include actual process exits, accepted revision IDs, counts, byte digests, manifest paths, processing fences, replay IDs, and cleanup state.
Transfer evidence also records consumed bytes, writer IDs, and the independent staging-file or multipart observations.
`headBeforeKill` and `revisionCountBefore` describe the accepted baseline before the tested finalization.
Evidence excludes API keys and file contents.
These checks establish process-crash behavior, rather than hardware power-loss durability or AWS service parity.

The direct Node guard checks reject HTTP-only progress, incomplete multipart evidence, and eligible cleanup stuck without errors.
They preserve the six physical test titles used by the release runner.

```sh
node tests/faults/verification-guards.mjs
```
