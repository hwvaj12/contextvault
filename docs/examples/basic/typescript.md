# TypeScript Basic Example

A complete example that creates a workspace, writes files, commits, reads them back, and cleans up.

## Full Workflow

```typescript
import { ContextVaultClient, NotFoundError } from '@contextvault/sdk';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  // Initialize client
  const cv = new ContextVaultClient({
    apiKey: 'cv-test-api-key-123',
    baseUrl: 'http://localhost:3000',
  });

  const customerId = 'customer-123';

  // --- Create a workspace ---
  const workspace = await cv.workspaces.create({
    customerId,
    name: 'demo-workspace',
  });
  console.log('Created workspace:', workspace.id);

  // --- Checkout a sandbox ---
  const sandbox = await cv.workspaces.checkout(workspace.id);
  console.log('Sandbox path:', sandbox.path);

  // --- Write files to the sandbox ---
  if (sandbox.path) {
    fs.mkdirSync(path.join(sandbox.path, 'notes'), { recursive: true });

    fs.writeFileSync(
      path.join(sandbox.path, 'notes', 'meeting.md'),
      '# Meeting Notes\n\n- Discussed project timeline\n- Agreed on milestones\n'
    );

    fs.writeFileSync(
      path.join(sandbox.path, 'config.json'),
      JSON.stringify({ theme: 'dark', language: 'en' }, null, 2)
    );
  }

  // --- Commit changes ---
  const commit = await cv.workspaces.commit(workspace.id, {
    message: 'Add meeting notes and config',
    author: 'demo-agent',
    agentId: 'agent-demo',
    tags: ['setup', 'notes'],
  });
  console.log('Committed:', commit.commitId);

  // --- Destroy the sandbox ---
  await cv.workspaces.destroy(workspace.id);
  console.log('Sandbox destroyed');

  // --- Pull files back ---
  const result = await cv.workspaces.pull(workspace.id);
  console.log('\nFiles in workspace:');
  for (const file of result.files) {
    console.log(`  ${file.path} (${file.content.length} bytes)`);
  }

  // --- Get a single file ---
  const meeting = await cv.workspaces.getFile(workspace.id, 'notes/meeting.md');
  console.log('\nMeeting notes content:');
  console.log(meeting.content);

  // --- View history ---
  const history = await cv.workspaces.history(workspace.id);
  console.log('\nCommit history:');
  for (const entry of history.commits) {
    console.log(`  ${entry.commitId} - ${entry.createdAt}`);
  }

  // --- List all workspaces for this customer ---
  const workspaces = await cv.workspaces.list({ customerId });
  console.log(`\nCustomer has ${workspaces.length} workspace(s)`);

  // --- Cleanup: delete the workspace ---
  await cv.workspaces.delete(workspace.id);
  console.log('Workspace deleted');

  // --- Verify deletion ---
  try {
    await cv.workspaces.get(workspace.id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.log('Confirmed: workspace no longer exists');
    }
  }
}

main().catch(console.error);
```

## Run It

```bash
npx ts-node example.ts
```
