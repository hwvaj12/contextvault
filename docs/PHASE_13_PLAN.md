# Phase 13 Plan — TMK Auto-Provisioning + Secrets Abstraction

**Goal:** Implement a secrets abstraction layer with local JSON backend, auto-provision TMKs for new tenants, and handle migration of existing tenants.

**Start date:** 2026-03-30
**Status:** In Progress

---

## Architecture

### Secrets Abstraction

```
┌─────────────────────────────────────────────────────────────┐
│ SecretsService Interface                                     │
│                                                             │
│   getSecret(tenantId, key) → string | null                │
│   setSecret(tenantId, key, value) → void                  │
│   deleteSecret(tenantId, key) → void                       │
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

### Local JSON Provider

```
data/secrets/
└── tenant-keys.json
    {
      "tenant_001": {
        "tmk": "base64_encoded_256bit_key",
        "keyId": "v1_1711833600000",
        "createdAt": "2026-03-30T18:00:00Z"
      },
      "tenant_002": { ... }
    }
```

### Environment Config

```bash
# .env
CONTEXTVAULT_SECRETS_BACKEND=local          # local | doppler | aws | gcp
CONTEXTVAULT_SECRETS_PATH=./data/secrets    # for local backend
CONTEXTVAULT_SECRETS_SYNC=false              # for future multi-instance sync
```

---

## Implementation Tasks

### Task 1: SecretsService Interface + Local Provider

**File:** `src/services/secrets.service.ts`

```typescript
export interface SecretsProvider {
  getSecret(tenantId: string, key: string): string | null;
  setSecret(tenantId: string, key: string, value: string): void;
  deleteSecret(tenantId: string, key: string): void;
  listTenantIds(): string[];
}

export class SecretsService {
  private provider: SecretsProvider;
  
  static createLocalProvider(secretsPath: string): LocalJsonProvider;
  // Future: static createDopplerProvider(token: string): DopplerProvider;
  
  getSecret(tenantId: string, key: string): string | null;
  setSecret(tenantId: string, key: string, value: string): void;
  generateTmk(tenantId: string): TMK;  // generates + stores
  getTmk(tenantId: string): TMK | null;
  hasTmk(tenantId: string): boolean;
}
```

### Task 2: Update TenantService to Auto-Provision TMK

**File:** `src/services/tenant.service.ts` (or create if doesn't exist)

On tenant creation:
```typescript
async function createTenant(id: string, name: string, ...): Promise<Tenant> {
  const tenant = await db.createTenant(...);
  
  // Auto-provision TMK
  const tmk = secretsService.generateTmk(tenant.id);
  
  logAuditEvent({ tenantId: tenant.id, eventType: 'tenant.tmk_provisioned' });
  
  return tenant;
}
```

### Task 3: Database Schema Update

**File:** `src/db/schema.sql`

Add to tenants table:
```sql
ALTER TABLE tenants ADD COLUMN tmk_key_id TEXT;
ALTER TABLE tenants ADD COLUMN tmk_created_at TEXT;
```

### Task 4: Migration Script for Existing Tenants

**File:** `scripts/migrate-existing-tenants.ts`

```typescript
// For each existing tenant without a TMK:
async function migrateTenant(tenantId: string): Promise<void> {
  const tmk = secretsService.generateTmk(tenantId);
  db.updateTenant(tenantId, { tmk_key_id: tmk.keyId, tmk_created_at: tmk.createdAt });
  logAuditEvent({ tenantId, eventType: 'tenant.tmk_migrated' });
}
```

Run with:
```bash
npx ts-node scripts/migrate-existing-tenants.ts
```

### Task 5: API Endpoints for TMK Management

**Internal only** (not exposed to consumers):
```
GET  /internal/tenants/:id/tmk/status   # Does tenant have TMK?
POST /internal/tenants/:id/tmk/rotate   # Rotate TMK (future)
```

### Task 6: Documentation Updates

**Files:**
- `docs/SECURITY_MODEL.md` — Add TMK provisioning section
- `docs/ONBOARDING.md` — Add tenant provisioning flow
- `README.md` — Add local secrets setup

---

## Migration: Existing Tenants

### Problem
Existing tenants (before Phase 13) don't have TMKs provisioned.

### Solution
1. **Detection:** On first access, check if tenant has TMK
2. **Auto-migration:** If missing, generate and store TMK transparently
3. **Logging:** Audit log each migration

```typescript
// In any code that needs TMK:
async function ensureTmk(tenantId: string): Promise<TMK> {
  const existing = secretsService.getTmk(tenantId);
  if (existing) return existing;
  
  // Migrate on-demand
  logAuditEvent({ tenantId, eventType: 'tenant.tmk_lazy_migration' });
  return secretsService.generateTmk(tenantId);
}
```

### Backward Compatibility
- Existing workspaces continue to work
- TMK is generated transparently on first write operation
- No breaking changes to existing vaults

---

## Files to Create/Modify

```
src/services/
├── secrets.service.ts        # NEW: interface + local provider
└── tenant.service.ts         # UPDATE: auto-provision TMK

src/db/
└── schema.sql                # UPDATE: add tmk columns

scripts/
└── migrate-existing-tenants.ts  # NEW: migration script

docs/
├── SECURITY_MODEL.md         # UPDATE: TMK section
├── PHASE_13_PLAN.md          # THIS FILE
└── ONBOARDING.md             # NEW: tenant provisioning flow

.env.example                  # UPDATE: add secrets config
```

---

## Verification

1. Run existing tests — all should pass
2. Add tests for SecretsService:
   - Local provider CRUD
   - TMK generation
   - Tenant migration
3. Manual test:
   ```bash
   # Create new tenant → verify TMK auto-generated
   # Check data/secrets/tenant-keys.json
   ```

---

## Checklist

- [ ] Task 1: SecretsService interface + LocalJsonProvider
- [ ] Task 2: TenantService auto-provision TMK
- [ ] Task 3: Database schema update
- [ ] Task 4: Migration script for existing tenants
- [ ] Task 5: Internal API endpoints
- [ ] Task 6: Documentation updates
- [ ] Run migration on existing tenants
- [ ] Verify all tests pass

---

_Last updated: 2026-03-30_
