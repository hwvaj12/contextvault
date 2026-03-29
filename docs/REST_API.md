# ContextVault REST API

REST API for ContextVault — HTTP interface for managing workspaces and sandboxes.

## Base URL

```
http://localhost:3000
```

## Authentication

All endpoints require `X-API-Key` header:
```
X-API-Key: your-api-key
```

---

## Workspaces

### Create Workspace
```
POST /workspaces
```

**Request:**
```json
{
  "customerId": "meta-profile",
  "name": "LeBron James"
}
```

**Response (201):**
```json
{
  "id": "ws_01HXXXXXXXX",
  "customerId": "meta-profile",
  "name": "LeBron James",
  "createdAt": "2024-02-28T21:00:00Z",
  "latestCommitId": null
}
```

---

### List Workspaces
```
GET /workspaces
```

**Query params:**
- `customerId` (optional) — Filter by customer

**Response (200):**
```json
{
  "workspaces": [
    {
      "id": "ws_01HXXXXXXXX",
      "customerId": "meta-profile",
      "name": "LeBron James",
      "createdAt": "2024-02-28T21:00:00Z",
      "latestCommitId": "abc123"
    }
  ]
}
```

---

### Get Workspace
```
GET /workspaces/{workspaceId}
```

**Response (200):**
```json
{
  "id": "ws_01HXXXXXXXX",
  "customerId": "meta-profile",
  "name": "LeBron James",
  "createdAt": "2024-02-28T21:00:00Z",
  "updatedAt": "2024-02-28T21:00:00Z",
  "latestCommitId": "abc123"
}
```

---

### Delete Workspace
```
DELETE /workspaces/{workspaceId}
```

**Response (200):**
```json
{
  "success": true,
  "deletedAt": "2024-02-28T21:00:00Z"
}
```

---

## Version Control

### Push (Create Commit)
```
POST /workspaces/{workspaceId}/push
```

**Request:**
```json
{
  "files": [
    {
      "path": "profile/summary.md",
      "content": "# LeBron James\n\n..."
    },
    {
      "path": "games/2024_001.json",
      "content": "{\"points\":28,...}"
    }
  ],
  "agentId": "meta-profile",
  "taskId": "game-recap-001",
  "tags": ["game", "recap", "nba"]
}
```

**Response (201):**
```json
{
  "commitId": "def456",
  "parentId": "abc123",
  "sizeBytes": 4096,
  "createdAt": "2024-02-28T21:00:00Z"
}
```

---

### Pull (Get Files)
```
GET /workspaces/{workspaceId}/pull
```

**Query params:**
- `v` (optional) — Commit hash. Defaults to HEAD.

**Response (200):**
```json
{
  "commitId": "def456",
  "parentId": "abc123",
  "files": [
    {
      "path": "profile/summary.md",
      "content": "# LeBron James\n\n..."
    }
  ],
  "metadata": {
    "agentId": "meta-profile",
    "taskId": "game-recap-001",
    "tags": ["game", "recap"]
  },
  "createdAt": "2024-02-28T21:00:00Z"
}
```

---

### Get History
```
GET /workspaces/{workspaceId}/history
```

**Query params:**
- `limit` (optional, default 20) — Max commits to return

**Response (200):**
```json
{
  "commits": [
    {
      "id": "def456",
      "parentId": "abc123",
      "metadata": {
        "agentId": "meta-profile",
        "taskId": "game-recap-001",
        "tags": ["game", "recap"]
      },
      "sizeBytes": 4096,
      "createdAt": "2024-02-28T21:00:00Z"
    },
    {
      "id": "abc123",
      "parentId": null,
      "metadata": {},
      "sizeBytes": 2048,
      "createdAt": "2024-02-28T20:00:00Z"
    }
  ]
}
```

---

### Diff
```
GET /workspaces/{workspaceId}/diff
```

**Query params:**
- `from` — Source commit hash
- `to` — Target commit hash

**Response (200):**
```json
{
  "from": "abc123",
  "to": "def456",
  "added": ["games/2024_001.md", "games/2024_001.json"],
  "removed": [],
  "modified": ["profile/summary.md"]
}
```

---

### Rollback
```
POST /workspaces/{workspaceId}/rollback
```

**Request:**
```json
{
  "toVersion": "abc123",
  "agentId": "meta-profile",
  "message": "Rolling back to previous state"
}
```

**Response (201):**
```json
{
  "commitId": "ghi789",
  "parentId": "def456",
  "rollbackFrom": "abc123",
  "createdAt": "2024-02-28T21:00:00Z"
}
```

---

## Sandboxes

Sandboxes are temporary working directories. Use them for agent workflows.

