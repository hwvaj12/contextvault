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

---

## Protocol

- Transport: stdio (local) or Streamable HTTP (remote)
- JSON-RPC 2.0
- Server name: `contextvault-mcp`
- Server version: `0.1.0`
