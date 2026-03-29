# ContextVault — Storage Layer

> **Storage Architecture — Updated 2026-03-28**

## Overview

ContextVault uses **Git-native storage** with a **sandbox model** for agent execution.

```
┌─────────────────────────────────────────────────────────────┐
│  ContextVault                                                │
│                                                              │
│  ┌─────────────┐         ┌─────────────┐                   │
│  │  Sandboxes  │◄───────►│   Agents    │                   │
│  │  (temp)     │          │             │                   │
│  └──────┬──────┘          └─────────────┘                   │
│         │                                                   │
│         │ commit                                            │
│         ▼                                                   │
│  ┌─────────────┐                                            │
│  │ Workspaces  │  (persistent Git repos)                   │
│  │             │                                            │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

## Storage Layout

```
data/
├── workspace-meta/              # Workspace metadata (JSON)
│   └── {workspaceId}.json
├── workspaces/                 # Persistent Git repos (source of truth)
│   └── {workspaceId}/
│       └── .git/
└── sandboxes/                   # Temporary agent workspaces
    └── {workspaceId}/          # Clone of workspace
        └── .git/
```

## Sandbox Model

### Lifecycle

```
1. CHECKOUT
   Source: data/workspaces/{id}/.git
   Dest:   data/sandboxes/{id}/
   Action: git clone (or git init + pull)
   Result: Agent can read/write files

2. AGENT EXECUTES
   Agent works in data/sandboxes/{id}/
   Normal filesystem operations
   No impact on persistent storage

3. COMMIT
   Source: data/sandboxes/{id}/
   Dest:   data/workspaces/{id}/
   Action: git add + git commit + git push
   Result: Changes persisted to workspace

4. DESTROY
   Target: data/sandboxes/{id}/
   Action: rm -rf
   Result: Sandbox removed, workspace intact
```

### Why Sandboxes?

| Without Sandbox | With Sandbox |
|----------------|-------------|
| Agent works directly in workspace | Agent works in temp clone |
| No isolation between agents | Full isolation |
| Failed run corrupts history | Failed run = discard sandbox |
| Agent must understand Git | Agent sees normal files |
| No room for experimentation | Agent can try anything |

## Git Operations

### Workspace (Persistent)

```typescript
// Create workspace
git init data/workspaces/{id}/
git config receive.denyCurrentBranch updateInstead

// Push to workspace
git add -A
git commit -m "message"
git log --oneline  // history

// Pull from workspace
git show {commit}:{file}  // specific file
git checkout {commit} -- .  // entire state
```

### Sandbox (Temporary)

```typescript
// Checkout workspace to sandbox
git clone data/workspaces/{id}/ data/sandboxes/{id}/

// Agent works... (read/write files normally)

// Commit changes from sandbox to workspace
cd data/sandboxes/{id}/
git add -A
git commit -m "message"
git push  // pushes to workspace's .git

// Destroy sandbox
rm -rf data/sandboxes/{id}/
```

## Workspace Metadata

Each workspace has metadata in `workspace-meta/{id}.json`:

```json
{
  "id": "ws_01HXXXXXXXX",
  "customerId": "meta-profile",
  "name": "LeBron James",
  "createdAt": "2024-02-28T21:00:00Z",
  "updatedAt": "2024-02-28T21:00:00Z",
  "deletedAt": null
}
```

## Commit Message Format

```
{agentId}: {taskId} | tags: {tag1,tag2}
---
{"agentId":"...","taskId":"...","files":["summary.md"],"sizeBytes":1024}
```

## File Structure Example

```
data/workspaces/ws_01HXXXXXXXX/
├── .git/
├── profile/
│   └── summary.md
├── games/
│   ├── 2024_001.json
│   └── 2024_001.md
└── analysis/
    └── shooting-improvement.md

data/sandboxes/ws_01HXXXXXXXX/  (temporary)
├── profile/
│   └── summary.md
├── games/
│   └── 2024_001.json
└── analysis/
    └── new-analysis.md  (agent added this)
```

## API vs MCP vs Direct Git

| Access Method | Use Case |
|-------------|----------|
| **MCP Server** | AI agents (Claude, Codex) |
| **REST API** | Developers, webhooks, CLI |
| **Direct Git** | Advanced operations, scripting |

All three ultimately use the same Git storage.

## Implementation Notes

### Creating a Sandbox

```typescript
async function createSandbox(workspaceId: string): Promise<string> {
  const workspacePath = path.join(WORKSPACES_DIR, workspaceId);
  const sandboxPath = path.join(SANDBOX_DIR, workspaceId);
  
  // Clone workspace to sandbox
  await fs.mkdir(sandboxPath, { recursive: true });
  const git = simpleGit(workspacePath);
  await git.clone(workspacePath, sandboxPath);
  
  return sandboxPath;
}
```

### Committing Sandbox Changes

```typescript
async function commitSandbox(workspaceId: string, message: string): Promise<string> {
  const sandboxPath = path.join(SANDBOX_DIR, workspaceId);
  const workspacePath = path.join(WORKSPACES_DIR, workspaceId);
  
  const sandboxGit = simpleGit(sandboxPath);
  
  // Commit in sandbox
  await sandboxGit.add("-A");
  const result = await sandboxGit.commit(message);
  
  // Push to workspace
  await sandboxGit.push();
  
  return result.commit;
}
```

### Destroying a Sandbox

```typescript
async function destroySandbox(workspaceId: string): Promise<void> {
  const sandboxPath = path.join(SANDBOX_DIR, workspaceId);
  await fs.rm(sandboxPath, { recursive: true, force: true });
}
```

## Environment Variables

```bash
CONTEXTVAULT_DATA_DIR=./data           # Root data directory
CONTEXTVAULT_WORKSPACES_DIR=data/workspaces  # Persistent storage
CONTEXTVAULT_SANDBOX_DIR=data/sandboxes     # Temporary storage
```
