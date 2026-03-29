# Workspaces API Reference

Workspaces are versioned, Git-backed storage containers scoped to a customer. All workspace operations are accessed via `client.workspaces` (TypeScript/Python) or `$client->workspaces()` (PHP).

## Methods

| Method | Description |
|--------|-------------|
| [create](#create) | Create a new workspace |
| [list](#list) | List workspaces for a customer |
| [get](#get) | Get a workspace by ID |
| [delete](#delete) | Delete a workspace |
| [checkout](#checkout) | Create a writable sandbox |
| [commit](#commit) | Commit sandbox changes |
| [destroy](#destroy) | Discard sandbox without committing |
| [pull](#pull) | Get all files from latest commit |
| [getFile](#getfile) | Get a single file by path |
| [history](#history) | Get commit history |

---

## create

Create a new workspace for a customer.

**Endpoint:** `POST /workspaces`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| customerId | string | Yes | Customer identifier |
| name | string | Yes | Workspace name |

### Usage

```typescript
// TypeScript
const workspace = await cv.workspaces.create({
  customerId: 'customer-123',
  name: 'agent-memory',
});
```

```python
# Python
workspace = cv.workspaces.create(
    customer_id="customer-123",
    name="agent-memory",
)
```

```php
// PHP
$workspace = $cv->workspaces()->create('customer-123', 'agent-memory');
```

### Response

```json
{
  "id": "ws_abc123",
  "customerId": "customer-123",
  "name": "agent-memory",
  "latestCommitId": null,
  "createdAt": "2026-03-29T12:00:00Z",
  "updatedAt": "2026-03-29T12:00:00Z",
  "deletedAt": null
}
```

---

## list

List all workspaces, optionally filtered by customer ID.

**Endpoint:** `GET /workspaces?customerId=...`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| customerId | string | TypeScript: optional, Python/PHP: required | Filter by customer |

### Usage

```typescript
// TypeScript
const workspaces = await cv.workspaces.list({ customerId: 'customer-123' });
```

```python
# Python
workspaces = cv.workspaces.list(customer_id="customer-123")
```

```php
// PHP
$workspaces = $cv->workspaces()->list('customer-123');
```

### Response

```json
[
  {
    "id": "ws_abc123",
    "customerId": "customer-123",
    "name": "agent-memory",
    "latestCommitId": "commit_xyz",
    "createdAt": "2026-03-29T12:00:00Z",
    "updatedAt": "2026-03-29T12:05:00Z",
    "deletedAt": null
  }
]
```

---

## get

Get a single workspace by ID.

**Endpoint:** `GET /workspaces/:workspaceId`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |

### Usage

```typescript
// TypeScript
const workspace = await cv.workspaces.get('ws_abc123');
```

```python
# Python
workspace = cv.workspaces.get("ws_abc123")
```

```php
// PHP
$workspace = $cv->workspaces()->get('ws_abc123');
```

### Response

Same shape as [create response](#response).

### Errors

| Status | Error | Description |
|--------|-------|-------------|
| 404 | NotFoundError | Workspace does not exist |

---

## delete

Delete a workspace (soft delete).

**Endpoint:** `DELETE /workspaces/:workspaceId`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |

### Usage

```typescript
// TypeScript
await cv.workspaces.delete('ws_abc123');
```

```python
# Python
cv.workspaces.delete("ws_abc123")
```

```php
// PHP
$cv->workspaces()->delete('ws_abc123');
```

### Errors

| Status | Error | Description |
|--------|-------|-------------|
| 404 | NotFoundError | Workspace does not exist |

---

## checkout

Create a writable sandbox for a workspace. The sandbox provides a filesystem path where your agent can read and write files.

**Endpoint:** `POST /workspaces/:workspaceId/sandbox`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |

### Usage

```typescript
// TypeScript
const sandbox = await cv.workspaces.checkout('ws_abc123');
console.log(sandbox.path); // write files here
```

```python
# Python
sandbox = cv.workspaces.checkout("ws_abc123")
print(sandbox["path"])  # write files here
```

```php
// PHP
$sandbox = $cv->workspaces()->checkout('ws_abc123');
echo $sandbox['path']; // write files here
```

### Response

```json
{
  "workspaceId": "ws_abc123",
  "sandboxId": "sbx_def456",
  "path": "/var/contextvault/sandboxes/ws_abc123",
  "status": "active",
  "createdAt": "2026-03-29T12:01:00Z"
}
```

---

## commit

Commit all changes in the sandbox to the workspace history.

**Endpoint:** `POST /workspaces/:workspaceId/sandbox/commit`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |
| message | string | No (TS), Yes (Python/PHP) | Commit message |
| author | string | No (TS), Yes (Python/PHP) | Commit author |
| agentId | string | No | Agent identifier (TypeScript only via options) |
| taskId | string | No | Task identifier (TypeScript only via options) |
| tags | string[] | No | Tags for the commit (TypeScript only via options) |

### Usage

```typescript
// TypeScript
const commit = await cv.workspaces.commit('ws_abc123', {
  message: 'Updated user profile',
  author: 'my-agent',
  agentId: 'agent-001',
  taskId: 'task-abc',
  tags: ['profile', 'update'],
});
```

```python
# Python
commit = cv.workspaces.commit(
    workspace_id="ws_abc123",
    message="Updated user profile",
    author="my-agent",
)
```

```php
// PHP
$commit = $cv->workspaces()->commit('ws_abc123', 'Updated user profile', 'my-agent');
```

### Response

```json
{
  "commitId": "commit_xyz789",
  "workspaceId": "ws_abc123",
  "parentId": "commit_prev",
  "files": [
    { "path": "profile/summary.md", "content": "..." }
  ],
  "metadata": {
    "agentId": "agent-001",
    "taskId": "task-abc",
    "tags": ["profile", "update"]
  },
  "sizeBytes": 1024,
  "createdAt": "2026-03-29T12:02:00Z"
}
```

---

## destroy

Destroy a sandbox without committing. Discards all uncommitted changes.

**Endpoint:** `POST /workspaces/:workspaceId/sandbox`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |

### Usage

```typescript
// TypeScript
const result = await cv.workspaces.destroy('ws_abc123');
// result: { workspaceId: 'ws_abc123', status: 'destroyed' }
```

```python
# Python
cv.workspaces.destroy("ws_abc123")
```

```php
// PHP
$cv->workspaces()->destroy('ws_abc123');
```

---

## pull

Get all files from the latest committed state of a workspace.

**Endpoint:** `GET /workspaces/:workspaceId/pull`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |
| version | string | No | Specific commit ID (TypeScript only) |

### Usage

```typescript
// TypeScript
const result = await cv.workspaces.pull('ws_abc123');
for (const file of result.files) {
  console.log(file.path, file.content);
}
```

```python
# Python
files = cv.workspaces.pull("ws_abc123")
for f in files:
    print(f["path"], f["content"])
```

```php
// PHP
$files = $cv->workspaces()->pull('ws_abc123');
foreach ($files as $file) {
    echo $file['path'] . ': ' . $file['content'];
}
```

### Response (TypeScript)

```json
{
  "commitId": "commit_xyz789",
  "workspaceId": "ws_abc123",
  "parentId": "commit_prev",
  "files": [
    { "path": "profile/summary.md", "content": "# User Profile\n..." },
    { "path": "notes/todo.md", "content": "- Item 1\n- Item 2" }
  ],
  "metadata": { "agentId": "agent-001" },
  "sizeBytes": 2048,
  "createdAt": "2026-03-29T12:02:00Z"
}
```

### Response (Python/PHP)

Returns the file array directly.

---

## getFile

Get a single file by path from the latest commit.

**Endpoint:** `GET /workspaces/:workspaceId/pull?path=:filePath`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |
| filePath | string | Yes | Path to the file (URL-encoded automatically) |

### Usage

```typescript
// TypeScript
const file = await cv.workspaces.getFile('ws_abc123', 'profile/summary.md');
console.log(file.content);
```

```python
# Python
file = cv.workspaces.get_file("ws_abc123", "profile/summary.md")
print(file)
```

```php
// PHP
$file = $cv->workspaces()->getFile('ws_abc123', 'profile/summary.md');
echo $file['content'];
```

### Response

```json
{
  "path": "profile/summary.md",
  "content": "# User Profile\n..."
}
```

### Errors

| Status | Error | Description |
|--------|-------|-------------|
| 404 | NotFoundError | File or workspace not found |

---

## history

Get the commit history for a workspace.

**Endpoint:** `GET /workspaces/:workspaceId/history`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workspaceId | string | Yes | Workspace ID |
| limit | number | No | Max commits to return (TypeScript only) |

### Usage

```typescript
// TypeScript
const history = await cv.workspaces.history('ws_abc123', 10);
console.log(history.commits); // array of CommitEntry
console.log(history.count);   // total count
```

```python
# Python
history = cv.workspaces.history("ws_abc123")
for entry in history:
    print(entry["commitId"])
```

```php
// PHP
$history = $cv->workspaces()->history('ws_abc123');
foreach ($history as $entry) {
    echo $entry['commitId'];
}
```

### Response (TypeScript)

```json
{
  "commits": [
    {
      "commitId": "commit_xyz789",
      "workspaceId": "ws_abc123",
      "parentId": "commit_prev",
      "metadata": { "agentId": "agent-001" },
      "sizeBytes": 1024,
      "createdAt": "2026-03-29T12:02:00Z"
    }
  ],
  "count": 1
}
```

### Response (Python/PHP)

Returns the commits array directly.

---

## Error Reference

All SDKs throw/raise typed errors for common failure cases:

| Error | HTTP Status | Description |
|-------|-------------|-------------|
| AuthError | 401, 403 | Invalid or missing API key |
| NotFoundError | 404 | Resource does not exist |
| ValidationError | 400, 422 | Invalid request parameters |
| ConflictError | 409 | Resource conflict (TypeScript only) |
| NetworkError | — | Connection failure or timeout |

All errors extend a base `ContextVaultError` (TypeScript/Python) or `ContextVaultException` (PHP).

### Auto-Retry

All SDKs automatically retry on network errors with exponential backoff:

- **TypeScript:** Up to `maxRetries` attempts (default 3)
- **Python:** Up to 3 attempts, 0.5s base backoff
- **PHP:** Up to `maxRetries` attempts (default 3), 1s base backoff
