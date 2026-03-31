# ContextVault

**Durable Git-backed workspace memory for AI agents.**

Every AI agent session starts from scratch. ContextVault gives agents persistent memory — versioned, diffable, and rollback-capable — without bloating context windows.

## The Problem

AI agents are stateless. They can't remember what happened in previous sessions. Prompt context is expensive and limited.

**ContextVault gives your agents permanent memory:**

1. **Give agents memory that lasts** — Every session builds on the last, not from scratch
2. **Isolated workspace per run** — Agents work in a clean sandbox, no cross-contamination
3. **Full version history** — Every change is a Git commit. Inspect, diff, or rollback anytime
4. **Commit when you're done** — Or abort and discard. No state left behind
5. **Zero context window bloat** — Agents pull only what they need from persistent storage

Memory that persists. Context that travels. Git that scales.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Start the API server
npm run dev

# In another terminal, start the MCP server
cd mcp && npm install && npm run dev
```

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` for local development.

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `CONTEXTVAULT_API_KEY` | `cv-test-api-key-123` | Master API key for admin access (override in production) |
| `CONTEXTVAULT_DATA_DIR` | `./data` | Directory for workspaces, sandboxes, and secrets |

### Secrets Configuration (Phase 13)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTVAULT_SECRETS_BACKEND` | `local` | Secrets backend: `local`, `doppler`, `aws`, `gcp` |
| `CONTEXTVAULT_SECRETS_PATH` | `./data/secrets` | Path for local secrets storage (when backend=`local`) |

**Local secrets storage** saves tenant TMKs to `data/secrets/tenant-keys.json`.

### Signing Keys (Phase 12)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTVAULT_SIGNING_PRIVATE_KEY` | _(none)_ | Ed25519 private key for signing workspace bundles (base64-encoded) |
| `CONTEXTVAULT_SIGNING_PUBLIC_KEY` | _(none)_ | Ed25519 public key for verifying bundles (base64-encoded) |
| `CONTEXTVAULT_SIGNING_KEY_ID` | _(none)_ | Key identifier for signature manifests (e.g., `v1`) |

**For local development**, generate a key pair:
```bash
# Generate Ed25519 key pair
openssl genpkey -algorithm ED25519 -out private_key.pem
openssl pkey -in private_key.pem -pubout -out public_key.pem

# Convert to base64
cat private_key.pem | base64 | tr -d '\n'
cat public_key.pem | base64 | tr -d '\n'
```

### Tenant Master Key (Future - Phase 13+)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTVAULT_TENANT_KEY` | _(none)_ | Master key for SQLCipher tenant encryption (base64-encoded 256-bit) |

### Complete `.env.example`

```bash
# Core
PORT=3000
CONTEXTVAULT_API_KEY=cv-test-api-key-123
CONTEXTVAULT_DATA_DIR=./data

# Secrets (Phase 13)
CONTEXTVAULT_SECRETS_BACKEND=local
CONTEXTVAULT_SECRETS_PATH=./data/secrets

# Signing Keys (Phase 12)
CONTEXTVAULT_SIGNING_PRIVATE_KEY=
CONTEXTVAULT_SIGNING_PUBLIC_KEY=
CONTEXTVAULT_SIGNING_KEY_ID=v1

# Encryption (Future)
CONTEXTVAULT_TENANT_KEY=
```

## Use Cases

**Persistent customer context** — Store dynamically loadable customer profiles, project state, and user preferences. When an agent picks up a ticket or resumes a conversation, it pulls the full context — past decisions, preferences, history — and continues where it left off.

**Replayable agent runs** — Each agent run is its own workspace with a full Git history. Inspect what happened in a specific run. Resume an interrupted task from the exact checkpoint. Roll back to a previous run if something went wrong. Audit every decision across time.

## API Example

```bash
# Create workspace
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: your-key" \
  -d '{"customerId":"my-customer","name":"agent-memory"}'

# Start a run (creates sandbox)
curl -X POST http://localhost:3000/workspaces/{id}/runs \
  -H "X-API-Key: your-key"

# Agent works in sandbox at data/sandboxes/{workspace_id}/...

# Finalize (commit changes)
curl -X POST http://localhost:3000/runs/{run_id}/finalize \
  -H "X-API-Key: your-key"

# Sandbox auto-destroyed, workspace has new commit
```

## SDKs

```bash
# TypeScript
npm install @contextvault/sdk

# Python
pip install contextvault

# PHP
composer require contextvault/contextvault-php
```

## Architecture

The system has two layers:

**Control Plane** — Coordinates workspace operations
- Workspace Service: manages workspace lifecycle
- Run Service: manages run lifecycle from created → merged/conflicted/failed
- Lock Service: exclusive/shared locking with conflict detection
- Audit Event: logs all significant operations

**Storage Layer** — Commit Gateway handles Git operations
- Creates run branches for isolated agent work
- Detects file changes (add/modify/delete)
- Creates structured commits with metadata
- Merges to canonical workspace

```
Sandboxed Agent ←→ Run Service ←→ Lock Service
                            ↓
                     Commit Gateway
                            ↓
              ┌──────────────────────────┐
              │   Canonical Repo Store   │
              │   (Bare Git repos)       │
              └──────────────────────────┘
```

## Status

**v0.2** — ✅ All phases complete!

| Component | Status | Details |
|----------|--------|---------|
| Core Engine | ✅ | Run lifecycle, lock service, commit gateway, SQLite DB |
| TypeScript SDK | ✅ | Full API coverage, 65 E2E tests passing |
| Python SDK | ✅ | Full API coverage |
| PHP SDK | ✅ | Full API coverage |
| MCP Server | ✅ | Tools for agents |
| REST API | ✅ | Fastify + Swagger docs at /docs |
| E2E Tests | ✅ | 65/65 tests passing |
| Multi-tenant | ✅ | API key scoping, customer isolation |
| Webhooks | ✅ | Event notifications with HMAC signatures |
| Diff | ✅ | Structured file diffs with hunks |
| Workspace Clone | ✅ | Clone workspace to new customer |
| Bulk Delete | ✅ | Delete multiple workspaces at once |

## What's New in v0.2

- **Multi-tenant isolation** — Customer-scoped API keys with full isolation
- **Webhook notifications** — Get notified when workspaces are created, commits happen, or runs complete
- **Structured diff** — Get detailed file changes with line-level hunks
- **Workspace clone** — Copy a workspace to a new customer
- **Bulk delete** — Remove multiple workspaces in one call
- **Environment config** — `.env` file support for local development

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design
- [REST API Reference](docs/api/workspaces.md) — API endpoints
- [Quickstart: TypeScript](docs/quickstart/typescript.md)
- [Quickstart: Python](docs/quickstart/python.md)
- [Quickstart: PHP](docs/quickstart/php.md)
- [LangChain Integration](docs/examples/langchain/typescript.md)
- [Postman Collection](docs/ContextVault-API.postman_collection.json)

## License

MIT License — see [LICENSE](LICENSE) file.

---

**ContextVault: Memory that persists. Context that travels. Git that scales.**
