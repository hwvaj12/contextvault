# ContextVault — Security Model

> **Comprehensive security architecture for multi-tenant workspace isolation.**

---

## Overview

ContextVault implements defense-in-depth security across multiple layers:

| Layer | Protection | Mechanism |
|-------|------------|-----------|
| Transport | Data in transit | TLS 1.3 (non-negotiable) |
| Storage | Data at rest | Tenant-level SQLCipher encryption |
| Integrity | Bundle authenticity | Ed25519 workspace signing |
| Isolation | Tenant separation | App-layer + file-layer scoping |
| Secrets | Config management | Runtime env vars only, never in workspaces |

---

## Non-Negotiable: TLS

All connections MUST use TLS. In production:

```bash
# Caddy (recommended)
tls {
  issuer acme
}

# Or nginx
ssl_certificate /path/to/fullchain.pem;
ssl_certificate_key /path/to/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
```

All API responses include:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

---

## Tenant Isolation Model

### Two-Layer Isolation

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: App-Layer (Query Scoping)                          │
│ - Every query filtered by customer_id/workspace_id         │
│ - Middleware enforces ownership verification                │
│ - verifyWorkspaceOwnership() on all workspace ops          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: File-Layer (Filesystem)                            │
│ - Workspace files stored at: data/workspaces/{id}/          │
│ - Sandboxes at: data/sandboxes/{id}/                        │
│ - Each tenant's data is a separate directory tree          │
└─────────────────────────────────────────────────────────────┘
```

### Middleware Enforcement

```typescript
// Every workspace operation goes through:
verifyWorkspaceOwnership(request, reply, workspaceId)
// → 404 if tenant doesn't own workspace
// → Passes through if admin or owner
```

### Database Isolation

```sql
-- All queries scoped by tenant
SELECT * FROM workspaces 
WHERE id = ? AND customer_id = ? AND status != 'deleted';
```

---

## Encryption Architecture

### Tenant Master Key (TMK)

Each tenant has **one encryption key** that encrypts all their workspace data.

```
┌─────────────────────────────────────────────────────────────┐
│ Tenant Master Key (TMK)                                     │
│ - Generated once per tenant                                 │
│ - Stored in: Doppler (prod) / .env (dev)                    │
│ - Never stored in workspace bundles                         │
│ - Used for: SQLCipher encryption of tenant data             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Tenant SQLCipher Database                                   │
│ - All workspaces for tenant in one encrypted DB             │
│ - OR: One .db file per workspace, same TMK                 │
│ - All workspaces unlockable with same TMK                  │
└─────────────────────────────────────────────────────────────┘
```

### Why Tenant-Level, Not Per-Workspace

| Approach | Pros | Cons |
|----------|------|------|
| **Tenant-level (chosen)** | Simpler key management, one key to rotate | Compromise of key exposes all workspaces |
| Per-workspace | Blast radius limited | Key derivation complexity, harder to manage |

**Decision:** Tenant-level is correct for v1. Per-workspace is premature optimization. The threat model (server breach, disk theft) is addressed at the tenant level.

### Key Management

```
Onboarding:
1. Generate TMK: crypto.randomBytes(32)  // 256-bit
2. Store in Doppler/Vault (prod) or .env (dev)
3. TMK never transmitted in plain text

Runtime:
1. Consumer provides TMK via environment
2. SQLCipher uses TMK to open tenant database
3. All workspace reads/writes go through encrypted layer

Rotation:
1. Generate new TMK
2. Re-encrypt database with new key
3. Update stored key in Doppler/Vault
4. Old workspaces re-exported with new key (future enhancement)
```

---

## Workspace Signing

### Why Signing?

Workspaces are portable bundles. Signing ensures:
- **Integrity:** Bundle wasn't corrupted or modified
- **Authenticity:** Bundle came from a valid ContextVault system
- **Non-repudiation:** ContextVault can't deny signing it

### Signing Flow

```
Export:
1. Build workspace bundle (files + meta.json)
2. Compute SHA-256 hash of each file
3. Create manifest with file hashes
4. Generate Ed25519 signature of manifest
5. Attach signature to manifest
6. Bundle is now signed and verifiable

