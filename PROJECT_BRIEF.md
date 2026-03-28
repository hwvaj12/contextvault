# ContextVault Prototype — PM Brief

## ContextVault Project Overview

ContextVault is a multi-tenant, versioned workspace layer for AI agent memory. Agents push/pull execution state to customer-scoped workspaces with git-like versioning.

**Repo:** `~/Desktop/Ventures/ContextVault` (already initialized with README)
**GitHub:** https://github.com/lab-rat0212/contextvault

---

## Technical Stack

| Layer | Choice |
|-------|--------|
| API Server | Node.js + Fastify |
| Language | TypeScript |
| Storage | DynamoDB Local (for local prototype) |
| File Storage | Local filesystem (./data/workspaces/) for prototype |
| Auth | Simple API key header (`X-API-Key`) |
| API Docs | Swagger/OpenAPI via @fastify/swagger |
| Test UI | Simple React app (Vite) |

---

## What to Build

### Phase 0: Skeleton (1-2 days)

1. **Project setup**
   - `npm init -y`
   - Install: fastify, typescript, @fastify/swagger, @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, ulid, zod
   - `tsconfig.json` setup
   - `npm run dev` with ts-node-dev

2. **Basic workspace CRUD**
   - `POST /workspaces` — create workspace (id, customerId, name, timestamps)
   - `GET /workspaces` — list all workspaces
   - `GET /workspaces/:id` — get single workspace
   - `DELETE /workspaces/:id` — soft delete workspace

3. **Auth middleware**
   - Check `X-API-Key` header
   - For prototype: single hardcoded key `cv-test-api-key-123`
   - Return 401 if missing/invalid

### Phase 1: Push/Pull (2-3 days)

4. **Push (create commit)**
   - `POST /workspaces/:id/push`
   - Request body: `{ files: [{path, content}], metadata: {agentId, taskId, tags?} }`
   - Store files to `data/workspaces/{workspaceId}/commits/{commitId}/`
   - Write manifest.json with commit metadata
   - Update DynamoDB with new commit record
   - Update workspace's latestCommitId

5. **Pull (read state)**
   - `GET /workspaces/:id/pull` — pull latest
   - `GET /workspaces/:id/pull?version=xxx` — pull specific version
   - Read manifest from filesystem, return file contents

### Phase 2: History + Diff + Rollback (2 days)

6. **History**
   - `GET /workspaces/:id/history` — list commits (paginated)
   - Query DynamoDB by workspaceId, sorted by createdAt

7. **Diff**
   - `GET /workspaces/:id/diff?from=v1&to=v2`
   - Compare file lists between two commits

8. **Rollback**
   - `POST /workspaces/:id/rollback`
   - Body: `{ toVersion: "v41" }`
   - Copy files from target commit, create new commit with same content

### Phase 3: React Test UI (2 days)

9. **Simple React test UI**
   - Vite + React + TypeScript
   - API key input field
   - Workspace list/create
   - Push form (select workspace, add files)
   - Pull display (show files)
   - History view
   - Basic styling (CSS or Tailwind)

---

## API Design

### Endpoints

```
POST   /workspaces              Create workspace
GET    /workspaces              List workspaces  
GET    /workspaces/:id          Get workspace
DELETE /workspaces/:id          Delete workspace

POST   /workspaces/:id/push     Push state (create commit)
GET    /workspaces/:id/pull     Pull latest state
GET    /workspaces/:id/pull?v=  Pull specific version

GET    /workspaces/:id/history  List commit history
GET    /workspaces/:id/diff     Compare two versions
POST   /workspaces/:id/rollback Rollback to version
```

### Data Model

**Workspace:**
```typescript
{
  id: string;           // "ws_" + ulid
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;    // ISO timestamp
  updatedAt: string;
  deletedAt: string | null;
}
```

**Commit:**
```typescript
{
  id: string;           // "v_" + ulid
  workspaceId: string;
  parentId: string | null;
  files: File[];
  metadata: {
    agentId?: string;
    taskId?: string;
    tags?: string[];
  };
  sizeBytes: number;
  createdAt: string;
}
```

**File:**
```typescript
{
  path: string;         // e.g. "context/summary.md"
  content: string;      // file content
}
```

---

## DynamoDB Tables (Local)

### Table: Workspaces
```
PK: WORKSPACE#{id}
SK: METADATA
Attributes: customerId, name, latestCommitId, createdAt, updatedAt, deletedAt
GSI: customerId-index (customerId -> workspaceId)
```

### Table: Commits
```
PK: WORKSPACE#{workspaceId}
SK: COMMIT#{id}
Attributes: parentId, metadata, sizeBytes, createdAt
GSI: createdAt-index (for history queries)
```

---

## Running Locally

1. **Start DynamoDB Local** (Docker):
   ```bash
   docker run -p 8000:8000 amazon/dynamodb-local
   ```

2. **Create tables** (use AWS CLI or script):
   ```bash
   aws dynamodb create-table --endpoint-url http://localhost:8000 ...
   ```

3. **Start API server**:
   ```bash
   npm run dev
   # Runs on http://localhost:3000
   ```

4. **Start React UI** (separate terminal):
   ```bash
   cd ui && npm run dev
   # Runs on http://localhost:5173
   ```

---

## Test the API

```bash
# Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: cv-test-api-key-123" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust_123", "name": "Test Workspace"}'

# Push state
curl -X POST http://localhost:3000/workspaces/ws_xxx/push \
  -H "X-API-Key: cv-test-api-key-123" \
  -H "Content-Type: application/json" \
  -d '{"files": [{"path": "summary.md", "content": "# Test"}], "metadata": {"agentId": "agent_1"}}'

# Pull state
curl http://localhost:3000/workspaces/ws_xxx/pull \
  -H "X-API-Key: cv-test-api-key-123"
```

---

## Key Constraints

1. **Local only** — No production deploys, no AWS-specific stuff beyond DynamoDB Local
2. **Single API key** — Hardcoded for prototype
3. **File storage** — Use local filesystem `./data/workspaces/` not S3
4. **DynamoDB Local** — Same API as production DynamoDB, just local

---

## Commit Messages

Commit frequently with clear messages:
- `feat: initialize project with TypeScript and Fastify`
- `feat: add workspace CRUD endpoints`
- `feat: add auth middleware with API key`
- `feat: implement push endpoint with file storage`
- `feat: implement pull endpoint`
- `feat: add history and diff endpoints`
- `feat: add rollback endpoint`
- `feat: add React test UI`

---

## When Done

1. Push all changes to GitHub: `git push origin main`
2. Verify at https://github.com/lab-rat0212/contextvault
3. Report back with what was built and how to run it
