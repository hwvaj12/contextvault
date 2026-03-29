# PHP Quickstart

Get up and running with ContextVault in PHP in under 5 minutes.

## Install

```bash
composer require contextvault/contextvault-php
```

## Initialize the Client

```php
<?php

use ContextVault\Client;

$cv = new Client(
    apiKey: 'cv-test-api-key-123',
    baseUrl: 'http://localhost:3000', // optional, this is the default
    maxRetries: 3,                    // optional, default is 3
);
```

## Create a Workspace

```php
$workspace = $cv->workspaces()->create('customer-123', 'agent-memory');

echo $workspace['id'];
```

## Checkout, Write, and Commit

```php
// 1. Checkout a sandbox
$sandbox = $cv->workspaces()->checkout($workspace['id']);
echo $sandbox['path']; // writable directory path

// 2. Your agent writes files to $sandbox['path']
// (use file_put_contents, or any file-writing method)

// 3. Commit the changes
$commit = $cv->workspaces()->commit(
    $workspace['id'],
    'Save agent session data',
    'my-agent'
);

echo $commit['commitId'];

// 4. Cleanup
$cv->workspaces()->destroy($workspace['id']);
```

## Read Files

```php
// Get all files from latest commit
$files = $cv->workspaces()->pull($workspace['id']);
foreach ($files as $file) {
    echo $file['path'] . ': ' . $file['content'] . "\n";
}

// Get a single file
$file = $cv->workspaces()->getFile($workspace['id'], 'profile/summary.md');
echo $file['content'];
```

## View History

```php
$history = $cv->workspaces()->history($workspace['id']);
foreach ($history as $entry) {
    echo $entry['commitId'] . "\n";
}
```

## Error Handling

```php
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\AuthError;
use ContextVault\Exception\ValidationError;
use ContextVault\Exception\NetworkError;

try {
    $ws = $cv->workspaces()->get('nonexistent');
} catch (NotFoundError $e) {
    echo "Workspace not found\n";
} catch (AuthError $e) {
    echo "Invalid API key\n";
} catch (ValidationError $e) {
    echo "Bad request: " . $e->getMessage() . "\n";
} catch (NetworkError $e) {
    echo "Connection failed: " . $e->getMessage() . "\n";
}
```

The PHP SDK uses Guzzle for HTTP and automatically retries failed requests (up to 3 times) with exponential backoff.

## Next Steps

- [Full Workspaces API Reference](../api/workspaces.md)
- [Basic Examples](../examples/basic/php.md)
- [TypeScript Quickstart](typescript.md) | [Python Quickstart](python.md)
