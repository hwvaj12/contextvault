# ContextVault MCP Server

MCP server for ContextVault — enables AI agents to interact with ContextVault workspaces via the Model Context Protocol.

## Quick Start

```bash
cd mcp
npm install
npm run dev    # Starts on stdio
```

## Configuration

Environment variables:
```bash
CONTEXTVAULT_DATA_DIR=./data           # Where workspaces are stored
CONTEXTVAULT_SANDBOX_DIR=./data/sandboxes  # Where sandboxes are created
```

## Claude Desktop Setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": ["/absolute/path/to/contextvault/mcp/src/index.mjs"],
      "env": {
        "CONTEXTVAULT_DATA_DIR": "/absolute/path/to/contextvault/data"
      }
    }
  }
}
```

---

## Patterns

### Pattern 1: Single-Agent Session

A single agent uses a workspace as its memory for one task or conversation.

```
Agent → create_workspace (if needed)
       → push_to_workspace (save initial context)
       → [later] pull_from_workspace (restore context)
       → push_to_workspace (save updated context)
```

**When to use:** One agent handling a standalone task. No other agent needs this workspace.

**Example:**
```typescript
// Start: pull latest context
const state = await pull_from_workspace({ workspaceId });

// Agent works, modifies state

// Done: push updated context
await push_to_workspace({
  workspaceId,
  files: updatedFiles,
  tags: ["completed"]
});
```

---

### Pattern 2: Multi-Agent Handoff

Agent A creates and populates a workspace. Agent B later pulls that workspace and continues from where A left off.

```
Agent A → create_workspace → push_to_workspace (commits work)
                                                         ↓
