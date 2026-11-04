# CV-29 runtime dependency verification

The clean baseline audit reported 17 advisories: one Critical, ten High, and six Moderate findings.
The update uses selected patched dependencies and compatible transitive updates.
It does not run broad `npm audit fix` or install global tooling.

## Changes

- Update simple-git to 4.0.2, Fastify to 5.12.8, and Zod to 4.6.7.
- Update the compatible Swagger plugins and fast-uri dependency.
- Pin the patched static-file dependency to 10.1.3 within Swagger UI's supported range.
- Update Vitest to 4.1.12 and affected compatible development dependencies.
- Convert seven root-package imports to simple-git's named export.
- Preserve every existing integration-test assertion.

The [simple-git release notes](https://github.com/steveukx/git-js/releases) document removal of its default export.
The [Fastify advisory](https://github.com/advisories/GHSA-p68q-wchp-6fh7) identifies the malformed-URL fallback bypass.
The [fast-uri advisory](https://github.com/advisories/GHSA-qw65-cvwx-89v3) identifies port-component authority injection.

## Regression evidence

Before updates, the Git guard test accepted command-bearing inline configuration.
The benign `git version` probe did not execute the configured helper.
The malformed public URL reached a private fallback and returned 200.
The updated libraries reject both cases.
An independent baseline dependency copy also failed the URI port-injection assertion.
The updated dependency rejects that invalid port while preserving a normal numeric port.

The first malformed-URL fixture used an asynchronous fallback and timed out.
The corrected fixture sends its response explicitly and reproduces the actual 200 disclosure.
Only the corrected assertion counts as vulnerability evidence.

## Independent installation evidence

The lead created a separate review checkout and ran a clean `npm ci`.
That checkout passed 153 tests across 16 files, including three security regressions.
Focused contracts passed 67 tests; the build and whitespace checks passed.
The full audit and production audit report no High or Critical findings.
Fresh analyst review and final closure checking remain separate gates.

Six Moderate dependency findings remain in the full audit.
Four affect the production static-file dependency chain; two additional findings affect development cleanup dependencies.
They involve glob, minimatch, Swagger static files, rimraf, and ts-node-dev.
The audit reports no compatible complete fix for these chains.
This evidence does not claim a vulnerability-free dependency tree.

The installed static plugin uses its fixed glob only when `wildcard: false`.
The existing application does not supply user-controlled patterns or cancellation signals to that traversal.
This observation does not remove the advisory or prove every future configuration safe.

The default npm update planner crashed while resolving optional development-tool peers.
A temporary npm 11.19.0 CLI completed the selected updates without changing global configuration.
The ordinary npm CLI then completed the clean lockfile installation and verification.
The [npm issue](https://github.com/npm/cli/issues/9787) describes this optional-peer planning failure.

The MCP package has a separate dependency graph.
CV-22 must verify and repair that graph independently.

## Node 20 compatibility correction

Fresh review found that the latest static-file dependency required Node 22 through content-disposition 3.
The existing development guide permits Node 20.
The old review snapshot failed an engine-strict production installation in Node 20 with `EBADENGINE`.
The final pin uses the latest compatible static release, 10.1.3, with content-disposition 2.0.1.
That pin includes the 10.1.1 and 10.1.2 static-path fixes and stays within Swagger UI's declared dependency range.
The production audit still reports zero High or Critical findings.

An isolated Node 20.20.2 container completed `npm ci --omit=dev --engine-strict` against the final lockfile.
The normal application factory constructed successfully with the installed Linux SQLite dependency.
Health, documentation, and a documentation CSS asset returned 200.
An unauthenticated workspace request returned 401.
The container was removed after verification.

The final review snapshot then passed a fresh ordinary `npm ci`, 153 tests, 67 focused contracts, and the build.
Raw logs are retained locally under `.lead/cv29-evidence/`.
They include the Node 20 before/after checks, clean installation, tests, contracts, build, and audit JSON.

The reviewer also found an [upstream Moderate case-fold advisory](https://github.com/fastify/fastify-static/security/advisories/GHSA-r799-r9gc-m956).
It affects static versions before 10.1.4 and was absent from the observed npm audit output.
The current application serves only public bundled Swagger assets through this plugin.
It supplies no `allowedPath` policy or guarded private subtree to the plugin.
Review established no current application exploit for that advisory.
Workspace bytes must continue through authorized application routes, rather than this public static plugin.
The pin preserves Node 20 support; it does not claim every upstream Moderate advisory is patched.
