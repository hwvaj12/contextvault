'use strict';
const { ContextVaultClient } = require('@contextvault/sdk');
const { spawn } = require('node:child_process');
async function main() {
  const argv = JSON.parse(process.env.AGENT_COMMAND_JSON ?? '[]');
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error('Set AGENT_COMMAND_JSON to an argument array');
  if (!process.env.CV_API_URL || !process.env.CV_API_KEY || !process.env.CV_STATE_DIR) throw new Error('Set CV_API_URL, CV_API_KEY, and a new absolute CV_STATE_DIR');
  const client = new ContextVaultClient({ apiKey: process.env.CV_API_KEY, baseUrl: process.env.CV_API_URL, maxRetries: 0 });
  let session; let publication;
  try {
    session = await client.openWorkspace({ ...(process.env.CV_WORKSPACE_ID ? { workspaceId: process.env.CV_WORKSPACE_ID } : { create: { customerId: process.env.CV_CUSTOMER_ID, name: process.env.CV_WORKSPACE_NAME ?? 'agent-task' } }), stateDirectory: process.env.CV_STATE_DIR,
      mode: 'read-write', agentLabel: process.env.AGENT_LABEL ?? 'existing-agent', task: process.env.AGENT_TASK ?? 'ordinary agent workspace', reason: process.env.AGENT_REASON ?? 'owner requested agent work' });
    process.stdout.write(JSON.stringify({ stage: 'ready', path: session.path, privateStatePath: session.privateStatePath, runId: session.run.id }) + '\n');
    const environment = { PATH: process.env.PATH, WORKSPACE_PATH: session.path };
    for (const name of (process.env.AGENT_ENV_NAMES ?? '').split(',').filter(Boolean)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('CV_') || name.startsWith('CONTEXTVAULT_') || name.startsWith('AWS_')) throw new Error('Agent environment names must exclude ContextVault and storage credentials');
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const heartbeatMs = Number(process.env.CV_HEARTBEAT_SECONDS ?? 10) * 1000;
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 120000) throw new Error('Invalid heartbeat interval');
    let heartbeat = Promise.resolve(); let heartbeatFailure; let pending = false;
    const agent = spawn(argv[0], argv.slice(1), { cwd: session.path, env: environment, stdio: 'inherit' });
    const timer = setInterval(() => {
      if (pending || heartbeatFailure) return; pending = true;
      heartbeat = session.heartbeat().catch(error => { heartbeatFailure ??= error; clearInterval(timer); agent.kill('SIGTERM'); const force = setTimeout(() => agent.kill('SIGKILL'), 2000); force.unref(); }).finally(() => { pending = false; });
    }, heartbeatMs);
    let status;
    try { status = await new Promise((resolve, reject) => { agent.once('error', reject); agent.once('exit', (code, signal) => resolve({ code, signal })); }); }
    finally { clearInterval(timer); await heartbeat; }
    if (heartbeatFailure) throw heartbeatFailure;
    if (status.code !== 0 || status.signal) throw new Error('Agent stopped without success; workspace retained for inspection');
    publication = await session.finalize({ writersStopped: true });
    await session.cleanup({ writersStopped: true });
    process.stdout.write(JSON.stringify({ stage: 'complete', publication, cleanupState: session.cleanupState, privateStatePath: session.privateStatePath }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ stage: 'retained', error: error.code ?? error.name, privateStatePath: error.privateStatePath ?? session?.privateStatePath ?? null, publication: publication ?? null }) + '\n');
    process.exitCode = 1;
  }
}
main().catch(() => { process.stderr.write('Worker configuration failed\n'); process.exitCode = 2; });