Agent B → pull_from_workspace → [resumes from A's commit]
```

**When to use:** Sequential handoffs. Agent A does research, Agent B acts on it. Different shifts on the same project.

**Key behavior:**
- `pull_from_workspace` with no `version` → pulls HEAD (latest commit)
- Each commit is immutable — Agent B always sees a complete snapshot
- Agent B's commits stack on top — Agent A's history is preserved

**Example:**
```typescript
// Agent B resuming — gets everything Agent A committed
const { files, commitId } = await pull_from_workspace({
  workspaceId: "ws_..."
});
// files contains all of Agent A's work
```

---

### Pattern 3: Resumable Session

An agent works intermittently. Each interaction pushes state. The next interaction resumes from the last commit.

```
Interaction 1 → push_to_workspace (commit "in-progress-1")
Interaction 2 → pull_from_workspace → push_to_workspace (commit "in-progress-2")
Interaction 3 → pull_from_workspace → push_to_workspace (commit "done")
```

**When to use:** Long-running tasks that span multiple conversations or sessions. Chatbots, code assistants, research agents.

**Key behavior:**
- Each `push_to_workspace` is a new commit on top of previous
- `pull_from_workspace` (no version) always gets the latest state
- Commit messages/tags let you track progress: `in-progress`, `review-needed`, `complete`

**Example:**
```typescript
// On every interaction:
async function saveProgress(workspaceId: string, files: File[]) {
  await push_to_workspace({
    workspaceId,
    files,
    tags: ["in-progress", `session-${sessionId}`]
  });
}

async function loadProgress(workspaceId: string) {
  const { files } = await pull_from_workspace({ workspaceId });
  return files;
}
```

---

### Pattern 4: Error Recovery

Agents encounter errors. Workspaces and sandboxes persist. Here are common recovery patterns.

#### Workspace not found
```typescript
// If pull fails because workspace doesn't exist, create it
try {
  await pull_from_workspace({ workspaceId });
} catch (e) {
  if (e.message.includes("not found")) {
    await create_workspace({ customerId, name: workspaceId });
    // Then retry pull (will get empty workspace)
  } else {
    throw e; // Unknown error, surface it
  }
}
```

#### Sandbox already exists
```typescript
// If checkout fails because sandbox exists, destroy it first
const status = await get_sandbox_status({ workspaceId });
if (status.exists) {
  await destroy_workspace({ workspaceId }); // Destroys sandbox, keeps workspace
}
await checkout_workspace({ workspaceId });
```

#### Agent crashes mid-session
```typescript
// On restart, check for orphaned sandboxes
const status = await get_sandbox_status({ workspaceId });
if (status.exists && status.hasChanges) {
  // Agent was mid-work — commit or discard
  // Option A: commit what exists
  await commit_workspace({ workspaceId, tags: ["crash-recovery"] });
  // Option B: destroy and start fresh
  await destroy_workspace({ workspaceId });
}
```

#### Commit fails (no changes)
```typescript
// commit_workspace succeeds but with empty files array if nothing changed
const result = await commit_workspace({ workspaceId });
if (result.files.length === 0) {
  // Nothing to commit — expected for read-only sessions
}
```

---

### Pattern 5: Workspace Per Conversation

Each conversation/session gets its own workspace. Clean separation, no cross-contamination.

```
Session 1 → create_workspace → push → ... → push → archive
Session 2 → create_workspace → push → ... → push → archive
```

**When to use:** Customer-facing chatbots, per-user memory, per-task workspaces.

**Key behavior:**
- Customer A's workspace is fully isolated from Customer B's
- Workspace ID maps to conversation/session/user in your app
- Archive by deleting (soft-delete) old workspaces

**Example:**
```typescript
// Start new conversation
const workspace = await create_workspace({
  customerId: user.id,
  name: `chat-${conversationId}`
});
// Workspace persists for lifetime of conversation

// End conversation — workspace is preserved, available for audit
```

---

## MCP Tools

### Workspace Management

| Tool | Description |
|------|-------------|
| `create_workspace` | Create a new workspace |
| `list_workspaces` | List all workspaces |
| `get_workspace` | Get workspace details |
| `delete_workspace` | Soft-delete workspace |

### Sandbox Operations

Sandboxes are temporary working directories for agent execution.

| Tool | Description |
|------|-------------|
| `checkout_workspace` | Clone workspace to sandbox, return path |
| `commit_workspace` | Commit sandbox changes to workspace |
| `destroy_workspace` | Destroy sandbox (keep workspace) |
| `get_sandbox_status` | Check if sandbox exists |

### Version Control

| Tool | Description |
|------|-------------|
| `push_to_workspace` | Push files directly (skip sandbox) |
| `pull_from_workspace` | Pull files directly (skip sandbox) |
| `get_workspace_history` | Get commit history |
| `diff_workspace` | Compare two versions |
| `rollback_workspace` | Rollback to previous version |

---

## Sandbox Model

**Don't put workspace in agent context — put it in a sandbox.**

```
1. Agent needs workspace context
   ↓
2. checkout_workspace(workspaceId)
   → Clones workspace to /tmp/contextvault-sandbox/{workspaceId}/
   → Returns sandbox path
   ↓
3. Agent works in sandbox (normal file operations)
   ↓
4. commit_workspace(workspaceId)
   → git add + commit in sandbox
   → Push to persistent workspace
   ↓
5. destroy_workspace(workspaceId)
   → rm -rf sandbox
   → Workspace intact, ready for next agent
```

---

## Tool Details

### create_workspace
```typescript
{ customerId: string, name: string }
→ { id, customerId, name, createdAt, latestCommitId }
```

### checkout_workspace
```typescript
{ workspaceId: string }
→ { sandboxPath: string, workspaceId: string }
```

### commit_workspace
```typescript
{ workspaceId: string, agentId?: string, taskId?: string, tags?: string[] }
→ { commitId: string, parentId: string | null, files: string[] }
```

### destroy_workspace
```typescript
{ workspaceId: string }
→ { success: true }
```

### get_sandbox_status
```typescript
{ workspaceId: string }
→ { exists: boolean, path: string, hasChanges: boolean }
```

### push_to_workspace
```typescript
{ workspaceId: string, files: {path, content}[], agentId?: string, taskId?: string, tags?: string[] }
→ { commitId: string, parentId: string | null, sizeBytes: number }
```

### pull_from_workspace
```typescript
{ workspaceId: string, version?: string }
→ { commitId, files: {path, content}[], metadata, createdAt }
```

### get_workspace_history
```typescript
{ workspaceId: string, limit?: number }
→ [{ id, parentId, metadata, sizeBytes, createdAt }, ...]
```

### diff_workspace
```typescript
{ workspaceId: string, from: string, to: string }
→ { added: string[], removed: string[], modified: string[] }
```

### rollback_workspace
```typescript
{ workspaceId: string, toVersion: string, agentId?: string }
→ { commitId, parentId, sizeBytes, createdAt }
```

---

## Example Session

```typescript
// 1. Create workspace
await callTool("create_workspace", {
  customerId: "meta-profile",
  name: "LeBron James"
})
// → { id: "ws_01HXXXXXXXX", ... }

// 2. Checkout to sandbox
await callTool("checkout_workspace", {
  workspaceId: "ws_01HXXXXXXXX"
})
// → { sandboxPath: "/tmp/contextvault-sandbox/ws_01HXXXXXXXX" }

// 3. Agent works in sandbox
// - Reads /tmp/contextvault-sandbox/ws_01HXXXXXXXX/profile/summary.md
// - Writes /tmp/contextvault-sandbox/ws_01HXXXXXXXX/analysis.md

// 4. Commit changes
await callTool("commit_workspace", {
  workspaceId: "ws_01HXXXXXXXX",
  agentId: "meta-profile",
  taskId: "analysis-001",
  tags: ["analysis"]
})
// → { commitId: "abc123", ... }

// 5. Destroy sandbox
await callTool("destroy_workspace", {
  workspaceId: "ws_01HXXXXXXXX"
})
// → { success: true }
```

---

## Error Handling

All errors return:
```typescript
{
  content: [{ type: "text", text: "Error message" }],
  isError: true
}
```

Common errors:
- `Invalid workspace ID format` — ID must match `ws_[A-Za-z0-9]{10,26}`
- `Workspace not found` — Workspace doesn't exist
- `Sandbox not found` — No sandbox for this workspace
- `No commits found` — Workspace has no commits
- `receive.denyCurrentBranch` — Workspace is locked by another agent

---

## Protocol

- Transport: stdio (local) or Streamable HTTP (remote)
- JSON-RPC 2.0
- Server name: `contextvault-mcp`
- Server version: `0.1.0`
