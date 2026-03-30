# ContextVault — PM Notes

**Role:** PM + Technical Lead
**Rule: All execution must go through Claude Code, not direct coding**

## Repos
- API: `~/Desktop/Ventures/ContextVault`
- Vault Browser UI: `src/vault-browser/`
- MetaProfile integration: `~/Desktop/Ventures/MetaProfile`

## PM Workflow
1. Identify feature gap → spec in `docs/PHASE_X_PLAN.md`
2. Delegate to Claude Code (`runtime="acp"`, `mode="run"`)
3. Review output, verify tests pass
4. Update plan and ship

## Phase 10 — Vault Browser Enhancements
- `docs/PHASE_10_PLAN.md`
- ✅ Syntax Highlighting (commit d52cda1)
- ✅ File Search (commit 8f1352f)
- ⬜ Commit Filtering — filter timeline by tag/date
- ⬜ Usage Dashboard — request counts, storage per customer
- ⬜ Webhook Management UI — create/delete webhooks from browser
- ⬜ API Key Management UI — scoped keys from browser

## How to Delegate

For coding tasks, spawn Claude Code:
```
runtime="acp", mode="run", cwd="~/Desktop/Ventures/ContextVault"
```

Provide a complete prompt with:
- Exact file paths
- The feature spec
- Expected behavior
- Test verification steps
