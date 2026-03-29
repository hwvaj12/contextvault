# Phase 9: Feature Completeness — Plan & Tracker

**Started:** 2026-03-29
**Owner:** AI Co-Founder (PM)
**Goal:** Ship ContextVault v0.2 with complete, polished feature set

---

## Features

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | Multi-tenant isolation | Customer-scoped workspaces, API key isolation, permissions | 📋 Backlog |
| 2 | File diffing | `GET /workspaces/:id/diff?from=&to=` — already exists, verify completeness | 🔍 Investigating |
| 3 | Workspace sharing | Clone/copy a workspace to a new customer | 📋 Backlog |
| 4 | Webhook notifications | Notify external systems on commit, run events | 📋 Backlog |
| 5 | Bulk delete | Remove stale workspaces efficiently | 📋 Backlog |

---

## 1. Multi-tenant Isolation

**What it means:**
- API keys are scoped to `customerId`
- `GET /workspaces` only returns workspaces for that customer
- No cross-customer data leakage
- Future: workspace sharing across customers needs explicit grant

**What exists:**
- `customerId` field on workspaces ✅
- `X-API-Key` auth middleware ✅
- `customerId` filter on list endpoint ✅

**What's missing:**
- [ ] API key → customerId lookup (currently API key is just a secret, not tied to customer)
- [ ] Workspace create/update — should auto-assign `customerId` from API key
- [ ] Permission model for workspace sharing (future)
- [ ] Rate limiting per customer (low priority)

**Implementation:**
```
1. Add api_keys table: {id, customer_id, key_hash, created_at}
2. Create /api-keys endpoint (admin only) to generate keys
3. Middleware: lookup customer_id from API key hash
4. All workspace operations auto-scope to authenticated customer
```

**Effort:** Medium — requires schema change + new endpoint

---

## 2. File Diffing

**What it means:**
`GET /workspaces/:id/diff?from=<commit>&to=<commit>` returns file-level diffs

**What exists:**
- Route in `commits.ts` ✅
- `storage.getDiff()` in `git-workspace.ts` ✅

**What's missing:**
- [ ] Verify it returns structured diff (not raw git output)
- [ ] Test it end-to-end
- [ ] SDK support (TS, Python, PHP)
- [ ] Document in README/quickstart

**Implementation:**
```
1. Test current implementation (curl)
2. Fix if raw git output → structured {files: [{path, status, hunks}]}
3. Add to TypeScript SDK
4. Add to Python SDK
5. Add to PHP SDK
6. Document
```

**Effort:** Low-Medium — mostly verification + SDK additions

---

## 3. Workspace Sharing / Clone

**What it means:**
Copy or clone a workspace to a new customer (or same customer, new ID)

**Use cases:**
- "Copy this template workspace to my new customer"
- "Duplicate athlete profile as template for new athlete"

**What exists:**
- Git clone mechanics in `sandbox.service.ts` ✅
- Git bare repo storage ✅

**What's missing:**
- [ ] `POST /workspaces/:id/clone` endpoint
- [ ] `clone(workspaceId, targetCustomerId, newName?)` in workspace service
- [ ] Permission check (can only clone workspaces you own)
- [ ] SDK support

**API Design:**
```
POST /workspaces/:id/clone
Body: { targetCustomerId: string, name?: string }
Returns: { id: string, workspaceId: new_workspace_id, customerId: targetCustomerId }
```

**Implementation:**
```
1. Add cloneWorkspace(sourceId, targetCustomerId, newName) in workspace.service.ts
2. Uses: git clone → new bare repo → new workspace record
3. Add route POST /workspaces/:id/clone
4. Add SDK method
5. Test E2E
```

**Effort:** Medium — new endpoint + service method

---

## 4. Webhook Notifications

**What it means:**
Register URLs to receive POST callbacks when events happen:
- `workspace.created`
- `workspace.deleted`
- `sandbox.checked_out`
- `sandbox.committed`
- `run.started`
- `run.completed`
- `run.failed`

**What exists:**
- Audit event logging ✅ (all events already logged to `audit_events` table)

**What's missing:**
- [ ] `POST /webhooks` — register a webhook
- [ ] `GET /webhooks` — list webhooks for customer
- [ ] `DELETE /webhooks/:id` — remove webhook
- [ ] Webhook delivery service (async, with retries)
- [ ] Webhook secret for signature verification
- [ ] SDK support

**API Design:**
```
POST /webhooks
Body: { url: string, events: string[], secret?: string }
Returns: { id: string, url: string, events: string[], secret: string }

Webhook POST body:
{
  "event": "workspace.committed",
  "timestamp": "...",
  "workspaceId": "...",
  "data": { commitId: "...", ... }
}
Headers: X-CV-Signature: sha256=<hmac>
```

**Implementation:**
```
1. Add webhooks table: {id, customer_id, url, events_json, secret_hash, active, created_at}
2. Add webhook registration endpoints
3. Add WebhookService: enqueues deliveries
4. Add delivery job (async, 3 retries with backoff)
5. Sign payloads with HMAC-SHA256
6. Add SDK methods
```

**Effort:** Medium — new table + new service + new endpoints

---

## 5. Bulk Delete

**What it means:**
Delete multiple workspaces in one call, or clean up by date range

**What exists:**
- `softDeleteWorkspace()` ✅ (marks as deleted)

**What's missing:**
- [ ] `POST /workspaces/bulk-delete` endpoint
- [ ] Actually removes files (bare repos, sandboxes) not just DB record
- [ ] Async cleanup job (for large deletions)
- [ ] SDK support

**API Design:**
```
POST /workspaces/bulk-delete
Body: { workspaceIds: string[] } OR { olderThan: ISO8601 date, customerId?: string }
Returns: { deleted: number, failed: [{id, error}] }
```

**Implementation:**
```
1. Add bulkDelete(workspaceIds) to workspace.service.ts
2. Delete: DB record + bare repo + any active sandboxes
3. Add route
4. Add SDK methods
5. Add async job for large deletes (>10 workspaces)
```

**Effort:** Low — mostly endpoint + service method

---

## Execution Order

| Order | Feature | Rationale |
|-------|---------|-----------|
| 1 | Diffing | Already partially exists, quick wins |
| 2 | Bulk Delete | Quick win, useful for cleanup |
| 3 | Webhooks | Builds on existing audit events, high UX value |
| 4 | Workspace Sharing | Medium effort, useful for templates |
| 5 | Multi-tenant Isolation | Most complex, likely v1.0 territory |

---

## v0.2 Scope Freeze

**Cutoff:** TBD — execute one at a time, verify each E2E before moving on

**Definition of done for each feature:**
- [ ] API endpoint implemented + tested
- [ ] TypeScript SDK updated
- [ ] Python SDK updated  
- [ ] PHP SDK updated
- [ ] E2E test added
- [ ] README/quickstart updated if needed

---

_Last updated: 2026-03-29T19:55:00Z_
