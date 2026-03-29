# ContextVault — Agent Guidelines

## Project Overview

ContextVault is a **multi-tenant, versioned workspace storage layer** for AI agents. Each workspace is a Git repository. Versioning is handled entirely by Git.

## Core Insight

**Don't put workspace in agent context — put it in a sandbox.**

```
Agent needs context → checkout workspace to sandbox → agent works → commit → destroy sandbox
```

This avoids context bloat and keeps agents isolated.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ContextVault                                                │
│                                                              │
│  ┌─────────────┐         ┌─────────────┐                   │
│  │  Sandboxes  │◄──────►│   Agents    │                   │
│  │  (temp)     │         │             │                   │
│  └──────┬──────┘         └─────────────┘                   │
│         │                                                   │
│         │ commit                                            │
│         ▼                                                   │
│  ┌─────────────┐                                            │
│  │ Workspaces  │  Persistent Git repos                      │
│  │             │                                            │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

## Storage Layout

```
data/
├── workspace-meta/              # JSON metadata
│   └── {id}.json
├── workspaces/                 # Persistent Git repos
│   └── {workspaceId}/
│       └── .git/
└── sandboxes/                  # Temporary sandboxes
    └── {workspaceId}/
        └── .git/
```

## Interfaces

| Interface | Use For |
|-----------|---------|
| **MCP Server** | AI agents (Claude, Codex) |
| **REST API** | Developers, webhooks, CLI |

## Workspace Operations

### Creating a Workspace
```typescript
POST /workspaces
{ customerId: "meta-profile", name: "LeBron James" }
// Creates: data/workspaces/ws_{ulid}/
```

### Sandbox Workflow
```
1. checkout_workspace(id)
   → Clones workspace to data/sandboxes/{id}/

2. Agent works in sandbox
   → Normal file operations

3. commit_workspace(id, metadata)
   → git add + commit in sandbox
   → Push to persistent workspace

4. destroy_workspace(id)
   → rm -rf data/sandboxes/{id}/
```

## Agent Workflow Example

```typescript
// Agent needs to analyze LeBron's game history

// 1. Get workspace context
const ws = await getWorkspace("ws_01HXXXXXXXX");

// 2. Checkout to sandbox
const { sandboxPath } = await checkoutWorkspace("ws_01HXXXXXXXX");
// sandboxPath = "/path/to/data/sandboxes/ws_01HXXXXXXXX"

// 3. Agent works in sandbox
// - Reads: data/sandboxes/ws_01HXXXXXXXX/games/*.json
// - Writes: data/sandboxes/ws_01HXXXXXXXX/analysis.md

// 4. Commit changes
await commitWorkspace("ws_01HXXXXXXXX", {
  agentId: "meta-profile",
  taskId: "game-analysis"
});

// 5. Clean up
await destroyWorkspace("ws_01HXXXXXXXX");
// Sandbox gone, workspace has new commit
```

## Git Storage Details

- **Commit tracking:** Git log
- **Diff:** Git diff between commits
- **Rollback:** Git revert (creates new commit)
- **Branching:** Future consideration

## Key Design Decisions

1. **Git-native** — Leverage Git's battle-tested version control
2. **Sandbox isolation** — Each agent run is isolated
3. **MCP + REST** — Both interfaces, same storage
4. **No database** — JSON metadata + Git = everything needed

## Project Structure

```
ContextVault/
├── src/
│   ├── routes/           # HTTP endpoints
│   ├── services/         # Business logic
│   └── storage/         # Git operations
├── mcp/
│   └── src/index.mjs    # MCP server
├── docs/
│   ├── ARCHITECTURE.md
│   ├── REST_API.md
│   └── STORAGE_LAYER.md
└── data/                # Workspace storage
```

## Environment Variables

```bash
CONTEXTVAULT_DATA_DIR=./data
CONTEXTVAULT_API_KEY=your-key
```
