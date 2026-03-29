# @contextvault/sdk

Official TypeScript SDK for ContextVault.

## Installation

```bash
npm install @contextvault/sdk
```

Requires Node.js 18+ (uses native `fetch`).

## Quickstart

```typescript
import { ContextVaultClient } from "@contextvault/sdk";

const cv = new ContextVaultClient({
  apiKey: "cv-my-api-key",
  baseUrl: "http://localhost:3000", // optional, this is the default
});
```

## Usage

### Create a workspace

```typescript
const workspace = await cv.workspaces.create({
  customerId: "cust_123",
  name: "my-project",
});
console.log(workspace.id); // "ws_01HXY..."
```

### List workspaces

```typescript
// List all workspaces
const all = await cv.workspaces.list();

// Filter by customer
const mine = await cv.workspaces.list({ customerId: "cust_123" });
```

### Get a workspace

```typescript
const workspace = await cv.workspaces.get("ws_01HXY...");
```

### Delete a workspace

```typescript
await cv.workspaces.delete("ws_01HXY...");
```

### Sandbox lifecycle (checkout, commit, destroy)

```typescript
// 1. Checkout: creates a sandbox for the workspace
const sandbox = await cv.workspaces.checkout("ws_01HXY...");

// 2. Agent does work in the sandbox...

// 3. Commit: saves sandbox changes back to the workspace
const commit = await cv.workspaces.commit("ws_01HXY...", {
  message: "Updated profile",
  author: "agent-1",
});

// 4. Destroy: tears down the sandbox
await cv.workspaces.destroy("ws_01HXY...");
```

### Pull files

```typescript
// Pull all files from the latest commit
const result = await cv.workspaces.pull("ws_01HXY...");
for (const file of result.files) {
  console.log(file.path, file.content);
}

// Pull a specific version
const older = await cv.workspaces.pull("ws_01HXY...", "commit_abc");
```

### Get a single file

```typescript
const file = await cv.workspaces.getFile("ws_01HXY...", "profile/summary.md");
console.log(file.content);
```

### View commit history

```typescript
const history = await cv.workspaces.history("ws_01HXY...");
for (const entry of history.commits) {
  console.log(entry.commitId, entry.createdAt);
}

// Limit results
const recent = await cv.workspaces.history("ws_01HXY...", 5);
```

## Error handling

The SDK throws typed errors that you can catch and handle:

```typescript
import {
  NotFoundError,
  AuthError,
  ValidationError,
  NetworkError,
  ConflictError,
  ContextVaultError,
} from "@contextvault/sdk";

try {
  await cv.workspaces.get("ws_nonexistent");
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log("Workspace not found");
  } else if (err instanceof AuthError) {
    console.log("Invalid API key");
  } else if (err instanceof ValidationError) {
    console.log("Bad request:", err.message);
  } else if (err instanceof NetworkError) {
    console.log("Could not reach server:", err.message);
  } else if (err instanceof ConflictError) {
    console.log("Sandbox already exists");
  } else if (err instanceof ContextVaultError) {
    console.log("API error:", err.statusCode, err.message);
  }
}
```

## Auto-retry

Network errors and 5xx server errors are automatically retried with exponential backoff (up to 3 attempts by default). You can configure this:

```typescript
const cv = new ContextVaultClient({
  apiKey: "cv-my-api-key",
  maxRetries: 5, // retry up to 5 times
});
```

Client errors (4xx) are never retried.

## API reference

### `ContextVaultClient`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | API key for authentication |
| `baseUrl` | `string` | `http://localhost:3000` | Server base URL |
| `maxRetries` | `number` | `3` | Max retries for network/server errors |

### `cv.workspaces`

| Method | Description |
|--------|-------------|
| `create({ customerId, name })` | Create a new workspace |
| `list({ customerId? })` | List workspaces |
| `get(workspaceId)` | Get a workspace by ID |
| `delete(workspaceId)` | Soft-delete a workspace |
| `checkout(workspaceId)` | Create a sandbox (checkout) |
| `commit(workspaceId, options?)` | Commit sandbox changes |
| `destroy(workspaceId)` | Tear down the sandbox |
| `pull(workspaceId, version?)` | Pull files from latest or specific commit |
| `getFile(workspaceId, filePath)` | Get a single file |
| `history(workspaceId, limit?)` | Get commit history |

## License

MIT
