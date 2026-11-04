# CV-10 first independent code review

Verdict: does-not-ship as a frozen foundation.

Six contract defects require correction before downstream work starts.

1. Persist selected submission and manifest digest in finalization intent.
2. Persist workspace creation intent before preparing initial storage, then accept creation atomically.
3. Persist pending client command keys and exact input before dispatch, including before operation IDs exist.
4. Add active-run expiry scanning and atomic expiry transitions.
5. Resolve public run/operation IDs through scoped catalog methods, with explicit administrator policy.
6. Give client materialization public run identity without internal binding IDs.

The reviewer inspected the stable 42-file combined snapshot and did not change files.
The lead independently passed 146 normal tests, 63 focused contract tests, 11 harness self-tests, and the server build.
The contract tests are included in the normal test count.
The outer public HTTP lifecycle remains intentionally red at the absent v1 route.
These checks do not establish feature implementation, S3 behavior, or host compatibility.
