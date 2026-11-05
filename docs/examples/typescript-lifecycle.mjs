import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, unlink, mkdir, access, realpath } from 'node:fs/promises';
import path from 'node:path';

// Resolve the installed package from the consumer project, outside the repository.
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { ContextVaultClient } = require('@contextvault/sdk');
for (const name of ['CV_API_URL', 'CV_API_KEY', 'CV_CUSTOMER_ID']) if (!process.env[name]) throw new Error(name + ' is required');
const client = new ContextVaultClient({ baseUrl: process.env.CV_API_URL, apiKey: process.env.CV_API_KEY });
const parent = await mkdtemp(path.join(await realpath(process.cwd()), 'contextvault-example-'));
const payload = Buffer.from([0, 255, 128, 10]);
let session;
const options = name => ({ mode: 'read-write', agentLabel: 'typescript-example', task: name, reason: 'Run the documented lifecycle', stateDirectory: path.join(parent, name) });
try {
  session = await client.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_ID, name: 'TypeScript documentation example' }, ...options('publish') });
  const workspaceId = session.workspaceId;
  await writeFile(path.join(session.path, 'output.bin'), payload);
  await writeFile(path.join(session.path, 'remove.txt'), 'This file is removed in the next revision.');
  await mkdir(path.join(session.path, 'empty'));
  // The application stops every agent writer before this explicit publication.
  const first = await session.finalize({ writersStopped: true });
  assert.equal(first.state, 'succeeded');
  await session.cleanup({ writersStopped: true });

  session = await client.openWorkspace({ workspaceId, ...options('delete') });
  assert.deepEqual(await readFile(path.join(session.path, 'output.bin')), payload);
  await unlink(path.join(session.path, 'remove.txt'));
  assert.equal((await session.finalize({ writersStopped: true })).state, 'succeeded');
  await session.cleanup({ writersStopped: true });

  session = await client.openWorkspace({ workspaceId, ...options('abort') });
  await writeFile(path.join(session.path, 'discarded.txt'), 'This edit is never published.');
  assert.equal((await session.abort({ reason: 'Demonstrate explicit abort', writersStopped: true })).state, 'aborted');
  await session.cleanup({ writersStopped: true });

  session = await client.openWorkspace({ workspaceId, ...options('verify'), mode: 'read-only' });
  assert.deepEqual(await readFile(path.join(session.path, 'output.bin')), payload);
  await assert.rejects(access(path.join(session.path, 'remove.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(session.path, 'discarded.txt')), { code: 'ENOENT' });
  await access(path.join(session.path, 'empty'));
  assert.equal((await session.finalize({ writersStopped: true })).state, 'succeeded');
  const privateStatePath = session.privateStatePath;
  await session.cleanup({ writersStopped: true });
  console.log(JSON.stringify({ language: 'typescript', workspaceId, privateStatePath, binary: true, deletion: true, abort: true, cleanup: true }));
} catch (error) {
  // Retain files and the exact journal when an outcome needs reconciliation.
  console.error(JSON.stringify({ error: error.code ?? 'EXAMPLE_FAILED', privateStatePath: error.privateStatePath ?? session?.privateStatePath ?? null }));
  process.exitCode = 1;
}
