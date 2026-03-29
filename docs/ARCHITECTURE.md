# ContextVault — Architecture

> **Durable, Git-backed workspace memory for AI agents with ephemeral execution sandboxes.**

## Overview

ContextVault solves the problem of stateless AI agents. Every session starts from scratch, losing context, artifacts, and work history.

ContextVault provides:
- **Durable workspace memory** — Each workspace is a Git repository that persists forever
- **Ephemeral sandboxes** — Agents materialize workspaces into temporary directories
- **Version history** — Every change is a Git commit. Full audit trail, diff, rollback
- **Concurrency control** — Multiple agents can work safely with conflict detection
- **Multi-tenant** — Customer-scoped workspaces with API key isolation

## Core Design Principles

### 1. Durable repo state != ephemeral execution state

Three distinct concepts that must never be conflated:

| Concept | Description | Durability |
|---------|-------------|------------|
| **Canonical workspace repo** | Source of truth, Git repo | Permanent |
| **Ephemeral sandbox** | Temp working tree for one run | Destroyed after run |
| **Agent context** | What's in the model's context window | Ephemeral |

### 2. Git is the durable state engine

Git is used as the source of truth because it provides:
- Version history
- Diffs
- Rollback
- Branching
- Content-addressable storage
- Battle-tested concurrency semantics

### 3. Agents operate on files, not Git internals

Agents should interact with normal filesystem trees:
- read/write/create/delete files
- Agents should NOT understand branch management, rebases, or repository plumbing

### 4. Sandboxes must be disposable

Sandboxes exist only for the duration of one run. After finalization:
- Sandbox is destroyed
- Changes are committed to canonical repo
- Next run starts fresh

### 5. Concurrency must be explicit

Multiple agents can touch the same workspace. The system must:
- Record base commit at run start
- Detect conflicts at finalize time
- Never silently overwrite concurrent changes

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         ContextVault                             │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Control Plane                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
│  │  │Workspace │  │   Run    │  │   Lock   │  │  Audit   │  │ │
│  │  │ Service  │  │ Service  │  │ Service  │  │  Event   │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │                    Commit Gateway                            │ │
│  │  • Change detection  • Branch management  • Merge policy   │ │
│  └───────────────────────────┼───────────────────────────────┘ │
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │              Canonical Repo Store                            │ │
│  │         (Bare Git repos per workspace)                       │ │
│  │         data/workspaces/{workspaceId}.git                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Git clone/fetch/push
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Ephemeral Sandbox                             │
│  /tmp/contextvault/runs/{run_id}/workspace/                     │
│                                                                  │
│  • Materialized from canonical repo at base commit              │
│  • Agent reads/writes files normally                            │
│  • Destroyed after run finalization                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Workspace

```typescript
interface Workspace {
  id: string;              // ws_01HXXXXXXXX
  customerId: string;      // "meta-profile"
  name: string;            // "LeBron James"
  repoLocation: string;    // Path to bare repo
  defaultBranch: string;   // "main"
  currentHead: string;     // Latest commit hash
  status: 'active' | 'suspended' | 'deleted';
  storageClass: string;    // "standard" | "archive"
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}
```

### Run

One agent job operating against one workspace at a specific base commit.

```typescript
interface Run {
  id: string;              // run_01HXXXXXXXX
  workspaceId: string;
  agentId: string;         // "meta-profile-agent"
  baseCommit: string;      // Commit used to materialize sandbox
  finalCommit: string | null;
  status: RunStatus;
  sandboxPath: string | null;
  startedAt: string;
  completedAt: string | null;
  failureReason: string | null;
  executionSummary: string | null;
  mergeStatus: 'pending' | 'merged' | 'conflicted' | 'failed';
}

type RunStatus = 
  | 'created'      // Run record created
  | 'provisioning' // Sandbox being created
  | 'ready'        // Sandbox ready, agent can start
  | 'running'      // Agent actively working
  | 'finalizing'   // Detecting changes, creating commit
  | 'merged'       // Successfully committed to canonical
  | 'conflicted'   // Merge conflict detected
  | 'failed'       // Execution failed
  | 'aborted'      // Manually aborted
  | 'cleaned_up';  // Sandbox destroyed
```

### Lock

```typescript
interface Lock {
  id: string;
  workspaceId: string;
  lockType: 'exclusive' | 'shared';
  ownerRunId: string;
  acquiredAt: string;
  expiresAt: string;
}
```

### Audit Event

```typescript
interface AuditEvent {
  id: string;
  workspaceId: string;
  runId: string | null;
  actorType: 'agent' | 'user' | 'system';
  actorId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
```

---

## Run Lifecycle

