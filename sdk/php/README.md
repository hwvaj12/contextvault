# ContextVault PHP SDK

Official PHP SDK for [ContextVault](https://github.com/hwvaj12/contextvault) — versioned context storage for AI agents.

## Installation

```bash
composer require contextvault/contextvault-php
```

## Quickstart

```php
<?php

require_once 'vendor/autoload.php';

use ContextVault\Client;

// Initialize the client
$client = new Client('your-api-key', 'http://localhost:3000');

// Create a workspace
$workspace = $client->workspaces()->create('cust_123', 'my-agent-project');
echo "Created workspace: " . $workspace['id'] . "\n";

// Checkout to get a sandbox
$sandbox = $client->workspaces()->checkout($workspace['id']);
echo "Sandbox path: " . ($sandbox['sandboxPath'] ?? 'N/A') . "\n";

// Commit changes
$commit = $client->workspaces()->commit($workspace['id'], [
    'message' => 'Initial files',
    'agentId' => 'agent_001',
    'tags' => ['setup'],
]);
echo "Commit: " . $commit['commitId'] . "\n";

// Pull latest files
$pullResult = $client->workspaces()->pull($workspace['id']);
foreach ($pullResult['files'] as $file) {
    echo $file['path'] . ": " . strlen($file['content']) . " bytes\n";
}

// Get a single file
$file = $client->workspaces()->getFile($workspace['id'], 'README.md');
echo $file['path'] . " content: " . substr($file['content'], 0, 100) . "...\n";

// Get commit history
$history = $client->workspaces()->history($workspace['id'], 10);
echo "Total commits: " . $history['count'] . "\n";

// Diff between two commits
$diff = $client->workspaces()->diff($workspace['id'], 'commit_aaa', 'commit_bbb');
echo "Added: " . implode(', ', $diff['added']) . "\n";
echo "Modified: " . implode(', ', $diff['modified']) . "\n";

// Destroy sandbox when done
$client->workspaces()->destroy($workspace['id']);
echo "Sandbox destroyed\n";

// List workspaces
$workspaces = $client->workspaces()->list('cust_123');
foreach ($workspaces as $ws) {
    echo "- {$ws['name']} ({$ws['id']})\n";
}

// Delete workspace
$client->workspaces()->delete($workspace['id']);
echo "Workspace deleted\n";
```

## API Reference

### Client

```php
$client = new Client(string $apiKey, string $baseUrl = 'http://localhost:3000', int $maxRetries = 3);
```

### Workspaces

| Method | Description |
|--------|-------------|
| `create(string $customerId, string $name)` | Create a new workspace |
| `list(?string $customerId = null)` | List all workspaces, optionally filtered |
| `get(string $workspaceId)` | Get a workspace by ID |
| `delete(string $workspaceId)` | Soft-delete a workspace |
| `bulkDelete(array $workspaceIds)` | Soft-delete multiple workspaces |
| `clone(string $workspaceId, string $targetCustomerId, ?string $name = null)` | Clone a workspace to another customer |
| `checkout(string $workspaceId)` | Create a sandbox for editing |
| `commit(string $workspaceId, array $options = [])` | Commit sandbox changes |
| `destroy(string $workspaceId)` | Destroy the sandbox |
| `pull(string $workspaceId, ?string $version = null)` | Pull latest files |
| `getFile(string $workspaceId, string $filePath)` | Get a single file |
| `diff(string $workspaceId, string $from, string $to)` | Compare two commits |
| `history(string $workspaceId, ?int $limit = null)` | Get commit history |

### Commit Options

```php
$client->workspaces()->commit($workspaceId, [
    'message'  => 'What changed',   // Commit message
    'author'   => 'Agent Name',     // Author name
    'agentId'  => 'agent_001',       // Agent identifier
    'taskId'   => 'task_123',       // Task identifier
    'tags'     => ['tag1', 'tag2'], // Metadata tags
]);
```

## Patterns

### Pattern 1: Single-Agent Session

A single agent uses a workspace as its memory for one task or conversation.

```
Agent → create workspace (if needed)
     → checkout → work in sandbox → commit
     → destroy sandbox
```

**When to use:** One agent handling a standalone task. No other agent needs this workspace.

```php
$client = new Client('your-api-key');

// Start: pull latest context
$state = $client->workspaces()->pull($workspaceId);
$files = $state['files'];

// Agent processes files...

// Done: checkout, write results, commit
$sandbox = $client->workspaces()->checkout($workspaceId);
// Write files to $sandbox['sandboxPath']...

$client->workspaces()->commit($workspaceId, [
    'message' => 'Analysis complete',
    'agentId' => 'agent_001',
    'tags'    => ['completed'],
]);
$client->workspaces()->destroy($workspaceId);
```

---

### Pattern 2: Multi-Agent Handoff

Agent A creates and populates a workspace. Agent B later pulls that workspace and continues from where A left off.

```
Agent A → create → checkout → commit (does research)
                                     ↓
Agent B →                    pull → checkout → commit (acts on research)
```

**When to use:** Sequential handoffs. Agent A does research, Agent B acts on it.

**Key behavior:**
- `pull()` with no `$version` returns HEAD (latest commit)
- Each commit is immutable — Agent B always sees a complete snapshot
- Agent B's commits stack on top — Agent A's history is preserved

```php
// Agent A: create and populate
$ws = $client->workspaces()->create('cust_123', 'research-handoff');
$sandbox = $client->workspaces()->checkout($ws['id']);
// Agent A writes research files to sandbox...
$client->workspaces()->commit($ws['id'], [
    'agentId' => 'researcher',
    'tags'    => ['research-done'],
]);
$client->workspaces()->destroy($ws['id']);

// Agent B: pick up where A left off
$state = $client->workspaces()->pull($ws['id']);
// $state['files'] contains all of Agent A's work
$sandbox = $client->workspaces()->checkout($ws['id']);
// Agent B writes action files to sandbox...
$client->workspaces()->commit($ws['id'], [
    'agentId' => 'executor',
    'tags'    => ['execution-done'],
]);
$client->workspaces()->destroy($ws['id']);
```

---

### Pattern 3: Resumable Session

An agent works intermittently. Each interaction commits state. The next interaction resumes from the last commit.

```
Interaction 1 → checkout → commit ("in-progress-1")
Interaction 2 → pull → checkout → commit ("in-progress-2")
Interaction 3 → pull → checkout → commit ("done")
```

**When to use:** Long-running tasks that span multiple conversations or sessions. Chatbots, code assistants, research agents.

**Key behavior:**
- Each `commit()` creates a new commit on top of previous
- `pull()` always gets the latest state
- Use tags to track progress: `in-progress`, `review-needed`, `complete`

```php
function saveProgress(Client $client, string $workspaceId, string $sessionId): void
{
    $client->workspaces()->commit($workspaceId, [
        'message' => 'Progress checkpoint',
        'tags'    => ['in-progress', "session-{$sessionId}"],
    ]);
    $client->workspaces()->destroy($workspaceId);
}

function loadProgress(Client $client, string $workspaceId): array
{
    return $client->workspaces()->pull($workspaceId)['files'];
}

// Usage
$files = loadProgress($client, $workspaceId);
// Agent works...
$sandbox = $client->workspaces()->checkout($workspaceId);
// Write updated files to sandbox...
saveProgress($client, $workspaceId, 'sess_abc');
```

---

### Pattern 4: Error Recovery

#### Workspace not found — create on first use

```php
use ContextVault\Exception\NotFoundError;

try {
    $state = $client->workspaces()->pull($workspaceId);
} catch (NotFoundError $e) {
    $ws = $client->workspaces()->create($customerId, 'my-workspace');
    $workspaceId = $ws['id'];
    // Workspace is empty — proceed with initial setup
}
```

#### Sandbox conflict — destroy stale sandbox and retry

```php
use ContextVault\Exception\ConflictError;

try {
    $sandbox = $client->workspaces()->checkout($workspaceId);
} catch (ConflictError $e) {
    // Sandbox already exists (previous run didn't clean up)
    $client->workspaces()->destroy($workspaceId);
    $sandbox = $client->workspaces()->checkout($workspaceId);
}
```

#### Agent crash recovery — commit or discard orphaned work

```php
// On agent restart, check for orphaned sandbox
try {
    // Try committing any in-progress work
    $client->workspaces()->commit($workspaceId, [
        'message' => 'Crash recovery — auto-committed',
        'tags'    => ['crash-recovery'],
    ]);
    $client->workspaces()->destroy($workspaceId);
} catch (NotFoundError $e) {
    // No sandbox — nothing to recover
} catch (\Exception $e) {
    // Commit failed — discard and start fresh
    $client->workspaces()->destroy($workspaceId);
}
```

---

## Error Handling

All SDK methods throw typed exceptions that extend `ContextVault\Exception\ContextVaultException`.

```php
use ContextVault\Client;
use ContextVault\Exception\AuthError;
use ContextVault\Exception\ConflictError;
use ContextVault\Exception\NetworkError;
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\ValidationError;

try {
    $workspace = $client->workspaces()->get('ws_nonexistent');
} catch (NotFoundError $e) {
    // 404 — workspace/sandbox/commit not found
    echo "Not found: " . $e->getMessage() . "\n";
    echo "Status: " . $e->getStatusCode() . "\n";
} catch (AuthError $e) {
    // 401 — invalid or missing API key
    echo "Auth failed: " . $e->getMessage() . "\n";
} catch (ValidationError $e) {
    // 400 — invalid parameters (bad workspace ID format, missing fields)
    echo "Validation: " . $e->getMessage() . "\n";
} catch (ConflictError $e) {
    // 409 — sandbox already exists, workspace locked
    echo "Conflict: " . $e->getMessage() . "\n";
} catch (NetworkError $e) {
    // Connection failed, timeout, DNS resolution error
    echo "Network: " . $e->getMessage() . "\n";
}
```

### Common Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `NotFoundError` | Workspace/sandbox/commit doesn't exist | Create the resource or check the ID |
| `AuthError` | Invalid or missing API key | Verify your API key |
| `ValidationError` | Bad parameters (e.g. invalid workspace ID format) | Check input format — IDs must match `ws_[A-Za-z0-9]+` |
| `ConflictError` | Sandbox already exists or workspace is locked | Destroy the existing sandbox, then retry |
| `NetworkError` | Server unreachable, timeout | Check server URL, retry with backoff (built-in: 3 retries) |

## Response Shapes

### Workspace
```json
{
  "id": "ws_xxx",
  "customerId": "cust_xxx",
  "name": "my-workspace",
  "latestCommitId": "commit_xxx",
  "createdAt": "2025-01-15T10:00:00Z",
  "updatedAt": "2025-01-15T10:00:00Z",
  "deletedAt": null
}
```

### Sandbox
```json
{
  "sandboxId": "sb_xxx",
  "workspaceId": "ws_xxx",
  "sandboxPath": "/path/to/sandbox",
  "createdAt": "2025-01-15T10:00:00Z"
}
```

### CommitEntry
```json
{
  "commitId": "commit_xxx",
  "workspaceId": "ws_xxx",
  "parentId": "commit_yyy",
  "metadata": { "agentId": "agent_001" },
  "sizeBytes": 1234,
  "createdAt": "2025-01-15T10:00:00Z"
}
```

### PullResult
```json
{
  "commitId": "commit_xxx",
  "workspaceId": "ws_xxx",
  "parentId": "commit_yyy",
  "files": [
    { "path": "README.md", "content": "# Hello World" }
  ],
  "metadata": { "agentId": "agent_001" },
  "sizeBytes": 1234,
  "createdAt": "2025-01-15T10:00:00Z"
}
```

### HistoryResult
```json
{
  "commits": [/* CommitEntry[] */],
  "count": 42
}
```

## License

MIT
