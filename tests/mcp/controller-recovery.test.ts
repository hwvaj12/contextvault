import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controller, recoverController } from '../../mcp/src/private';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';
import { configuredFixture } from '../revisions/helpers';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const marker = (id: string) => JSON.stringify({ schemaVersion: 1, id, token: randomUUID() });
const partialMarkers = (id: string) => ['', '{', marker(id).slice(0, 24), marker(id).slice(0, -20), marker(id).slice(0, -1)];
const partition = (parent: string, c: any) => join(parent, digest(JSON.stringify([c.baseUrl, c.keyA, null])));
const sessionId = (requestId: string) => 'session-' + digest(requestId);
const commandId = (requestId: string) => 'command-' + digest('create:' + requestId);
const absent = async (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
async function owned(callback: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-mcp-controller-'));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

it('explicit recovery retires only complete or recognizable interrupted controller markers', async () => {
  await owned(async directory => {
    const id = sessionId('partial-local'), path = join(directory, 'controller');
    for (const bytes of [...partialMarkers(id), marker(id)]) {
      await writeFile(path, bytes, { mode: 0o600 });
      await recoverController(path, id);
      await absent(path);
    }
  });
});

it('normal acquisition never steals an interrupted controller marker', async () => {
  await owned(async directory => {
    const id = sessionId('still-locked'), path = join(directory, 'controller');
    let called = false;
    await writeFile(path, '', { mode: 0o600 });
    await expect(controller(path, id, async () => { called = true; })).rejects.toMatchObject({ code: 'CONTROLLER_ACTIVE' });
    expect(called).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('');
  });
});

it('recovery refuses foreign or malformed ownership and unsafe filesystem objects', async () => {
  await owned(async directory => {
    const id = sessionId('strict-local'), path = join(directory, 'controller'), outside = join(directory, 'outside');
    for (const bytes of [marker(sessionId('foreign')), JSON.stringify({ schemaVersion: 2, id, token: randomUUID() }), 'null', '[]', '{}', '"foreign"', '{"schemaVersion":9', '{"id":"foreign"', marker(id).slice(0, -10) + 'invalid']) {
      await writeFile(path, bytes, { mode: 0o600 });
      await expect(recoverController(path, id)).rejects.toMatchObject({ code: 'CONTROLLER_CHANGED' });
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    await unlink(path);
    await writeFile(outside, 'outside stays', { mode: 0o600 });
    await symlink(outside, path);
    await expect(recoverController(path, id)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await unlink(path); await link(outside, path);
    await expect(recoverController(path, id)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await unlink(path); await mkdir(path);
    await expect(recoverController(path, id)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await rm(path, { recursive: true });
    await writeFile(path, '', { mode: 0o600 }); await chmod(path, 0o644);
    await expect(recoverController(path, id)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await chmod(path, 0o600); await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
    await expect(recoverController(path, id)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readFile(outside, 'utf8')).toBe('outside stays');
  });
});

it('public recovery preserves established session and command journals after interrupted marker writes', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const c = f.server.client, parent = join(f.directory, 'private-state'), directory = partition(parent, c);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: parent } }).initialize();
    const workspace = await canonicalWorkspace(f.server);
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'established' });
    expect(opened.isError).not.toBe(true);
    const handle = opened.value.workspaceHandle, lock = join(directory, 'locks', handle + '.json');
    const statePath = join(directory, 'sessions', handle, 'state.json'), controlPath = join(directory, 'controls', handle + '.json');
    for (const bytes of ['', marker(handle).slice(0, -12), marker(handle)]) {
      const state = await readFile(statePath), control = await readFile(controlPath);
      await writeFile(lock, bytes, { mode: 0o600 });
      expect((await peer.tool('workspace_status', { workspaceHandle: handle })).value.error.code).toBe('CONTROLLER_ACTIVE');
      expect((await peer.tool('recover_workspace_controller', { workspaceHandle: handle, controllersStopped: false })).isError).toBe(true);
      expect(await readFile(lock, 'utf8')).toBe(bytes);
      expect((await peer.tool('recover_workspace_controller', { workspaceHandle: handle, controllersStopped: true })).isError).not.toBe(true);
      expect(await readFile(statePath)).toEqual(state); expect(await readFile(controlPath)).toEqual(control);
      expect((await peer.tool('workspace_status', { workspaceHandle: handle })).value.runId).toBe(opened.value.runId);
    }
    const input = { customerId: c.customerA, name: 'established command', requestId: 'established-create' };
    const created = await peer.tool('create_workspace', input); expect(created.isError).not.toBe(true);
    const commandHandle = commandId(input.requestId), commandPath = join(directory, 'commands', commandHandle + '.json'), commandLock = commandPath + '.controller';
    const command = await readFile(commandPath);
    for (const bytes of ['', marker(commandHandle).slice(0, -12), marker(commandHandle)]) {
      await writeFile(commandLock, bytes, { mode: 0o600 });
      expect((await peer.tool('create_workspace', input)).value.error.code).toBe('CONTROLLER_ACTIVE');
      expect((await peer.tool('recover_command_controller', { commandHandle, controllersStopped: true })).isError).not.toBe(true);
      expect(await readFile(commandPath)).toEqual(command);
      expect((await peer.tool('create_workspace', input)).value.id).toBe(created.value.id);
    }
    expect((await peer.tool('list_workspaces')).value.map((value: any) => value.id).sort()).toEqual([workspace.id, created.value.id].sort());
    await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'owned controller recovery finished' });
    await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true });
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);

