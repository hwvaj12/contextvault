# ContextVault REST API

REST API for ContextVault — HTTP interface for managing workspaces, sandboxes, and webhooks.

## Base URL

```
http://localhost:3000
```

## Authentication

All endpoints require `X-API-Key` header:
```
X-API-Key: your-api-key
```

For development, use the master key (set via `CONTEXTVAULT_API_KEY` env var). In production, create scoped API keys via `/api-keys`.

---

## API Keys

### Create API Key
```
POST /api-keys
```

**Request:**
```json
{
  "customerId": "my-customer",
  "name": "production-key"
}
```

**Response (201):**
```json
{
  "id": "ak_01HXXXXXXXX",
  "customerId": "my-customer",
  "name": "production-key",
  "key": "cv_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "createdAt": "2024-02-28T21:00:00Z"
}
```
> ⚠️ The `key` field is only returned on creation. Store it securely.

---

### List API Keys
```
GET /api-keys
```

**Response (200):**
```json
{
  "keys": [
    {
      "id": "ak_01HXXXXXXXX",
      "customerId": "my-customer",
      "name": "production-key",
      "createdAt": "2024-02-28T21:00:00Z",
      "lastUsedAt": "2024-02-28T22:00:00Z"
    }
  ]
}
```

---

### Revoke API Key
```
DELETE /api-keys/{keyId}
```

**Response (200):**
```json
{
  "success": true
}
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
  "customerId": "my-customer",
  "name": "LeBron James"
}
```

**Response (201):**
```json
{
  "id": "ws_01HXXXXXXXX",
  "customerId": "my-customer",
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

Returns workspaces scoped to the authenticated customer.

**Response (200):**
```json
{
  "workspaces": [
    {
      "id": "ws_01HXXXXXXXX",
      "customerId": "my-customer",
      "name": "LeBron James",
      "createdAt": "2024-02-28T21:00:00Z",
      "latestCommitId": "abc123"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
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
  "customerId": "my-customer",
  "name": "LeBron James",
  "createdAt": "2024-02-28T21:00:00Z",
  "updatedAt": "2024-02-28T21:00:00Z",
  "latestCommitId": "abc123"
}
```

---

### Delete Workspace (Soft)
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

### Bulk Delete Workspaces
```
POST /workspaces/bulk-delete
```

**Request:**
```json
{
  "workspaceIds": ["ws_01HXXXXXXXX", "ws_01HYYYYYYYY"]
}
```

**Response (200):**
```json
{
  "deleted": 2,
  "failed": []
}
```

**With failures:**
```json
{
  "deleted": 1,
  "failed": [
    { "id": "ws_01HYYYYYYYY", "error": "Workspace not found" }
  ]
}
```

---

### Clone Workspace
```
POST /workspaces/{workspaceId}/clone
```

Create a copy of a workspace for a target customer.

**Request:**
```json
{
  "targetCustomerId": "other-customer",
  "name": "LeBron James (Copy)"
}
```

**Response (201):**
```json
{
  "id": "ws_01HZZZZZZZ",
  "workspaceId": "ws_01HZZZZZZZ",
  "customerId": "other-customer",
  "name": "LeBron James (Copy)",
  "createdAt": "2024-02-28T21:00:00Z"
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
    }
  ],
  "count": 1
}
```

---

### Diff
```
GET /workspaces/{workspaceId}/diff
```

Compare two commits and get structured file changes.

**Query params:**
- `from` — Source commit hash
- `to` — Target commit hash

**Response (200):**
```json
{
  "from": "abc123",
  "to": "def456",
  "files": [
    {
      "path": "profile/summary.md",
      "status": "modified",
      "additions": 12,
      "deletions": 3,
      "hunks": [
        {
          "header": "@@ -1,5 +1,8 @@",
          "lines": ["...", "+new line", "..."]
        }
      ]
    },
    {
      "path": "games/2024_002.md",
      "status": "added",
      "additions": 45,
      "deletions": 0,
      "hunks": []
    }
  ],
  "summary": {
    "filesChanged": 2,
    "additions": 57,
    "deletions": 3
  }
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
  "status": "ready",
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
  "commitId": "jkl012",
  "workspaceId": "ws_01HXXXXXXXX",
  "sandboxId": "sb_01HXXXXXXXX",
  "parentId": "def456",
  "filesChanged": ["analysis/shooting.md"],
  "sizeBytes": 1024,
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
  "workspaceId": "ws_01HXXXXXXXX"
}
```

---

## Webhooks

### Register Webhook
```
POST /webhooks
```

**Request:**
```json
{
  "url": "https://my-app.com/webhooks/contextvault",
  "events": ["workspace.created", "workspace.deleted", "sandbox.committed"],
  "secret": "my-webhook-secret"
}
```

**Response (201):**
```json
{
  "id": "wh_01HXXXXXXXX",
  "url": "https://my-app.com/webhooks/contextvault",
  "events": ["workspace.created", "workspace.deleted", "sandbox.committed"],
  "secret": "cv_whsec_xxxxxxxxxxxxxxxx",
  "active": true,
  "createdAt": "2024-02-28T21:00:00Z"
}
```

**Available events:**
- `workspace.created`
- `workspace.deleted`
- `sandbox.checked_out`
- `sandbox.destroyed`
- `sandbox.committed`
- `run.started`
- `run.completed`
- `run.failed`

---

### List Webhooks
```
GET /webhooks
```

**Response (200):**
```json
{
  "webhooks": [
    {
      "id": "wh_01HXXXXXXXX",
      "url": "https://my-app.com/webhooks/contextvault",
      "events": ["workspace.created", "sandbox.committed"],
      "active": true,
      "createdAt": "2024-02-28T21:00:00Z"
    }
  ]
}
```

---

### Delete Webhook
```
DELETE /webhooks/{webhookId}
```

**Response (200):**
```json
{
  "success": true
}
```

---

### Webhook Payload

When an event fires, your endpoint receives:
```json
{
  "event": "sandbox.committed",
  "timestamp": "2024-02-28T21:00:00Z",
  "workspaceId": "ws_01HXXXXXXXX",
  "data": {
    "commitId": "jkl012",
    "sandboxId": "sb_01HXXXXXXXX",
    "parentId": "def456",
    "filesChanged": ["profile/summary.md"]
  }
}
```

**Headers:**
- `X-CV-Signature` — HMAC-SHA256 signature of payload using your secret
- `X-CV-Event` — Event type
- `X-CV-Webhook-ID` — Webhook ID

Verify signature:
```bash
echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET"
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
  "version": "0.2.0",
  "timestamp": "2024-02-28T21:00:00Z"
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
| 400 | `NO_CHANGES` | No changes to commit |
| 403 | `FORBIDDEN` | Access denied (wrong customer) |
| 404 | `WORKSPACE_NOT_FOUND` | Workspace does not exist |
| 404 | `SANDBOX_NOT_FOUND` | Sandbox does not exist |
| 404 | `FILE_NOT_FOUND` | File not found in workspace |
| 409 | `SANDBOX_EXISTS` | Sandbox already exists for workspace |
| 409 | `WORKSPACE_EXISTS` | Workspace already exists |
| 500 | `GIT_ERROR` | Git operation failed |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Example: Full Sandbox Workflow

