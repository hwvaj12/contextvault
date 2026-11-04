import { expect, it, vi } from 'vitest';
import { call, faultFixture, publish, workspace } from './helpers';
import { api, setSelectedCustomerId } from '../../ui/src/api';

it('preserves secondary UI customer selection, the supported diff DTO, and truthful deletion outcomes through HTTP', async () => {
  const server = await faultFixture(); const fetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => fetch(typeof input === 'string' ? new URL(input, server.client.baseUrl) : input, init));
  try {
    const c = server.client; setSelectedCustomerId(''); const w = await workspace(c);
    const first = await publish(c, w.id, { 'changed.txt': Buffer.from('before'), 'removed.txt': Buffer.from('removed') }); const second = await publish(c, w.id, { 'added.txt': Buffer.from('added'), 'changed.txt': Buffer.from('after') });
    const diff = await api.diff(c.keyA, w.id, first, second); expect(diff).toEqual({ from: first, to: second, files: [{ path: 'added.txt', status: 'added' }, { path: 'changed.txt', status: 'modified' }, { path: 'removed.txt', status: 'deleted' }], summary: { filesChanged: 3 } });
    await expect(api.listWorkspaces(server.master)).rejects.toThrow('select');
    setSelectedCustomerId(c.customerA); expect((await api.listWorkspaces(server.master)).map(value => value.id)).toContain(w.id);
    const created = await api.createWorkspace(server.master, c.customerA, 'selected administrator customer'); expect(created.customerId).toBe(c.customerA); expect(created.latestCommitId).toMatch(/^revision-/);
    await expect(api.createWorkspace(server.master, c.customerB, 'mismatched customer')).rejects.toThrow('Customer');
    setSelectedCustomerId(''); expect((await api.listWorkspaces(c.keyA)).map(value => value.id)).toContain(w.id);
    await expect(api.deleteWorkspace(c.keyB, w.id)).rejects.toThrow('Workspace'); expect((await call(c, `/workspaces/${w.id}`)).status).toBe(200);
    expect(await api.deleteWorkspace(c.keyA, created.id)).toBeUndefined(); expect((await call(c, '/workspaces')).body.data.map((value: any) => value.id)).not.toContain(created.id);
    expect((await server.app.contextVault.control.getWorkspace({ customerId: c.customerA, workspaceId: created.id } as any))?.status).toBe('deleted');
  } finally { setSelectedCustomerId(''); vi.unstubAllGlobals(); await server.dispose(); }
}, 60000);
