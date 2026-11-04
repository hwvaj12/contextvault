import { createApp } from '../../src/app';
import { loadConfiguration } from '../../src/config';
async function main() {
  const app = await createApp({ logger: false, contextVault: { configuration: loadConfiguration(process.env), maintenance: false } });
  const original = app.contextVault.control.claimCopySourcePin.bind(app.contextVault.control);
  app.contextVault.control.claimCopySourcePin = async input => { const pin = await original(input); process.send!({ stage: 'pin-owned', pin }); await new Promise(() => {}); return pin; };
  await app.listen({ host: '127.0.0.1', port: 0 }); process.send!({ stage: 'ready', baseUrl: `http://127.0.0.1:${(app.server.address() as any).port}` });
}
main().catch(error => { process.stderr.write(String(error.stack ?? error)); process.exitCode = 1; });
