import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { faultFixture } from './fault-fixture';
import { workspace, call, push } from './helpers';
import { WorkspaceError } from '../../src/domain';

it('persists a reopened run whose accepted base advanced and explicitly abandons it without another publication', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'opening'); expect(opened.status).toBe(201);
    await writeFile(join(opened.body.sandboxPath, 'checkpoint.txt'), 'checkpoint');
    const lifecycle = server.app.contextVault.lifecycle; const original = lifecycle.openRun.bind(lifecycle); let advanced = false;
    lifecycle.openRun = async input => {
      if (input.idempotencyKey.startsWith('sandbox-reopen-') && !advanced) { advanced = true; expect((await push(c, w.id, [{ path: 'concurrent.txt', content: 'concurrent accepted head' }])).status).toBe(201); }
      return original(input);
    };
    const pending = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint'); expect(pending.status).toBe(201); expect(pending.body.state).toBe('published-needs-reopen');
    const scope = { customerId: c.customerA, workspaceId: w.id }; const active = (await server.app.contextVault.control.listRuns(scope)).runs.filter(run => run.state === 'active'); expect(active).toHaveLength(1);
    expect(pending.body.runId).toBe(active[0].id); expect(pending.body.reopenRunId).toBe(active[0].id);
    const replay = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint'); expect(replay.body.reopenRunId).toBe(active[0].id); expect(replay.body.operation.id).toBe(pending.body.operation.id);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'abandon')).status).toBe(200);
    expect((await server.app.contextVault.control.listRuns(scope)).runs.some(run => run.state === 'active')).toBe(false);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'concurrent.txt', content: 'concurrent accepted head' }]);
    await expect(access(opened.body.sandboxPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await server.dispose(); }
});

it('retains an incomplete opening until stopped-writer abandonment, including a canonical abort and healthy subsequent checkout', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c); expect((await push(c, w.id, [{ path: 'one.txt', content: 'one' }, { path: 'two.txt', content: 'two' }])).status).toBe(201);
    const runtime = server.app.contextVault; const original = runtime.revisionStore; let fail = true;
    runtime.revisionStore = async binding => new Proxy(await original(binding), { get(target, property) {
      if (property === 'openFile') return (...args: any[]) => { if (fail) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Injected transient hydration failure'); return (target.openFile as any)(...args); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'original-open')).status).toBe(503); fail = false;
    const state = await call(c, `/workspaces/${w.id}/sandbox`); expect(state.status).toBe(200); expect(state.body.state).toBe('opening'); expect(state.body.runId).toBeTruthy();
    await mkdir(state.body.sandboxPath, { recursive: true }); await writeFile(join(state.body.sandboxPath, 'retained.txt'), 'possibly exposed local work');
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'original-open')).status).toBe(503);
    expect(await readFile(join(state.body.sandboxPath, 'retained.txt'), 'utf8')).toBe('possibly exposed local work');
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: false, abandon: true }, c.keyA, 'unsafe-abandon')).status).toBe(400);
    const run = await call(c, `/v1/runs/${state.body.runId}`); expect((await call(c, `/v1/runs/${state.body.runId}/abort`, 'POST', { expectedRunVersion: run.body.version, reason: 'explicit incomplete opening abort' }, c.keyA, 'abort-opening')).status).toBe(200);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'abandon-opening')).status).toBe(200);
    expect((await call(c, `/v1/runs/${state.body.runId}`)).body.outcome.state).toBe('aborted');
    const next = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'new-open'); expect(next.status).toBe(201); expect(next.body.runId).not.toBe(state.body.runId);
    expect(await readFile(join(next.body.sandboxPath, 'one.txt'), 'utf8')).toBe('one');
  } finally { await server.dispose(); }
});

it('abandons the exact accepted reopen after its response is lost before local identity persistence', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'lost-reopen-open');
    await writeFile(join(opened.body.sandboxPath, 'accepted.txt'), 'accepted checkpoint');
    const lifecycle = server.app.contextVault.lifecycle; const original = lifecycle.openRun.bind(lifecycle); let lost = false;
    lifecycle.openRun = async input => {
      const result = await original(input);
      if (input.idempotencyKey.startsWith('sandbox-reopen-') && !lost) { lost = true; throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Injected lost reopen response', { operationId: result.operation.id }); }
      return result;
    };
    const pending = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'lost-reopen-checkpoint'); expect(pending.status).toBe(201); expect(pending.body.state).toBe('published-needs-reopen');
    const scope = { customerId: c.customerA, workspaceId: w.id }; expect((await server.app.contextVault.control.listRuns(scope)).runs.filter(run => run.state === 'active')).toHaveLength(1);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'abandon-lost-reopen')).status).toBe(200);
    expect((await server.app.contextVault.control.listRuns(scope)).runs.some(run => run.state === 'active')).toBe(false);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'accepted.txt', content: 'accepted checkpoint' }]);
  } finally { await server.dispose(); }
});
