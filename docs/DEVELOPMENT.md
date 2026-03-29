# ContextVault — Development Guide

## Prerequisites

- Node.js 20+
- npm 10+

## Setup

```bash
cd ContextVault
npm install
```

## Development

### Run API Server
```bash
npm run dev
# Starts on http://localhost:3000
```

### Run MCP Server
```bash
cd mcp
npm install
npm run dev
# Starts on stdio
```

### Run Tests
```bash
npm test
```

## Project Structure

```
ContextVault/
├── src/
│   ├── index.ts              # API server entry
│   ├── app.ts               # Fastify app setup
│   ├── routes/              # HTTP route handlers
│   │   └── workspace.routes.ts
│   ├── services/            # Business logic
│   │   ├── workspace.service.ts
│   │   └── commit.service.ts
│   └── storage/             # Git storage layer
│       ├── git-storage.ts
│       └── git-workspace.ts
├── mcp/
│   └── src/index.mjs        # MCP server
├── docs/                   # Documentation
├── tests/                  # Test files
└── data/                   # Workspace storage (git repos)
    ├── workspace-meta/
    ├── workspaces/
    └── sandboxes/
```

## API Testing

### Health Check
```bash
curl http://localhost:3000/health
```

### Create Workspace
```bash
curl -X POST http://localhost:3000/workspaces \
  -H "X-API-Key: cv-test-api-key-123" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"test","name":"Test Workspace"}'
```

### Push Files
```bash
curl -X POST http://localhost:3000/workspaces/{id}/push \
  -H "X-API-Key: cv-test-api-key-123" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"path":"test.md","content":"# Hello"}]}'
```

### Pull Files
```bash
curl http://localhost:3000/workspaces/{id}/pull \
  -H "X-API-Key: cv-test-api-key-123"
```

## MCP Testing

```bash
cd mcp
npm run dev
# Server starts, tools available via MCP
```

## Debugging

### Check Git Storage
```bash
# List workspaces
ls -la data/workspaces/

# Check workspace git log
cd data/workspaces/{id}
git log --oneline

# Check sandbox
ls -la data/sandboxes/
```

### View Workspace Metadata
```bash
cat data/workspace-meta/{id}.json
```

## Common Issues

### MCP Server Won't Start
- Check `npm install` in mcp directory
- Verify tsconfig.json has `"moduleResolution": "bundler"`
- Try `npx tsx src/index.mjs` for verbose errors

### Git Operations Fail
- Ensure git is installed: `git --version`
- Check workspace exists: `ls data/workspaces/{id}/.git`
- Verify permissions on data directory

### API Returns 401
- Check X-API-Key header matches `CV_API_KEY` env var
- Default key for dev: `cv-test-api-key-123`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | API server port |
| `CV_API_KEY` | cv-test-api-key-123 | API authentication |
| `CONTEXTVAULT_DATA_DIR` | ./data | Storage directory |

## Scripts

```json
{
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "test": "vitest"
}
```