it('public recovery clears pre-journal acquisition and the original checkout or create request retries once', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const c = f.server.client, parent = join(f.directory, 'private-state'), directory = partition(parent, c);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: parent } }).initialize();
    const workspace = await canonicalWorkspace(f.server), createdIds: string[] = [workspace.id];
    for (const [index, kind] of ['empty', 'partial', 'complete'].entries()) {
      const requestId = 'initial-session-' + kind, handle = sessionId(requestId), lock = join(directory, 'locks', handle + '.json');
      const bytes = index === 0 ? '' : index === 1 ? marker(handle).slice(0, -12) : marker(handle);
      await writeFile(lock, bytes, { mode: 0o600 });
      const input = { workspaceId: workspace.id, access: 'remote', requestId };
      const blocked = await peer.tool('checkout_workspace', input); expect(blocked.value.error.code).toBe('CONTROLLER_ACTIVE');
      const recovered = await peer.tool('recover_workspace_controller', { workspaceHandle: handle, workspaceId: workspace.id, controllersStopped: true });
      expect(recovered.isError).not.toBe(true); expect(recovered.value.initializationIncomplete).toBe(true);
      expect(blocked.value.error.workspaceHandle).toBe(handle); await absent(lock);
      const opened = await peer.tool('checkout_workspace', input); expect(opened.isError).not.toBe(true);
      expect((await peer.tool('checkout_workspace', input)).value.runId).toBe(opened.value.runId);
      await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'owned initial recovery finished' });
      await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true });
      const commandRequest = 'initial-create-' + kind, commandHandle = commandId(commandRequest), commandLock = join(directory, 'commands', commandHandle + '.json.controller');
      await writeFile(commandLock, index === 0 ? '' : index === 1 ? marker(commandHandle).slice(0, -12) : marker(commandHandle), { mode: 0o600 });
      const createInput = { customerId: c.customerA, name: commandRequest, requestId: commandRequest };
      const commandBlocked = await peer.tool('create_workspace', createInput); expect(commandBlocked.value.error.code).toBe('CONTROLLER_ACTIVE');
      const recoveredCommand = await peer.tool('recover_command_controller', { commandHandle, controllersStopped: true });
      expect(recoveredCommand.isError).not.toBe(true); expect(recoveredCommand.value.initializationIncomplete).toBe(true);
      expect(commandBlocked.value.error.commandHandle).toBe(commandHandle); await absent(commandLock);
      const created = await peer.tool('create_workspace', createInput); expect(created.isError).not.toBe(true);
      expect((await peer.tool('create_workspace', createInput)).value.id).toBe(created.value.id); createdIds.push(created.value.id);
    }
    expect((await peer.tool('list_workspaces')).value.map((value: any) => value.id).sort()).toEqual(createdIds.sort());
    const response = await fetch(c.baseUrl + '/workspaces/' + workspace.id + '/runs', { headers: { 'X-API-Key': c.keyA } });
    expect(response.status).toBe(200); const runs = await response.json(); expect(runs.data ?? runs.runs ?? runs).toHaveLength(3);
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);

