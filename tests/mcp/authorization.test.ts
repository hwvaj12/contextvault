import { expect, it } from 'vitest';
import { join } from 'node:path';
import { access, link, readFile, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';
import { configuredFixture } from '../revisions/helpers';

it('MCP file tools reject traversal, links, private metadata and oversized chunks while preserving outside files', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: f.server.client.baseUrl, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') } }).initialize();
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'local', requestId: 'safe-local-files' }); const handle = opened.value.workspaceHandle; const local = opened.value.path;
    expect(opened.value.machine).toBe('mcp-host'); expect(local).toContain(f.directory);
    const outside = join(f.directory, 'outside.txt'); await writeFile(outside, 'outside-owned-file'); await symlink(outside, join(local, 'linked.txt'));
    expect((await peer.tool('read_workspace_file', { workspaceHandle: handle, path: 'linked.txt' })).isError).toBe(true);
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'linked.txt', base64: 'eA==', truncate: true })).isError).toBe(true); await unlink(join(local, 'linked.txt'));
    await link(outside, join(local, 'hardlinked.txt'));
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'hardlinked.txt', base64: 'eA==', truncate: true })).isError).toBe(true); await unlink(join(local, 'hardlinked.txt'));
    expect(await readFile(outside, 'utf8')).toBe('outside-owned-file');
    for (const path of ['../state.json', '.git/config', '.contextvault/key', '/absolute', 'x\\escape']) expect((await peer.tool('read_workspace_file', { workspaceHandle: handle, path })).isError).toBe(true);
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'large.bin', base64: Buffer.alloc(65537).toString('base64') })).isError).toBe(true);
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'bad.bin', base64: '!!!!' })).isError).toBe(true);
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'hole.bin', base64: 'eA==', offset: 1 })).isError).toBe(true);
    await expect(access(join(local, 'hole.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await peer.tool('read_workspace_file', { workspaceHandle: handle, path: 'outside.txt', length: 65537 })).isError).toBe(true);
    const invalid = await peer.tool('workspace_status', { workspaceHandle: handle, workspaceId: 'different-workspace' }); expect(invalid.value.error.code).toBe('INVALID_REQUEST');
    await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'owned path verification complete' }); await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true });
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);

it('remote file writes enforce the shared total workspace byte limit before creating another file', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: f.server.client.baseUrl, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') } }).initialize();
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'local', requestId: 'bounded-workspace-files' }); const handle = opened.value.workspaceHandle; const local = opened.value.path;
    for (let index = 0; index < 8; index++) { const path = join(local, 'sparse-' + index + '.bin'); await writeFile(path, ''); await truncate(path, 64 * 1024 * 1024); }
    const rejected = await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'overflow.bin', base64: 'eA==', truncate: true }); expect(rejected.isError).toBe(true); expect(rejected.value.error.code).toBe('QUOTA_EXCEEDED');
    await expect(access(join(local, 'overflow.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'sparse-0.bin', base64: '', truncate: true })).isError).not.toBe(true);
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'overflow.bin', base64: 'eA==', truncate: true })).isError).not.toBe(true);
    await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'owned quota verification complete' }); await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true });
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);

it('current credential revocation blocks MCP file reads, publication and reconciliation without exposing retained bytes', async () => {
  const f = await configuredFixture(); let peer: Protocol | undefined; let foreign: Protocol | undefined;
  try {
    const c = f.client; const state = join(f.directory, 'mcp-private');
    const created = await fetch(c.baseUrl + '/v1/workspaces', { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'mcp-authority-create', 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: c.customerA, name: 'MCP authority' }) }); expect(created.status).toBe(201); const workspace = await created.json();
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: state } }).initialize();
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'authority-session' }); const handle = opened.value.workspaceHandle;
    await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'secret.txt', base64: Buffer.from('retained-only-for-authorized-owner').toString('base64'), truncate: true });
    foreign = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyB, CV_MCP_STATE_DIR: state } }).initialize();
    expect((await foreign.tool('get_workspace', { workspaceId: workspace.id })).isError).toBe(true); expect((await foreign.tool('read_workspace_file', { workspaceHandle: handle, path: 'secret.txt' })).isError).toBe(true);
    const revoked = await fetch(c.baseUrl + '/api-keys/' + f.keys[0].id, { method: 'DELETE', headers: { 'X-API-Key': f.master } }); expect(revoked.status).toBe(204);
    for (const [name, args] of [['read_workspace_file', { path: 'secret.txt' }], ['finalize_workspace', { writersStopped: true }], ['reconcile_workspace', { writersStopped: true }]] as const) {
      const denied = await peer.tool(name, { workspaceHandle: handle, ...args }); expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain('retained-only-for-authorized-owner'); expect(JSON.stringify(denied)).not.toContain(c.keyA);
    }
  } finally { await foreign?.close(); await peer?.close(); await f.dispose(); }
}, 60000);

