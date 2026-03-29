# ContextVault — Multi-Tenant Storage Architecture

> **Design document for production multi-customer storage.**

## Overview

ContextVault supports multiple customers, where each customer can have unlimited workspaces. Storage must be isolated, durable, and fast for agent workloads.

## Hot vs Cold Storage

**Critical distinction (per spec Section 19.3):**
> "Do not mount object storage as if it were a normal POSIX filesystem and use that as the live active `.git` directory layer."

| Layer | Storage Type | Purpose | Examples |
|-------|--------------|---------|---------|
| **Hot (Canonical)** | Git server + local disk | Active Git operations | push, pull, clone, commit |
| **Cold (Backup)** | S3-compatible object store | Durability, disaster recovery | Nightly snapshots, archives |

```
┌─────────────────────────────────────────────────────────────┐
│  Agent                                                        │
└────────────────────────┬────────────────────────────────────┘
                         │ git clone / git push
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  ContextVault Git Server (hot)                              │
│  - Handles Git smart protocol (upload-pack, receive-pack)    │
│  - Local SSD/NVMe for active repos                          │
│  - Low-latency random I/O for Git objects                   │
└────────────┬────────────────────────────────────────────────┘
             │ nightly backup
             ▼
┌─────────────────────────────────────────────────────────────┐
│  S3 Compatible Storage (cold)                               │
│  - Long-term durability (11 9's)                           │
│  - Disaster recovery                                        │
│  - Geo-redundancy                                          │
└─────────────────────────────────────────────────────────────┘
```

## Git Server Options

### Option 1: Self-Hosted Git Server (Recommended for v1)

ContextVault runs its own Git server — **which it already does**.

The current implementation handles:
- `git clone http://localhost:3000/repos/{id}` (via upload-pack)
- `git push` (via receive-pack)
- Git smart protocol over HTTP

**Pros:**
- Full control
- We already built this
- Simple mental model
- Can add auth, rate limiting, caching

**Cons:**
- Need to manage server infrastructure
- Need to handle scaling

### Option 2: Gitea (Self-hosted, lightweight)

A minimal Git hosting platform:
- Single binary, easy to deploy
- Built-in web UI, issue tracking
- MySQL/PostgreSQL backend
- S3 for storage backend

```bash
# docker-compose.yml
services:
  gitea:
    image: gitea/gitea:latest
    environment:
      - GITEA__storage__storage__TYPE=s3
      - GITEA__storage__s3__ACCESSKEYID=xxx
      - GITEA__storage__s3__SECRETACCESSKEY=xxx
      - GITEA__storage__s3__BUCKET=gitea repos
      - GITEA__storage__s3__REGION=us-east-1
```

**Pros:**
- Proven, production-ready
- Web UI included
- S3 integration built-in

**Cons:**
- Adds complexity
- Full Git hosting features (may be overkill)

### Option 3: GitHub/GitLab API

Use existing Git hosting as backend.

**Pros:**
- Fully managed
- No server maintenance
- Great APIs

**Cons:**
- Vendor lock-in
- Per-repo pricing
- Less control

### Option 4: GitHub Enterprise / GitLab Premium

For enterprise customers wanting isolated deployment.

---

## Recommended Architecture for Production

```
┌─────────────────────────────────────────────────────────────┐
│  ContextVault Cluster (Kubernetes/Docker)                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ContextVault Git Server                             │  │
│  │  - Fastify + simple-git                            │  │
│  │  - Git smart protocol (HTTP)                        │  │
│  │  - JWT auth middleware                              │  │
│  │  - Rate limiting                                    │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                 │
│         ┌─────────────────┼─────────────────┐              │
│         │                 │                 │              │
│         ▼                 ▼                 ▼              │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐      │
│  │ Worker Node │   │ Worker Node │   │ Worker Node │      │
│  │ Local SSD   │   │ Local SSD   │   │ Local SSD   │      │
│  │ repos/{id}  │   │ repos/{id}  │   │ repos/{id}  │      │
│  └─────────────┘   └─────────────┘   └─────────────┘      │
│         │                 │                 │              │
│         └─────────────────┼─────────────────┘              │
│                           │                                 │
│                    Shared storage (EBS, NFS, or distributed) │
└───────────────────────────┼─────────────────────────────────┘
                            │ nightly sync
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  S3 Compatible Storage (Cold)                              │
│                                                              │
│  Bucket: contextvault-backups                               │
│  Path: {customerId}/workspaces/{workspaceId}/{date}/       │
│                                                              │
│  - Nightly snapshots of all repos                          │
│  - Point-in-time recovery                                   │
│  - Cross-region replication (optional)                      │
└─────────────────────────────────────────────────────────────┘
```

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

```typescript
interface Workspace {
  id: string;                // ws_01HXXXXXXXX
  customerId: string;        // "meta-profile"
  name: string;             // "LeBron James"
  repoLocation: string;      // Path to local Git repo
  defaultBranch: string;     // "main"
  currentHead: string;       // Latest commit hash
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}
```

## Local Storage Layout (Hot)

```
/var/lib/contextvault/
└── repos/
    └── {customerId}/
        └── {workspaceId}.git/
            ├── objects/
            ├── refs/
            ├── HEAD
            └── hooks/
```

**Storage characteristics:**
- SSD/NVMe required for Git object access
- ~10-100MB per typical workspace
- Git compression keeps sizes manageable

## S3 Storage Layout (Cold)

```
s3://contextvault-backups/{customerId}/workspaces/{workspaceId}/
├── 2024-03-28/
│   └── {workspaceId}.tar.gz
├── 2024-03-27/
│   └── {workspaceId}.tar.gz
└── latest/
    └── {workspaceId}.git.tar.gz
```

**Backup strategy:**
- Nightly incremental backups
- Weekly full snapshots
- 30-day retention (configurable)
- Point-in-time recovery available

## Authentication & Authorization

### Per-Customer API Keys

```yaml
# Example: API key per customer
meta-profile:   cv-key-prod-mp-xxx
tourney-machine: cv-key-prod-tm-yyy
```

Each key grants access only to that customer's workspaces.

### Git Access Control

Git operations use the same API key auth:
```bash
git clone https://git.contextvault.ai/customer/workspace.git
# Auth via: X-API-Key header or .netrc file
```

## Implementation Roadmap

### Phase 1: MVP (Current)
- Local filesystem storage
- ContextVault API handles Git protocol
- Basic backup via `git clone --mirror`

### Phase 2: Production Hot Storage
- Deploy ContextVault Git server cluster
- Local SSD storage with shared filesystem
- Implement repo caching and prefetching

### Phase 3: Cold Storage Integration
- Nightly backup jobs to S3
- Point-in-time recovery
- Cross-region replication

### Phase 4: Multi-Tenant Isolation
- Namespace per customer
- Quotas and rate limits
- Usage metering

## Cost Estimation

Assuming:
- 100 customers
- 1000 workspaces per customer
- Average workspace: 50MB (.git with history)
- Hot storage: 50GB total
- Cold storage: 500GB (with compression)

**Hot Storage (SSD):**
- 50GB × $0.10/GB = $5/month

**Cold Storage (S3):**
- 500GB × $0.023/GB = $11.50/month
- 100,000 objects × $0.001/1000 = $0.10/month

**Total:** ~$17/month for 100 customers, 1000 workspaces each.

## Open Questions

- [x] Hot storage: Use ContextVault's own Git server (already built)
- [ ] Cold storage: S3 vs R2 vs MinIO?
- [ ] Backup frequency: Nightly sufficient?
- [ ] Retention policy: 30 days default?
- [ ] Git server hosting: Single node vs Kubernetes?
