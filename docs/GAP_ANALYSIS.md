# ContextVault — Gap Analysis vs. Durable Workspace Spec

> Comparing current implementation against `docs/durable-workspace-spec.md`

---

## What Exists ✅

### Core Infrastructure
| Feature | Status | Notes |
|---------|--------|-------|
| Workspace CRUD | ✅ Complete | Works, tested |
| Sandbox lifecycle | ✅ Complete | checkout/commit/destroy/status |
| Git-native storage | ✅ Complete | Each workspace = Git repo |
| REST API | ✅ Complete | Fastify, works |
| MCP Server | ✅ Complete | Tools for agents |
| Push/Pull | ✅ Complete | File operations |
| History/Diff/Rollback | ✅ Complete | Via Git |
| Customer scoping | ✅ Complete | `customerId` field |

### Documentation
| Document | Status |
|----------|--------|
| README.md | ✅ Enticing, clear |
| ARCHITECTURE.md | ✅ Current |
| REST_API.md | ✅ Complete |
| STORAGE_LAYER.md | ✅ Current |
| MULTITENANT_STORAGE.md | ✅ Just added |
| DEVELOPMENT.md | ✅ Current |

---

## What's Missing 🔴

### 1. Control Plane / Metadata Model (Section 14)

**Current:** JSON files in `workspace-meta/`
**Spec wants:** Relational database tables

| Table | Current | Needed |
|-------|---------|--------|
| Workspace | JSON file | Full schema with `tenant_id`, `repo_location`, `default_branch`, `current_head`, `status`, `storage_class`, `last_accessed_at` |
| **Run** | ❌ None | New: tracks execution lifecycle |
| **Lock/Concurrency** | ❌ None | New: for concurrent access |
| **Audit Event** | ❌ None | New: traceable changes |

**Gap:** No run concept, no concurrency tracking, no audit trail.

---

### 2. Run/Execution Service (Section 15.3)

**Current:** No run lifecycle
**Spec wants:** Full run state machine

```
needed states: created → provisioning → ready → running → finalizing → merged/conflicted/failed → cleaned_up
```

**Gap:** No run records, no state transitions.

---

### 3. Concurrency Control (Section 12)

**Current:** Nothing
**Spec wants:**
- Record `base_commit` and `workspace HEAD` at run start
- Check for divergence before merge
- Detect conflicts
- Optional: exclusive workspace lock

**Gap:** Concurrent runs could silently overwrite each other.

---

### 4. Commit Gateway (Section 15.4)

**Current:** Simple `git add . && git commit`
**Spec wants:**
- Run branch/ref per execution
- Structured commit messages: `contextvault: workspace={id} run={id} agent={id}`
- Merge policy enforcement
- Conflict detection

**Gap:** No run branches, no structured messages, no merge logic.

---

### 5. Lock Service (Section 15.5)

**Current:** Nothing
**Spec wants:**
- Acquire/release locks
- Heartbeat/expire stale locks
- Enforce concurrency policy

**Gap:** No locking at all.

---

### 6. Change Detection (Section 9.4)

**Current:** `git add -A` (stages everything)
**Spec wants:**
- Detect added files
- Detect modified files
- Detect deleted files
- Detect renamed files

**Gap:** Can't handle deletes or renames properly.

---

### 7. Default Workspace Layout (Section 8)

**Current:** Empty repo, agent creates files
**Spec suggests:**
```
/
  profile/
    summary.md
    facts.json
  memory/
    timeline.md
    known_entities.json
  state/
    current.json
    preferences.json
  tasks/
    open.yaml
    completed.yaml
  decisions/
  artifacts/
  logs/
  system/
```

**Gap:** No default structure seeding on workspace creation.

---

### 8. Tests (Section 20)

**Current:** Manual E2E test only (`e2e-test.ts` in MetaProfile)
**Spec wants:**
- Unit tests
- Integration tests
- Failure-path tests
- E2E scenario test

**Gap:** Zero automated tests.

---

### 9. Observability (Section 21)

