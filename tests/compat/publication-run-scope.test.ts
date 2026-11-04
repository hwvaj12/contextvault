import { expect, it } from 'vitest';
import { fixture, workspace, call } from './helpers';
it('keeps same-key empty finalize requests independent for two writable runs, including restart replay', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c);
    const runs = [];
    for (const key of ['first-run', 'second-run']) {
      const opened = await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: key }, c.keyA, key);
      expect(opened.status).toBe(201); runs.push(opened.body);
    }
    const first = await call(c, `/runs/${runs[0].id}/finalize`, 'POST', {}, c.keyA, 'same-finalize-key'); expect(first.status).toBe(200);
    const second = await call(c, `/runs/${runs[1].id}/finalize`, 'POST', {}, c.keyA, 'same-finalize-key'); expect(second.status).toBe(200);
    expect(second.body.id).toBe(runs[1].id); expect(second.body.state).toBe('finalized'); expect(second.body.operationId).not.toBe(first.body.operationId);
    expect((await call(c, `/v1/runs/${runs[1].id}`)).body.state).toBe('finalized');
    await server.restart();
    for (const [index, run] of runs.entries()) {
      const replay = await call(c, `/runs/${run.id}/finalize`, 'POST', {}, c.keyA, 'same-finalize-key'); expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(run.id); expect(replay.body.operationId).toBe([first, second][index].body.operationId);
    }
  } finally { await server.dispose(); }
});
