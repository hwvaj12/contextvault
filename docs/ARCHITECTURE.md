# ContextVault — Architecture

> Multi-tenant, versioned workspace layer for AI agent memory.
> "Git over S3" — versioned file storage for agent context.

---

## System Overview

```mermaid
graph TB
    subgraph "Client Layer"
        AI[AI Agent]
        UI[React Test UI]
        API[API Consumer]
    end

    subgraph "API Layer"
        Fastify[Fastify Server]
        Auth[Auth Middleware]
        Routes[Route Handlers]
        Swagger[Swagger Docs]
    end

    subgraph "Service Layer"
        WorkspaceSvc[Workspace Service]
        CommitSvc[Commit Service]
    end

    subgraph "Storage Layer"
        Storage[Storage Factory]
        SQLite[(SQLite Adapter)]
        DynamoDB[(DynamoDB Adapter)]
        Files[File Storage]
    end

    subgraph "Data Layer"
        SQLiteDB[(SQLite DB)]
        S3[(S3 / Local FS)]
    end

    AI --> Routes
    UI --> Routes
    API --> Routes
    Routes --> Auth
    Auth --> WorkspaceSvc
    Auth --> CommitSvc
    WorkspaceSvc --> Storage
    CommitSvc --> Storage
    Storage --> Files
    Storage --> SQLite
    Storage --> DynamoDB
    SQLite --> SQLiteDB
    Files --> S3

    style AI fill:#e1f5fe
    style Files fill:#fff3e0
    style S3 fill:#fff3e0
```

---

## Data Flow: Push (Agent Saves State)

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant API as Fastify API
    participant Service as Commit Service
    participant Storage as Storage Layer
    participant FS as File System

    Agent->>API: POST /workspaces/{id}/push<br/>{files, metadata}
    API->>API: Validate API key
    API->>Service: createCommit(workspaceId, data)
    Service->>Storage: createCommit()
    Storage->>FS: Write files to<br/>/commits/{commitId}/
    Storage->>FS: Write manifest.json<br/>(commit metadata)
    Storage->>SQLiteDB: Insert commit record
    SQLiteDB-->>Storage: commit record
    FS-->>Storage: files written
    Storage-->>Service: Commit created
    Service-->>API: {commitId, parentId, ...}
    API-->>Agent: 201 Created
```

---

## Data Flow: Pull (Agent Restores State)

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant API as Fastify API
    participant Service as Commit Service
    participant Storage as Storage Layer
    participant FS as File System

    Agent->>API: GET /workspaces/{id}/pull<br/>?version=xxx (optional)
    API->>API: Validate API key
    API->>Service: getCommit(workspaceId, version?)
    Service->>Storage: getLatestCommit() or<br/>getCommit(commitId)
    Storage->>SQLiteDB: Query commit record
    SQLiteDB-->>Storage: commit record
    Storage->>FS: Read manifest.json
    Storage->>FS: Read all files in commit
    FS-->>Storage: files content
    Storage-->>Service: Commit with files
    Service-->>API: {commitId, files, metadata}
    API-->>Agent: 200 OK
```

---

## Directory Structure (File Storage)

```mermaid
graph TD
    Root["data/"]
    WS["workspaces/"]
    Commits["commits/"]
    Commit1["v_001/"]
    Commit2["v_002/"]
    Manifest1["manifest.json"]
    Manifest2["manifest.json"]
    Files1["files/"]
    Files2["files/"]
    Summary["summary.md"]
    Output["output.json"]
    State["state.json"]

    Root --> WS
    WS --> WS1["ws_abc123/"]
    WS1 --> Commits
    Commits --> Commit1
    Commits --> Commit2
    Commit1 --> Manifest1
    Commit1 --> Files1
    Commit2 --> Manifest2
    Commit2 --> Files2
    Files1 --> Summary
    Files1 --> Output
    Files2 --> Summary
    Files2 --> State

    style Root fill:#fafafa
    style Manifest1 fill:#e8f5e9
    style Manifest2 fill:#e8f5e9
```

---

## Storage Abstraction Layer

```mermaid
classDiagram
    class IStorage {
        <<interface>>
        +createWorkspace(data) Workspace
        +getWorkspace(id) Workspace
        +listWorkspaces() Workspace[]
        +deleteWorkspace(id) void
        +createCommit(wsId, data) Commit
        +getCommit(wsId, commitId) Commit
        +getLatestCommit(wsId) Commit
        +listCommits(wsId) Commit[]
    }

    class SqliteStorage {
        +createWorkspace(data)
        +getWorkspace(id)
        +listWorkspaces()
        +deleteWorkspace(id)
        +createCommit(wsId, data)
        +getCommit(wsId, commitId)
        +getLatestCommit(wsId)
        +listCommits(wsId)
    }

    class DynamoDBStorage {
        +createWorkspace(data)
        +getWorkspace(id)
        +listWorkspaces()
        +deleteWorkspace(id)
        +createCommit(wsId, data)
        +getCommit(wsId, commitId)
        +getLatestCommit(wsId)
        +listCommits(wsId)
    }

    class StorageFactory {
        +createStorage() IStorage
    }

    IStorage <|.. SqliteStorage
    IStorage <|.. DynamoDBStorage
    StorageFactory ..> IStorage

    note for StorageFactory "STORAGE_TYPE=sqlite<br/>STORAGE_TYPE=dynamodb"
```

