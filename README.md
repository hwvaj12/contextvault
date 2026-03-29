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

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Create workspace (durable Git repo)                         │
│     → data/workspaces/{id}.git/                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Start run (agent execution)                                 │
│     → Checkout workspace to sandbox                              │
│     → Record base commit + workspace HEAD                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Agent works in sandbox                                      │
│     → Normal file operations (read, write, create, delete)       │
│     → No Git knowledge required                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Finalize run (commit changes)                               │
│     → Detect file changes (added, modified, deleted)              │
│     → Create structured commit with metadata                     │
│     → Merge to canonical workspace                              │
│     → Detect conflicts if concurrent                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Cleanup                                                     │
│     → Destroy sandbox                                           │
│     → Release locks                                             │
│     → Update workspace metadata                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Multi-tenant** — Customer-scoped with API key isolation
- **Git-native storage** — Every change is a commit. Full history, diff, rollback
- **Ephemeral sandboxes** — Agents work in temp directories, not persistent storage
- **Concurrency control** — Multiple agents safe with conflict detection
- **Run lifecycle** — Full tracking from created → merged/conflicted/failed
- **Structured commits** — Machine-readable metadata for audit trails
- **Default workspace layout** — Pre-seeded directories for organization

## Two Interfaces

| Interface | Purpose | Best For |
|-----------|---------|----------|
| **MCP Server** | AI agents (Claude, Codex) | Tool-use by agents |
| **REST API** | Developers, webhooks | Building integrations |

## Quick Start

```bash
# API server
npm install
npm run dev

# MCP server (separate terminal)
cd mcp && npm install && npm run dev
```

## API Example

```bash
# Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: your-key" \
  -d '{"customerId":"meta-profile","name":"LeBron James"}'

# Start run (checkout to sandbox)
curl -X POST http://localhost:3000/workspaces/{id}/runs

# Agent works in /tmp/contextvault/runs/{run_id}/workspace/...

# Finalize (commit changes)
curl -X POST http://localhost:3000/runs/{run_id}/finalize

# Sandbox auto-destroyed, workspace has new commit
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

## Default Workspace Layout

```
/
├── profile/
│   ├── summary.md          # Human-readable summary
│   └── facts.json          # Structured facts
├── memory/
│   ├── timeline.md         # Chronological events
│   └── known_entities.json
├── state/
│   ├── current.json
│   └── preferences.json
├── tasks/
│   ├── open.yaml
│   └── completed.yaml
├── decisions/
├── artifacts/
├── logs/
└── system/
    └── workspace_manifest.yaml
```

## Status

**v0.1** — MVP with sandbox workflow
**v0.2** (in progress) — Full run lifecycle, concurrency, SQLite DB

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design
- [REST API](docs/REST_API.md) — API reference
- [Storage Layer](docs/STORAGE_LAYER.md) — Git storage details
- [Multi-Tenant Storage](docs/MULTITENANT_STORAGE.md) — S3 design
- [Gap Analysis](docs/GAP_ANALYSIS.md) — Implementation roadmap

## GitHub

https://github.com/hwvaj12/contextvault

---

**ContextVault: Memory that persists. Context that travels. Git that scales.**
