const { join } = require('node:path');
const { writeFile, access } = require('node:fs/promises');
const root = process.env.CV_SOURCE_ROOT;
const journal = require(join(root, 'src/compat/journal.ts'));
const original = journal.loadJournal;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
journal.loadJournal = async file => {
  const value = await original(file);
  if (process.env.CV_COMPAT_BARRIER && file.includes('/legacy-compat/sessions/') && value === null) {
    await writeFile(join(process.env.CV_COMPAT_BARRIER, `${process.pid}.read`), 'empty-session-read');
    for (;;) { try { await access(join(process.env.CV_COMPAT_BARRIER, 'release')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } await pause(10); }
  }
  return value;
};
const { createApp } = require(join(root, 'src/app.ts'));
(async () => {
  const app = await createApp({ logger: false, contextVault: { maintenance: false } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  process.on('message', async message => { if (message === 'stop') { app.server.closeAllConnections(); await app.close(); process.exit(0); } });
  process.send({ baseUrl: `http://127.0.0.1:${app.server.address().port}`, pid: process.pid });
})().catch(() => process.exit(1));
