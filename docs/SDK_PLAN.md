# ContextVault SDK & Documentation Plan

## Context

Build official SDKs for ContextVault in TypeScript, Python, and PHP. These SDKs make it easy for developers to integrate ContextVault into their applications.

## Current State

- ContextVault API exists (port 3000)
- Basic workspace/sandbox/commit endpoints
- SDKs don't exist yet
- Documentation is sparse

## Goals

1. **TypeScript SDK** (`@contextvault/sdk`) — Primary, most complete
2. **Python SDK** (`contextvault`) — Full parity with TypeScript
3. **PHP SDK** (`contextvault/contextvault-php`) — Full parity
4. **Documentation** — Quickstart, API reference, examples

## SDK Requirements

### Core Interface

```typescript
// Workspaces
const workspace = await cv.workspaces.create({ customerId, name });
const workspaces = await cv.workspaces.list({ customerId });
const workspace = await cv.workspaces.get(workspaceId);
await cv.workspaces.delete(workspaceId);

// Sandbox lifecycle
const sandbox = await cv.workspaces.checkout(workspaceId);
// sandbox.path — agent works here
await cv.workspaces.commit(workspaceId, { message, author });
await cv.workspaces.destroy(workspaceId);

// Pull (read files)
const files = await cv.workspaces.pull(workspaceId);
const file = await cv.workspaces.getFile(workspaceId, 'profile/summary.md');

// History
const history = await cv.workspaces.history(workspaceId);
```

### Features

| Feature | Description |
|---------|-------------|
| Auto-retry | Exponential backoff on network errors |
| Typed errors | Clear error classes (NotFoundError, AuthError, etc.) |
| Mock mode | Test without real ContextVault |
| TypeScript | Full type safety |
| Async/await | Modern async patterns |

## Directory Structure

```
~/Desktop/Ventures/ContextVault/
├── sdk/
│   ├── typescript/           # @contextvault/sdk
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   ├── workspaces.ts
│   │   │   ├── errors.ts
│   │   │   └── types.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── README.md
│   ├── python/               # contextvault
│   │   ├── src/
│   │   │   ├── __init__.py
│   │   │   ├── client.py
│   │   │   ├── workspaces.py
│   │   │   └── exceptions.py
│   │   ├── setup.py
│   │   ├── pyproject.toml
│   │   └── README.md
│   └── php/                  # contextvault/contextvault-php
│       ├── src/
│       │   ├── Client.php
│       │   ├── Workspaces.php
│       │   └── Exception/
│       ├── composer.json
│       └── README.md
└── docs/
    ├── README.md
    ├── quickstart/
    │   ├── typescript.md
    │   ├── python.md
    │   └── php.md
    ├── api/
    │   └── workspaces.md
    └── examples/
        ├── langchain/
        └── basic/
```

## Execution Plan

### Phase 1: TypeScript SDK (Priority)

1. Create `sdk/typescript/` directory structure
2. Implement `Client` class with API key handling
3. Implement `Workspaces` class with all methods:
   - `create`, `list`, `get`, `delete`
   - `checkout`, `commit`, `destroy`
   - `pull`, `getFile`, `history`
4. Implement error types
5. Add auto-retry logic
6. Write tests
7. Write README + examples
8. Publish to npm (later)

### Phase 2: Python SDK

1. Mirror TypeScript structure
2. Implement `Client` class
3. Implement `Workspaces` class
4. Add exception classes
5. Write setup.py and pyproject.toml
6. Write tests
7. Write README

### Phase 3: PHP SDK

1. Mirror TypeScript structure
2. Implement `Client` class
3. Implement `Workspaces` class
4. Add exception classes
5. Write composer.json
6. Write tests (PHPUnit)
7. Write README

### Phase 4: Documentation

1. Create `docs/README.md` (hub page)
2. Create `docs/quickstart/` with guides for each language
3. Create `docs/api/workspaces.md` (full API reference)
4. Create example projects

## Implementation Notes

### TypeScript

- Use `fetch` for HTTP
- Export `ContextVaultClient` as main export
- Use generic type for workspace responses
- Follow npm best practices

### Python

- Use `requests` library
- Exception hierarchy
- Type hints throughout
- Publish to PyPI later

### PHP

- Use `guzzlehttp/guzzle`
- PSR-4 autoloading
- Exception hierarchy
- Publish to Packagist later

## Out of Scope

- Publishing to npm/PyPI/Packagist (local only for now)
- Authentication beyond API key
- Webhook handling
- Advanced Git operations (for now, just push/pull)

## Success Criteria

- [ ] TypeScript SDK has all workspace methods working
- [ ] Python SDK has all workspace methods working
- [ ] PHP SDK has all workspace methods working
- [ ] All SDKs have README with quickstart
- [ ] Documentation has at least one example per language
- [ ] Code is clean and follows language conventions
