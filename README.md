# ContextVault

**Multi-tenant, versioned workspace layer for AI agent memory — powered by Git.**

Agents push/pull execution state to customer-scoped workspaces. Every version is a Git commit. Full audit trail, diff, and rollback — built on battle-tested Git.

## Quick Start

```bash
npm install
npm run dev        # API at localhost:3000
```

No external dependencies required. Each workspace is a local Git repository. The database is just JSON metadata.

## What is this?

ContextVault solves the problem of stateless AI agents. Every session starts from scratch, losing context, artifacts, and work history.

**The insight:** Git is the perfect versioned storage for AI agents. It's distributed, handles deltas, has battle-tested diff/merge/rollback, and agents already understand Git.

ContextVault provides:
- **Workspaces** — customer-scoped, isolated storage namespaces
- **Push** — agents push execution state as Git commits
- **Pull** — agents pull latest (or specific) state to restore context
- **History** — full audit trail via `git log`
- **Diff/Rollback** — compare and revert using native Git operations

## Architecture

```
data/
├── workspace-meta/              # JSON: customerId, name, timestamps
└── workspaces/
    └── {workspaceId}/           # One Git repo per workspace
        └── .git/               # Actual Git repository
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/workspaces` | Create workspace (git init) |
| GET | `/workspaces` | List all workspaces |
| GET | `/workspaces/:id` | Get workspace metadata |
| DELETE | `/workspaces/:id` | Soft-delete workspace |
| POST | `/workspaces/:id/push` | Push files (git add + commit) |
| GET | `/workspaces/:id/pull` | Pull latest state (git checkout) |
| GET | `/workspaces/:id/pull?v=hash` | Pull specific version |
| GET | `/workspaces/:id/history` | Commit history (git log) |
| GET | `/workspaces/:id/diff` | Compare versions (git diff) |
| POST | `/workspaces/:id/rollback` | Revert to version (git revert) |

All endpoints require `X-API-Key` header.

## Status

v0.1 — Prototype in progress
- ✅ Git-native storage (simple-git)
- ✅ Workspace CRUD
- ✅ Push/Pull operations
- ✅ History/Diff/Rollback
- 🚧 Git clone via protocol (git-upload-pack)
- 📋 Web UI for browsing repos