### Checkout (Create Sandbox)
```
POST /workspaces/{workspaceId}/sandbox
```

**Response (201):**
```json
{
  "workspaceId": "ws_01HXXXXXXXX",
  "sandboxId": "sb_01HXXXXXXXX",
  "sandboxPath": "/tmp/contextvault-sandbox/ws_01HXXXXXXXX",
  "createdAt": "2024-02-28T21:00:00Z"
}
```

---

### Get Sandbox Status
```
GET /workspaces/{workspaceId}/sandbox
```

**Response (200):**
```json
{
  "workspaceId": "ws_01HXXXXXXXX",
  "sandboxId": "sb_01HXXXXXXXX",
  "sandboxPath": "/tmp/contextvault-sandbox/ws_01HXXXXXXXX",
  "exists": true,
  "hasChanges": true,
  "createdAt": "2024-02-28T21:00:00Z"
}
```

---

### Commit Sandbox (Save Changes)
```
POST /workspaces/{workspaceId}/sandbox/commit
```

**Request:**
```json
{
  "agentId": "meta-profile",
  "taskId": "game-analysis-001",
  "tags": ["analysis", "game-recap"]
}
```

**Response (201):**
```json
{
  "workspaceId": "ws_01HXXXXXXXX",
  "sandboxId": "sb_01HXXXXXXXX",
  "commitId": "jkl012",
  "parentId": "def456",
  "filesChanged": ["analysis/shooting.md"],
  "createdAt": "2024-02-28T21:00:00Z"
}
```

---

### Destroy Sandbox
```
DELETE /workspaces/{workspaceId}/sandbox
```

**Response (200):**
```json
{
  "success": true,
  "workspaceId": "ws_01HXXXXXXXX",
  "sandboxPath": "/tmp/contextvault-sandbox/ws_01HXXXXXXXX"
}
```

---

## Files

### Get Single File
```
GET /workspaces/{workspaceId}/files/{path}
```

**Query params:**
- `v` (optional) — Commit hash. Defaults to HEAD.

**Response (200):**
```json
{
  "path": "profile/summary.md",
  "content": "# LeBron James\n\n...",
  "commitId": "def456",
  "size": 2048
}
```

---

### Upload Multiple Files
```
POST /workspaces/{workspaceId}/files
```

**Request:** `multipart/form-data`
```
files: [file1.md, file2.json]
basePath: "games/2024_001/"  (optional)
```

**Response (201):**
```json
{
  "uploaded": [
    { "path": "games/2024_001/file1.md", "size": 1024 },
    { "path": "games/2024_001/file2.json", "size": 512 }
  ]
}
```

---

## Health & Info

### Health Check
```
GET /health
```

**Response (200):**
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "timestamp": "2024-02-28T21:00:00Z"
}
```

---

### API Info
```
GET /
```

**Response (200):**
```json
{
  "name": "ContextVault",
  "version": "0.1.0",
  "documentation": "https://github.com/lab-rat0212/contextvault"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "WORKSPACE_NOT_FOUND",
    "message": "Workspace ws_01HXXXXXXXX not found",
    "details": {}
  }
}
```

### Error Codes

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `INVALID_REQUEST` | Malformed request body |
| 400 | `INVALID_WORKSPACE_ID` | Workspace ID format invalid |
| 404 | `WORKSPACE_NOT_FOUND` | Workspace does not exist |
| 404 | `SANDBOX_NOT_FOUND` | Sandbox does not exist |
| 404 | `FILE_NOT_FOUND` | File not found in workspace |
| 409 | `SANDBOX_EXISTS` | Sandbox already exists for workspace |
| 500 | `GIT_ERROR` | Git operation failed |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Rate Limits

| Tier | Requests/minute |
|------|-----------------|
| Free | 60 |
| Pro | 600 |
| Enterprise | Unlimited |

---

## Example: Full Sandbox Workflow

```bash
# 1. Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: your-key" \
  -d '{"customerId":"meta-profile","name":"LeBron James"}'

# 2. Checkout to sandbox
curl -X POST http://localhost:3000/workspaces/ws_01HXXXXXXXX/sandbox \
  -H "X-API-Key: your-key"

# 3. Agent works in sandbox at /tmp/contextvault-sandbox/ws_01HXXXXXXXX/

# 4. Commit sandbox changes
curl -X POST http://localhost:3000/workspaces/ws_01HXXXXXXXX/sandbox/commit \
  -H "X-API-Key: your-key" \
  -d '{"agentId":"meta-profile","taskId":"analysis-001"}'

# 5. Destroy sandbox
curl -X DELETE http://localhost:3000/workspaces/ws_01HXXXXXXXX/sandbox \
  -H "X-API-Key: your-key"
```
