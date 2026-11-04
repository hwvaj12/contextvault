import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
// @ts-ignore explicit test configuration and bounded cleanup contracts
import { requireS3 } from '../../../scripts/run-workspace-tests.mjs';
// @ts-ignore controller-only cleanup, never mounted into an agent
import { cleanupHttpFixtureStorage } from '../../http/no-git-server.mjs';

const root = resolve(import.meta.dirname, '../../..');
const execute = promisify(execFile);
const ownerLabel = 'io.contextvault.host-test.owner';
const sourceLabel = 'io.contextvault.host-test.server-source';
const baseLabel = 'io.contextvault.host-test.server-base';
const baseImage = 'node:22-bookworm-slim';
const environment = () => Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'].filter(name => process.env[name]).map(name => [name, process.env[name]!]));
async function docker(args: string[], timeout = 120000) {
  try { return (await execute('docker', args, { env: environment(), timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error: any) { throw Object.assign(new Error('Docker API fixture command failed (' + error.code + '): ' + (error.stderr ?? '').slice(-8000)), { code: error.code }); }
}
const inspect = async (name: string) => JSON.parse(await docker(['inspect', name]))[0];
async function removeContainer(name: string, owner: string) {
  let value;
  try { value = await inspect(name); } catch (error) { if (/No such (?:object|container)/i.test((error as Error).message)) return; throw error; }
  if (value.Config.Labels?.[ownerLabel] !== owner) throw new Error('Refusing another API fixture container owner');
  if (value.State.Running) await docker(['stop', '--time', '10', name], 15000);
  if ((await inspect(name)).State.Running) throw new Error('API fixture is still running; storage cleanup remains blocked');
  await docker(['rm', name], 10000);
}
async function removeNetwork(name: string, owner: string) {
  let value;
  try { value = JSON.parse(await docker(['network', 'inspect', name]))[0]; }
  catch (error) { if (/not found|No such/i.test((error as Error).message)) return; throw error; }
  if (value.Labels?.[ownerLabel] !== owner || Object.keys(value.Containers ?? {}).length) throw new Error('Refusing a foreign or occupied API fixture network');
  await docker(['network', 'rm', name], 10000);
}

let imagePromise: Promise<{ image: string; imageId: string; sourceHash: string; baseId: string }> | undefined;
async function serverImage() {
  return imagePromise ??= (async () => {
    let base;
    try { base = JSON.parse(await docker(['image', 'inspect', baseImage]))[0]; }
    catch (error) { if (!/No such image|No such object/i.test((error as Error).message)) throw error; await docker(['pull', baseImage], 180000); base = JSON.parse(await docker(['image', 'inspect', baseImage]))[0]; }
    const reference = base.RepoDigests?.find((value: string) => /(?:^|\/)node@sha256:[a-f0-9]{64}$/.test(value));
    if (!reference) throw new Error('The API fixture requires an official digest-addressed Node base');
    const files = ['package.json', 'package-lock.json', 'tsconfig.json'];
    const walk = async (directory: string) => {
      for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = directory + '/' + entry.name;
        if (path === 'src/vault-browser') continue;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
        else throw new Error('API image inputs must be ordinary TypeScript source files');
      }
    };
    await walk('src');
    const recipe = await readFile(join(import.meta.dirname, 'Dockerfile'));
    const digest = createHash('sha256').update('contextvault-host-api-v1\0').update(base.Id).update(recipe);
    for (const path of files) { if (!(await lstat(join(root, path))).isFile()) throw new Error('API image input identity changed'); digest.update('\0' + path + '\0').update(await readFile(join(root, path))); }
    const sourceHash = digest.digest('hex'); const image = 'cv-host-api-source:' + sourceHash;
    let built;
    try { built = JSON.parse(await docker(['image', 'inspect', image]))[0]; }
    catch (error) { if (!/No such image|No such object/i.test((error as Error).message)) throw error; }
    if (!built) {
      const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-api-image-'));
      try {
        for (const path of files) { const target = join(directory, path); await mkdir(dirname(target), { recursive: true }); await cp(join(root, path), target); }
        await writeFile(join(directory, 'Dockerfile'), recipe);
        await docker(['build', '--pull=false', '--build-arg', 'BASE_IMAGE=' + reference, '--label', sourceLabel + '=' + sourceHash, '--label', baseLabel + '=' + base.Id, '--tag', image, directory], 600000);
        built = JSON.parse(await docker(['image', 'inspect', image]))[0];
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    if (built.Config.Labels?.[sourceLabel] !== sourceHash || built.Config.Labels?.[baseLabel] !== base.Id) throw new Error('API image cache ownership differs from its exact inputs');
    return { image, imageId: built.Id, sourceHash, baseId: base.Id };
  })();
}

interface StorageTarget { endpoint: string; containerEndpoint: string; network: string; bucket: string; region: string; prefix: string }
export async function storageTarget(backend: string, id: string, inspectService = inspect): Promise<StorageTarget | undefined> {
  if (!['git', 's3'].includes(backend)) throw new Error('Host API backend must be explicitly git or s3');
  if (backend === 'git') return;
  const selected = { ...process.env }; requireS3(selected, { s3Provider: selected.CV_TEST_S3_PROVIDER });
  const endpoint = new URL(selected.CV_TEST_S3_ENDPOINT!);
  if (selected.CV_TEST_S3_PROVIDER !== 'localstack' || endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('The Docker host fixture requires the explicitly mapped local HTTP emulator');
  // Use one explicit IPv4 destination for both published-port validation and controller cleanup.
  if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
  const service = await inspectService(selected.CV_TEST_S3_CONTAINER ?? 'cv-localstack-01a1a255');
  if (!service.State.Running || !(service.NetworkSettings.Ports['4566/tcp'] ?? []).some((port: any) => port.HostPort === endpoint.port && (port.HostIp === endpoint.hostname || port.HostIp === '0.0.0.0'))) throw new Error('Selected S3 endpoint does not identify the running owned service');
  const networks = Object.entries(service.NetworkSettings.Networks) as [string, any][];
  const linked = networks.find(([, value]) => value.Aliases?.includes('contextvault-s3')) ?? (networks.length === 1 ? networks[0] : undefined);
  if (!linked || ['host', 'none', 'bridge'].includes(linked[0])) throw new Error('S3 fixture requires an explicit dedicated backend network');
  const hostname = service.Name.replace(/^\//, '');
  return { endpoint: endpoint.origin, containerEndpoint: 'http://' + hostname + ':4566', network: linked[0], bucket: selected.CV_TEST_S3_BUCKET!, region: selected.CV_TEST_S3_REGION!, prefix: selected.CV_TEST_S3_PREFIX! + 'http-' + id + '/' };
}

export async function startContainerWorkspaceServer(backend: string) {
  const id = randomUUID(); const image = await serverImage(); const target = await storageTarget(backend, id);
  const network = 'cv-host-server-' + id; const containerName = 'cv-host-server-' + id;
  const master = 'cv-host-master-' + randomUUID(); const customerA = 'fixture-a-' + id; const customerB = 'fixture-b-' + id;
  const keys: string[] = []; let networkCreated = false; let containerCreated = false; let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    if (containerCreated) await removeContainer(containerName, id);
    if (networkCreated) await removeNetwork(network, id);
    if (target) {
      const client = new S3Client({ endpoint: target.endpoint, region: target.region, forcePathStyle: true, ignoreConfiguredEndpointUrls: true, maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
      await cleanupHttpFixtureStorage({ client, bucket: target.bucket, prefix: target.prefix, timeoutMs: 30000 });
    }
    disposed = true;
  };
  try {
    // Docker does not publish controller ports from an internal-only network. Agents use their separate internal network.
    networkCreated = true; await docker(['network', 'create', '--label', ownerLabel + '=' + id, network]);
    const variables: Record<string, string> = { PORT: '3000', HOST: '0.0.0.0', HOME: '/tmp', CV_DATA_DIR: '/tmp/contextvault-fixture', CONTEXTVAULT_API_KEY: master, CV_STORAGE_BACKEND: backend, CV_LEASE_TTL_MS: '60000', GIT_AUTHOR_NAME: 'ContextVault fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'ContextVault fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    if (target) Object.assign(variables, { CV_S3_PROVIDER: 'localstack', CV_S3_ENDPOINT: target.containerEndpoint, CV_S3_BUCKET: target.bucket, CV_S3_REGION: target.region, CV_S3_PREFIX: target.prefix, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_EC2_METADATA_DISABLED: 'true' });
    containerCreated = true;
    await docker(['create', '--init', '--pull=never', '--name', containerName, '--label', ownerLabel + '=' + id, '--network', network, '--network-alias', 'contextvault-server', '--publish', '127.0.0.1::3000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...Object.entries(variables).flatMap(([key, value]) => ['--env', key + '=' + value]), image.image]);
    if (target) await docker(['network', 'connect', target.network, containerName]);
    await docker(['start', containerName]);
    const container = await inspect(containerName); const port = container.NetworkSettings.Ports['3000/tcp']?.[0];
    const networks = Object.keys(container.NetworkSettings.Networks).sort();
    if (container.Mounts.length || JSON.stringify(networks) !== JSON.stringify([network, ...(target ? [target.network] : [])].sort())) throw new Error('API fixture mount or network boundary changed');
    if (port?.HostIp !== '127.0.0.1' || !/^\d+$/.test(port.HostPort)) throw new Error('API controller port is not loopback-only: ' + JSON.stringify({ status: container.State.Status, exitCode: container.State.ExitCode, ports: container.NetworkSettings.Ports }));
    const baseUrl = 'http://127.0.0.1:' + port.HostPort; const deadline = Date.now() + 15000; let healthy = false;
    while (Date.now() < deadline) {
      try { const response = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(500) }); healthy = response.ok && (await response.json()).status === 'healthy'; if (healthy) break; } catch { /* Await the exact owned container's listener. */ }
      if (!(await inspect(containerName)).State.Running) throw new Error('Owned API container exited during startup');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!healthy) throw new Error('Owned API container did not become healthy');
    for (const customerId of [customerA, customerB]) {
      const response = await fetch(baseUrl + '/api-keys', { method: 'POST', headers: { 'X-API-Key': master, 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId, name: 'installed-client-fixture' }), signal: AbortSignal.timeout(15000) });
      if (response.status !== 201) throw new Error('Owned API tenant credential setup failed');
      const key = (await response.json()).plainKey; if (typeof key !== 'string' || !key) throw new Error('Owned API omitted its scoped credential'); keys.push(key);
    }
    const verified = await fetch(baseUrl + '/v1/workspaces', { headers: { 'X-API-Key': keys[0] }, signal: AbortSignal.timeout(15000) });
    if (verified.status !== 200) throw new Error('Owned API authority check failed'); await verified.body?.cancel();
    const runtime = JSON.parse(await docker(['exec', containerName, 'node', '-e', 'const D=require("better-sqlite3");const d=new D(":memory:");console.log(JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch,sqlite:d.prepare("select sqlite_version() as version").get().version}));d.close();']));
    if (runtime.platform !== 'linux' || Number(runtime.node.split('.')[0]) < 22 || !runtime.sqlite) throw new Error('API image did not execute the required native Linux runtime');
    const git = (await docker(['exec', containerName, 'git', '--version'])).trim();
    const proof = { kind: 'docker', id, containerName, containerId: container.Id, network, networks, controllerBinding: { host: port.HostIp, port: port.HostPort }, hostMounts: false, upstream: 'http://contextvault-server:3000', ...image, runtime: { ...runtime, git }, privateRoot: variables.CV_DATA_DIR };
    return { client: { baseUrl, customerA, customerB, keyA: keys[0], keyB: keys[1] }, proof, dispose: cleanup };
  } catch (error) {
    let detail = '';
    if (containerCreated) { try { const log = await execute('docker', ['logs', '--tail', '30', containerName], { env: environment(), timeout: 5000, maxBuffer: 65536 }); detail = (log.stdout + log.stderr).slice(-4000); } catch { /* Cleanup remains authoritative. */ } }
    for (const secret of [master, ...keys]) detail = detail.split(secret).join('[redacted]');
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API fixture startup and owned cleanup failed'); }
    throw new Error((error as Error).message + (detail ? '\nRedacted API startup evidence: ' + detail : ''));
  }
}
