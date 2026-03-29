# ContextVault — Multi-Tenant Storage Architecture

> **Design document for production multi-customer storage on S3.**

## Overview

ContextVault supports multiple customers, where each customer can have unlimited workspaces. Storage must be isolated, scalable, and cost-visible per customer.

## Multi-Tenant Model

```
ContextVault
└── Customers
    ├── meta-profile
    │   └── Workspaces
    │       ├── athlete-lebron
    │       ├── athlete-stephen
    │       └── team-lakers
    ├── tourney-machine
    │   └── Workspaces
    │       ├── tournament-ncaa-2024
    │       └── team-duke-coaches
    └── future-customer
        └── Workspaces
            └── ...
```

### Data Model

Each workspace belongs to a `customerId`:

```typescript
interface Workspace {
  id: string;           // ws_01HXXXXXXXX
  customerId: string;   // "meta-profile"
  name: string;         // "LeBron James"
  createdAt: string;
  latestCommitId: string | null;
}
```

**Namespace rule:** `customerId` + `workspaceId` must be globally unique.

## Storage Layout

### S3 Bucket Structure

```
s3://{bucket-name}/{customerId}/workspaces/{workspaceId}/.git/
├── HEAD
├── config
├── objects/
│   ├── pack/
│   └── pack/
├── refs/
└── hooks/
```

**Key insight:** Each workspace is a complete Git repository. The `.git` directory IS the workspace from Git's perspective.

### S3 Prefix Hierarchy

```
contextvault-prod/
├── meta-profile/
│   └── workspaces/
│       ├── ws_01HXXXXXXXX/
│       │   └── .git/
│       └── ws_01HYYYYYYYY/
│           └── .git/
├── tourney-machine/
│   └── workspaces/
│       └── ws_01HZZZZZZZZ/
│           └── .git/
└── ...
```

**Benefits:**
- IAM policies can restrict by prefix: `s3://contextvault-prod/meta-profile/*`
- Cost allocation tags per prefix
- CloudWatch metrics per prefix

## API Changes

### Customer Scoping

All API calls are scoped by customer via `customerId`:

```bash
# List workspaces for a customer
GET /workspaces?customerId=meta-profile

# Create workspace for a customer
POST /workspaces
{
  "customerId": "meta-profile",
  "name": "LeBron James"
}
```

### Storage-Aware Responses

```json
{
  "id": "ws_01HXXXXXXXX",
  "customerId": "meta-profile",
  "name": "LeBron James",
  "storage": {
    "region": "us-east-1",
    "bucket": "contextvault-prod",
    "prefix": "meta-profile/workspaces/ws_01HXXXXXXXX/"
  }
}
```

## Authentication & Authorization

### Per-Customer API Keys

```yaml
# Example: API key per customer
meta-profile:   cv-key-prod-mp-xxx
tourney-machine: cv-key-prod-tm-yyy
```

Each key grants access only to that customer's workspaces.

### IAM Policy Example

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::contextvault-prod/meta-profile/*"
    }
  ]
}
```

## Sandbox with Remote Storage

Sandboxes are temporary clones. With S3-backed storage:

```
1. Agent requests checkout
   → git clone s3://bucket/customer/workspaces/ws_XXX
   → Creates temp directory on compute instance
   
2. Agent works in sandbox
   → Local filesystem operations (fast)
   
3. Agent commits
   → git push back to S3
   
4. Sandbox destroyed
   → Temp directory cleaned up
```

**Challenge:** `git clone` from S3 requires either:
- A git remote helper (git-remote-s3)
- An S3-compatible Git server (GitLab S3 storage, Gitea, etc.)
- A lightweight Git daemon in front of S3

### Solution: git-remote-s3

AWS Labs provides `git-remote-s3` — lets you do:

```bash
git clone s3://contextvault-prod/meta-profile/workspaces/ws_01HXXX
```

**Pros:**
- Native Git experience
- No server component for storage
- Works with any S3-compatible provider

**Cons:**
- Requires helper installed on client
- Performance varies by object store

### Alternative: Lightweight Git Server

Run a minimal Git server (Node.js/Fastify) that:
1. Receives `git clone/fetch/push` requests
2. Translates to S3 operations via `@aws-sdk/client-s3`
3. Uses git's smart protocol over HTTP

```bash
git clone https://git.contextvault.ai/customer/workspace.git
```

**Pros:**
- Standard Git over HTTPS (works everywhere)
- Can add auth, rate limiting, logging
- Can cache frequently-accessed repos

**Cons:**
- Need to run/host the server
- More complexity than pure S3

## Implementation Options

| Option | Complexity | Best For |
|--------|------------|----------|
| **git-remote-s3** | Low | Simple, client-side |
| **Git server + S3** | Medium | Production, standard Git |
| **GitHub/GitLab API** | Low | Quick start, fully managed |

## Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ContextVault API (Fastify)                                 │
│                                                              │
│  Routes:                                                    │
│  - /workspaces (CRUD)                                       │
│  - /workspaces/:id/sandbox (checkout/commit/destroy)         │
│  - /push, /pull, /history                                   │
└────────────────┬────────────────────────────────────────────┘
                 │ Git operations
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Git Server (Fastify + simple-git)                          │
│                                                              │
│  Implements Git smart protocol over HTTP:                     │
│  - POST /:customer/:workspace/git/upload-pack               │
│  - POST /:customer/:workspace/git/receive-pack              │
│                                                              │
│  Backed by S3:                                              │
│  - read/write Git objects to S3                             │
│  - cache frequently-accessed repos locally                  │
└────────────────┬────────────────────────────────────────────┘
                 │ S3 API
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Amazon S3 (or S3-compatible: R2, MinIO, etc.)             │
│                                                              │
│  Bucket: contextvault-prod                                  │
│  Key: {customerId}/workspaces/{workspaceId}/.git/...       │
└─────────────────────────────────────────────────────────────┘
```

## Cost Estimation

Assuming:
- 100 customers
- 1000 workspaces per customer
- Average workspace: 10MB (.git)
- 100 commits per workspace

**Storage:**
- 100 × 1000 × 10MB = 1TB raw storage
- With Git compression + deltas: ~500GB
- S3 cost: ~$12/month (at $0.023/GB)

**API Requests:**
- Clone/fetch: ~$0.09 per 1000 requests
- Push: ~$0.05 per 1000 requests

**Total estimated:** ~$15-30/month for 100 customers, 1000 workspaces each.

## Next Steps

1. **MVP:** Use local filesystem + nightly S3 backup
2. **V1:** Implement git-remote-s3 for direct S3 access
3. **V2:** Build Git server layer for standard HTTPS Git access

## Open Questions

- [ ] Which S3-compatible provider (AWS, Cloudflare R2, MinIO)?
- [ ] Git server hosting (Lambda, EC2, container)?
- [ ] Customer onboarding flow (API key generation)?
- [ ] Data migration from local to S3?
