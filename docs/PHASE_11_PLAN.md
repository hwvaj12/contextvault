# Phase 11 Plan — Commit Summaries

**Goal:** Auto-generate a 1-3 sentence summary for each commit using an LLM. System works fully without LLM access.

**Start date:** 2026-03-29
**Status:** PM Spec — Pending Approval

---

## Non-Functional Requirements

1. **System works without LLM** — if `SUMMARIZATION_ENABLED=false` or LLM unreachable, commit creation succeeds normally with no summary
2. **Non-blocking** — summarization never delays or fails a commit
3. **Non-required** — summaries are best-effort enrichment, not a dependency
4. **Two LLM backends** — Ollama (local, default) and OpenAI (cloud, optional)
5. **Per-customer LLM keys** — customers can bring their own OpenAI key

---

## Design

### Storage
Summaries live in existing Git commit metadata. No new tables.

```
commit.metadata = {
  ...existing fields...,
  summary?: string,        // "Added JWT auth to /login endpoint"
  summaryModel?: string,   // "llama3.3" or "gpt-4o-mini"
  summaryGeneratedAt?: string  // ISO timestamp
}
```

### API
```
GET /workspaces/:id/summaries?limit=10&commitId=optional
```
Returns list of commits with their summaries (from metadata). Falls back to `metadata.tags` or first line of commit message if no LLM summary exists.

### Flow
```
Agent push → pushCommit() → commit created (fast, no LLM)
                         → async: enqueueSummaryJob() [non-blocking]
                              → if LLM available: generate summary
                              → if not: skip silently
                              → update commit metadata with summary
```

### Configuration
```env
SUMMARIZATION_ENABLED=true           # Enable/disable entire feature
SUMMARIZATION_PROVIDER=ollama        # "ollama" | "openai"
OLLAMA_URL=http://localhost:11434     # Ollama endpoint
OLLAMA_MODEL=llama3.3                # Default Ollama model
OPENAI_API_KEY=sk-...                # Optional, for OpenAI fallback
OPENAI_MODEL=gpt-4o-mini             # Default OpenAI model
SUMMARIZATION_TIMEOUT_MS=10000       # 10s timeout before skipping
SUMMARIZATION_MAX_RETRIES=2          # Retry on transient failures
```

---

## Implementation

### 1. Config Service (`src/services/config.service.ts`)
- Read summarization config from env
- Provide `isSummarizationEnabled()`, `getLlmConfig()`

### 2. LLM Service (`src/services/summary.service.ts`)
- `generateSummary(diff: string, files: string[]): Promise<string | null>`
- Provider: Ollama (default) or OpenAI
- Handles: connection errors, timeouts, retries
- Returns `null` on failure — never throws

### 3. Commit Gateway Hook
In `commit-gateway.service.ts` after successful `pushCommit`:
```typescript
// Non-blocking — don't await
setImmediate(() => enrichCommitWithSummary(workspaceId, commitId));
```

### 4. Summaries Endpoint
`GET /workspaces/:id/summaries` in `commits.ts`
- Returns list of `{ commitId, summary, files, createdAt }`
- Uses existing commit history query, extracts summary from metadata
- Falls back to first line of commit message if no LLM summary

### 5. Vault Browser UI
- New "Summaries" tab in workspace view
- Shows commit message + LLM summary side by side
- If no LLM summary: shows "No summary available" gracefully

---

## SDK Updates (TypeScript + Python + PHP)
- `listSummaries(workspaceId, limit?)` → returns `CommitSummary[]`
- `CommitSummary = { commitId, summary: string | null, files: string[], createdAt }`

---

## E2E Tests
- Commit without LLM: verify commit succeeds, summary field is null
- Commit with Ollama: verify summary appears in metadata
- Summaries API: verify returns summaries for workspace
- Config OFF: verify no LLM calls, commit still works

---

## Out of Scope
- Vector embeddings / semantic search
- Workspace digest (rolling summary)
- Selective retrieval

---

## Dependencies
- None required (uses existing HTTP client)
- Optional: `express` or similar for job queue (v1 uses `setImmediate`)
