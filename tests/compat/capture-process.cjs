const { join } = require('node:path');
const { readdir, readFile } = require('node:fs/promises');
const root = process.env.CV_SOURCE_ROOT;
const data = process.env.CV_DATA_DIR;
const streams = require(join(root, 'src/application/files/streams.ts'));
const journal = require(join(root, 'src/compat/journal.ts'));
const { WorkspaceError } = require(join(root, 'src/domain'));
let armed = null; let prior = new Set();
const ids = async () => readdir(join(data, 'legacy-compat/captures')).catch(() => []);
async function owned(captureId) {
  const directory = join(data, 'legacy-compat/capture-owners');
  for (const group of await readdir(directory).catch(() => [])) for (const file of await readdir(join(directory, group)).catch(() => [])) {
    try { if (JSON.parse(await readFile(join(directory, group, file), 'utf8')).captureId === captureId) return true; } catch {}
  }
  return false;
}
const originalPersist = streams.persistByteStream;
streams.persistByteStream = async (handle, source, expected, limits, signal) => {
  if (!['failure', 'partial'].includes(armed)) return originalPersist(handle, source, expected, limits, signal);
  const mode = armed; armed = null; const captureId = (await ids()).find(id => !prior.has(id)); const durableOwner = await owned(captureId);
  const iterator = source[Symbol.asyncIterator](); const first = await iterator.next();
  if (!first.done) { await handle.writeFile(first.value); await handle.sync(); } await iterator.return?.();
  process.send({ kind: 'fault', mode, captureId, durableOwner });
  if (mode === 'failure') throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Owned copy fault before journal selection');
  await new Promise(() => {});
};
const originalSave = journal.saveJournal;
journal.saveJournal = async (file, value) => {
  await originalSave(file, value);
  if (armed === 'cleanup' && file.includes('/capture-owners/') && value.state === 'discarding' && !value.retryable) {
    armed = null; process.send({ kind: 'fault', mode: 'cleanup', captureId: value.captureId, durableOwner: await owned(value.captureId) }); await new Promise(() => {});
  }
  if (armed === 'sealed' && file.includes('/captures/') && value.state === 'sealed') {
    armed = null; process.send({ kind: 'fault', mode: 'sealed', captureId: value.captureId, durableOwner: await owned(value.captureId) }); await new Promise(() => {});
  }
};
(async () => {
  const { createApp } = require(join(root, 'src/app.ts')); const app = await createApp({ logger: false, contextVault: { maintenance: false } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  process.on('message', async message => {
    if (message === 'stop') { app.server.closeAllConnections(); await app.close(); process.exit(0); }
    if (message?.arm) { prior = new Set(await ids()); armed = message.arm; process.send({ kind: 'armed', mode: armed }); }
  });
  process.send({ kind: 'ready', baseUrl: `http://127.0.0.1:${app.server.address().port}` });
})().catch(() => process.exit(1));
