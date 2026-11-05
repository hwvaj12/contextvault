import { mkdtemp, cp, readFile, writeFile, rm, mkdir, chmod, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest } from 'node:http';
import { startWorkspaceServer } from '../../helpers/workspace-server.mjs';
import { requireS3 } from '../../../scripts/run-workspace-tests.mjs';
import { transportChecks } from './transport.mjs';

const execute = promisify(execFile);
const focusedReopen = process.argv.slice(2).includes('--focus-reopen');
const focusedDeadline = process.argv.slice(2).includes('--focus-deadline');
const focusedTransport = process.argv.slice(2).includes('--focus-transport');
if ([focusedReopen, focusedDeadline, focusedTransport].filter(Boolean).length > 1 || process.argv.slice(2).some(argument => !['--focus-reopen', '--focus-deadline', '--focus-transport'].includes(argument))) throw new Error('Unknown installed PHP acceptance option');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(path.join(tmpdir(), 'cv-php-installed-'));
const artifact = path.join(directory, 'artifact');
const packageRoot = path.join(directory, 'package');
const run = async (command, args, options = {}) => {
  try { return await execute(command, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`${command} exited ${error.code}: ${(error.stderr ?? error.message).split('\n').filter(line => !line.includes('Deprecation')).slice(-35).join('\n')}\n${(error.stdout ?? '').slice(0, 1500)}`); }
};
let fixture;
let container;
let deadlineProxy;
try {
  const env = { ...process.env };
  requireS3(env, { s3Provider: 'localstack' }); // Missing or conflicting target is a hard failure.
  await mkdir(packageRoot);
  await cp(path.join(root, 'sdk/php/src'), path.join(packageRoot, 'src'), { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(root, 'sdk/php/composer.json'), 'utf8'));
  await writeFile(path.join(packageRoot, 'composer.json'), JSON.stringify(metadata));
  await run('tar', ['-czf', path.join(directory, 'package.tar.gz'), '-C', packageRoot, 'composer.json', 'src'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await mkdir(artifact);
  await writeFile(path.join(artifact, 'composer.json'), JSON.stringify({
    name: 'contextvault/installed-acceptance', require: { [metadata.name]: '1.0.0' },
    config: { platform: { php: '8.0.30' } },
    repositories: [{ type: 'package', package: { ...metadata, version: '1.0.0', dist: { type: 'tar', url: `file://${directory}/package.tar.gz` } } }],
  }));
  await run(process.env.CV_TEST_COMPOSER_BINARY ?? 'composer', ['install', '--no-dev', '--no-plugins', '--no-scripts', '--no-interaction', '--no-progress'], { cwd: artifact });
  await cp(path.join(root, 'tests/fixtures/workspaces/canonical.v1.json'), path.join(artifact, 'canonical.v1.json'));
  const results = {};
  for (const backend of ['git', 's3']) {
    process.stderr.write(`Installed PHP 8.0.30 consumer: ${backend}${backend === 's3' ? ' / strict localstack' : ''}\n`);
    fixture = await startWorkspaceServer({ backend, env, serverNode: process.execPath, serverEnv: { CV_LEASE_TTL_MS: '12000', CV_MAINTENANCE_INTERVAL_MS: '50' } });
    container = `cv-php-${fixture.id}`;
    const { baseUrl, keyA, keyB, customerA, customerB } = fixture.client;
    const origin = baseUrl.replace('127.0.0.1', 'host.docker.internal');
    let holdFirstOperation = !focusedReopen;
    let denyNextOperationPoll = false;
    let operationGets = 0;
    const reopenPolicy = new Map();
    deadlineProxy = createServer((request, response) => {
      const requestUrl = new URL(request.url, 'http://owned-fixture');
      if (requestUrl.pathname === '/correction-operation-polls') {
        if (request.headers['x-api-key'] !== keyA || request.method !== 'GET') { response.writeHead(403, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ operationGets })); return;
      }
      if (request.method === 'GET' && requestUrl.pathname.startsWith('/v1/operations/')) operationGets++;
      if (requestUrl.pathname === '/correction-reopen-policy') {
        const workspace = requestUrl.searchParams.get('workspace'); const mode = requestUrl.searchParams.get('mode');
        if (request.headers['x-api-key'] !== keyA || !workspace || !['deny', 'allow'].includes(mode)) { response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Invalid owned fixture control' } })); return; }
        reopenPolicy.set(workspace, mode); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ configured: true })); return;
      }
      const openingWorkspace = /^\/v1\/workspaces\/([^/?]+)\/runs$/.exec(requestUrl.pathname);
      if (request.method === 'POST' && openingWorkspace && reopenPolicy.get(decodeURIComponent(openingWorkspace[1])) === 'deny') {
        request.resume(); response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Owned first reopen rejection' } })); return;
      }
      if (request.url === '/correction-metadata') {
        const prefix = `${'a'.repeat(220)}/${'b'.repeat(220)}/${'c'.repeat(220)}/`;
        const entries = Array.from({ length: 9000 }, (_, index) => ({ path: `${prefix}${'d'.repeat(210)}${String(index).padStart(8, '0')}`, kind: 'file', byteLength: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }));
        const bytes = JSON.stringify({ schemaVersion: 1, entries }); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }); response.end(bytes); return;
      }
      if (denyNextOperationPoll && request.method === 'GET' && request.url.startsWith('/v1/operations/')) {
        denyNextOperationPoll = false; response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Owned first operation poll denial' } })); return;
      }
      if (holdFirstOperation && request.url.startsWith('/v1/operations/')) {
        holdFirstOperation = false;
        // The finalize already reached the actual server. This response exceeds the client's operation deadline.
        const timer = setTimeout(() => { response.writeHead(503); response.end('{}'); }, 1800);
        response.on('close', () => clearTimeout(timer));
        return;
      }
      const upstream = httpRequest(new URL(request.url, baseUrl), { method: request.method, headers: { ...request.headers, host: new URL(baseUrl).host } }, incoming => {
        if (request.method === 'POST' && request.url.endsWith('/finalize') && request.headers['x-cv-test-deny-poll'] === '1' && incoming.statusCode === 202) denyNextOperationPoll = true;
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
        response.on('close', () => incoming.destroy());
      });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream); request.on('aborted', () => upstream.destroy());
    });
    await new Promise(resolve => deadlineProxy.listen(0, '0.0.0.0', resolve));
    const deadlineOrigin = `http://host.docker.internal:${deadlineProxy.address().port}`;
    const correctionArgs = ['--mount', `type=bind,source=${artifact},target=/artifact,readonly`, '--mount', `type=bind,source=${path.join(root, 'tests/sdk/php')},target=/tests,readonly`,
      '-e', 'CV_PHP_AUTOLOAD=/artifact/vendor/autoload.php'];
    const checkTransport = () => transportChecks({ fixture, docker: true, runPhp: variables => {
      container = `cv-php-transport-${fixture.id}`;
      return run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway', ...correctionArgs,
        ...Object.entries(variables).flatMap(([name, value]) => ['-e', `${name}=${value}`]), 'php:8.0-cli', 'php', '/tests/transport.php']);
    } });
    const reopenArgs = [...correctionArgs, '-e', `CV_TIMEOUT_URL=${deadlineOrigin}`, '-e', `CV_KEY_A=${keyA}`, '-e', `CV_CUSTOMER_A=${customerA}`];
    if (focusedTransport) {
      results[backend] = { transport: await checkTransport() };
      deadlineProxy.closeAllConnections(); await new Promise(resolve => deadlineProxy.close(resolve)); deadlineProxy = undefined;
      await fixture.dispose(); fixture = undefined; container = undefined; continue;
    }
    if (focusedReopen) {
      container = `cv-php-reopen-focus-${fixture.id}`;
      const focused = await run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway', ...reopenArgs, 'php:8.0-cli', 'php', '-d', 'memory_limit=512M', '/tests/corrections.php', 'reopen-policy']);
      results[backend] = JSON.parse(focused.stdout);
      if (Object.keys(results[backend].reopenPolicy ?? {}).length !== 4 || !Object.values(results[backend].reopenPolicy).every(value => value === true)) throw new Error('Installed reopen policy checks failed');
      deadlineProxy.closeAllConnections(); await new Promise(resolve => deadlineProxy.close(resolve)); deadlineProxy = undefined;
      await fixture.dispose(); fixture = undefined; await run('docker', ['rm', '-f', container]).catch(() => {}); container = undefined;
      continue;
    }
    const { stdout } = await run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway',
      '--mount', `type=bind,source=${artifact},target=/artifact,readonly`,
      '--mount', `type=bind,source=${path.join(root, 'tests/sdk/php')},target=/tests,readonly`,
      '--tmpfs', '/scratch:rw,mode=0700', '-e', `CV_URL=${origin}`, '-e', `CV_KEY_A=${keyA}`,
      ...(focusedDeadline ? ['-e', 'CV_PHP_FOCUS_DEADLINE=1'] : []),
      '-e', `CV_TIMEOUT_URL=${deadlineOrigin}`,
      '-e', `CV_KEY_B=${keyB}`, '-e', `CV_CUSTOMER_A=${customerA}`, '-e', `CV_CUSTOMER_B=${customerB}`,
      'php:8.0-cli', 'php', '-d', 'memory_limit=512M', '-d', 'zend.assertions=1', '-d', 'assert.exception=1', '/tests/consumer.php']);
    results[backend] = JSON.parse(stdout);
    if (focusedDeadline) {
      if (!(results[backend].deadline?.prePollSeconds >= 1) || !(results[backend].deadline.operationWaitSeconds < 0.9) || results[backend].deadline.operationGetRequests !== 1) throw new Error('Installed deadline interval or request-count check failed');
      deadlineProxy.closeAllConnections(); await new Promise(resolve => deadlineProxy.close(resolve)); deadlineProxy = undefined;
      await fixture.dispose(); fixture = undefined; await run('docker', ['rm', '-f', container]).catch(() => {}); container = undefined; continue;
    }
    container = `cv-php-reopen-${fixture.id}`;
    const reopenChecks = JSON.parse((await run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway', ...reopenArgs, 'php:8.0-cli', 'php', '-d', 'memory_limit=512M', '/tests/corrections.php', 'reopen-policy'])).stdout);
    if (Object.keys(reopenChecks.reopenPolicy ?? {}).length !== 4 || !Object.values(reopenChecks.reopenPolicy).every(value => value === true)) throw new Error('Installed reopen policy checks failed');
    results[backend].reopenPolicy = reopenChecks.reopenPolicy;
    results[backend].transport = await checkTransport();
    container = `cv-php-corrections-${fixture.id}`;
    const focused = await run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway', ...correctionArgs, 'php:8.0-cli', 'php', '-d', 'memory_limit=512M', '/tests/corrections.php']);
    const focusedResults = JSON.parse(focused.stdout);
    if (!Object.values(focusedResults).every(value => value.passed === true)) throw new Error('Installed correction checks failed');
    const clientDirectory = path.join(directory, `capture-client-${backend}`); await mkdir(clientDirectory); await chmod(clientDirectory, 0o777);
    const captureArgs = [...correctionArgs, '--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,source=${clientDirectory},target=/client`, '-e', `CV_URL=${origin}`, '-e', `CV_KEY_A=${keyA}`, '-e', 'CV_CORRECTION_REAL_HTTP=1'];
    container = `cv-php-capture-${fixture.id}`;
    const captureExecution = run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway', ...captureArgs, 'php:8.0-cli', 'php', '/tests/corrections.php', 'capture-worker', results[backend].correctionWorkspaceId, '/client']).then(result => ({ result }), error => ({ error }));
    const captureDeadline = Date.now() + 15_000; let captureReady = false;
    while (Date.now() < captureDeadline) {
      try { await access(path.join(clientDirectory, 'capture-ready')); captureReady = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!captureReady) throw new Error('Actual installed capture did not reach its payload crash boundary');
    const privateName = (await readdir(clientDirectory)).find(name => /^contextvault-private-[a-f0-9]{32}$/.test(name));
    if (!privateName) throw new Error('Capture did not retain a private recovery identity');
    const capturedJournal = JSON.parse(await readFile(path.join(clientDirectory, privateName, 'session.json'), 'utf8'));
    await run('docker', ['kill', '--signal', 'KILL', container]); await captureExecution;
    await run('docker', ['rm', '-f', container]).catch(() => {});
    if (capturedJournal.workflow.capture !== null || capturedJournal.workflow.captures.length !== 1) throw new Error('Capture ownership was not durable before actual Docker KILL');
    container = `cv-php-capture-resume-${fixture.id}`;
    const recoveredCapture = await run('docker', ['run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway', ...captureArgs, 'php:8.0-cli', 'php', '/tests/corrections.php', 'capture-resume', `/client/${privateName}/session.json`]);
    if (JSON.parse(recoveredCapture.stdout).captureCrashRecovered !== true) throw new Error('Interrupted installed capture cleanup did not complete');
    results[backend].corrections = true; results[backend].correctionChecks = focusedResults; results[backend].actualDockerCaptureKill = true;
    deadlineProxy.closeAllConnections(); await new Promise(resolve => deadlineProxy.close(resolve)); deadlineProxy = undefined;
    await fixture.dispose(); fixture = undefined;
    await run('docker', ['rm', '-f', container]).catch(() => {}); container = undefined;
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  if (container) await run('docker', ['rm', '-f', container]).catch(() => {});
  if (deadlineProxy) { deadlineProxy.closeAllConnections(); await new Promise(resolve => deadlineProxy.close(resolve)); }
  await fixture?.dispose();
  await rm(directory, { recursive: true, force: true });
}