Import:
1. Decrypt bundle (if encrypted with TMK)
2. Load manifest
3. Extract signature
4. Verify signature against ContextVault public key
5. If valid → mount workspace
   If invalid → reject with error
```

### Algorithm: Ed25519

| Property | Value |
|----------|-------|
| Type | Asymmetric (Edwards-curve) |
| Signature | 64 bytes, deterministic |
| Key size | 256-bit (32 bytes) |
| Standard | RFC 8032 |

**Why Ed25519 over HMAC-SHA256?**
- Public key can be published (no secret needed to verify)
- No shared secret to distribute
- Widely supported, audited implementation
- Deterministic signatures (same content = same sig, good for caching)

### Manifest Structure

```json
{
  "version": "1.0",
  "workspaceId": "ws_01HXXXXXXXX",
  "createdAt": "2026-03-30T17:33:00Z",
  "schemaVersion": "1.0",
  "signatureAlgorithm": "Ed25519",
  "signedBy": "contextvault",
  "signedAt": "2026-03-30T17:33:00Z",
  "files": [
    {
      "path": "workspace.db",
      "size": 16384,
      "hash": "sha256:abc123..."
    },
    {
      "path": "meta.json",
      "size": 256,
      "hash": "sha256:def456..."
    }
  ],
  "signature": "base64_encoded_Ed25519_signature"
}
```

### Key Management

```
Signing Private Key:
- Held by ContextVault service
- Never exposed in SDK or API responses
- Rotated periodically (with key versioning)

Verification Public Key:
- Published in SDK documentation
- Bundled with SDK clients
- Consumers verify signatures against this key
- Key ID allows rotation without breaking old signatures
```

### Verification Code (SDK)

```typescript
import { verifySignature, ContextVaultPublicKey } from '@contextvault/sdk';

function importWorkspace(bundle: ArrayBuffer): Workspace {
  const manifest = extractManifest(bundle);
  
  // Verify signature
  const isValid = verifySignature(
    manifest,
    manifest.signature,
    ContextVaultPublicKey
  );
  
  if (!isValid) {
    throw new Error('Workspace bundle signature verification failed');
  }
  
  // Bundle is valid, proceed with import
  return mountWorkspace(bundle);
}
```

---

## Secrets Management

### Core Principle: No Secrets in Workspaces

Workspaces are **sealed data artifacts**. They contain:
- User data and files
- Metadata and manifests
- Schema versions

They do **NOT** contain:
- API keys
- Environment variables
- Encryption keys
- Credentials or secrets

### Runtime Configuration

```
Consumer provides at runtime (env vars):
├── CONTEXTVAULT_TENANT_KEY        # TMK for SQLCipher
├── CONTEXTVAULT_API_KEY          # API authentication
├── THIRD_PARTY_API_KEYS          # For agent use (never stored)
└── LOG_LEVEL, DEBUG, etc.        # Non-sensitive config
```

### Secrets Scanner

Before workspace export, secrets are scanned:

```typescript
const DANGER_PATTERNS = [
  /password\s*=/i,
  /api[_-]?key\s*=/i,
  /secret\s*=/i,
  /BEGIN\s+(RSA|EC|DSA)?\s*PRIVATE\s+KEY/i,
  /AWS_ACCESS_KEY/i,
  /STRIPE_SECRET/i,
  /OPENAI_API_KEY/i,
  /\.env\b/,
  /ENV\s*=/,
];

function scanForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const pattern of DANGER_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push({ pattern: pattern.source, match });
    }
  }
  return findings;
}
```

If secrets are detected:
1. **Reject the export** with error
2. **Log the violation** (for audit)
3. **Suggest remediation** (use env vars instead)

---

## TMK Auto-Provisioning (Phase 13)

### Secrets Abstraction

TMKs are managed through a pluggable secrets abstraction:

```
┌─────────────────────────────────────────────────────────────┐
│ SecretsService Interface                                     │
│                                                             │
│   getSecret(tenantId, key) → string | null                │
│   setSecret(tenantId, key, value) → void                  │
│   generateTmk(tenantId) → TMK                             │
│   getTmk(tenantId) → TMK | null                           │
└─────────────────────────────────────────────────────────────┘
                           ↑
                           │
         ┌─────────────────┼─────────────────┐
         ↓                 ↓                 ↓
