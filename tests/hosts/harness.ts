import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
// @ts-ignore normal-server test controller
import { startWorkspaceServer } from '../helpers/workspace-server.mjs';

export const root = resolve(import.meta.dirname, '../..');
export const backend = process.env.CV_TEST_BACKEND ?? 'git';
export type Language = 'typescript' | 'python' | 'php';
export type Environment = 'worker' | 'container' | 'remote-machine';
const images = { typescript: 'node:18-bookworm-slim', python: 'python:3.8-slim', php: 'php:8.0-cli' };
const ownerLabel = 'io.contextvault.host-test.owner';
const execute = promisify(execFile);
const allowedEnvironment = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'HOME'];
const hostEnvironment = () => Object.fromEntries(allowedEnvironment.filter(name => process.env[name]).map(name => [name, process.env[name]!]));
export async function run(command: string, args: string[], options: any = {}) {
  try { return await execute(command, args, { timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: hostEnvironment(), ...options }); }
  catch (error: any) { throw new Error(`${basename(command)} failed (${error.code}): ${(error.stderr ?? error.message).split('\n').filter((line: string) => !line.includes('Deprecat')).slice(-30).join('\n')}\n${(error.stdout ?? '').slice(-4000)}`); }
}
let toolsPromise: Promise<any> | undefined;
async function hostTools() {
  return toolsPromise ??= (async () => {
    const php = process.env.CV_TEST_PHP_BINARY ?? 'php';
    const python = process.env.CV_TEST_PYTHON_BINARY ?? '/usr/bin/python3';
    let composer = process.env.CV_TEST_COMPOSER_BINARY;
    if (!composer) { const candidate = join(homedir(), '.config/herd-lite/bin/composer'); try { await access(candidate); composer = candidate; } catch { composer = 'composer'; } }
    const versions = { node: process.versions.node, php: (await run(php, ['-r', 'echo PHP_VERSION;'])).stdout.trim(), python: (await run(python, ['--version'])).stdout.trim(), composer: (await run(composer, ['--version'])).stdout.trim() };
    return { php, python, composer, versions };
  })();
}
async function sourceHash() {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ recipe: 'host-artifacts-v2', platform: process.platform, arch: process.arch, tools: await hostTools() }));
  async function add(file: string) { const data = await readFile(file); hash.update(file.slice(root.length)); hash.update(data); }
  async function walk(directory: string) { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name === '__pycache__') continue; const file = join(directory, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile()) await add(file); } }
  for (const path of ['sdk/typescript/src', 'sdk/python/contextvault', 'sdk/php/src', 'cli/bin', 'cli/lib']) await walk(join(root, path));
  for (const path of ['sdk/typescript/package.json', 'sdk/typescript/package-lock.json', 'sdk/typescript/tsconfig.json', 'sdk/typescript/README.md', 'sdk/python/pyproject.toml', 'sdk/python/README.md', 'sdk/php/composer.json', 'sdk/php/composer.lock', 'cli/package.json', 'cli/README.md']) await add(join(root, path));
  return hash.digest('hex');
}
let packagePromise: Promise<any> | undefined;
export function packages(): Promise<any> { return packagePromise ??= buildPackages(); }
async function buildPackages() {
  const tools = await hostTools();
  const key = await sourceHash(); const tooling = join(root, 'tests/hosts/tooling'); await mkdir(tooling, { recursive: true });
  const destination = join(tooling, 'packages-' + key);
  try { const marker = JSON.parse(await readFile(join(destination, 'ready.json'), 'utf8')); if (marker.key === key) return { ...marker, directory: destination }; } catch { /* No completed immutable artifact cache. */ }
  const directory = await mkdtemp(join(tooling, 'building-'));
  try {
    const sdkBuild = join(directory, 'sdk-build'); await mkdir(sdkBuild);
    for (const name of ['src', 'package.json', 'tsconfig.json', 'node_modules']) await cp(join(root, 'sdk/typescript', name), join(sdkBuild, name), { recursive: true });
    await run(process.execPath, [join(sdkBuild, 'node_modules/typescript/bin/tsc'), '--project', join(sdkBuild, 'tsconfig.json')]);
    const ts = join(directory, 'typescript'); await mkdir(ts);
    const packedSdk = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: sdkBuild })).stdout)[0].filename;
    const packedCli = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: join(root, 'cli') })).stdout)[0].filename;
    await writeFile(join(ts, 'package.json'), JSON.stringify({ name: 'cv-host-installed-ts', version: '1.0.0', private: true }));
    await run('npm', ['install', '--offline', '--engine-strict', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packedSdk), join(directory, packedCli)], { cwd: ts });
    await rm(sdkBuild, { recursive: true });

    const python = join(directory, 'python'); await mkdir(python);
    const builder = join(directory, 'python-build'); await run(tools.python, ['-m', 'venv', builder]);
    const buildPython = join(builder, 'bin/python');
    await run(buildPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(root, 'tests/sdk/python/requirements.txt')]);
    const pySource = join(directory, 'python-source'); await mkdir(pySource);
    for (const name of ['contextvault', 'pyproject.toml', 'README.md']) await cp(join(root, 'sdk/python', name), join(pySource, name), { recursive: true, filter: file => !file.includes('__pycache__') });
    const wheels = join(python, 'wheels'); await mkdir(wheels);
    await run(buildPython, ['-m', 'build', '--wheel', '--no-isolation', '--outdir', wheels, pySource]);
    await run(buildPython, ['-m', 'pip', 'download', '--disable-pip-version-check', '--no-cache-dir', '--only-binary=:all:', '--python-version', '3.8', '--platform', 'any', '--implementation', 'py', '--abi', 'none', '--dest', wheels, 'requests>=2.20,<3']);
    const pyWorker = join(python, 'worker'); await run(tools.python, ['-m', 'venv', pyWorker]);
    await run(join(pyWorker, 'bin/python'), ['-m', 'pip', 'install', '--no-index', '--find-links=' + wheels, 'contextvault']);
    const pyContainer = join(python, 'container'); await mkdir(pyContainer);
    await run('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=bind,src=${wheels},dst=/wheels,readonly`, '--mount', `type=bind,src=${pyContainer},dst=/installed`, images.python, 'python', '-m', 'pip', 'install', '--no-index', '--no-compile', '--find-links=/wheels', '--target=/installed', 'contextvault']);
    await rm(pySource, { recursive: true }); await rm(builder, { recursive: true });

    const php = join(directory, 'php'); await mkdir(php);
    const phpSource = join(directory, 'php-source'); await mkdir(phpSource);
    for (const name of ['src', 'composer.json']) await cp(join(root, 'sdk/php', name), join(phpSource, name), { recursive: true });
    const metadata = JSON.parse(await readFile(join(phpSource, 'composer.json'), 'utf8')); const archive = join(directory, 'php-package.tar.gz');
    await run('tar', ['-czf', archive, '-C', phpSource, 'composer.json', 'src'], { env: { ...hostEnvironment(), COPYFILE_DISABLE: '1' } });
    await writeFile(join(php, 'composer.json'), JSON.stringify({ name: 'contextvault/host-installed', require: { [metadata.name]: '1.0.0' }, config: { platform: { php: '8.0.30' } }, repositories: [{ type: 'package', package: { ...metadata, version: '1.0.0', dist: { type: 'tar', url: 'file://' + archive } } }] }));
    await run(tools.composer, ['install', '--no-dev', '--no-scripts', '--no-plugins', '--no-interaction', '--no-progress'], { cwd: php, env: { ...hostEnvironment(), COMPOSER_HOME: join(directory, 'composer-home'), COMPOSER_CACHE_DIR: join(directory, 'composer-cache') } });
    await rm(phpSource, { recursive: true }); await rm(join(directory, 'composer-home'), { recursive: true, force: true }); await rm(join(directory, 'composer-cache'), { recursive: true, force: true });
    const marker = { key, hostTools: tools.versions, artifacts: { typescript: createHash('sha256').update(await readFile(join(directory, packedSdk))).digest('hex'), cli: createHash('sha256').update(await readFile(join(directory, packedCli))).digest('hex'), python: createHash('sha256').update(await readFile(join(wheels, (await readdir(wheels)).find(name => name.startsWith('contextvault-'))!))).digest('hex'), php: createHash('sha256').update(await readFile(archive)).digest('hex') } };
    await writeFile(join(directory, 'ready.json'), JSON.stringify(marker));
    try { await rename(directory, destination); } catch (error: any) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; const completed = JSON.parse(await readFile(join(destination, 'ready.json'), 'utf8')); if (completed.key !== key) throw new Error('Artifact cache identity changed'); await rm(directory, { recursive: true }); }
    return { ...marker, directory: destination };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export async function removeOwnedContainer(name: string, owner: string) {
  let inspected;
  try { inspected = await run('docker', ['inspect', '--format', `{{index .Config.Labels "${ownerLabel}"}}`, name], { timeout: 5000 }); } catch (error: any) { if (/No such (?:object|container)/i.test(error.message)) return; throw error; }
  if (inspected.stdout.trim() !== owner) throw new Error('Refused another container owner');
  await run('docker', ['rm', '--force', name], { timeout: 10000 });
}
export async function fixture() {
  const artifact = await packages(); const id = randomUUID(); const network = 'cv-host-api-' + id; const relay = 'cv-host-relay-' + id; const control = randomUUID();
  const server = await startWorkspaceServer({ backend, serverEnv: { CV_LEASE_TTL_MS: '60000' } });
  const boundaryDirectory = await mkdtemp(join(await realpath(tmpdir()), 'cv-host-private-'));
  const hostOnlyFile = join(boundaryDirectory, 'not-mounted'); await writeFile(hostOnlyFile, id, { mode: 0o600 });
  let networkCreated = false; let relayCreated = false;
  try {
    await run('docker', ['network', 'create', '--internal', '--label', `${ownerLabel}=${id}`, network]); networkCreated = true;
    await run('docker', ['create', '--name', relay, '--label', `${ownerLabel}=${id}`, '--network', network, '--network-alias', 'contextvault-api', '-p', '127.0.0.1::8080', '--mount', `type=bind,src=${join(root, 'tests/hosts/relay.cjs')},dst=/relay.cjs,readonly`, '-e', `UPSTREAM=${server.client.baseUrl.replace('127.0.0.1', 'host.docker.internal')}`, '-e', `CONTROL_TOKEN=${control}`, images.typescript, 'node', '/relay.cjs']); relayCreated = true;
    await run('docker', ['network', 'connect', 'bridge', relay]); await run('docker', ['start', relay]);
    const ports = JSON.parse((await run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', relay])).stdout);
    const origin = 'http://127.0.0.1:' + ports['8080/tcp'][0].HostPort;
    for (let index = 0; index < 100; index++) { try { if ((await fetch(origin + '/health')).ok) break; } catch {} if (index === 99) throw new Error('API relay did not start'); await new Promise(resolve => setTimeout(resolve, 50)); }
    const hostAddress = (await run('docker', ['exec', relay, 'node', '-e', 'require("node:dns").lookup("host.docker.internal",(e,a)=>{if(e)throw e;console.log(a)})'])).stdout.trim();
    let storageIp = '127.0.0.1'; let storagePort = '0';
    if (backend === 's3') {
      if (process.env.CV_TEST_S3_PROVIDER !== 'localstack') throw new Error('Host isolation gate requires the explicitly selected LocalStack service');
      const endpoint = new URL(process.env.CV_TEST_S3_ENDPOINT!);
      if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('The Docker isolation gate needs an explicitly mapped local emulator endpoint');
      const container = JSON.parse((await run('docker', ['inspect', process.env.CV_TEST_S3_CONTAINER ?? 'cv-localstack-01a1a255'])).stdout)[0];
      const addresses = Object.values(container.NetworkSettings.Networks).map((network: any) => network.IPAddress).filter(Boolean);
      const published = container.NetworkSettings.Ports['4566/tcp'] ?? [];
      if (!published.some((port: any) => port.HostPort === endpoint.port) || !addresses.length) throw new Error('Configured endpoint does not identify the inspected canonical storage service');
      storageIp = addresses[0] as string; storagePort = endpoint.port;
    }
    if (!hostAddress) throw new Error('An actual host gateway address is required');
    const environment = { CV_API_URL: origin, CV_API_KEY: server.client.keyA, CV_CUSTOMER_ID: server.client.customerA, CV_HOST_ONLY_FILE: hostOnlyFile, CV_STORAGE_PROBE_IP: storageIp, CV_STORAGE_PROBE_HOST_IP: hostAddress, CV_STORAGE_PROBE_HOST_PORT: storagePort, CV_STORAGE_PROBE_REQUIRED: backend === 's3' ? '1' : '0' };
    return {
      artifact, id, network, origin, client: server.client, environment,
      async arm(drop = true, pause: string | null = null) { const response = await fetch(origin + '/__control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': control }, body: JSON.stringify({ drop, pause }) }); if (!response.ok) throw new Error('Cannot arm owned API relay'); },
      async evidence() { const response = await fetch(origin + '/__control', { headers: { 'x-control-token': control } }); if (!response.ok) throw new Error('Cannot read owned API relay evidence'); return response.json(); },
      async dispose() { try { if (relayCreated) await removeOwnedContainer(relay, id); } finally { try { if (networkCreated) await run('docker', ['network', 'rm', network], { timeout: 10000 }); } finally { await server.dispose(); await rm(boundaryDirectory, { recursive: true }); } } },
    };
  } catch (error) { try { if (relayCreated) await removeOwnedContainer(relay, id); } finally { try { if (networkCreated) await run('docker', ['network', 'rm', network]); } finally { await server.dispose(); await rm(boundaryDirectory, { recursive: true }); } } throw error; }
}
export type HostFixture = Awaited<ReturnType<typeof fixture>>;
export function cliPath(artifact: any) { return join(artifact.directory, 'typescript/node_modules/@contextvault/cli/bin/contextvault.cjs'); }
export async function recordEvidence(name: string, proof: any) {
  const directory = join(root, 'tests/hosts/tooling/evidence'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, backend + '-' + name + '.json'), JSON.stringify({ recordedAt: new Date().toISOString(), ...proof }, null, 2) + '\n', { mode: 0o600 });
}