```
┌──────────┐
│ created  │ ← Run record created
└────┬─────┘
     ▼
┌────────────┐
│ provisioning│ ← Sandbox being materialized
└────┬───────┘
     ▼
┌──────────┐
│  ready   │ ← Sandbox ready
└────┬─────┘
     ▼
┌──────────┐
│ running  │ ← Agent working in sandbox
└────┬─────┘
     ▼
┌─────────────┐
│ finalizing  │ ← Detecting changes, committing
└──────┬──────┘
       │
       ├──────────────────┬──────────────────┐
       ▼                  ▼                  ▼
┌──────────┐       ┌────────────┐     ┌──────────┐
│ merged   │       │ conflicted │     │  failed  │
└────┬─────┘       └─────┬──────┘     └────┬─────┘
     │                   │                  │
     └───────────────────┴──────────────────┘
                       │
                       ▼
               ┌──────────────┐
               │ cleaned_up   │ ← Sandbox destroyed
               └──────────────┘
```

---

## Concurrency Model

### How It Works

1. **Run starts** → System records:
   - `baseCommit` — the commit sandbox was created from
   - `workspaceHead` — the HEAD of canonical repo at start

2. **Run finalizes** → System checks:
   - Has canonical HEAD changed since run started?
   - If no → fast-forward or normal merge
   - If yes but clean → merge commit
   - If conflict → mark `conflicted`, preserve for resolution

3. **Conflict resolution** (future):
   - Human or agent reviews
   - Decides: accept ours/theirs/rebase

### Lock Types

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Exclusive** | One mutable run per workspace at a time | Safer, simpler |
| **Optimistic** | Parallel runs, detect divergence at merge | Higher throughput |

**v1 default:** Exclusive locking (simpler, less risk)

---

## Default Workspace Layout

**ContextVault uses BLANK workspaces.** No forced structure. No template files.

When a workspace is created, it's an empty Git repository. AI agents decide what files and directories to create based on their needs.

This is intentional — different agents have different memory needs. Forcing a structure would be a leaky abstraction.

If you need a structured workspace, seed it yourself after creation.

---

## API Endpoints

### Workspaces
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/workspaces` | Create workspace (seeds layout) |
| GET | `/workspaces` | List workspaces (filter by customer) |
| GET | `/workspaces/:id` | Get workspace metadata |
| DELETE | `/workspaces/:id` | Soft-delete workspace |

### Runs
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/workspaces/:id/runs` | Create and start a run |
| GET | `/runs/:id` | Get run status |
| POST | `/runs/:id/finalize` | Finalize run (commit changes) |
| POST | `/runs/:id/abort` | Abort run |

### Sandboxes
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/workspaces/:id/sandbox` | Create sandbox (checkout) |
| GET | `/workspaces/:id/sandbox` | Get sandbox status |
| DELETE | `/workspaces/:id/sandbox` | Destroy sandbox |

### Version Control
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/workspaces/:id/push` | Push files (git add + commit) |
| GET | `/workspaces/:id/pull` | Pull latest or specific version |
| GET | `/workspaces/:id/history` | Commit history |
| GET | `/workspaces/:id/diff` | Compare versions |
| POST | `/workspaces/:id/rollback` | Rollback to version |

---

## Storage Layout

### Current (Local Filesystem)

```
data/
├── workspace-meta/           # JSON metadata
│   └── {id}.json
├── workspaces/              # Bare Git repos
│   └── {id}.git/
└── sandboxes/               # Ephemeral sandboxes
    └── {id}/               # git clone targets
```

### Future (S3)

```
s3://{bucket}/{customerId}/workspaces/{workspaceId}.git/
```

---

## Build Phases

### Phase 1: Foundation
- [x] SQLite database layer
- [x] Workspace, Run, Lock, Audit tables
- [x] Run service with state machine

### Phase 2: Concurrency & Safety
- [x] Lock service
- [x] Concurrency control (base commit tracking)
- [x] Conflict detection
- [x] Path safety validation

### Phase 3: Commit Gateway
- [x] Run branches (`run/{run_id}`)
- [x] Structured commit messages
- [x] Proper change detection (add/modify/delete)
- [x] Merge policy enforcement

### Phase 4: Polish
- [x] Unit tests
- [x] Integration tests
- [x] E2E test scenario (22/22 passing)
- [x] Structured logging (service built, not yet integrated into routes)

---

## Commit Message Format

```text
contextvault: workspace={id} run={id} agent={id}

Summary:
- updated profile/summary.md
- added games/2024_001.json

---
{"workspaceId":"ws_01HXXX","runId":"run_01HXXX","agentId":"meta-profile","files":["profile/summary.md","games/2024_001.json"],"sizeBytes":2048}
```

---

## Security

- **Isolation** — Each sandbox is a separate directory
- **Path safety** — Validation prevents traversal outside sandbox
- **Access control** — API key per customer, IAM-style policies
- **No repo corruption** — Transactions ensure atomic commits

---

## Environment Variables

```bash
CONTEXTVAULT_DATA_DIR=./data
CONTEXTVAULT_API_PORT=3000
CONTEXTVAULT_API_KEY=cv-test-api-key-123
CONTEXTVAULT_LOCK_MODE=exclusive  # or "optimistic"
```

---

_Last updated: 2026-03-28_
