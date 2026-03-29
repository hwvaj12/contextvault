# ContextVault PM Tracker

## Status: ACTIVE — Full steam ahead

**PM:** AI (OpenClaw)
**Owner:** Houa Vang
**Started:** 2026-03-29
**Repo:** https://github.com/hwvaj12/contextvault

---

## Vision

ContextVault is a multi-tenant, versioned workspace storage layer for AI agents. The goal is to make it trivial for developers to integrate durable, Git-backed agent memory into any application.

**Mission:** Ship a complete, documented SDK ecosystem that makes ContextVault the default choice for AI agent memory.

---

## Phases

### ✅ Phase 0-4: Core Engine (COMPLETE as of 2026-03-28)
- v0.2 complete
- 24 tests passing
- Run lifecycle, lock service, commit gateway, SQLite DB, MCP + REST API

### 🔴 Phase 5: SDK Completion (IN PROGRESS)
**Priority: HIGH** — Without SDKs, developers hand-roll HTTP calls. Bad DX kills adoption.

- [x] **TypeScript SDK** ✅ COMPLETE (2026-03-29)
  - [x] Client class with API key handling
  - [x] Workspaces class: create, list, get, delete
  - [x] Sandbox methods: checkout, commit, destroy
  - [x] Pull methods: pull, getFile, history
  - [x] Typed errors (NotFoundError, AuthError, etc.)
  - [x] Auto-retry logic
  - [x] Build passes
  - [x] Integration test passes (all 8 endpoints verified)

- [ ] **Python SDK** (🔄 IN PROGRESS - agent running)
  - [ ] Fix wrong API paths
  - [ ] Match TypeScript SDK signatures
  - [ ] Complete pyproject.toml
  - [ ] README with quickstart
  - [ ] Integration test

- [ ] **PHP SDK** (🔄 IN PROGRESS - agent running)
  - [ ] Fix wrong API paths
  - [ ] Match TypeScript SDK signatures
  - [ ] Complete composer.json
  - [ ] README with quickstart

### 🟡 Phase 6: DX & Documentation
**Priority: HIGH** — Docs are the product experience for SDK users.

- [ ] Complete quickstart guides (scaffolded in docs/quickstart/)
- [ ] LangChain integration examples (started in docs/examples/)
- [ ] Interactive API docs (Swagger UI live at /docs)
- [ ] Postman/Insomnia collection

### 🟡 Phase 7: E2E + Observability
**Priority: MEDIUM**

- [ ] End-to-end lifecycle test (create ws → run → commit → verify)
- [ ] Structured logging for key events
- [ ] Basic metrics tracking

### 🟡 Phase 8: Production Hardening
**Priority: MEDIUM**

- [ ] API versioning strategy
- [ ] Rate limiting
- [ ] S3 backend abstraction layer
- [ ] Pagination for list endpoints

---

## Current Work

### TypeScript SDK (Phase 5, Task 1 of N)

**Agent:** Claude Code (background)
**Started:** 2026-03-29
**Task:** Build complete TypeScript SDK in sdk/typescript/

**Context for agent:**
- REST API base: http://localhost:3000
- API key auth: X-API-Key header
- Key endpoints:
  - POST /workspaces → create
  - GET /workspaces → list
  - GET /workspaces/:id → get
  - DELETE /workspaces/:id → delete
  - POST /workspaces/:id/runs → start run
  - GET /runs/:id → get run
  - POST /runs/:id/finalize → commit
  - POST /runs/:id/abort → abort
  - GET /workspaces/:id/sandbox → sandbox status
  - DELETE /workspaces/:id/sandbox → destroy sandbox
  - POST /workspaces/:id/checkout → checkout to sandbox
  - GET /workspaces/:id/pull → pull latest
  - GET /workspaces/:id/history → commit history
  - GET /workspaces/:id/diff?from=&to= → diff

---

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SDK order | TypeScript first | Primary language, most users |
| Error handling | Typed error classes | Clear, actionable errors |
| Auth | X-API-Key header | Already implemented in API |
| Retry | Exponential backoff | Network resilience |

---

## Metrics

| Metric | Value | Date |
|--------|-------|------|
| Tests | 24 passing | 2026-03-28 |
| Core features | 100% | 2026-03-28 |
| TypeScript SDK | 0% | 2026-03-29 |
| Python SDK | 0% | 2026-03-29 |
| PHP SDK | 0% | 2026-03-29 |

---

_Last updated: 2026-03-29_