**Current:** Basic Fastify logger
**Spec wants structured logging for:**
- workspace creation
- sandbox creation/destruction
- run lifecycle events
- commit creation
- merge results
- conflict detection
- lock acquisition/release

Plus metrics:
- sandbox create duration
- run duration
- conflict rate
- etc.

**Gap:** No structured logging, no metrics.

---

### 10. S3 Backend (Section 7, MULTITENANT_STORAGE.md)

**Current:** Local filesystem only
**Spec doesn't require S3 for v1**, but future-ready

**Gap:** No S3 integration, no remote storage abstraction.

---

## What Partially Exists 🟡

### Sandbox Creation
- ✅ `checkout_workspace` clones to sandbox
- ⚠️ Doesn't record base commit
- ⚠️ No run branch created

### Commit on Finalize
- ✅ Our `commit_workspace` commits changes
- ⚠️ No run tracking
- ⚠️ No structured commit message format

### Path Safety
- ⚠️ Basic workspace ID validation in MCP
- ❌ No enforcement in REST API
- ❌ No path traversal prevention

---

## What Conflicts with Spec ⚠️

### 1. Storage Model
**Spec:** Bare repos for canonical storage
**Current:** We use regular repos (`.git` inside working directory)

**Decision needed:** Change to bare repo format?

### 2. Sandbox Location
**Spec:** `/tmp/contextvault/runs/{run_id}/workspace/`
**Current:** `data/sandboxes/{workspaceId}/`

**Minor:** Different path structure, functionally equivalent.

---

## Implementation Plan

### Phase 1: Foundation
1. **Add database layer** — SQLite for metadata (simple, no external deps)
   - Workspaces table (enhanced)
   - Runs table (new)
   - Locks table (new)
   - Audit events table (new)

2. **Add run service** — Run lifecycle management
   - `createRun(workspaceId, agentId)`
   - `startRun(runId)`
   - `finalizeRun(runId)`
   - `abortRun(runId)`
   - State machine enforcement

3. **Seed default layout** — On workspace creation
   - Create default directories
   - Initial `workspace_manifest.yaml`

### Phase 2: Concurrency & Safety
4. **Add lock service**
   - Acquire/release locks
   - Stale lock expiration
   - Configurable: exclusive vs optimistic

5. **Add concurrency control**
   - Record base commit at run start
   - Check HEAD before merge
   - Conflict detection

6. **Path safety** — Validate all paths stay within sandbox

### Phase 3: Commit Gateway
7. **Run branches** — `run/{run_id}` branch per execution

8. **Structured commit messages**
   ```
   contextvault: workspace={id} run={id} agent={id}
   
   Summary:
   - changed file 1
   - changed file 2
   ```

9. **Proper change detection** — `git diff --name-status`

### Phase 4: Polish
10. **Tests** — Unit, integration, E2E

11. **Structured logging** — For all key events

12. **Metrics** — Duration tracking, conflict rates

---

## Decisions Confirmed

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Locking policy** | Exclusive by default | Simpler, safer for v1 |
| **Database** | SQLite | Simple, no external deps |
| **Concurrency** | Optimistic with base commit tracking | Detect conflicts at merge |
| **Repo format** | Working repos (not bare) | Simpler for agents to understand |

## Open Questions

1. **S3:** When to implement remote storage?
2. **File deletion:** Allowed? When?
3. **Failed sandbox retention:** How long to keep for debugging?

---

## Summary

| Category | Status |
|----------|--------|
| Core sandbox workflow | ✅ Working |
| Run lifecycle | ❌ Missing |
| Concurrency control | ❌ Missing |
| Lock service | ❌ Missing |
| Control plane DB | ❌ Missing (JSON only) |
| Change detection | ⚠️ Partial |
| Default workspace layout | ❌ Missing |
| Tests | ❌ Missing |
| Observability | ❌ Missing |
| S3 backend | ❌ Not started |

**Verdict:** Core sandbox mechanic works. Need: run management, concurrency, DB layer, tests.

**Plan:** Spawn coding agent to implement all 4 phases in sequence.
