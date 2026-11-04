import { fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { journalPath } from '../../src/compat/journal';
import { call, migrationFixture, publish, workspace } from './helpers';
import { service, transferInput } from './process-helpers';
const root = resolve(import.meta.dirname, '../..');

it('recovers the original clone source and target after SIGKILL before journal write, then drains its pin before actual migration', async () => {
  const f = await migrationFixture(); let child: ReturnType<typeof fork> | undefined; const spies: any[] = [];
  try {
    const c = f.client; const w = await workspace(c); const selected = await publish(c, w.id, { 'old.txt': Buffer.from('original selected bytes') });
    child = fork(join(root, 'tests/migrations/pin-worker.ts'), [], { cwd: root, execArgv: ['-r', join(root, 'node_modules/ts-node/register/transpile-only')], env: { PATH: process.env.PATH, TS_NODE_PROJECT: join(root, 'tsconfig.json'), ...f.storage, CV_STORAGE_BACKEND: 'git', CV_DATA_DIR: f.configuration.dataDirectory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let errors = ''; child.stderr!.on('data', value => { errors += value; }); child.stdout!.resume();
    const message = () => new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Pin worker timed out: ${errors}`)), 15000); child!.once('message', value => { clearTimeout(timer); resolve(value); }); child!.once('error', reject); });
    const ready = await message(); expect(ready.stage).toBe('ready'); const owned = message();
    const request = { targetCustomerId: c.customerA, name: 'recover exact clone' }; const key = 'crash-before-clone-journal';
    const pending = call({ ...c, baseUrl: ready.baseUrl }, `/v1/workspaces/${w.id}/clone`, 'POST', request, c.keyA, key).catch(() => null);
    const pin = (await owned).pin; expect(pin.source.revision.id).toBe(selected); expect(pin.state).toBe('held');
    const file = journalPath(f.app.contextVault, 'administration', { kind: 'clone', scope: pin.scope, actorId: pin.principal.actorId, credentialId: pin.principal.credential.id, key }); await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const exited = new Promise(resolve => child!.once('exit', (_code, signal) => resolve(signal))); child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL'); await pending;
    expect(await f.app.contextVault.control.getWorkspace({ customerId: c.customerA, workspaceId: pin.target.workspaceId } as any)).toBeNull();
    await publish(c, w.id, { 'new.txt': Buffer.from('later accepted bytes') });
    const input = transferInput(f, w.id); await expect(service(f).transfer(input)).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    const restored = await call(c, `/v1/workspaces/${w.id}/clone`, 'POST', request, c.keyA, key); expect(restored.status, JSON.stringify(restored.body)).toBe(201); expect(restored.body.id).toBe(pin.target.workspaceId);
    const cloned = await fetch(`${c.baseUrl}/v1/workspaces/${restored.body.id}/revisions/${restored.body.currentRevisionId}/files?path=old.txt`, { headers: { 'X-API-Key': c.keyA } }); expect(cloned.status).toBe(200); expect(await cloned.text()).toBe('original selected bytes');
    expect((await f.app.contextVault.control.listCopySourcePins(input.scope))[0]).toMatchObject({ id: pin.id, source: pin.source, target: pin.target, state: 'released' });
    const oldStore = await f.app.contextVault.revisionStore(pin.source.binding); expect((await service(f).transfer(input)).state).toBe('complete');
    for (const method of ['readManifest', 'openFile', 'inspectCandidate', 'prepare'] as const) spies.push(vi.spyOn(oldStore, method).mockRejectedValue(new Error('Retired source must not be read')));
    const replay = await call(c, `/v1/workspaces/${w.id}/clone`, 'POST', request, c.keyA, key); expect(replay.status).toBe(201); expect(replay.body).toEqual(restored.body); for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { child?.kill('SIGKILL'); for (const spy of spies) spy.mockRestore(); await f.dispose(); }
}, 60000);
