# Phase 10 Plan — Vault Browser Enhancements

**Goal:** Make the Vault Browser a first-class auditing and management tool for ContextVault.

**Start date:** 2026-03-29
**PM:** AI Co-Founder (Lab Rat)

---

## In Scope

### P0 — Must Have
1. **🔍 Workspace File Search** — Full-text search within workspace files
2. **🎨 Syntax Highlighting** — Code files get proper highlighting in viewer

### P1 — Should Have
3. **📝 Commit Filtering** — Filter commit timeline by tag, date, or agent
4. **📊 Usage Dashboard** — Per-customer request counts, storage breakdown
5. **🔔 Webhook Management UI** — Create/edit/delete webhooks from the browser

### P2 — Nice to Have
6. **📈 API Key Management UI** — Create/revoke scoped keys from browser
7. **🌐 Branch Switching** — View workspace at any commit SHA

---

## Implementation Order

### 1. Syntax Highlighting (P0)
**Why first:** Zero backend changes, just add a library and apply to FileViewer.

- Add `highlight.js` or `shiki` for syntax highlighting
- Detect language from file extension in FileViewer
- Apply theme matching current dark UI

### 2. Workspace File Search (P0)
**Why second:** Adds immediate value for auditing.

- Add search endpoint: `GET /workspaces/:id/search?q=query`
- Search within `files` table using `content LIKE '%query%'`
- Add search bar to Workspace page (top of file tree)
- Results show file path + highlighted snippet

### 3. Commit Filtering (P1)
**Why third:** Straightforward UI addition on existing commit timeline.

- Add filter controls above commit history (tag dropdown, date range)
- Filter is client-side for now (loaded commits)

### 4. Usage Dashboard (P1)
**Why fourth:** Admin need visibility into usage.

- Add `GET /analytics/usage?customerId=xxx` endpoint
- Show: total requests (24h/7d/30d), storage bytes, workspace count, key count
- New `/vault/usage` page

### 5. Webhook Management UI (P1)
**Why fifth:** Webhooks are already in API, need a UI to manage them.

- Add `GET/POST/DELETE /webhooks` endpoints if not already exposed
- New `/vault/webhooks` page: list, create (URL + events), delete

---

## Out of Scope
- ❌ File editing from browser — managed outside only
- ❌ Go SDK — not urgent

---

## Dependencies
- All features need SDK updates (TypeScript + Python + PHP)
- E2E tests for each new endpoint

---

## Success Metrics
- File search returns results in <200ms
- Syntax highlighting applies to 20+ common extensions
- Usage dashboard loads in <1s with 30d of data
