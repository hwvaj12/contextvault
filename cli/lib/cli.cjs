'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { ContextVaultClient, AuthError, ConflictError, OutcomeUnknownError } = require('@contextvault/sdk');

const commands = new Set(['open', 'submit', 'finalize', 'checkpoint', 'abort', 'status', 'reconcile', 'heartbeat', 'cleanup']);
const flags = new Set(['workspace', 'customer', 'name', 'state-dir', 'session', 'mode', 'agent-label', 'task', 'reason']);
const booleanFlags = new Set(['writers-stopped', 'controllers-stopped']);
class InvocationError extends Error { constructor(message) { super(message); this.code = 'INVALID_INVOCATION'; } }
class ControllerBusy extends Error { constructor() { super('Another controller owns this session; stop every controller before using --controllers-stopped'); this.code = 'LOCAL_CONTROLLER_BUSY'; } }
function parse(args) {
  if (args.length === 1 && ['--help', 'help'].includes(args[0])) return { command: 'help', options: {} };
  const [command, ...rest] = args;
  if (!commands.has(command)) throw new InvocationError('Provide a supported command; use --help');
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new InvocationError('Use named options; credentials belong in CV_API_KEY');
    const name = argument.slice(2);
    if ((!flags.has(name) && !booleanFlags.has(name)) || name in options) throw new InvocationError('Unknown or duplicate option: ' + argument);
    if (booleanFlags.has(name)) options[name] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new InvocationError('Provide a value for ' + argument);
      options[name] = value;
    }
  }
  const allowed = command === 'open'
    ? new Set(['workspace', 'customer', 'name', 'state-dir', 'mode', 'agent-label', 'task', 'reason', 'controllers-stopped'])
    : new Set(['session', 'writers-stopped', 'controllers-stopped', ...(command === 'abort' ? ['reason'] : [])]);
  for (const name of Object.keys(options)) if (!allowed.has(name)) throw new InvocationError('Option does not apply to ' + command + ': --' + name);
  if (command === 'open') {
    if (Boolean(options.workspace) === Boolean(options.customer) || (options.customer && !options.name) || (options.workspace && options.name)) throw new InvocationError('Provide --workspace, or --customer with --name');
    if (!options['state-dir'] || !path.isAbsolute(options['state-dir'])) throw new InvocationError('Provide an absolute, new --state-dir for recoverable opening');
    for (const name of ['agent-label', 'task', 'reason']) if (!options[name]?.trim()) throw new InvocationError('Provide --' + name);
    if (options.mode && !['read-only', 'read-write'].includes(options.mode)) throw new InvocationError('Mode must be read-only or read-write');
  } else {
    if (!options.session || !path.isAbsolute(options.session)) throw new InvocationError('Provide an absolute --session state file or directory');
    if (['submit', 'finalize', 'checkpoint', 'abort', 'reconcile', 'cleanup'].includes(command) && options['writers-stopped'] !== true) throw new InvocationError('Stop every agent writer and provide --writers-stopped');
    if (command === 'abort' && !options.reason?.trim()) throw new InvocationError('Provide an abort --reason');
  }
  return { command, options };
}
async function privateDirectory(command, options) {
  if (command === 'open') return path.join(await fs.realpath(path.dirname(options['state-dir'])), path.basename(options['state-dir']));
  const candidate = path.basename(options.session) === 'state.json' ? path.dirname(options.session) : options.session;
  return fs.realpath(candidate);
}
async function regularMarker(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 4096) throw new InvocationError('Unsafe private controller marker');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.schemaVersion !== 1 || typeof value.token !== 'string' || typeof value.sessionDirectory !== 'string') throw new InvocationError('Invalid private controller marker');
  return value;
}
async function retireStoppedMarker(file, directory) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 4096) throw new InvocationError('Unsafe private controller marker');
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  // Death between exclusive allocation and writing may leave an empty/partial owned marker.
  // The explicit stopped-controller assertion can retire that marker, without touching SDK state.
  if (value && (value.schemaVersion !== 1 || value.sessionDirectory !== directory)) throw new InvocationError('Controller marker belongs to another session or version');
  await fs.unlink(file);
}
async function acquireController(directory, controllersStopped) {
  const hash = createHash('sha256').update(directory).digest('hex');
  const marker = path.join(path.dirname(directory), '.contextvault-controller-' + hash + '.json');
  const token = randomUUID();
  if (controllersStopped) {
    try {
      // This is a caller assertion, never a conclusion from a PID, age, or lease.
      await retireStoppedMarker(marker, directory);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let file;
  try { file = await fs.open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new ControllerBusy(); throw error; }
  try { await file.writeFile(JSON.stringify({ schemaVersion: 1, sessionDirectory: directory, token })); await file.sync(); }
  finally { await file.close(); }
  return async () => {
    try { const current = await regularMarker(marker); if (current.token !== token || current.sessionDirectory !== directory) return false; await fs.unlink(marker); return true; }
    catch { return false; }
  };
}
function snapshot(session) {
  let run = null; let workspaceId = null;
  try { run = session.run; workspaceId = session.workspaceId; } catch { /* A durable pre-ID session is still recoverable. */ }
  return { sessionId: session.sessionId, workspaceId, runId: run?.id ?? null, path: session.path,
    privateStatePath: session.privateStatePath, sessionStatus: session.sessionStatus,
    materializationState: session.materializationState, cleanupState: session.cleanupState,
    outcome: session.outcome, checkpointReceipt: session.checkpointReceipt };
}
function exitCode(error) {
  if (error instanceof InvocationError) return 2;
  if (error instanceof OutcomeUnknownError || error.code === 'PUBLICATION_OUTCOME_UNKNOWN') return 5;
  if (error instanceof AuthError || [401, 403].includes(error.statusCode)) return 3;
  if (error instanceof ConflictError || error instanceof ControllerBusy || error.statusCode === 409) return 4;
  return 1;
}
async function main(args, environment) {
  let session; let release; let command; let options; let envelope; let code = 0;
  try {
    ({ command, options } = parse(args));
    if (command === 'help') {
      envelope = { ok: true, commands: [...commands], environment: ['CV_API_URL', 'CV_API_KEY'], recovery: 'Use --controllers-stopped only after stopping every controller; --writers-stopped is a separate agent-writer assertion.' };
    } else {
      if (!environment.CV_API_URL || !environment.CV_API_KEY || /[\r\n]/.test(environment.CV_API_KEY)) throw new InvocationError('Set CV_API_URL and CV_API_KEY; credentials must not appear in arguments');
      let origin;
      try { origin = new URL(environment.CV_API_URL); } catch { throw new InvocationError('CV_API_URL must be an HTTP(S) origin'); }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new InvocationError('CV_API_URL must be an HTTP(S) origin without credentials, query, or path');
      const directory = await privateDirectory(command, options);
      release = await acquireController(directory, options['controllers-stopped'] === true);
      const client = new ContextVaultClient({ apiKey: environment.CV_API_KEY, baseUrl: origin.origin, maxRetries: 0 });
      let result;
      if (command === 'open') {
        session = await client.openWorkspace({ ...(options.workspace ? { workspaceId: options.workspace } : { create: { customerId: options.customer, name: options.name } }),
          stateDirectory: directory, mode: options.mode ?? 'read-write', agentLabel: options['agent-label'], task: options.task, reason: options.reason });
      } else {
        session = await client.resumeWorkspace(path.join(directory, 'state.json'));
        if (command === 'abort') result = await session.abort({ writersStopped: true, reason: options.reason });
        else if (['submit', 'finalize', 'checkpoint', 'reconcile', 'cleanup'].includes(command)) result = await session[command]({ writersStopped: true });
        else result = await session[command]();
      }
      envelope = { ok: true, command, workspace: snapshot(session), ...(result && result !== session ? { result } : {}) };
    }
  } catch (error) {
    code = exitCode(error);
    envelope = { ok: false, command: command ?? null, error: { code: error.code ?? 'CLI_FAILURE', message: error.message ?? 'CLI command failed',
      ...(error.operationId ? { operationId: error.operationId } : {}), ...(error.privateStatePath ? { privateStatePath: error.privateStatePath } : {}) },
      ...(session ? { workspace: snapshot(session) } : {}) };
  } finally {
    if (release && !(await release())) { envelope.controllerCleanup = { state: 'retained', message: 'Stop every controller before recovering its private marker' }; if (code === 0) code = 1; }
  }
  const output = JSON.stringify(envelope, (_key, value) => typeof value === 'string' && environment.CV_API_KEY ? value.split(environment.CV_API_KEY).join('[redacted]') : value);
  await new Promise((resolve, reject) => process.stdout.write(output + '\n', error => error ? reject(error) : resolve()));
  return code;
}
module.exports = { main };