it('pre-journal recovery retains ambiguous SDK data and requires current workspace authority', async () => {
  const f = await configuredFixture(); let peer: Protocol | undefined; let foreign: Protocol | undefined;
  try {
    const c = f.client, parent = join(f.directory, 'private-state'), directory = partition(parent, c);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: parent } }).initialize();
    const response = await fetch(c.baseUrl + '/v1/workspaces', { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'controller-authority', 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: c.customerA, name: 'controller authority' }) });
    expect(response.status).toBe(201); const workspace = await response.json();
    const handle = sessionId('ambiguous'), lock = join(directory, 'locks', handle + '.json'), sessionDirectory = join(directory, 'sessions', handle);
    await mkdir(sessionDirectory, { mode: 0o700 }); const statePath = join(sessionDirectory, 'state.json'), bytes = '{"pendingCommand":"must remain"}';
    await writeFile(statePath, bytes, { mode: 0o600 }); await writeFile(lock, marker(handle), { mode: 0o600 });
    const denied = await peer.tool('recover_workspace_controller', { workspaceHandle: handle, workspaceId: workspace.id, controllersStopped: true });
    expect(denied.isError).toBe(true); expect(denied.value.error.code).toBe('RECONCILIATION_REQUIRED'); expect(await readFile(statePath, 'utf8')).toBe(bytes);
    await lstat(lock);
    const orphan = sessionId('authority-orphan'), orphanLock = join(directory, 'locks', orphan + '.json'); await writeFile(orphanLock, '', { mode: 0o600 });
    foreign = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyB, CV_MCP_STATE_DIR: parent } }).initialize();
    expect((await foreign.tool('recover_workspace_controller', { workspaceHandle: orphan, workspaceId: workspace.id, controllersStopped: true })).isError).toBe(true);
    expect(await readFile(orphanLock, 'utf8')).toBe('');
    expect((await fetch(c.baseUrl + '/api-keys/' + f.keys[0].id, { method: 'DELETE', headers: { 'X-API-Key': f.master } })).status).toBe(204);
    expect((await peer.tool('recover_workspace_controller', { workspaceHandle: orphan, workspaceId: workspace.id, controllersStopped: true })).isError).toBe(true);
    expect(await readFile(orphanLock, 'utf8')).toBe('');
    const commandHandle = commandId('revoked-orphan'), commandLock = join(directory, 'commands', commandHandle + '.json.controller'); await writeFile(commandLock, '', { mode: 0o600 });
    expect((await peer.tool('recover_command_controller', { commandHandle, controllersStopped: true })).isError).toBe(true);
    expect(await readFile(commandLock, 'utf8')).toBe('');
  } finally { await foreign?.close(); await peer?.close(); await f.dispose(); }
}, 60000);

