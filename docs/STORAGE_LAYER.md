# ContextVault — Storage Abstraction Layer

## Goal

Abstract the storage layer so the same code works with SQLite locally and DynamoDB in production.

## Architecture

```
routes/
  └── calls → services/
                    └── calls → storage.interface.ts
                                      ├── sqlite.adapter.ts  (local)
                                      └── dynamodb.adapter.ts (production)
```

## Interface Design

```typescript
// src/storage/interfaces.ts

export interface IStorage {
  // Workspace operations
  createWorkspace(data: CreateWorkspaceInput): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  listWorkspaces(): Promise<Workspace[]>;
  deleteWorkspace(id: string): Promise<void>;

  // Commit operations
  createCommit(workspaceId: string, data: CreateCommitInput): Promise<Commit>;
  getCommit(workspaceId: string, commitId: string): Promise<Commit | null>;
  getLatestCommit(workspaceId: string): Promise<Commit | null>;
  listCommits(workspaceId: string, limit?: number, offset?: number): Promise<Commit[]>;
}

export interface CreateWorkspaceInput {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommitInput {
  id: string;
  workspaceId: string;
  parentId: string | null;
  files: FileRecord[];
  metadata: CommitMetadata;
  sizeBytes: number;
  createdAt: string;
}

export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Commit {
  id: string;
  workspaceId: string;
  parentId: string | null;
  files: FileRecord[];
  metadata: CommitMetadata;
  sizeBytes: number;
  createdAt: string;
}

export interface FileRecord {
  path: string;
  content: string;
}

export interface CommitMetadata {
  agentId?: string;
  taskId?: string;
  tags?: string[];
}
```

## Adapter Pattern

Each adapter implements `IStorage`:

### SQLite Adapter
- File storage via `./data/workspaces/{id}/commits/{commitId}/`
- Metadata in SQLite via `better-sqlite3`
-路径: `src/storage/sqlite.adapter.ts`

### DynamoDB Adapter
- File storage via S3
- Metadata in DynamoDB
-路径: `src/storage/dynamodb.adapter.ts`

## Factory Pattern

```typescript
// src/storage/index.ts

import { IStorage } from './interfaces';
import { SqliteStorage } from './sqlite.adapter';
import { DynamoDBStorage } from './dynamodb.adapter';

export function createStorage(): IStorage {
  const type = process.env.STORAGE_TYPE || 'sqlite';
  
  switch (type) {
    case 'sqlite':
      return new SqliteStorage();
    case 'dynamodb':
      return new DynamoDBStorage();
    default:
      throw new Error(`Unknown storage type: ${type}`);
  }
}

export { IStorage, Workspace, Commit, FileRecord, CommitMetadata } from './interfaces';
```

## Environment Variables

```bash
# Local development (default)
STORAGE_TYPE=sqlite

# Production
STORAGE_TYPE=dynamodb
DYNAMODB_ENDPOINT=https://dynamodb.us-east-1.amazonaws.com
DYNAMODB_REGION=us-east-1
S3_BUCKET=contextvault-production
```

## Migration Path

1. **Now:** SQLite adapter for local development ✅
2. **Later:** DynamoDB adapter for production
3. **Future:** Could add PostgreSQL, Supabase, etc.

## Benefits

- **Testability:** Can mock storage in unit tests
- **Flexibility:** Swap backends without touching business logic
- **Parity:** Local and production behave identically at the interface level
- **Extensibility:** Add new adapters without modifying existing code
