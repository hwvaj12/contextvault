# ContextVault

**Durable Git-backed workspace memory for AI agents.**

Every AI agent session starts from scratch. ContextVault gives agents persistent memory — versioned, diffable, and rollback-capable — without bloating context windows.

## The Problem

AI agents are stateless. They can't remember what happened in previous sessions. Prompt context is expensive and limited.

**ContextVault solution:**
```
Agent needs context → materialize workspace into sandbox → agent works → commit → destroy sandbox
```

Memory that persists. Context that travels. Git that scales.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Workspace** | Durable Git repository representing persistent memory |
| **Sandbox** | Ephemeral working directory for one agent run |
| **Run** | One agent execution with full lifecycle tracking |
| **Commit** | Versioned snapshot with audit metadata |

## How It Works

**1. Create workspace** — A durable Git repo is created at `data/workspaces/{id}.git/`

**2. Start run** — Agent checks out the workspace into an ephemeral sandbox, recording the base commit and workspace HEAD

**3. Agent works** — Agent operates on normal files in the sandbox (read, write, create, delete). No Git knowledge required.

**4. Finalize** — ContextVault detects all changes, creates a structured commit, merges to the canonical workspace, and detects any conflicts

**5. Cleanup** — Sandbox is destroyed, locks are released, workspace metadata is updated

## Features

- **Multi-tenant** — Customer-scoped with API key isolation
- **Git-native storage** — Every change is a commit. Full history, diff, rollback
- **Ephemeral sandboxes** — Agents work in temp directories, not persistent storage
- **Concurrency control** — Multiple agents safe with conflict detection
- **Run lifecycle** — Full tracking from created → merged/conflicted/failed
- **Structured commits** — Machine-readable metadata for audit trails
- **MCP server** — AI agents can use ContextVault as a tool
- **REST API** — Full API for integrations and webhooks
- **SDKs** — TypeScript, Python, and PHP official SDKs
- **Blank workspaces** — Agents decide their own file structure (no forced layout)

## Two Interfaces

| Interface | Purpose | Best For |
|-----------|---------|----------|
| **MCP Server** | AI agents (Claude, Codex) | Tool-use by agents |
| **REST API** | Developers, webhooks | Building integrations |

## Quick Start

```bash
# Install dependencies
npm install

# Start the API server
npm run dev

# In another terminal, start the MCP server
cd mcp && npm install && npm run dev
```

## API Example

```bash
# Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: your-key" \
  -d '{"customerId":"my-customer","name":"agent-memory"}'

# Start a run (creates sandbox)
curl -X POST http://localhost:3000/workspaces/{id}/runs \
  -H "X-API-Key: your-key"

# Agent works in sandbox at data/sandboxes/{workspace_id}/...

# Finalize (commit changes)
curl -X POST http://localhost:3000/runs/{run_id}/finalize \
  -H "X-API-Key: your-key"

# Sandbox auto-destroyed, workspace has new commit
```

## SDKs

```bash
# TypeScript
npm install @contextvault/sdk

# Python
pip install contextvault

# PHP
composer require contextvault/contextvault-php
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Control Plane                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │Workspace │  │   Run    │  │   Lock   │  │  Audit   │ │
│  │ Service  │  │ Service  │  │ Service  │  │  Event   │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                           │                               │
│                    Commit Gateway                           │
│                           │                               │
│              ┌────────────┴────────────┐                  │
│              │  Canonical Repo Store   │                  │
│              │  (Bare Git repos)       │                  │
│              └─────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

## Status

**v0.2** — ✅ All phases complete!

| Component | Status | Details |
|----------|--------|---------|
| Core Engine | ✅ | Run lifecycle, lock service, commit gateway, SQLite DB |
| TypeScript SDK | ✅ | Full API coverage, tested |
| Python SDK | ✅ | Full API coverage, tested |
| PHP SDK | ✅ | Full API coverage, tested |
| MCP Server | ✅ | Tools for agents |
| REST API | ✅ | Fastify + Swagger docs at /docs |
| E2E Tests | ✅ | 22/22 tests passing |
| Unit Tests | ✅ | 24/24 tests passing |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design
- [REST API Reference](docs/api/workspaces.md) — API endpoints
- [Quickstart: TypeScript](docs/quickstart/typescript.md)
- [Quickstart: Python](docs/quickstart/python.md)
- [Quickstart: PHP](docs/quickstart/php.md)
- [LangChain Integration](docs/examples/langchain/typescript.md)
- [Postman Collection](docs/ContextVault-API.postman_collection.json)

## License

MIT License — see [LICENSE](LICENSE) file.

---

**ContextVault: Memory that persists. Context that travels. Git that scales.**
