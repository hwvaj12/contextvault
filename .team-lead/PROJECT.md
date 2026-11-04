# ContextVault planning context

## Scope and checkout

The user approved the ports-and-adapters design in chat 01a1a255-17c8-7dd0-b1b7-5d4af16d854f on 2026-11-03.
The user approved execution of CV-10 through CV-28 using team-lead and subagents.
Repository: /Users/hwvaj/PhpstormProjects/contextvault.
Planning base: 7f46cd7a1aedb38a09477b9fd949bbecf35e9e61 on main.
Known origin/main: bd8e448d46077a4a102460fdb413c5f886a0e04e; the two newer commits change documentation only.
Preserve the existing sdk/python/pyproject.toml edit and Python build artifacts.
Only the lead commits reviewed item changes in the isolated integration branch.
Workers never stage, commit, or modify protected records. No remote push or deployment is authorized.

## Stack

TypeScript, Fastify, better-sqlite3, simple-git, Vitest.
Separate TypeScript, Python, PHP SDK packages and an MCP package.
Git operations currently exist outside the storage interface, including both MCP entrypoints.

## Commands

| Purpose | Command |
|---|---|
| Existing TypeScript tests | npm test |
| Server type check without output | npx tsc --noEmit |
| SDK build | npm --prefix sdk/typescript run build |
| MCP build | npm --prefix mcp run build |
| Planning validation | node /Users/hwvaj/.codex/skills/team-lead/scripts/team-lead.mjs --root /Users/hwvaj/PhpstormProjects/contextvault plan-check |

Commands above are discovered commands, not claims that they passed.
The root Vitest include pattern excludes tests/e2e/*.mjs.
New acceptance commands must be explicitly added by implementation.

## Binding design

ContextVault owns authorization, revision publication, finalize, abort, audit, and run expiry.
Git and S3 store immutable revision content behind the same contract.
A transactional catalog holds the only authoritative current revision.
Existing agents keep running in application workers, containers, local CLIs, and separate machines.
A workspace client materializes files beside each agent; AgentCore and S3 Files mounts are optional future adapters.
Repeated requests, stale revisions, revocation, cleanup failures, and interrupted finalization need explicit outcomes.

## Review checklist

Ground every current-behavior claim in source; preserve uncommitted user work.
Cover direct HTTP writes, direct Git push, sandbox commits, both MCP entrypoints, all SDKs, export/import, browser consumers, and downstream integrations.
Keep plan validation separate from implementation/runtime proof.

## Writing style

Follow the chat AGENTS instructions: plain language, sentences at most 25 words, steps at most 20 words, no full STE-compliance claim.

## Runtime evidence

The helper found an installation receipt, but native hooks/list is unavailable in this session.
Worker bindings were prepared; native hook trust remains unverified.
Hook-generated events and one worker-tool denial demonstrate activity for those observed paths only.
Hook-generated dispatch and started events were observed for the three inspection workers.
Native hook trust remains unverified because hooks/list is unavailable.
The lead relies on read-only briefs and independent source audits, and avoids duplicate automatic events.

## Execution checkout

Integration: /private/tmp/contextvault-01a1a255/integration.
Branch: codex/contextvault-completion, continuing verified commit 4df9b9360391fdd9013537b5a673dce367053f9a.
Worker worktrees live under /private/tmp/contextvault-01a1a255/.
macOS offloaded files in the Documents checkout. Preserve that checkout and all original changes.
The lead recovered committed source through Git and verified recovered PHP source against recorded hashes.
The original checkout and its Python packaging edit remain untouched.
CV-19 must preserve and carry the setuptools.build_meta correction into its isolated changes.

## Worktree runtime registry

The native runtime selects the Git common-directory root before worktree-local records.
Prepare workers with --root /Users/hwvaj/PhpstormProjects/contextvault and their explicit isolated --worktree path.
Product integration, item state, reviews, audits, and verification remain in the isolated integration checkout.
Use the integration checkout for lead-owned plan-check and status evidence.
Host HTTP listeners and Docker require authorized host execution in this sandbox.

## Baseline

The clean integration baseline passed 83 tests across nine files and npm run build.
Docker server 28.0.4, Node 24.19.0, Python 3.14.6, PHP 8.4.1, and Composer 2.8.12 are available.
The user selected LocalStack for S3 verification on 2026-11-04.
The isolated target is recorded in the integration .lead/localstack.json.
Report LocalStack evidence separately from unperformed AWS verification.