---

## API Endpoints

```mermaid
graph LR
    subgraph "Workspaces"
        CWS["POST /workspaces"]
        LWS["GET /workspaces"]
        GWS["GET /workspaces/:id"]
        DWS["DELETE /workspaces/:id"]
    end

    subgraph "Commits"
        Push["POST /workspaces/:id/push"]
        Pull["GET /workspaces/:id/pull"]
        Hist["GET /workspaces/:id/history"]
        Diff["GET /workspaces/:id/diff"]
        Roll["POST /workspaces/:id/rollback"]
    end

    subgraph "System"
        Health["GET /health"]
        Docs["GET /docs"]
    end

    CWS --> Create["Create workspace"]
    LWS --> List["List all workspaces"]
    GWS --> Get["Get workspace details"]
    DWS --> Delete["Soft delete workspace"]
    Push --> NewCommit["Create new commit"]
    Pull --> Latest["Get latest commit"]
    Pull -.-> Specific["Get specific version"]
    Hist --> Commits["List commit history"]
    Diff --> Compare["Compare two versions"]
    Roll --> Revert["Revert to version"]

    style Create fill:#e3f2fd
    style NewCommit fill:#e8f5e9
    style Latest fill:#fff3e0
```

---

## Manifest Format

Each commit folder contains a `manifest.json`:

```json
{
  "commitId": "v_01KMV8AD9C57X4BE65ZGFC672S",
  "workspaceId": "ws_01KMV8A7Q49R28XN7CHH0TAA8Z",
  "parentId": "v_01KMV8A7Q49R28XN7CHH0TAA8Z",
  "metadata": {
    "agentId": "agent_support_01",
    "taskId": "ticket_123",
    "tags": ["resolved", "customer_a"]
  },
  "sizeBytes": 1024,
  "createdAt": "2026-03-28T14:30:00Z",
  "files": [
    {
      "path": "context/summary.md",
      "content": "# Task Summary\n\nResolved issue..."
    },
    {
      "path": "artifacts/response.json",
      "content": "{\"status\": \"success\"}"
    }
  ]
}
```

---

## Versioning Model (Git-like)

```mermaid
graph LR
    V1["v_001<br/>parent: null"]
    V2["v_002<br/>parent: v_001"]
    V3["v_003<br/>parent: v_002"]
    V4["v_004<br/>parent: v_003<br/>(rollback)"]

    V1 --> V2
    V2 --> V3
    V3 --> V4

    style V4 fill:#ffecb3
```

**Key concepts:**
- Each commit has a `parentId` (like git)
- Rollback creates a *new* commit (doesn't destroy history)
- Files stored directly (content-addressable in future)

---

## Why Filesystem + Database?

| Concern | Filesystem | Database |
|---------|------------|----------|
| Agent artifacts (code, outputs) | ✅ Native | ❌ Awkward |
| Version history | ✅ Git-like | ❌ Extra complexity |
| Streaming/binary data | ✅ Native | ⚠️ BLOB needed |
| "List all workspaces" | ❌ Slow scan | ✅ Indexed |
| "Find commits by agent" | ❌ Full scan | ✅ Indexed |
| Simplicity | ✅ Just files | ❌ Schema migrations |

**Current approach:** Filesystem for artifacts + SQLite for metadata index.

**Future:** Could drop SQLite entirely and use a manifest-based approach (filesystem IS the database).

---

## Environment Configuration

```mermaid
graph TD
    ENV["Environment Variables"]
    StorageType["STORAGE_TYPE"]
    DBPath["DB_PATH<br/>(SQLite)"]
    S3Bucket["S3_BUCKET<br/>(Production)"]
    DynamoEndpoint["DYNAMODB_ENDPOINT<br/>(Production)"]
    APIKey["API_KEY"]

    ENV --> StorageType
    StorageType --> Local["sqlite"]
    StorageType --> Prod["dynamodb"]
    Local --> DBPath
    Prod --> S3Bucket
    Prod --> DynamoEndpoint
    ENV --> APIKey

    style StorageType fill:#e8f5e9
    style Local fill:#c8e6c9
    style Prod fill:#ffccbc
```

---

## Security Model

```mermaid
graph TB
    Request["HTTP Request"]
    APIKey["X-API-Key Header"]
    Auth["Auth Middleware"]
    Workspace["Workspace Access Check"]
    Denied["401 Unauthorized"]
    Allowed["Proceed"]

    Request --> APIKey
    APIKey --> Auth
    Auth -->|Valid| Workspace
    Auth -->|Invalid| Denied
    Workspace -->|Same Org| Allowed
    Workspace -->|Wrong Org| Denied
```
