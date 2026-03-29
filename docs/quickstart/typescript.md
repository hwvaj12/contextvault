# TypeScript Quickstart

Get up and running with ContextVault in TypeScript in under 5 minutes.

## Install

```bash
npm install @contextvault/sdk
```

## Initialize the Client

```typescript
import { ContextVaultClient } from '@contextvault/sdk';

const cv = new ContextVaultClient({
  apiKey: 'cv-test-api-key-123',
  baseUrl: 'http://localhost:3000', // optional, this is the default
  maxRetries: 3,                    // optional, default is 3
});
```

## Create a Workspace

```typescript
const workspace = await cv.workspaces.create({
  customerId: 'customer-123',
  name: 'agent-memory',
});

console.log(workspace.id); // workspace ID
```

## Checkout, Write, and Commit

```typescript
// 1. Checkout a sandbox
const sandbox = await cv.workspaces.checkout(workspace.id);
console.log(sandbox.path); // writable directory path

// 2. Your agent writes files to sandbox.path
// (use fs, or any file-writing method)

// 3. Commit the changes
const commit = await cv.workspaces.commit(workspace.id, {
  message: 'Save agent session data',
  author: 'my-agent',
  agentId: 'agent-001',
  taskId: 'task-abc',
  tags: ['session', 'memory'],
});

console.log(commit.commitId);

// 4. Cleanup
await cv.workspaces.destroy(workspace.id);
```

## Read Files

```typescript
// Get all files from latest commit
const result = await cv.workspaces.pull(workspace.id);
for (const file of result.files) {
  console.log(file.path, file.content);
}

// Get a single file
const file = await cv.workspaces.getFile(workspace.id, 'profile/summary.md');
console.log(file.content);
```

## View History

```typescript
const history = await cv.workspaces.history(workspace.id);
for (const entry of history.commits) {
  console.log(entry.commitId, entry.metadata);
}
```

## Error Handling

```typescript
import {
  NotFoundError,
  AuthError,
  ValidationError,
  NetworkError,
} from '@contextvault/sdk';

try {
  const ws = await cv.workspaces.get('nonexistent');
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log('Workspace not found');
  } else if (err instanceof AuthError) {
    console.log('Invalid API key');
  } else if (err instanceof ValidationError) {
    console.log('Bad request:', err.message);
  } else if (err instanceof NetworkError) {
    console.log('Connection failed:', err.message);
  }
}
```

## Next Steps

- [Full Workspaces API Reference](../api/workspaces.md)
- [Basic Examples](../examples/basic/typescript.md)
- [Python Quickstart](python.md) | [PHP Quickstart](php.md)