┌────────────────┐ ┌───────────────┐ ┌──────────────┐
│LocalJsonProvider│ │DopplerProvider│ │ Future:aws/gcp│
│ (data/secrets/) │ │   (Doppler)   │ │              │
└────────────────┘ └───────────────┘ └──────────────┘
```

**Local JSON Provider (v1):**
```json
// data/secrets/tenant-keys.json
{
  "tenant_001": {
    "tmk": "base64_encoded_256bit_key",
    "keyId": "v1_1711833600000",
    "createdAt": "2026-03-30T18:00:00Z"
  }
}
```

**Environment config:**
```bash
CONTEXTVAULT_SECRETS_BACKEND=local          # local | doppler | aws | gcp
CONTEXTVAULT_SECRETS_PATH=./data/secrets    # for local backend
```

### Auto-Provisioning Flow

```
Tenant onboards:
1. Tenant record created in DB
2. System auto-generates TMK: crypto.randomBytes(32)
3. TMK stored in secrets provider (local/Doppler/Vault)
4. DB updated with tmk_key_id reference
5. Tenant gets "ready" — zero friction, zero complexity

On first workspace access:
1. Check if tenant has TMK
2. If missing → generate + store (lazy migration)
3. Existing tenants migrate transparently
```

### Migration: Existing Tenants

Existing tenants (pre-Phase 13) get TMKs automatically:
- **Lazy migration:** TMK generated on first write operation
- **Audit logged:** `tenant.tmk_lazy_migration` event
- **No breaking changes:** Existing vaults work as-is

---

## Threat Model

### Protected Against

| Threat | Protection |
|--------|------------|
| Server breach (filesystem access) | SQLCipher encryption |
| Disk theft | SQLCipher encryption |
| Man-in-the-middle (network) | TLS |
| Workspace tampering | Ed25519 signing |
| Secret exfiltration | Secrets scanner + no storage in workspaces |
| Cross-tenant access | App-layer scoping + file isolation |
| Replay attacks | Nonces, timestamps in manifests |

### Not Protected Against

| Threat | Note |
|--------|------|
| Consumer-side key theft | If TMK is compromised, tenant data is exposed |
| Memory scraping | Runtime secrets in process memory |
| Compromised consumer device | Local storage may be unencrypted |

### Mitigations for Unprotected Threats

- Consumer key theft → Key rotation policy + Doppler audit logs
- Memory scraping → Process isolation (future: separate tenant processes)
- Consumer device → Consumer responsible for device security

---

## Implementation Checklist

### Phase 12 — Complete ✅
- [x] Add Ed25519 signing service (`src/services/signing.service.ts`)
- [x] Add secrets scanner utility (`src/utils/secrets-scanner.ts`)
- [x] Add workspace manifest builder (`src/services/manifest.service.ts`)
- [x] Update workspace export to include signing
- [x] Update workspace import to verify signatures
- [x] Add TMK configuration to config service
- [x] Add signing key rotation documentation
- [x] Add verification examples to SDK

### Phase 13 — In Progress
- [ ] Add SecretsService interface + LocalJsonProvider
- [ ] Update TenantService to auto-provision TMK
- [ ] Database schema update (tmk columns)
- [ ] Migration script for existing tenants
- [ ] Internal API endpoints for TMK management
- [ ] Documentation updates

### Future
- [ ] Add SQLCipher encryption to storage layer
- [ ] Add Doppler/Vault providers for production
- [ ] Key rotation documentation

---

## Open Questions

- [ ] Key rotation: How do we handle old signatures when signing key rotates?
  - Solution: Include key ID in manifest, consumers trust key metadata
- [ ] Consumer-created workspaces: Can they be signed by ContextVault?
  - Solution: Consumer signs locally, ContextVault co-signs on upload
- [ ] SDK key distribution: How do consumers get the verification public key?
  - Solution: Bundled with SDK, published at known URL

---

_Last updated: 2026-03-30_
