const { join } = require('node:path');
const source = process.env.CV_SOURCE_ROOT;
let interrupted = false;
(async () => {
  const { createApp } = require(join(source, 'src/app.ts'));
  const clock = process.env.CV_RESTORE_CLOCK;
  if (!Number.isFinite(Date.parse(clock))) throw new Error('Restore fixture requires its private clock');
  const app = await createApp({ logger: false, contextVault: { now: () => clock, lifecycle: { processingRenewIntervalMs: 0, hook: async (stage, operation) => {
    if (operation.kind !== 'restore') return;
    if (process.env.CV_RESTORE_MODE === 'crash' && stage === 'after-prepare' && !interrupted) {
      interrupted = true; process.send({ kind: 'prepared', operation }); await new Promise(() => {});
    }
    if (stage === 'after-accept') process.send({ kind: 'accepted', id: operation.id, fence: operation.claim.fence });
  } } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  process.on('message', async message => { if (message === 'stop') { app.server.closeAllConnections(); await app.close(); process.exit(0); } });
  process.send({ kind: 'ready', clock, baseUrl: `http://127.0.0.1:${app.server.address().port}` });
})().catch(error => { process.send?.({ kind: 'error', message: error.message }); process.exit(1); });