```bash
# 1. Create API key
curl -X POST http://localhost:3000/api-keys \
  -H "X-API-Key: cv-test-api-key-123" \
  -d '{"customerId":"my-customer","name":"dev-key"}'
# Returns: { "key": "cv_key_xxx", ... }

# 2. Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: cv_key_xxx" \
  -d '{"customerId":"my-customer","name":"LeBron James"}'

# 3. Checkout to sandbox
curl -X POST http://localhost:3000/workspaces/ws_01HXXXXXXXX/sandbox \
  -H "X-API-Key: cv_key_xxx"

# 4. Agent works in sandbox at /tmp/contextvault-sandbox/ws_01HXXXXXXXX/

# 5. Commit sandbox changes
curl -X POST http://localhost:3000/workspaces/ws_01HXXXXXXXX/sandbox/commit \
  -H "X-API-Key: cv_key_xxx" \
  -d '{"agentId":"meta-profile","taskId":"analysis-001"}'

# 6. Check diff between commits
curl "http://localhost:3000/workspaces/ws_01HXXXXXXXX/diff?from=abc123&to=def456" \
  -H "X-API-Key: cv_key_xxx"

# 7. Register webhook for commits
curl -X POST http://localhost:3000/webhooks \
  -H "X-API-Key: cv_key_xxx" \
  -d '{"url":"https://my-app.com/cv-webhook","events":["sandbox.committed"]}'

# 8. Destroy sandbox
curl -X DELETE http://localhost:3000/workspaces/ws_01HXXXXXXXX/sandbox \
  -H "X-API-Key: cv_key_xxx"
```
