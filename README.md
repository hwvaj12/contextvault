# ContextVault

**Git-native virtual filesystem for AI agents.** Every workspace is a Git repository. Agents work in sandboxes, committing changes that persist forever.

## The Problem

AI agents are stateless. Every conversation starts from scratch. Memory, context, and work history — gone.

**ContextVault gives agents a persistent memory layer built on Git.**

## Why Git?

Git is the perfect storage layer for AI agents:

- **Versioned** — Every change is a commit. Full history, instant rollback.
- **Distributed** — Each workspace is a full Git repo. No single point of failure.
- **Delta-efficient** — Only changes are stored, not full copies.
- **Battle-tested** — Git handles billions of commits. Your data is safe.
- **Agent-native** — Agents already understand files and Git. No new mental models.

## How It Works

```
You → ContextVault → Workspace (Git repo)
                    ↘ Sandbox (temp clone)
```

1. **Create a workspace** — A new Git repository, customer-scoped
2. **Checkout to sandbox** — Clone the workspace to a temp directory
3. **Agent works** — Reads and writes files normally
4. **Commit changes** — Changes are committed back to the workspace
5. **Destroy sandbox** — Temp directory is cleaned up

The workspace persists forever. The sandbox is ephemeral.

## Virtual Filesystem Model

**Don't push workspace into agent context — pull workspace into a sandbox.**

Agents don't need to understand Git or serialization. They just work with files:

```
Agent sees:    /sandbox/ws_01HXXXXXXXX/profile/summary.md
               /sandbox/ws_01HXXXXXXXX/games/2024_001.json
               /sandbox/ws_01HXXXXXXXX/analysis/shooting.md

Behind scenes: Git commits in data/workspaces/ws_01HXXXXXXXX/.git/
```

No context bloat. No serialization overhead. Pure filesystem semantics.

## Two Interfaces

| Interface | Purpose | Best For |
|-----------|---------|----------|
| **MCP Server** | AI agent tool | Claude, Codex, any MCP client |
| **REST API** | Developer access | Webhooks, CLI, integrations |

Both use the same Git storage underneath.

## Quick Start

```bash
npm install
npm run dev        # API at localhost:3000
cd mcp && npm install && npm run dev  # MCP on stdio
```

## API Example

```bash
# Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: your-key" \
  -d '{"customerId":"meta-profile","name":"LeBron James"}'

# Checkout to sandbox (get a temp directory to work in)
curl -X POST http://localhost:3000/workspaces/{id}/sandbox \
  -H "X-API-Key: your-key"

# Agent works in /tmp/contextvault-sandbox/{id}/...

# Commit changes (persist to Git)
curl -X POST http://localhost:3000/workspaces/{id}/sandbox/commit \
  -H "X-API-Key: your-key"

# Destroy sandbox (cleanup)
curl -X DELETE http://localhost:3000/workspaces/{id}/sandbox \
  -H "X-API-Key: your-key"
```

## MCP Tools

```typescript
// Agent workflow
await checkout_workspace({ workspaceId: "ws_01HXXXXXXXX" })
// → { sandboxPath: "/tmp/contextvault-sandbox/ws_01HXXXXXXXX" }

// Agent reads/writes files in sandboxPath...

await commit_workspace({ 
  workspaceId: "ws_01HXXXXXXXX",
  agentId: "my-agent",
  taskId: "analysis-001"
})
// → { commitId: "abc123", filesChanged: ["profile/summary.md"] }

await destroy_workspace({ workspaceId: "ws_01HXXXXXXXX" })
// → { success: true }
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ContextVault                                                │
│                                                              │
│  ┌─────────────┐         ┌─────────────┐                   │
│  │  Sandboxes  │◄──────►│   Agents    │                   │
│  │  (temp)     │         │  (ephemeral)│                   │
│  └──────┬──────┘         └─────────────┘                   │
│         │ commit                                          │
│         ▼                                                   │
│  ┌─────────────┐                                            │
│  │ Workspaces  │  Persistent Git repos                      │
│  └─────────────┘  (forever)                                │
└─────────────────────────────────────────────────────────────┘
```

Storage layout:
```
data/
├── workspace-meta/              # JSON metadata
├── workspaces/                  # Persistent Git repos
│   └── {workspaceId}/.git/
└── sandboxes/                  # Temp sandboxes
    └── {workspaceId}/          # git clone target
```

## Use Cases

- **Agent Memory** — Give agents persistent context across sessions
- **Athlete Profiles** — Store game history, stats, recaps per athlete
- **Team Workspaces** — Shared context for team AI assistants
- **Research** — Versioned research artifacts and findings
- **Any AI Workflow** — Anywhere you need memory that persists

## Status

v0.1 — MVP complete ✅

- ✅ Git-native storage with full version control
- ✅ Workspace CRUD with customer scoping
- ✅ Sandbox workflow (checkout → work → commit → destroy)
- ✅ MCP server for AI agents
- ✅ REST API for developers
- ✅ Push/Pull/History/Diff/Rollback

---

**ContextVault: Memory that persists. Context that travels. Git that scales.**
