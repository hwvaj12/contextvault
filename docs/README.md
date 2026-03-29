# ContextVault Documentation

ContextVault provides persistent, versioned file storage for AI agents. Each workspace is a Git-backed container where agents can read, write, and commit files with full history tracking.

## Quick Links

| Resource | Description |
|----------|-------------|
| [TypeScript Quickstart](quickstart/typescript.md) | Get started with the TypeScript SDK |
| [Python Quickstart](quickstart/python.md) | Get started with the Python SDK |
| [PHP Quickstart](quickstart/php.md) | Get started with the PHP SDK |
| [Workspaces API Reference](api/workspaces.md) | Full API reference for workspace operations |
| [Basic Examples](examples/basic/) | Copy-pasteable examples for each language |

## SDKs

| SDK | Package | Install |
|-----|---------|---------|
| TypeScript | `@contextvault/sdk` | `npm install @contextvault/sdk` |
| Python | `contextvault` | `pip install contextvault` |
| PHP | `contextvault/contextvault-php` | `composer require contextvault/contextvault-php` |

## Core Concepts

**Workspaces** are isolated, versioned storage containers scoped to a customer. Each workspace is backed by Git, giving you full commit history.

**Sandboxes** are temporary working copies of a workspace. Check out a sandbox, let your agent write files, then commit the changes — or destroy the sandbox to discard them.

**Commits** capture a snapshot of all files in a workspace. Every commit has a message, author, and optional metadata (agent ID, task ID, tags).

## Typical Workflow

```
1. Create a workspace for a customer
2. Checkout a sandbox (creates a writable working copy)
3. Agent writes files to the sandbox path
4. Commit the changes (snapshot saved to history)
5. Destroy the sandbox (cleanup)
```

## Authentication

All API requests require an `X-API-Key` header:

```
X-API-Key: cv-test-api-key-123
```

The SDKs handle this automatically — just pass your API key when creating the client.

## API Base URL

Default: `http://localhost:3000`

All SDKs default to this URL. Override it by passing `baseUrl` (TypeScript/PHP) or `base_url` (Python) to the client constructor.
