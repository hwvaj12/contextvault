# ContextVault — AGENTS.md

## Project Context

This is ContextVault — a multi-tenant, versioned workspace layer for AI agent memory.

## Codebase Standards

### TypeScript Best Practices

1. **Strict mode enabled** — `strict: true` in tsconfig.json
2. **Explicit types** — No `any`, use proper interfaces and generics
3. **Immutability** — Prefer `const`, readonly arrays/objects, `Readonly<T>`
4. **Error handling** — Never swallow errors, always propagate or handle explicitly
5. **Async/await** — No raw Promises without await in route handlers
6. **Naming** — `camelCase` for variables/functions, `PascalCase` for types/classes, `SCREAMING_SNAKE` for constants

### Clean Architecture

```
src/
├── routes/        # HTTP layer (Fastify route handlers)
├── services/     # Business logic (orchestration)
├── storage/      # Data access layer (interface + adapters)
│   ├── interfaces.ts   # IStorage contract
│   ├── sqlite-*.ts      # SQLite implementation
│   └── dynamodb-*.ts    # DynamoDB implementation
├── middleware/   # Auth, validation, error handling
├── types/       # Shared TypeScript types
└── utils/       # Helpers, constants
```

**Dependency rule:** Dependencies point inward. Routes → Services → Storage. Never the reverse.

### API Design

- RESTful endpoints with proper HTTP methods
- JSON request/response bodies
- Consistent error format: `{ error: string, message: string, details?: object }`
- HTTP status codes: 200 (ok), 201 (created), 400 (bad request), 401 (unauthorized), 404 (not found), 500 (server error)
- All endpoints require `X-API-Key` header

### Testing Policy

**User is skeptical of results. Always provide verifiable proof.**

When claiming something works:
- Run actual tests (curl, unit tests, integration tests)
- Show actual output (logs, screenshots, API responses)
- Never claim tests pass without running them
- Never claim code works without verification

### Git Workflow

- Commit messages follow conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- One logical change per commit
- Push to GitHub after each significant milestone
- Never commit secrets, credentials, or sensitive data

## Running Locally

```bash
npm install
npm run dev        # API at localhost:3000
cd ui && npm run dev  # Test UI at localhost:5173
```

## Verification Checklist

Before claiming a feature is complete:

- [ ] `npm run build` passes (TypeScript compiles)
- [ ] `npm run dev` starts without errors
- [ ] API endpoints return expected responses
- [ ] Unit tests pass (if applicable)
- [ ] Changes pushed to GitHub

**Provide proof:** Log output, curl commands, or screenshots showing the feature working.
