# PHP Basic Example

A complete example that creates a workspace, writes files, commits, reads them back, and cleans up.

## Full Workflow

```php
<?php

require_once __DIR__ . '/vendor/autoload.php';

use ContextVault\Client;
use ContextVault\Exception\NotFoundError;

// Initialize client
$cv = new Client(
    apiKey: 'cv-test-api-key-123',
    baseUrl: 'http://localhost:3000',
);

$customerId = 'customer-123';

// --- Create a workspace ---
$workspace = $cv->workspaces()->create($customerId, 'demo-workspace');
$workspaceId = $workspace['id'];
echo "Created workspace: {$workspaceId}\n";

// --- Checkout a sandbox ---
$sandbox = $cv->workspaces()->checkout($workspaceId);
$sandboxPath = $sandbox['path'];
echo "Sandbox path: {$sandboxPath}\n";

// --- Write files to the sandbox ---
if ($sandboxPath) {
    $notesDir = $sandboxPath . '/notes';
    if (!is_dir($notesDir)) {
        mkdir($notesDir, 0755, true);
    }

    file_put_contents(
        $notesDir . '/meeting.md',
        "# Meeting Notes\n\n- Discussed project timeline\n- Agreed on milestones\n"
    );

    file_put_contents(
        $sandboxPath . '/config.json',
        json_encode(['theme' => 'dark', 'language' => 'en'], JSON_PRETTY_PRINT)
    );
}

// --- Commit changes ---
$commit = $cv->workspaces()->commit($workspaceId, 'Add meeting notes and config', 'demo-agent');
echo "Committed: {$commit['commitId']}\n";

// --- Destroy the sandbox ---
$cv->workspaces()->destroy($workspaceId);
echo "Sandbox destroyed\n";

// --- Pull files back ---
$files = $cv->workspaces()->pull($workspaceId);
echo "\nFiles in workspace:\n";
foreach ($files as $file) {
    echo "  {$file['path']} (" . strlen($file['content']) . " bytes)\n";
}

// --- Get a single file ---
$meeting = $cv->workspaces()->getFile($workspaceId, 'notes/meeting.md');
echo "\nMeeting notes content:\n";
echo $meeting['content'] . "\n";

// --- View history ---
$history = $cv->workspaces()->history($workspaceId);
echo "\nCommit history:\n";
foreach ($history as $entry) {
    echo "  {$entry['commitId']}\n";
}

// --- List all workspaces for this customer ---
$workspaces = $cv->workspaces()->list($customerId);
echo "\nCustomer has " . count($workspaces) . " workspace(s)\n";

// --- Cleanup: delete the workspace ---
$cv->workspaces()->delete($workspaceId);
echo "Workspace deleted\n";

// --- Verify deletion ---
try {
    $cv->workspaces()->get($workspaceId);
} catch (NotFoundError $e) {
    echo "Confirmed: workspace no longer exists\n";
}
```

## Run It

```bash
php example.php
```
