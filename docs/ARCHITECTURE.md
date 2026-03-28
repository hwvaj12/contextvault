# ContextVault — Architecture

> Multi-tenant, versioned workspace layer for AI agent memory.
> "Git for AI agents" — each workspace is a Git repository.

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
        GitStorage[GitStorage]
    end

    subgraph "Data Layer"
        WorkspaceRepos["workspaces/{id}/.git"]
        Meta["workspace-meta/{id}.json"]
    end

    AI --> Routes
    UI --> Routes
    API --> Routes
    Routes --> Auth
    Auth --> WorkspaceSvc
    Auth --> CommitSvc
    WorkspaceSvc --> GitStorage
    CommitSvc --> GitStorage
    GitStorage --> WorkspaceRepos
    GitStorage --> Meta

    style AI fill:#e1f5fe
    style GitStorage fill:#e8f5e9
    style WorkspaceRepos fill:#fff3e0
```

---

## Key Insight: Git-native Storage

Each workspace IS a Git repository. All versioning is handled by Git — no custom commit tracking, no diff logic, no rollbacks to implement.

**Benefits:**
- Battle-tested Git operations (diff, merge, blame, revert)
- Branching for agent experiments
- Standard tool — no proprietary versioning
- Commit messages encode agent metadata

---

## Directory Structure

```
data/
├── workspace-meta/           # JSON files for workspace metadata
│   └── {workspaceId}.json   # (customerId, name, timestamps)
└── workspaces/
    └── {workspaceId}/       # One git repo per workspace
        └── .git/            # Actual Git repository
```

---

## Data Flow: Push (Agent Saves State)

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant API as Fastify API
    participant Service as Commit Service
    participant Git as GitStorage
    participant GitRepo as .git Repo

    Agent->>API: POST /workspaces/{id}/push<br/>{files, metadata}
    API->>API: Validate X-API-Key
    API->>Service: pushCommit(workspaceId, files, metadata)
    Service->>Git: pushCommit()
    Git->>GitRepo: git add -A
    Git->>GitRepo: git commit -m<br/>"agent: {id} | task: {id}\n---<br/>{json: files, size, ...}"
    GitRepo-->>Git: commit hash
    Git-->>Service: {commitId, parentId, sizeBytes}
    Service-->>API: 201 Created
    API-->>Agent: {commitId, ...}
```

---

## Data Flow: Pull (Agent Restores State)

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant API as Fastify API
    participant Service as Commit Service
    participant Git as GitStorage
    participant GitRepo as .git Repo

    Agent->>API: GET /workspaces/{id}/pull?version=xxx
    API->>API: Validate X-API-Key
    API->>Service: pullCommit(workspaceId, version?)
    Service->>Git: pullCommit()
    Git->>GitRepo: git log / git show
    GitRepo-->>Git: commit info + file contents
    Git-->>Service: {commitId, files, metadata}
    Service-->>API: 200 OK
    API-->>Agent: {commitId, files, metadata}
```

---

## Commit Message Format

Git commit messages encode agent metadata:

```
agent: agent_123 | task: task_456
---
{"agentId":"agent_123","taskId":"task_456","files":["summary.md"],"sizeBytes":1024}
```

**Parsed on read** to extract metadata without a database.

---

## Versioning Model (Git-native)

```mermaid
graph LR
    V1["v1 (root)"]
    V2["v2"]
    V3["v3"]
    RV["rollback<br/>to v1"]

    V1 --> V2
    V2 --> V3
    V3 --> RV

    style RV fill:#ffecb3
```

**Git handles:**
- Parent pointers
- Full history
- Diff between any two commits
- Revert/rollback creates new commit (preserves history)

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

    subgraph "Commits (Git Operations)"
        Push["POST /workspaces/:id/push"]
        Pull["GET /workspaces/:id/pull"]
        Hist["GET /workspaces/:id/history"]
        Diff["GET /workspaces/:id/diff"]
        Roll["POST /workspaces/:id/rollback"]
    end

    CWS --> Create["git init"]
    LWS --> List["ls workspace-meta/"]
    GWS --> Get["read meta JSON"]
    DWS --> Delete["mark deleted"]
    Push --> NewCommit["git add + commit"]
    Pull --> Latest["git show HEAD"]
    Pull -.-> Specific["git show {hash}"]
    Hist --> Log["git log"]
    Diff --> Compare["git diff"]
    Roll --> Revert["git revert"]

    style NewCommit fill:#e8f5e9
    style Log fill:#e8f5e9
```

---

## Storage Abstraction

```mermaid
classDiagram
    class IStorage {
        <<interface>>
        +createWorkspace(data) Workspace
        +getWorkspace(id) Workspace
        +listWorkspaces() Workspace[]
        +deleteWorkspace(id) void
        +pushCommit(wsId, files, meta) Commit
        +pullCommit(wsId, version?) Commit
        +getHistory(wsId) Commit[]
        +getDiff(wsId, from, to) Diff
        +rollback(wsId, hash) Commit
    }

    class GitStorage {
        +createWorkspace(data)
        +getWorkspace(id)
        +listWorkspaces()
        +deleteWorkspace(id)
        +pushCommit(wsId, files, meta)
        +pullCommit(wsId, version?)
        +getHistory(wsId)
        +getDiff(wsId, from, to)
        +rollback(wsId, hash)
    }

    IStorage <|.. GitStorage
```

**Current implementation:** GitStorage only (local filesystem)

**Future adapters:** S3-backed Git, GitHub-backed, etc.

---

## Why Git?

| Aspect | Custom Implementation | Git |
|--------|----------------------|-----|
| Diff | Write diff algorithm | `git diff` |
| History | Track commit records | `git log` |
| Rollback | Track reverse changes | `git revert` |
| Branching | Build from scratch | `git branch` |
| Storage | Custom file management | Git handles it |
| Reliability | Unknown | Battle-tested |

---

## Environment Configuration

```bash
# Local development (default)
STORAGE_TYPE=git
DATA_DIR=./data

# Future: Production with S3-backed Git
# STORAGE_TYPE=s3-git
# S3_BUCKET=contextvault-prod
```

---

## Security Model

```mermaid
graph TB
    Request["HTTP Request"]
    APIKey["X-API-Key Header"]
    Auth["Auth Middleware"]
    Workspace["Workspace Ownership"]
    Denied["401 Unauthorized"]
    Allowed["Proceed"]

    Request --> APIKey
    APIKey --> Auth
    Auth -->|Valid| Workspace
    Auth -->|Invalid| Denied
    Workspace -->|Owner| Allowed
    Workspace -->|Not Owner| Denied
```

---

## Verification Checklist

Before claiming a feature works:

- [ ] `npm run build` passes (TypeScript compiles)
- [ ] `npm run dev` starts without errors
- [ ] Create workspace → `.git` folder exists
- [ ] Push → `git log` shows commit with metadata
- [ ] Pull → files returned correctly
- [ ] History → commits parsed with metadata
- [ ] Diff → git diff output matches
- [ ] Rollback → new commit created, old content restored
- [ ] Push to GitHub
