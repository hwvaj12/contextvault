# ContextVault — Next Task Brief

## Project
ContextVault — Git remote + HTTP API for AI agent memory

## Repo
`~/Desktop/Ventures/ContextVault`

## Current Status
- API running at localhost:3000 ✅
- TypeScript compiles ✅
- Bare repos working ✅
- Git remote endpoints (info/refs) working ✅
- Git push via HTTP API working ✅

## Next Task: Full Git Clone Support

Currently `git clone http://localhost:3000/repos/{id}` doesn't work because the upload-pack handler doesn't actually generate packfiles.

### What needs to be done

1. **Install isomorphic-git** (already added to package.json)
   - Already in package.json, just verify it's installed

2. **Implement full git-upload-pack** in `src/routes/git-remote.ts`
   - Parse the want/have packets from client
   - Generate a packfile containing the requested objects
   - Use isomorphic-git for packfile generation

3. **Test git clone works**
   ```bash
   cd /tmp
   rm -rf test-clone
   git clone http://cv-test-api-key-123@localhost:3000/repos/ws_01KMVCMGSFVJAYDH8SJ7QQ9DEZ test-clone
   ```
   - Should clone an EMPTY repo (no commits yet)
   - After pushing via HTTP API, should clone WITH content

4. **Verify the full flow works**
   - Create workspace → get gitUrl
   - Push via HTTP API → creates commit
   - Clone via git → gets the content
   - Push via git → updates the repo

### Implementation hints

For upload-pack, the Git protocol is complex. Simplified approach:

1. Use isomorphic-git's `findPackFile` to locate objects
2. Or use `git pack-objects` command via simple-git
3. Or spawn `git upload-pack` subprocess pointing to the bare repo

Example using simple-git:
```typescript
// In handleUploadPack:
const git = simpleGit(repoPath);
const pack = await git.raw(['upload-pack', '--stateless', '.'], 
  { input: requestBody });
```

### Verification

After each step:
1. `npm run build` must pass
2. `npm run dev` must start
3. `git clone` test must succeed

Commit your changes with clear messages like:
- `feat: implement git-upload-pack handler`
- `test: verify git clone works end-to-end`

Push to GitHub when done.
