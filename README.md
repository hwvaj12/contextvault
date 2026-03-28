# ContextVault

**Multi-tenant, versioned workspace layer for AI agent memory.**

Agents push/pull execution state to customer-scoped workspaces — enabling durable context, full audit trails, and LLM-native file storage.

## Quick Start

```bash
npm install
npm run dev
```

No external dependencies required — ContextVault uses SQLite (via better-sqlite3) for metadata storage. The database file is auto-created at `data/contextvault.db` on first run.

## What is this?

ContextVault solves the problem of stateless AI agents. Every session starts from scratch, losing context, artifacts, and work history.

ContextVault provides:
- **Workspaces** — customer-scoped, isolated storage namespaces
- **Push** — agents push execution state as versioned commits
- **Pull** — agents pull latest (or specific) state to restore context
- **History** — full audit trail of all commits
- **Diff/Rollback** — compare and revert to previous versions

## Status

v0.1 — Prototype in progress
