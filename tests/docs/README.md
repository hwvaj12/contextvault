# Workspace documentation checks

`npm run test:docs -- --self-test` runs deterministic harness fixtures.
It does not prove real quickstarts, Postman behavior, or release readiness.

`npm run test:docs` requires `tests/docs/workspace-docs.json`.
CV-26 supplies this allowlist after the public API and installed clients exist.
Missing configuration fails the check.
The example below documents the format; it does not certify these future files.

```json
{
  "requiredEnvironment": ["CV_DOCS_BASE_URL", "CV_DOCS_API_KEY"],
  "markdown": ["README.md", "docs/quickstart/typescript.md"],
  "quickstarts": [
    {
      "file": "docs/quickstart/typescript.md",
      "block": "typescript-lifecycle",
      "display": "node docs/examples/typescript-lifecycle.mjs",
      "command": ["node", "${PROJECT_ROOT}/docs/examples/typescript-lifecycle.mjs"]
    }
  ],
  "postman": [
    {
      "file": "docs/ContextVault-API.postman_collection.json",
      "environment": {
        "baseUrl": "CV_DOCS_BASE_URL",
        "apiKey": "CV_DOCS_API_KEY"
      }
    }
  ]
}
```

Quickstart fences use a unique `cv-check:<block>` marker after the language.
Their exact contents must match the allowlisted `display` value.
The harness executes the declared argv with `shell: false` in an isolated temporary directory.
`${PROJECT_ROOT}` and `${WORK_DIR}` substitutions provide explicit file locations.
Each quickstart has a 30-second timeout.
Use an isolated server and disposable test credentials.

Markdown checks cover local inline links, reference links, files, and Markdown heading anchors.
They ignore code fences and external URLs.
They do not certify external URL availability.

Postman checks require a vetted Newman runtime with assertion failures, request errors, and timeouts preserved.
No Newman dependency is bundled because the current release adds Critical and High dependency advisories.
Without that runtime, full Postman verification fails explicitly.
Harness fixtures inject an executor and runtime location; they do not execute Newman.
Each request must inherit or declare a `pm.test` assertion.
The harness accepts Postman collection schema v2.1.
`baseUrl` must be explicit.
Loopback URLs are allowed for isolated test servers.
Other origins require `CV_DOCS_NONPRODUCTION_ORIGIN` to equal the exact test origin.
Response scripts may fill path and query variables after earlier requests complete.
Origin variables must resolve before execution.
The harness disables redirects and writes environment values into a private temporary file.
It removes that file after the check.

Collection scripts are trusted repository test code.
Static URL checks do not sandbox Newman scripts or their side effects.
Credentials must never appear in collection files, displayed commands, or assertions.

# Named future test gates

Named test scripts use `scripts/run-workspace-tests.mjs`.
Backend gates require `--backend git` or `--backend s3`.
SDK gates require `--language typescript`, `python`, or `php`.
Missing suites and missing runtime tools fail without running unrelated baseline tests.

Real S3 gates require `CV_TEST_S3_BUCKET`, `CV_TEST_S3_REGION`, and `CV_TEST_S3_PREFIX`.
The prefix must use `contextvault-tests/<unique-run-id>/`.
The AWS credential chain remains the adapter's responsibility.
Configuration checks do not prove that S3 access succeeds.

`npm run test:e2e` explicitly runs the existing `.mjs` HTTP scripts.
It requires `CV_TEST_API_URL` and `CV_TEST_API_KEY`.
A non-loopback server also requires the matching `CV_TEST_NONPRODUCTION_ORIGIN`.
This command does not start a server.

`npm test` excludes the separately runnable public lifecycle acceptance suite.
`npm run test:acceptance -- --backend git` runs that suite without skipping missing product behavior.
The final release runner remains a separate CV-27 deliverable.
Its missing file fails the release command.
