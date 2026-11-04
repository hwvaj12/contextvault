import { expect, it } from 'vitest';
import { join } from 'node:path';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';

it('remote MCP handles publish exact binary files, checkpoint, finalize and abort without exposing host paths', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: f.server.client.baseUrl, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') } }).initialize();
    const tools = (await peer.call('tools/list')).tools.map((tool: any) => tool.name);
    expect(tools).toContain('checkout_workspace');
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'remote-session' });
    expect(opened.isError).not.toBe(true); expect(opened.value.workspaceHandle).toMatch(/^session-/); expect(opened.value).not.toHaveProperty('path'); expect(opened.value).not.toHaveProperty('sandboxPath');
    const handle = opened.value.workspaceHandle;
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'binary.bin', base64: bytes.toString('base64'), offset: 0, truncate: true })).isError).not.toBe(true);
    expect((await peer.tool('make_workspace_directory', { workspaceHandle: handle, path: 'empty' })).isError).not.toBe(true);
    const first = await peer.tool('read_workspace_file', { workspaceHandle: handle, path: 'binary.bin' }); expect(Buffer.from(first.value.base64, 'base64')).toEqual(bytes);
    expect((await peer.tool('commit_workspace', { workspaceHandle: handle })).isError).toBe(true);
    const checkpoint = await peer.tool('commit_workspace', { workspaceHandle: handle, writersStopped: true }); expect(checkpoint.isError).not.toBe(true); expect(checkpoint.value.checkpointReceipt.operation.result.changed).toBe(true);
    expect((await peer.tool('delete_workspace_file', { workspaceHandle: handle, path: 'binary.bin' })).isError).not.toBe(true);
    const finalized = await peer.tool('finalize_workspace', { workspaceHandle: handle, writersStopped: true }); expect(finalized.isError).not.toBe(true); expect(finalized.value.run.state).toBe('finalized');
    expect((await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true })).value.cleanupState).toBe('complete');
    const readback = await peer.tool('checkout_workspace', { workspaceId: workspace.id, mode: 'read-only', access: 'remote', requestId: 'readback' });
    const deniedWrite = await peer.tool('write_workspace_file', { workspaceHandle: readback.value.workspaceHandle, path: 'forbidden.txt', base64: 'eA==', truncate: true }); expect(deniedWrite.isError).toBe(true); expect(deniedWrite.value.error.code).toBe('INVALID_TRANSITION');
    const listed = await peer.tool('list_workspace_files', { workspaceHandle: readback.value.workspaceHandle }); expect(listed.value.entries).toEqual([{ path: 'empty', kind: 'directory' }]);
    const aborted = await peer.tool('abort_workspace', { workspaceHandle: readback.value.workspaceHandle, writersStopped: true, reason: 'owned verification complete' }); expect(aborted.value.run.state).toBe('aborted');
    await peer.tool('cleanup_workspace', { workspaceHandle: readback.value.workspaceHandle, writersStopped: true });
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);
