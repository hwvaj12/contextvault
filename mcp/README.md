# ContextVault MCP Server

MCP server for ContextVault — enables AI agents to interact with ContextVault workspaces via the Model Context Protocol.

## Installation

```bash
cd mcp
npm install
npm run build
```

## Configuration for Claude Desktop

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": ["/path/to/contextvault/mcp/dist/index.js"],
      "env": {
        "DATA_DIR": "/path/to/contextvault/data"
      }
    }
  }
}
```

## Available Tools

### Workspace Management

- **create_workspace** — Create a new workspace
  - `customerId`: Customer ID this workspace belongs to
  - `name`: Human-readable name

- **list_workspaces** — List all workspaces (optionally filtered by customerId)

- **get_workspace** — Get details of a specific workspace
  - `workspaceId`: Format `ws_<ulid>`

- **delete_workspace** — Soft-delete a workspace
  - `workspaceId`: Workspace ID to delete

### Version Control Operations

- **push_to_workspace** — Push files as a new commit (agent saves state)
  - `workspaceId`: Target workspace ID
  - `files`: Array of `{path, content}` objects
  - `agentId`: ID of the agent pushing
  - `taskId`: Current task ID
  - `tags`: Optional tags array

- **pull_from_workspace** — Pull files from a workspace (agent restores state)
  - `workspaceId`: Workspace to pull from
  - `version`: Specific commit hash (optional, defaults to HEAD)

- **get_workspace_history** — Get commit history for a workspace
  - `workspaceId`: Workspace ID
  - `limit`: Max commits to return (default 20)

- **diff_workspace** — Compare two versions
  - `workspaceId`: Workspace ID
  - `from`: Source commit hash
  - `to`: Target commit hash

- **rollback_workspace** — Rollback to a previous version (creates new commit)
  - `workspaceId`: Workspace ID
  - `toVersion`: Commit hash to rollback to
  - `agentId`: Agent performing rollback

## Example Usage

```
# Create a workspace
Tool: create_workspace
customerId: "cust_123"
name: "My Agent Context"

# Push files to save state
Tool: push_to_workspace
workspaceId: "ws_01HXXXXXXXX"
files: [{"path": "context/summary.md", "content": "# Session Summary..."}]
agentId: "claude-code"

# Pull to restore state
Tool: pull_from_workspace
workspaceId: "ws_01HXXXXXXXX"
```

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx (hot reload)
```

## How It Works

The MCP server wraps the ContextVault Git-native storage layer:
- Each workspace is a Git repository
- Push = `git add` + `git commit`
- Pull = `git show` at specific commit
- History = `git log`
- Diff = `git diff`
- Rollback = `git revert`

This gives agents full version control semantics without needing to understand Git.
