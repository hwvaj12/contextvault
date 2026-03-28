# ContextVault — Git-Native Storage

> **Status:** This document describes the current implementation (as of 2026-03-28).
> The old SQLite/DynamoDB abstraction has been replaced with Git-native storage.

## Overview

Each workspace **is** a Git repository. All versioning is handled by Git itself — no custom commit tracking, no diff logic, no rollback implementation needed.

```
data/
├── workspace-meta/           # JSON files for workspace metadata
│   └── {workspaceId}.json   # (customerId, name, timestamps)
└── workspaces/
    └── {workspaceId}/       # One git repo per workspace
        └── .git/           # Actual Git repository
```

## Why Git?

| Aspect | Custom Implementation | Git-native |
|--------|----------------------|------------|
| Diff | Write diff algorithm | `git diff` |
| History | Track commit records | `git log` |
| Rollback | Track reverse changes | `git revert` |
| Branching | Build from scratch | `git branch` |
| Storage | Custom file management | Git handles it |
| Reliability | Unknown | Battle-tested |

## Core Operations

### Create Workspace
```typescript
git init data/workspaces/{workspace_id}/
```
Creates a new bare git repo per workspace.

### Push (Create Commit)
```typescript
git add -A
git commit -m "agent: {agentId}, task: {taskId}\n---\n{files: [...], sizeBytes: N}"
```
- Stage all files in workspace
- Commit with metadata in message body
- Returns commit hash (the version ID)

### Pull (Get Files)
```typescript
git show {commitHash}:{filePath}
// or for entire state:
git checkout {commitHash} -- .
```
- Get files from specific commit (or HEAD for latest)

### History
```typescript
git log --oneline --format="%H %s %at"
// Returns: [{hash, message, timestamp}, ...]
```

### Diff
```typescript
git diff {fromCommit} {toCommit}
// Returns unified diff output
```

### Rollback
```typescript
git revert --no-commit {commitHash}
git commit -m "Revert to {commitHash}"
```
- Creates a NEW commit that undoes the old one
- Preserves full history (non-destructive)

## Implementation

Using `simple-git` npm package for Git operations.

```typescript
// src/storage/git-storage.ts

export interface IGitStorage {
  initWorkspace(workspaceId: string): Promise<void>;
  pushCommit(workspaceId: string, files: FileRecord[], metadata: CommitMetadata): Promise<Commit>;
  pullCommit(workspaceId: string, version?: string): Promise<Commit>;
  getHistory(workspaceId: string): Promise<Commit[]>;
  getDiff(workspaceId: string, from: string, to: string): Promise<DiffResult>;
  rollback(workspaceId: string, toVersion: string): Promise<Commit>;
}
```

## Commit Message Format

Git commit messages encode all agent metadata:

```
agent: {agentId} | task: {taskId} | tags: {tag1,tag2}
---
{"agentId":"...","taskId":"...","files":["summary.md"],"sizeBytes":1024,"createdAt":"..."}
```

**Header line:** Human-readable summary for `git log`
**Body (JSON):** Machine-parseable metadata

## Metadata Storage

| Data | Storage |
|------|---------|
| Workspace metadata (customerId, name) | `workspace-meta/{id}.json` |
| File versions | Git commits |
| Commit metadata (agentId, taskId, tags) | Git commit message |
| File contents | Git objects |

## Environment Variables

```bash
# Local development (current)
STORAGE_TYPE=git
DATA_DIR=./data

# Future: S3-backed Git repos
# STORAGE_TYPE=s3-git
# S3_BUCKET=contextvault-prod
```

## Future: Remote Git Backends

The Git-native design makes distributed storage straightforward:

1. **S3-backed Git** — Push to S3, pull from S3
2. **GitHub-backed** — Workspaces as GitHub repos
3. **Custom Git server** — `git push contextvault.ai`

All benefit from Git's built-in replication and caching.

## Verification

After any storage change:
- [ ] `npm run build` passes (TypeScript compiles)
- [ ] `npm run dev` starts without errors
- [ ] Create workspace → `.git` folder exists in `data/workspaces/{id}/`
- [ ] Push → `git log` shows commit with metadata in message
- [ ] Pull → files returned correctly from git
- [ ] History → commits parsed with metadata from messages
- [ ] Diff → `git diff` output is returned
- [ ] Rollback → new commit created, old content restored