it('public recovery retries saved control before SDK initialization with one original run', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const c = f.server.client, parent = join(f.directory, 'private-state'), directory = partition(parent, c);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: parent } }).initialize();
    const workspace = await canonicalWorkspace(f.server), requestId = 'saved-before-sdk', handle = sessionId(requestId);
    const request = { workspaceId: workspace.id, access: 'remote', mode: 'read-write', agentLabel: 'mcp-agent', task: 'MCP workspace task', reason: 'explicit MCP checkout' };
    const controlPath = join(directory, 'controls', handle + '.json'), lock = join(directory, 'locks', handle + '.json');
    const control = JSON.stringify({ schemaVersion: 1, id: handle, request, blocked: true, cleaned: false });
    await writeFile(controlPath, control, { mode: 0o600 }); await writeFile(lock, marker(handle), { mode: 0o600 });
    const runs = async () => {
      const response = await fetch(c.baseUrl + '/workspaces/' + workspace.id + '/runs', { headers: { 'X-API-Key': c.keyA } });
      expect(response.status).toBe(200); const value = await response.json(); return value.data ?? value.runs ?? value;
    };
    expect(await runs()).toHaveLength(0);
    expect((await peer.tool('checkout_workspace', { ...request, requestId })).value.error.code).toBe('CONTROLLER_ACTIVE');
    const recovered = await peer.tool('recover_workspace_controller', { workspaceHandle: handle, controllersStopped: true });
    expect(recovered.isError).not.toBe(true); expect(await readFile(controlPath, 'utf8')).toBe(control);
    await absent(join(directory, 'sessions', handle)); expect(await runs()).toHaveLength(0);
    expect((await peer.tool('checkout_workspace', { ...request, reason: 'different request', requestId })).value.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const opened = await peer.tool('checkout_workspace', { ...request, requestId });
    expect(opened.isError).not.toBe(true); expect(recovered.value.initializationIncomplete).toBe(true);
    expect(opened.value.workspaceHandle).toBe(handle);
    expect((await peer.tool('checkout_workspace', { ...request, requestId })).value.runId).toBe(opened.value.runId);
    expect((await runs()).map((run: any) => run.id)).toEqual([opened.value.runId]);
    await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'saved control recovery finished' });
    await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true });
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);

it('public recovery retains saved control and incomplete or unsafe SDK directories', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const c = f.server.client, parent = join(f.directory, 'private-state'), directory = partition(parent, c);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: parent } }).initialize();
    const workspace = await canonicalWorkspace(f.server);
    for (const kind of ['empty', 'owner', 'malformed', 'symlink', 'hardlink']) {
      const handle = sessionId('sdk-without-state-' + kind), controlPath = join(directory, 'controls', handle + '.json'), lock = join(directory, 'locks', handle + '.json');
      const request = { workspaceId: workspace.id, access: 'remote', mode: 'read-write', agentLabel: 'mcp-agent', task: 'MCP workspace task', reason: 'explicit MCP checkout' };
      const control = JSON.stringify({ schemaVersion: 1, id: handle, request, blocked: true, cleaned: false }), owner = JSON.stringify({ sessionId: randomUUID() });
      const sessionDirectory = join(directory, 'sessions', handle); await mkdir(sessionDirectory, { mode: 0o700 });
      if (kind !== 'empty') await writeFile(join(sessionDirectory, 'owner.json'), owner, { mode: 0o600 });
      const statePath = join(sessionDirectory, 'state.json'), outside = join(f.directory, 'outside-state-' + kind);
      if (kind === 'malformed') await writeFile(statePath, '{}', { mode: 0o600 });
      if (kind === 'symlink' || kind === 'hardlink') {
        await writeFile(outside, 'outside state must remain', { mode: 0o600 });
        if (kind === 'symlink') await symlink(outside, statePath); else await link(outside, statePath);
      }
      const controllerBytes = marker(handle); await writeFile(controlPath, control, { mode: 0o600 }); await writeFile(lock, controllerBytes, { mode: 0o600 });
      const recovered = await peer.tool('recover_workspace_controller', { workspaceHandle: handle, controllersStopped: true });
      expect(recovered.isError).toBe(true);
      if (kind === 'empty' || kind === 'owner') expect(recovered.value.error.code).toBe('RECONCILIATION_REQUIRED');
      expect(await readFile(controlPath, 'utf8')).toBe(control); expect(await readFile(lock, 'utf8')).toBe(controllerBytes);
      if (kind !== 'empty') expect(await readFile(join(sessionDirectory, 'owner.json'), 'utf8')).toBe(owner);
      if (kind === 'empty' || kind === 'owner') await absent(statePath);
      else if (kind === 'malformed') expect(await readFile(statePath, 'utf8')).toBe('{}');
      else expect(await readFile(outside, 'utf8')).toBe('outside state must remain');
    }
    const response = await fetch(c.baseUrl + '/workspaces/' + workspace.id + '/runs', { headers: { 'X-API-Key': c.keyA } });
    expect(response.status).toBe(200); const runs = await response.json(); expect(runs.data ?? runs.runs ?? runs).toHaveLength(0);
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);