export async function hostJourney(f: HostFixture, language: Language, environment: Environment) {
  const id = randomUUID(); const name = 'cv-host-client-' + id; const volume = 'cv-host-client-' + id;
  let containerCreated = false; let volumeCreated = false; let clientParent: string | undefined;
  const proof = join(root, 'tests/hosts/consumers');
  const executable = language === 'typescript' ? process.execPath : language === 'python' ? join(f.artifact.directory, 'python/worker/bin/python') : (await hostTools()).php;
  const script = language === 'typescript' ? 'typescript.cjs' : language === 'python' ? 'python.py' : 'php.php';
  const clientEnvironment: Record<string, string> = { ...f.environment, CV_ARTIFACTS: f.artifact.directory, CV_BOUNDARY: environment, CV_CLIENT_PARENT: '' };
  try {
    if (environment === 'worker') {
      clientParent = await mkdtemp(join(await realpath(tmpdir()), 'cv-host-worker-')); clientEnvironment.CV_CLIENT_PARENT = clientParent;
    } else {
      let clientMount;
      if (environment === 'container') { clientParent = await mkdtemp(join(await realpath(tmpdir()), 'cv-host-volume-')); clientMount = `type=bind,src=${clientParent},dst=/client`; }
      else { await run('docker', ['volume', 'create', '--label', `${ownerLabel}=${id}`, volume]); volumeCreated = true; clientMount = `type=volume,src=${volume},dst=/client`; }
      await run('docker', ['run', '--detach', '--pull=never', '--name', name, '--label', `${ownerLabel}=${id}`, '--network', f.network, ...(environment === 'container' && process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []), '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--mount', `type=bind,src=${f.artifact.directory},dst=/artifacts,readonly`, '--mount', `type=bind,src=${proof},dst=/proof,readonly`, '--mount', clientMount, images[language], 'sleep', '600']); containerCreated = true;
      await run('docker', ['exec', name, 'chmod', '700', '/client']);
      const mounts = JSON.parse((await run('docker', ['inspect', '--format', '{{json .Mounts}}', name])).stdout);
      if (mounts.length !== 3 || !mounts.some((mount: any) => mount.Destination === '/artifacts' && !mount.RW) || !mounts.some((mount: any) => mount.Destination === '/proof' && !mount.RW) || !mounts.some((mount: any) => mount.Destination === '/client' && mount.RW)) throw new Error('Consumer mount boundary changed');
      if (mounts.some((mount: any) => ['/artifacts', '/proof', '/client'].indexOf(mount.Destination) < 0 || mount.Source === '/var/run/docker.sock' || mount.Source === root)) throw new Error('Server source or socket crossed into a consumer');
      const networks = JSON.parse((await run('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', name])).stdout);
      if (Object.keys(networks).length !== 1 || !networks[f.network]) throw new Error('Consumer joined a non-API network');
      Object.assign(clientEnvironment, { CV_ARTIFACTS: '/artifacts', CV_API_URL: 'http://contextvault-api:8080', CV_CLIENT_PARENT: '/client', PYTHONDONTWRITEBYTECODE: '1', ...(language === 'python' ? { PYTHONPATH: '/artifacts/python/container' } : {}) });
    }
    const invoke = async (action: string, crash = false) => {
      const command = environment === 'worker' ? executable : 'docker';
      const args = environment === 'worker' ? [join(proof, script), action] : ['exec', ...Object.keys(clientEnvironment).flatMap(key => ['--env', key]), name, language === 'typescript' ? 'node' : language === 'python' ? 'python' : 'php', '/proof/' + script, action];
      let result;
      try { result = await execute(command, args, { timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, cwd: clientParent ?? root, env: { ...hostEnvironment(), ...clientEnvironment } }); if (crash) throw new Error('Controller did not die at its crash boundary'); }
      catch (error: any) {
        if (!crash || !(error.signal === 'SIGKILL' || error.code === 137)) throw new Error(`${language}/${environment}/${action} failed: ${error.stderr ?? error.message}\n${error.stdout ?? ''}`);
        result = { stdout: error.stdout, stderr: error.stderr };
      }
      const lines = result.stdout.trim().split('\n'); return JSON.parse(lines[lines.length - 1]);
    };
    await f.arm(true); const interrupted = await invoke('start', true);
    if (interrupted.phase !== 'crash' || !interrupted.originalKey) throw new Error('Crash omitted its durable command identity');
    let accepted;
    for (let count = 0; count < 100; count++) { const response = await fetch(f.client.baseUrl + '/v1/workspaces/' + interrupted.workspaceId, { headers: { 'X-API-Key': f.client.keyA } }); if (!response.ok) throw new Error('Cannot read accepted workspace'); accepted = await response.json(); if (accepted.version === 2) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    if (accepted?.version !== 2) throw new Error('Original checkpoint did not reach its canonical accepted revision');
    await invoke('tamper'); const recovered = await invoke('resume');
    if (!recovered.ok || recovered.originalKey !== interrupted.originalKey || recovered.version !== 3 || !recovered.binaryDeletion || !recovered.killedControllerRecovery || !recovered.finalized || !recovered.aborted || !recovered.cleaned) throw new Error('Host lifecycle proof is incomplete');
    const imageId = environment === 'worker' ? null : (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', images[language]])).stdout.trim();
    const result = { ...recovered, environment, backend, packageArtifact: f.artifact.artifacts[language], artifactSet: f.artifact.key, image: environment === 'worker' ? null : images[language], imageId };
    if (result.minimumCliProof) result.minimumCliProof.packageArtifact = f.artifact.artifacts.cli;
    await recordEvidence(environment + '-' + language, result);
    return result;
  } catch (error: any) {
    throw new Error(error.message + '\nOwned relay evidence: ' + JSON.stringify(await f.evidence().catch(() => ({}))));
  } finally {
    await f.arm(false).catch(() => {});
    if (containerCreated) await removeOwnedContainer(name, id);
    if (volumeCreated) { const owned = (await run('docker', ['volume', 'inspect', '--format', `{{index .Labels "${ownerLabel}"}}`, volume])).stdout.trim(); if (owned !== id) throw new Error('Refused another volume owner'); await run('docker', ['volume', 'rm', volume]); }
    if (clientParent) await rm(clientParent, { recursive: true, force: true });
  }
}

export async function exampleJourney(f: HostFixture, language: Language, failure: boolean, reservedEnvironment = false) {
  const application = await mkdtemp(join(await realpath(tmpdir()), 'cv-agent-example-'));
  const extension = language === 'typescript' ? 'cjs' : language === 'python' ? 'py' : 'php';
  const example = join(application, 'worker.' + extension); await cp(join(root, 'examples/agents/worker.' + extension), example);
  if (language === 'typescript') await symlink(join(f.artifact.directory, 'typescript/node_modules'), join(application, 'node_modules'), 'dir');
  const environment = { ...hostEnvironment(), CV_API_URL: f.origin, CV_API_KEY: f.client.keyA, CV_CUSTOMER_ID: f.client.customerA, CV_STATE_DIR: join(application, 'private-session'), CV_LOCAL_PARENT: application, CV_PHP_AUTOLOAD: join(f.artifact.directory, 'php/vendor/autoload.php'), CV_HEARTBEAT_SECONDS: '0.05', AGENT_COMMAND_JSON: JSON.stringify(['/bin/sh', '-c', 'test -z "${CV_API_KEY-}${AWS_ACCESS_KEY_ID-}"; sleep 0.2; printf agent-example > result.txt; exit ' + (failure ? '7' : '0')]) };
  if (reservedEnvironment) Object.assign(environment, { AGENT_ENV_NAMES: 'CONTEXTVAULT_API_KEY', CONTEXTVAULT_API_KEY: 'owned-reserved-secret' });
  const command = language === 'typescript' ? process.execPath : language === 'python' ? join(f.artifact.directory, 'python/worker/bin/python') : (await hostTools()).php;
  let result: any; let ready: any;
  try {
    await f.arm(false);
    try { result = await execute(command, [example], { env: environment, cwd: application, timeout: 20000, maxBuffer: 1024 * 1024 }); if (failure) throw new Error('Failed agent incorrectly completed'); }
    catch (error: any) { if (!failure || error.code !== 1) throw error; result = error; }
    if (result.stdout.includes(f.client.keyA) || result.stderr.includes(f.client.keyA)) throw new Error('Example exposed its API credential');
    ready = result.stdout.split('\n').filter(Boolean).map((line: string) => JSON.parse(line)).find((value: any) => value.stage === 'ready');
    if (!ready?.runId || !ready.privateStatePath) throw new Error('Example omitted its local recovery identity');
    const response = await fetch(f.client.baseUrl + '/v1/runs/' + ready.runId, { headers: { 'X-API-Key': f.client.keyA } }); const current = await response.json();
    if (!response.ok || (!reservedEnvironment && current.leaseVersion <= 1)) throw new Error('Example did not renew the foreground agent lease');
    if (failure) {
      const retained = JSON.parse(result.stderr.trim().split('\n').pop());
      if (retained.stage !== 'retained' || current.state !== 'active') throw new Error('Failed agent did not retain its active local session');
      if (reservedEnvironment) { try { await access(join(ready.path, 'result.txt')); throw new Error('Reserved credential reached a launched agent'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } }
      else if ((await readFile(join(ready.path, 'result.txt'), 'utf8')) !== 'agent-example') throw new Error('Failed agent did not retain inspectable local files');
      const trace = await f.evidence(); if (trace.commandKeys.some((item: any) => item.path.endsWith('/finalize'))) throw new Error('Failed agent attempted publication');
      const aborted = await fetch(f.client.baseUrl + '/v1/runs/' + ready.runId + '/abort', { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': f.client.keyA, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedRunVersion: current.version, reason: 'owned example failure inspected' }) }); if (!aborted.ok) throw new Error('Cannot explicitly settle owned example run');
    } else {
      const complete = JSON.parse(result.stdout.trim().split('\n').pop());
      if (complete.stage !== 'complete' || complete.cleanupState !== 'complete' || current.state !== 'finalized') throw new Error('Example lifecycle did not finish truthfully');
      try { await access(ready.path); throw new Error('Example retained a directory after reporting cleanup complete'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    return { language, failure, foregroundLeaseRenewed: !reservedEnvironment, reservedCredentialRejected: reservedEnvironment, retainedOnFailure: failure, knownPublication: !failure };
  } catch (error: any) {
    const retained = join(root, 'tests/hosts/tooling/evidence/failed-example-' + randomUUID());
    await cp(application, retained, { recursive: true });
    const diagnostic = { language, expectedAgentFailure: failure, reservedEnvironment, command, retained, code: result?.code ?? null, signal: result?.signal ?? null, stdout: result?.stdout ?? null, stderr: result?.stderr ?? null, relay: await f.evidence().catch(() => null) };
    await recordEvidence('example-failure-' + language, JSON.parse(JSON.stringify(diagnostic, (_key, value) => typeof value === 'string' ? value.split(f.client.keyA).join('[redacted]') : value)));
    throw new Error(error.message + '; retained process and relay evidence: ' + retained);
  } finally { await rm(application, { recursive: true, force: true }); }
}

export async function containerExample(f: HostFixture) {
  const application = await mkdtemp(join(await realpath(tmpdir()), 'cv-container-example-')); const image = 'cv-agent-client-example:' + randomUUID(); let built = false; const containerRunId = randomUUID();
  try {
    for (const name of ['Dockerfile', 'worker.cjs']) await cp(join(root, 'examples/agents', name), join(application, name));
    for (const name of (await readdir(f.artifact.directory)).filter(name => /^contextvault-(sdk|cli)-.*\.tgz$/.test(name))) await cp(join(f.artifact.directory, name), join(application, name));
    await run('docker', ['build', '--network=none', '--pull=false', '--label', `${ownerLabel}=${f.id}`, '-t', image, application]); built = true;
    const imageId = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
    const runtime = JSON.parse((await run('docker', ['run', '--rm', '--network=none', '--entrypoint=node', image, '-p', 'JSON.stringify({node:process.versions.node,os:process.platform+"/"+process.arch})'])).stdout);
    const created = await fetch(f.client.baseUrl + '/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': f.client.keyA, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ customerId: f.client.customerA, name: 'existing-container-example' }) });
    if (created.status !== 201) throw new Error('Example workspace creation did not settle'); const workspace = await created.json();
    const result = await run('/bin/sh', [join(root, 'examples/agents/container.sh'), '/bin/sh', '-c', 'test -z "${CV_API_KEY-}${AWS_ACCESS_KEY_ID-}"; sleep 2; printf container-example > result.txt'], { timeout: 45000, env: { ...hostEnvironment(), TMPDIR: application, CV_CONTAINER_RUN_ID: containerRunId, CV_HEARTBEAT_SECONDS: '0.2', CV_API_URL: 'http://contextvault-api:8080', CV_API_KEY: f.client.keyA, CV_WORKSPACE_ID: workspace.id, CV_CLIENT_NETWORK: f.network, CV_CLIENT_IMAGE: image, AGENT_IMAGE: 'alpine:3.20' } });
    if (result.stdout.includes(f.client.keyA) || result.stderr.includes(f.client.keyA)) throw new Error('Container example exposed its credential');
    const events = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const owner = events.find(event => event.clientStateParent);
    if (owner?.containerRunId !== containerRunId || !owner.clientStateParent.startsWith(application)) throw new Error('Example omitted its durable local ownership receipt');
    const completed = events.find(event => event.command === 'cleanup'); if (completed?.workspace.cleanupState !== 'complete') throw new Error('Example did not finish local cleanup');
    const runResponse = await fetch(f.client.baseUrl + '/v1/runs/' + completed.workspace.runId, { headers: { 'X-API-Key': f.client.keyA } }); const finalizedRun = await runResponse.json();
    if (!runResponse.ok || finalizedRun.leaseVersion <= 1) throw new Error('Container launcher did not renew the foreground agent lease');
    const head = await fetch(f.client.baseUrl + '/v1/workspaces/' + workspace.id, { headers: { 'X-API-Key': f.client.keyA } }); const current = await head.json(); if (current.version !== 2) throw new Error('Example did not publish one accepted revision');
    const opened = await fetch(f.client.baseUrl + '/v1/workspaces/' + workspace.id + '/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': f.client.keyA, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ mode: 'read-only', agentLabel: 'example-verifier', task: 'readback', reason: 'verify existing container agent' }) }); if (opened.status !== 201) throw new Error('Cannot verify example content'); const reader = await opened.json();
    const bytes = await fetch(f.client.baseUrl + '/v1/runs/' + reader.id + '/workspace/files?path=result.txt', { headers: { 'X-API-Key': f.client.keyA } }); if (!bytes.ok || await bytes.text() !== 'container-example') throw new Error('Container example bytes differ');
    const settled = await fetch(f.client.baseUrl + '/v1/runs/' + reader.id + '/abort', { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': f.client.keyA, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedRunVersion: reader.version, reason: 'example readback complete' }) }); if (!settled.ok) throw new Error('Cannot settle example readback');
    const proof = { backend, runtime, imageId, packageArtifact: f.artifact.artifacts.cli, artifactSet: f.artifact.key, existingAgentImage: 'alpine:3.20', agentNetwork: 'none', workspaceOnlyAgentMount: true, foregroundLeaseRenewed: true, version: 2, cleaned: true };
    await recordEvidence('container-example', proof);
    return proof;
  } catch (error: any) {
    const retained = join(root, 'tests/hosts/tooling/evidence/failed-container-example-' + randomUUID());
    await cp(application, retained, { recursive: true });
    await recordEvidence('container-example-failure', { retained, containerRunId, error: error.message.split(f.client.keyA).join('[redacted]'), relay: await f.evidence().catch(() => null) });
    throw new Error(error.message + '; retained container evidence: ' + retained);
  } finally {
    if (containerRunId) { const ids = (await run('docker', ['ps', '-aq', '--filter', 'label=io.contextvault.agent-run=' + containerRunId])).stdout.trim().split('\n').filter(Boolean); for (const id of ids) await run('docker', ['rm', '-f', id]); }
    if (built) await run('docker', ['image', 'rm', image], { timeout: 10000 });
    await rm(application, { recursive: true, force: true });
  }
}
