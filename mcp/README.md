# ContextVault MCP Server

MCP server for ContextVault — enables AI agents to interact with ContextVault workspaces via the Model Context Protocol.

## Key Concept: Sandboxed Execution

**Don't put workspace in agent context — put it in a sandbox.**

```
Agent needs context → checkout workspace to sandbox → agent works in filesystem → commit → destroy sandbox
```

This avoids context bloat and keeps agents isolated from each other.

## Architecture

```
Consumer (MetaProfile, etc.)
         │
         │ MCP over stdio or HTTP
         ▼
┌────────────────────────────────┐
│  ContextVault MCP Server        │
│                                │
│  Tools:                        │
│  • create_workspace            │
│  • checkout_workspace  ───────►│──► Temporary sandbox
│  • commit_workspace   ◄───────│◄───── Agent works in files
│  • destroy_workspace          │
│  • pull / push / history      │
└────────────────────────────────┘
         │
         │ Git operations
         ▼
┌────────────────────────────────┐
│  ContextVault Storage           │
│  (persistent Git repos)        │
└────────────────────────────────┘
```

## Sandbox Lifecycle

```
1. checkout_workspace(workspaceId)
   → Clones workspace to /tmp/contextvault-sandbox/{workspaceId}/
   → Returns sandbox path

2. Agent works in sandbox
   → Reads/writes files normally
   → Files are in a real directory

3. commit_workspace(workspaceId)
   → git add + commit in sandbox
   → Pushes changes to persistent storage
   → Returns new commit hash

4. destroy_workspace(workspaceId)
   → rm -rf /tmp/contextvault-sandbox/{workspaceId}/
   → ContextVault storage untouched
```

## MCP Tools

### Sandbox Operations

**checkout_workspace**
```typescript
// Pull workspace to temp sandbox
workspaceId: "ws_01HXXXXXXXX"
→ Returns: { sandboxPath: "/tmp/contextvault-sandbox/ws_01HXXXXXXXX" }
```

**commit_workspace**
```typescript
// Commit sandbox changes to ContextVault
workspaceId: "ws_01HXXXXXXXX"
agentId: "claude-code"
taskId: "analyze-performance"
tags: ["analysis", "game-recap"]
→ Returns: { commitId: "abc123", parentId: "def456", files: ["games/001.md"] }
```

**destroy_workspace**
```typescript
// Destroy sandbox, keep persistent storage
workspaceId: "ws_01HXXXXXXXX"
→ Returns: { success: true }
```

**get_sandbox_status**
```typescript
// Check if sandbox exists
workspaceId: "ws_01HXXXXXXXX"
→ Returns: { exists: true, path: "/tmp/contextvault-sandbox/ws_01HXXXXXXXX" }
```

### Workspace Management

**create_workspace**
```typescript
customerId: "meta-profile"
name: "LeBron James"
→ Returns: { id: "ws_01HXXXXXXXX", ... }
```

**list_workspaces**
```typescript
// Returns all workspaces
```

**get_workspace**
```typescript
workspaceId: "ws_01HXXXXXXXX"
→ Returns: { id, customerId, name, latestCommitId, ... }
```

**delete_workspace**
```typescript
workspaceId: "ws_01HXXXXXXXX"
// Soft delete
```

### Version Control (Direct)

**push_to_workspace** — Direct push (skip sandbox)
**pull_from_workspace** — Direct pull (skip sandbox)
**get_workspace_history** — Git log
**diff_workspace** — Compare versions
**rollback_workspace** — Git revert

## Installation

```bash
cd mcp
npm install
```

## Running

### Development
```bash
npm run dev    # Uses tsx for hot reload
```

### Production
```bash
npm run build  # Compiles to dist/
npm start      # Runs compiled JS
```

## Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": ["/path/to/contextvault/mcp/dist/index.js"],
      "env": {
        "CONTEXTVAULT_DATA_DIR": "/path/to/contextvault/data",
        "CONTEXTVAULT_SANDBOX_DIR": "/tmp/contextvault-sandbox"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTVAULT_DATA_DIR` | `./data` | Where workspaces are stored |
| `CONTEXTVAULT_SANDBOX_DIR` | `/tmp/contextvault-sandbox` | Where sandboxes are created |
| `CONTEXTVAULT_API_KEY` | (none) | API key for authentication |

## Example Usage

```typescript
// 1. Create workspace
const ws = await callTool("create_workspace", {
  customerId: "meta-profile",
  name: "LeBron James"
});

// 2. Checkout to sandbox
const { sandboxPath } = await callTool("checkout_workspace", {
  workspaceId: ws.id
});
// sandboxPath = "/tmp/contextvault-sandbox/ws_01HXXXXXXXX"

// 3. Agent works in sandbox
// - Reads /tmp/contextvault-sandbox/ws_01HXXXXXXXX/games/001.md
// - Writes /tmp/contextvault-sandbox/ws_01HXXXXXXXX/analysis.md

// 4. Commit changes
const { commitId } = await callTool("commit_workspace", {
  workspaceId: ws.id,
  agentId: "meta-profile",
  taskId: "game-analysis"
});

// 5. Destroy sandbox
await callTool("destroy_workspace", { workspaceId: ws.id });
// Sandbox is gone, ContextVault storage intact
```

## MCP Transport

- **Default**: stdio (same machine)
- **Future**: Streamable HTTP (remote access)

For Claude Desktop on the same machine, stdio is fine.
For remote access, use the HTTP transport (see HTTP_SERVER.md).
