# ContextVault — Architecture

> **Versioned storage for AI agents with sandboxed execution.**

## Overview

ContextVault is a Git-native, multi-tenant workspace storage layer. It provides versioned, persistent storage for AI agents without bloating agent context.

## Core Insight

**Don't put workspace in context — put workspace in a sandbox.**

```
Agent needs context → pull workspace to sandbox → agent works in filesystem → commit changes → destroy sandbox
```

This avoids:
- **Context bloat** — full workspace in context = expensive
- **Disk pollution** — agent leaves files everywhere
- **State leakage** — next agent sees previous agent's work

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Consumer (e.g., MetaProfile)                              │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐ │
│  │  Sandbox    │    │   Agent     │    │   MCP Client    │ │
│  │  Manager    │◄──►│  (Claude,   │◄──►│   (connects to  │ │
│  │             │    │  Codex...)  │    │   ContextVault)  │ │
│  └──────┬──────┘    └─────────────┘    └────────┬────────┘ │
│         │                                        │          │
│         │ file ops                   MCP protocol │          │
└─────────┼────────────────────────────────────────┼──────────┘
          │                                        ▼
          │                         ┌────────────────────────┐
          │                         │  ContextVault MCP      │
          │                         │  Server                │
          │                         │                        │
          │                         │  • create_workspace    │
          │                         │  • checkout_workspace  │
          │                         │  • commit_workspace   │
          │                         │  • destroy_workspace  │
          │                         │  • pull / push        │
          │                         └───────────┬────────────┘
          │                                     │
          │         ┌───────────────────────────┘
          │         │
          ▼         ▼
┌─────────────────────────────────────────────────────────────┐
│  ContextVault Storage (Git-native)                          │
│                                                             │
│  data/                                                      │
│  └── workspaces/                                            │
│      └── {workspaceId}/                                     │
│          └── .git/ (persistent, versioned)                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Sandbox Model

### Lifecycle

```
1. CREATE SANDBOX
   Consumer → checkout_workspace(workspaceId)
              → clones workspace to temp directory
              → returns sandbox path

2. AGENT WORKS
   Agent reads/writes files in sandbox
   (normal filesystem operations)

3. COMMIT CHANGES
   Consumer → commit_workspace(workspaceId)
              → git add + commit in sandbox
              → push to persistent storage
              → returns new commit hash

4. DESTROY SANDBOX
   Consumer → destroy_workspace(workspaceId)
              → rm -rf temp directory
              → workspace persists in ContextVault
```

### Sandbox Location

```
/tmp/contextvault-sandbox/{workspaceId}/
```

Sandboxes are:
- **Temporary** — destroyed after commit
- **Isolated** — each workspace gets its own directory
- **Clean** — always start fresh from latest commit

## MCP Tools

### Workspace Management
| Tool | Description |
|------|-------------|
| `create_workspace` | Create new workspace |
| `list_workspaces` | List all workspaces |
| `get_workspace` | Get workspace metadata |
| `delete_workspace` | Soft-delete workspace |

### Sandbox Operations
| Tool | Description |
|------|-------------|
| `checkout_workspace` | Pull workspace to sandbox, return path |
| `commit_workspace` | Commit sandbox changes to ContextVault |
| `destroy_workspace` | Destroy sandbox, keep persistent storage |
| `get_sandbox_status` | Check if sandbox exists |

### Version Control
| Tool | Description |
|------|-------------|
| `push_to_workspace` | Direct push (skip sandbox) |
| `pull_from_workspace` | Direct pull (skip sandbox) |
| `get_workspace_history` | Get commit history |
| `diff_workspace` | Compare two versions |
| `rollback_workspace` | Rollback to previous version |

## Workspace Structure

Each workspace is a Git repository:

```
workspace/
├── .git/
├── profile/
│   └── summary.md
├── games/
│   ├── 2024_001.json
│   └── 2024_001.md
└── ...
```

## Commit Message Format

```
agent: {agentId} | task: {taskId} | tags: {tag1,tag2}
---
{"agentId":"...","taskId":"...","files":["summary.md"],"sizeBytes":1024}
```

## Storage Backend

Currently: Local filesystem Git repos
```
data/workspaces/{workspaceId}/.git
```

Future: S3-backed, GitHub-backed, etc.

## Authentication

API Key via `X-API-Key` header or MCP configuration.

## Environment Variables

```bash
CONTEXTVAULT_DATA_DIR=./data          # Where workspaces are stored
CONTEXTVAULT_SANDBOX_DIR=/tmp/contextvault-sandbox  # Where sandboxes live
CONTEXTVAULT_API_PORT=3000            # HTTP API port
```
