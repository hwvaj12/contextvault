import { it, expect } from 'vitest';
import { faultFixture } from './fault-fixture';
import { call, workspace, push, backend } from './helpers';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { principalForVerifiedApiKey } from '../../src/middleware/catalog-identity';
const execute = promisify(execFile);

it('requires current scoped read grants for run listing and rejects revoked HTTP and Git credentials', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c);
    const run = await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'current' }, c.keyA, 'open'); expect(run.status).toBe(201);
    expect((await call(c, `/workspaces/${w.id}/runs?limit=0`)).status).toBe(400);
    expect((await call(c, `/workspaces/${w.id}/runs?limit=1001`)).status).toBe(400);
    expect((await call(c, `/workspaces/${w.id}/runs`, 'GET', undefined, server.master)).status).toBe(400);
    const runtime = server.app.contextVault; const principal = (await principalForVerifiedApiKey(runtime.database, { id: server.keys[0].id, customerId: c.customerA }, runtime.now()))!;
    const authority = (await runtime.control.getAuthority({ customerId: c.customerA }, principal))!;
    const authorization = await runtime.lifecycle.runtime.authorize(principal, 'credential:manage', { customerId: c.customerA });
    await runtime.control.updateAuthority({ scope: { customerId: c.customerA }, principal, authorization, expectedCredentialVersion: authority.credentialVersion, expectedPermissionEpoch: authority.permissionEpoch, authority: { ...authority, credentialVersion: authority.credentialVersion + 1, permissionEpoch: authority.permissionEpoch + 1, grants: authority.grants.filter(grant => grant.action !== 'run:read') } });
    expect((await call(c, `/workspaces/${w.id}/runs`)).status).toBe(403);
    const revoked = await fetch(`${c.baseUrl}/api-keys/${server.keys[0].id}`, { method: 'DELETE', headers: { 'X-API-Key': server.master } }); expect(revoked.status).toBe(204);
    expect((await push(c, w.id, [{ path: 'unauthorized', content: 'denied' }])).status).toBe(401);
    expect((await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { 'X-API-Key': c.keyA } })).status).toBe(401);
  } finally { await server.dispose(); }
});

it.skipIf(backend !== 'git')('never serves candidate refs or private object IDs through Git, including direct object wants', async () => {
  let reached!: () => void; let release!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; }); let privateOid = '';
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => { if (stage === 'after-record-prepared' && operation.kind === 'finalize' && operation.intent.mode === 'read-write') { privateOid = operation.candidate!.privateReference.opaqueKey.split('/').at(-1)!; reached(); await held; } } } });
  try {
    const c = server.client; const w = await workspace(c);
    const run = await call(c, `/v1/workspaces/${w.id}/runs`, 'POST', { mode: 'read-write', agentLabel: 'private', task: 'candidate', reason: 'test' }, c.keyA, 'open');
    const submission = await call(c, `/v1/runs/${run.body.id}/submissions`, 'POST', {}, c.keyA, 'begin');
    const bytes = Buffer.from('never-published-secret'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = await fetch(`${c.baseUrl}/v1/runs/${run.body.id}/submissions/${submission.body.id}/files?path=private.txt`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'upload', 'X-Content-SHA256': sha256 }, body: bytes }); expect(upload.status).toBe(201); const receipt: any = await upload.json();
    expect((await call(c, `/v1/runs/${run.body.id}/submissions/${submission.body.id}/seal`, 'POST', { manifest: { schemaVersion: 1, entries: [{ path: 'private.txt', kind: 'file', byteLength: bytes.length, sha256 }] }, receipts: [{ path: 'private.txt', receiptId: receipt.id }] }, c.keyA, 'seal')).status).toBe(200);
    expect((await call(c, `/v1/runs/${run.body.id}/finalize`, 'POST', { expectedRunVersion: run.body.version, submissionId: submission.body.id }, c.keyA, 'finalize')).status).toBe(202); await ready;
    const advertisement = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { 'X-API-Key': c.keyA } }); expect(advertisement.status).toBe(200); const advertised = await advertisement.text(); expect(advertised).not.toContain(privateOid); expect(advertised).not.toContain('contextvault/');
    const packet = (text: string) => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
    const want = await fetch(`${c.baseUrl}/repos/${w.id}/git-upload-pack`, { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/x-git-upload-pack-request' }, body: packet(`want ${privateOid} no-progress\n`) + '0000' + packet('done\n') }); expect(want.status).toBe(400); expect(await want.text()).not.toContain('never-published-secret');
    const checkout = await mkdtemp(join(server.directory, 'clone-'));
    try { await execute('git', ['-c', `http.extraHeader=X-API-Key: ${c.keyA}`, 'clone', `${c.baseUrl}/repos/${w.id}`, checkout], { timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }); await expect(readFile(join(checkout, 'private.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); }
    finally { await rm(checkout, { recursive: true, force: true }); }
    // Revoke before releasing: the prepared private object must never become accepted.
    expect((await fetch(`${c.baseUrl}/api-keys/${server.keys[0].id}`, { method: 'DELETE', headers: { 'X-API-Key': server.master } })).status).toBe(204);
    release();
  } finally { release(); await server.dispose(); }
});

it('binds legacy presentation metadata to the exact current owner and command, never foreign or revoked callers', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'marker' }, c.keyA, 'marker-open');
    const runtime = server.app.contextVault; const principal = (await principalForVerifiedApiKey(runtime.database, { id: server.keys[0].id, customerId: c.customerA }, runtime.now()))!;
    const foreign = (await principalForVerifiedApiKey(runtime.database, { id: server.keys[1].id, customerId: c.customerB }, runtime.now()))!;
    const scope = { customerId: c.customerA, workspaceId: w.id }; const run = (await runtime.control.getRun(scope, opened.body.id))!;
    const command = runtime.lifecycle.runtime.command('finalize', { principal, idempotencyKey: 'marker', request: { expectedRunVersion: run.version } }, scope, run.id);
    const authorization = await runtime.lifecycle.runtime.authorize(principal, 'run:finalize', scope); const input = { scope: { ...run.scope, runId: run.id }, principal, authorization, command };
    await runtime.control.recordLegacyPush(input); await runtime.control.recordLegacyPush(input);
    await expect(runtime.control.recordLegacyPush({ ...input, command: { ...command, requestDigest: 'f'.repeat(64) as never } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(runtime.control.recordLegacyPush({ ...input, principal: foreign })).rejects.toBeTruthy();
    expect((await fetch(`${c.baseUrl}/api-keys/${server.keys[0].id}`, { method: 'DELETE', headers: { 'X-API-Key': server.master } })).status).toBe(204);
    await expect(runtime.control.recordLegacyPush(input)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    // A marker alone produces no publication, audit, or delivery event.
    expect((await runtime.control.listRevisions(scope)).revisions).toHaveLength(1); expect((await runtime.control.listAudit(scope)).events.map(event => event.type).sort()).toEqual(['run.started', 'workspace.created']);
  } finally { await server.dispose(); }
});