it.each(['local', 'remote'] as const)('deleted workspace content authority blocks every %s MCP file tool while retaining run status', async accessMode => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const c = f.server.client; const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') } }).initialize();
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: accessMode, requestId: 'deleted-content-authority' }); expect(opened.isError).not.toBe(true); const workspaceHandle = opened.value.workspaceHandle;
    const secret = Buffer.from('retained-bytes-require-current-content-authority').toString('base64');
    expect((await peer.tool('write_workspace_file', { workspaceHandle, path: 'secret.txt', base64: secret, truncate: true })).isError).not.toBe(true);
    expect((await peer.tool('read_workspace_file', { workspaceHandle, path: 'secret.txt' })).value.base64).toBe(secret);
    const deleted = await fetch(c.baseUrl + '/v1/workspaces/' + workspace.id, { method: 'DELETE', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'delete-content-authority', 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'owned content authorization verification' }) }); expect(deleted.status).toBe(204);
    const headers = { 'X-API-Key': c.keyA };
    expect((await fetch(c.baseUrl + '/v1/runs/' + opened.value.runId, { headers })).status).toBe(200);
    for (const path of ['/v1/workspaces/' + workspace.id, '/v1/runs/' + opened.value.runId + '/workspace/manifest', '/v1/runs/' + opened.value.runId + '/workspace/files?path=secret.txt']) expect((await fetch(c.baseUrl + path, { headers })).status).toBe(403);
    const attempts = [
      ['read_workspace_file', { path: 'secret.txt' }], ['list_workspace_files', {}],
      ['write_workspace_file', { path: 'new.txt', base64: 'eA==', truncate: true }],
      ['delete_workspace_file', { path: 'secret.txt' }], ['make_workspace_directory', { path: 'new-directory' }],
    ] as const;
    const results = [];
    for (const [name, args] of attempts) results.push({ name, reply: await peer.tool(name, { workspaceHandle, ...args }) });
    for (const { name, reply } of results) { expect(reply.isError, name).toBe(true); expect(reply.value.error.code, name).toBe('FORBIDDEN'); expect(JSON.stringify(reply), name).not.toContain(secret); expect(JSON.stringify(reply), name).not.toContain('secret.txt'); }
    if (accessMode === 'local') {
      expect(await readFile(join(opened.value.path, 'secret.txt'), 'utf8')).toBe('retained-bytes-require-current-content-authority');
      for (const path of ['new.txt', 'new-directory']) await expect(access(join(opened.value.path, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const status = await peer.tool('workspace_status', { workspaceHandle }); expect(status.isError).not.toBe(true); expect(status.value.runId).toBe(opened.value.runId);
    // Inactive workspace policy currently rejects abort. This fix must not claim or grant broader lifecycle authority.
    expect((await peer.tool('abort_workspace', { workspaceHandle, writersStopped: true, reason: 'owned inactive verification complete' })).isError).toBe(true);
    expect((await peer.tool('cleanup_workspace', { workspaceHandle, writersStopped: true })).isError).toBe(true);
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);

it('administrator MCP access requires one selected customer and never expands a customer credential', async () => {
  const f = await configuredFixture(); const peers: Protocol[] = [];
  try {
    const c = f.client;
    for (const [key, customerId] of [[c.keyA, c.customerA], [c.keyB, c.customerB]]) {
      const response = await fetch(c.baseUrl + '/v1/workspaces', { method: 'POST', headers: { 'X-API-Key': key, 'Idempotency-Key': 'selected-' + customerId, 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId, name: customerId }) }); expect(response.status).toBe(201);
    }
    const launch = async (key: string, customer?: string) => {
      const peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: key, CV_MCP_STATE_DIR: join(f.directory, 'mcp-private'), ...(customer ? { CV_CUSTOMER_ID: customer } : {}) } }).initialize(); peers.push(peer); return peer;
    };
    expect((await (await launch(f.master)).tool('list_workspaces')).isError).toBe(true);
    const selected = await launch(f.master, c.customerA);
    expect((await selected.tool('list_workspaces')).value.map((workspace: any) => workspace.customerId)).toEqual([c.customerA]);
    expect((await selected.tool('create_workspace', { customerId: c.customerB, name: 'foreign', requestId: 'admin-outside-selection' })).isError).toBe(true);
    expect((await (await launch(c.keyA, c.customerB)).tool('list_workspaces')).isError).toBe(true);
  } finally { for (const peer of peers) await peer.close(); await f.dispose(); }
}, 60000);
