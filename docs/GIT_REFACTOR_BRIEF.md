# ContextVault Git Refactor — PM Brief

## Concept

Each workspace IS a Git repository. We use actual Git for all versioning, no custom commit/diff/rollback logic needed.

## Architecture

```
workspaces/
└── {workspace_id}/
    └── .git/           ← actual git repo (bare or regular)
    └── files/          ← working tree (or just commit objects)
```

## How Each Operation Works

### Create Workspace
```typescript
git init data/workspaces/{workspace_id}/
```
Creates a new git repo per workspace.

### Push (Create Commit)
```typescript
git add -A
git commit -m "agent: {agentId}, task: {taskId}"
```
- Stage all files in workspace
- Commit with metadata message
- Returns commit hash

### Pull (Get Files)
```typescript
git checkout {commit_hash} -- .
// OR
git show {commit_hash}:{file_path}
```
- Get files from specific commit (or HEAD for latest)

### History
```typescript
git log --oneline --format="%H %s"
// Returns array of {hash, message, timestamp}
```

### Diff
```typescript
git diff {from_commit} {to_commit}
// Returns: {added: [...], removed: [...], modified: [...]}
```

### Rollback
```typescript
git revert --no-commit {commit_hash}
git commit -m "Revert to {commit_hash}"
```
Creates a NEW commit that undoes the old one (doesn't destroy history).

## Library Choice

Use `simple-git` (npm package) — wraps Git CLI, most reliable.

```bash
npm install simple-git
```

## Changes Needed

1. **Install simple-git** in main project
2. **Create GitWorkspace service** at `src/storage/git-workspace.ts`
   - `init(workspaceId)` — git init
   - `commit(workspaceId, files, message)` — add + commit
   - `checkout(workspaceId, commitHash?, filePath?)` — pull files
   - `log(workspaceId)` — history
   - `diff(workspaceId, from, to)` — compare
   - `revert(workspaceId, commitHash)` — rollback

3. **Update storage interface** — add git adapter

4. **Update services** — workspace service creates git repo on init

5. **Remove SQLite** — no longer needed for commits

6. **Simplify** — we no longer need our own commit ID system, just use git hashes

## What Stays the Same

- API endpoints (same contracts)
- File storage (git repo IS the storage)
- Auth middleware
- React UI

## What Changes

- No more SQLite for commit metadata
- No more custom manifest.json (git handles versioning)
- Commit "messages" encode metadata (agentId, taskId as commit message)

## Metadata in Commit Messages

Format commit messages like:
```
agent: agent_123 | task: task_456 | tags: resolved,customer_a
files: summary.md, output.json
```

Parse these to extract metadata on pull.

## Verification

After refactor:
- `npm run build` — TypeScript compiles
- `npm run dev` — starts without errors
- Create workspace → git repo created
- Push → files committed to git
- Pull → files restored from git
- History → git log output
- Diff → git diff output
- Rollback → git revert creates new commit

## Commit Message

"refactor: use actual Git for workspace versioning

- Each workspace is a git repository
- simple-git for Git operations
- Remove SQLite dependency for commits
- Push = git add + commit
- Pull = git checkout
- History = git log
- Diff/rollback = git native"
