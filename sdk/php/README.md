# ContextVault PHP SDK

Official PHP SDK for [ContextVault](https://github.com/contextvault) -- versioned context storage for AI agents.

## Requirements

- PHP 8.0+
- Guzzle 7.x

## Installation

```bash
composer require contextvault/contextvault-php
```

## Quickstart

```php
<?php

require_once 'vendor/autoload.php';

use ContextVault\Client;
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\AuthError;

// Initialize the client
$cv = new Client('your-api-key', 'http://localhost:3000');

// Create a workspace
$workspace = $cv->workspaces()->create('customer-123', 'my-workspace');
$workspaceId = $workspace['id'];

// List workspaces for a customer
$workspaces = $cv->workspaces()->list('customer-123');

// Get a single workspace
$workspace = $cv->workspaces()->get($workspaceId);

// Checkout a sandbox for editing
$sandbox = $cv->workspaces()->checkout($workspaceId);

// Commit changes
$result = $cv->workspaces()->commit($workspaceId, 'Updated profile', 'agent@example.com');

// Destroy the sandbox when done
$cv->workspaces()->destroy($workspaceId);

// Pull files from a workspace
$files = $cv->workspaces()->pull($workspaceId);

// Get a specific file
$file = $cv->workspaces()->getFile($workspaceId, 'profile/summary.md');

// View commit history
$history = $cv->workspaces()->history($workspaceId);

// Delete a workspace
$cv->workspaces()->delete($workspaceId);
```

## Error Handling

The SDK throws typed exceptions for different error scenarios:

```php
use ContextVault\Exception\AuthError;
use ContextVault\Exception\NotFoundError;
use ContextVault\Exception\ValidationError;
use ContextVault\Exception\NetworkError;
use ContextVault\Exception\ContextVaultException;

try {
    $workspace = $cv->workspaces()->get('nonexistent-id');
} catch (NotFoundError $e) {
    // 404 - Resource not found
    echo "Not found: " . $e->getMessage();
} catch (AuthError $e) {
    // 401/403 - Authentication or authorization failure
    echo "Auth error: " . $e->getMessage();
} catch (ValidationError $e) {
    // 400/422 - Invalid request data
    echo "Validation error: " . $e->getMessage();
} catch (NetworkError $e) {
    // Connection failures (after retries exhausted)
    echo "Network error: " . $e->getMessage();
} catch (ContextVaultException $e) {
    // Any other API error
    echo "Error ({$e->getStatusCode()}): " . $e->getMessage();
}
```

## Configuration

```php
// Custom base URL and retry count
$cv = new Client(
    apiKey: 'your-api-key',
    baseUrl: 'https://api.contextvault.io',
    maxRetries: 5
);
```

## Features

- **Auto-retry**: Exponential backoff on network errors (default: 3 retries)
- **Typed exceptions**: Clear error classes mapped from HTTP status codes
- **PSR-4 autoloading**: Standard Composer autoloading
- **PHP 8.0+**: Typed properties, named arguments, match expressions

## License

MIT
