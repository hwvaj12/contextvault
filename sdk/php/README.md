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
| `checkout(string $workspaceId)` | Create a sandbox for editing |
| `commit(string $workspaceId, array $options = [])` | Commit sandbox changes |
| `destroy(string $workspaceId)` | Destroy the sandbox |
| `pull(string $workspaceId, ?string $version = null)` | Pull latest files |
| `getFile(string $workspaceId, string $filePath)` | Get a single file |
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

## Error Handling

```php
use ContextVault\Client;
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\AuthError;
use ContextVault\Exception\ValidationError;
use ContextVault\Exception\NetworkError;

try {
    $workspace = $client->workspaces()->get('nonexistent-id');
} catch (NotFoundError $e) {
    echo "Workspace not found: " . $e->getMessage();
    echo "Status: " . $e->getStatusCode();
} catch (AuthError $e) {
    echo "Authentication failed: " . $e->getMessage();
} catch (ValidationError $e) {
    echo "Validation error: " . $e->getMessage();
} catch (NetworkError $e) {
    echo "Network error: " . $e->getMessage();
}
```

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
