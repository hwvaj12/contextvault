import assert from 'node:assert/strict';
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startContainerWorkspaceServer } from '../hosts/server';
import { packages } from '../hosts/harness';
// @ts-ignore Node documentation harness and its isolated runtime.
import { documentationEnvironment, runPostman, runQuickstart, verifyDocumentation } from '../../scripts/verify-workspace-docs.mjs';
// @ts-ignore Native Node tooling adapter.
import { docker, ownerLabel, postmanExecutor, postmanImage, removeOwnedNetwork } from './postman-runtime.mjs';

const execute = promisify(execFile);
export const root = resolve(import.meta.dirname, '../..');
const exampleNames: Record<string, string> = { 'typescript-lifecycle': 'typescript-lifecycle.mjs', 'python-lifecycle': 'python-lifecycle.py', 'php-lifecycle': 'php-lifecycle.php' };
async function setupCommand(command: string, args: string[], directory: string, extra = {}) {
  return execute(command, args, { cwd: directory, env: { ...documentationEnvironment({ HOME: directory }), ...extra }, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
}

export async function documentationFixture() {
  const backend = process.env.CV_TEST_BACKEND ?? 'git';
  const owner = randomUUID(); const network = 'cv-docs-api-' + owner;
  let server: Awaited<ReturnType<typeof startContainerWorkspaceServer>> | undefined; let networkCreated = false;
  try {
    server = await startContainerWorkspaceServer(backend); const api = server;
    const artifact = await packages(); const image = await postmanImage();
    networkCreated = true;
    await docker(['network', 'create', '--internal', '--label', ownerLabel + '=' + owner, network]);
    await docker(['network', 'connect', '--alias', 'contextvault-docs', network, api.proof.containerName]);
    const inspected = JSON.parse((await docker(['network', 'inspect', network])).stdout)[0];
    assert.equal(inspected.Internal, true); assert.deepEqual(Object.keys(inspected.Containers), [api.proof.containerId]);
    const environment = { CV_API_URL: api.client.baseUrl, CV_API_KEY: api.client.keyA, CV_CUSTOMER_ID: api.client.customerA };
    const observations: any[] = []; const examples: any[] = [];
    const postman = { run: postmanExecutor({ image, network, owner, observations, allowedPeerIds: [api.proof.containerId] }), variables: { baseUrl: 'http://contextvault-docs:3000' }, allowedOrigin: 'http://contextvault-docs:3000' };
    async function prepare(directory: string, spec: any) {
      const name = exampleNames[spec.block]; if (!name) throw new Error('Unsupported installed documentation example');
      await mkdir(join(directory, 'docs/examples'), { recursive: true });
      await copyFile(join(root, 'docs/examples', name), join(directory, 'docs/examples', name));
      if (name.endsWith('.mjs')) {
        await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'contextvault-docs-consumer', version: '1.0.0', private: true }));
        const archive = (await readdir(artifact.directory)).find(name => /^contextvault-sdk-.*\.tgz$/.test(name)); if (!archive) throw new Error('Installed SDK archive is missing');
        await setupCommand('npm', ['install', '--offline', '--engine-strict', '--ignore-scripts', '--no-audit', '--no-fund', join(artifact.directory, archive)], directory);
      } else if (name.endsWith('.py')) {
        await setupCommand(process.env.CV_TEST_PYTHON_BINARY ?? '/usr/bin/python3', ['-m', 'venv', join(directory, '.venv')], directory);
        await setupCommand(join(directory, '.venv/bin/python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links=' + join(artifact.directory, 'python/wheels'), 'contextvault'], directory);
        return { environment: { PATH: join(directory, '.venv/bin') + ':' + process.env.PATH } };
      } else {
        const metadata = JSON.parse((await setupCommand('tar', ['-xOf', join(artifact.directory, 'php-package.tar.gz'), 'composer.json'], directory)).stdout);
        await writeFile(join(directory, 'composer.json'), JSON.stringify({ name: 'contextvault/docs-consumer', require: { [metadata.name]: '1.0.0' }, config: { platform: { php: '8.0.30' } }, repositories: [{ type: 'package', package: { ...metadata, version: '1.0.0', dist: { type: 'tar', url: 'file://' + join(artifact.directory, 'php-package.tar.gz') } } }] }));
        const composer = process.env.CV_TEST_COMPOSER_BINARY ?? 'composer';
        await setupCommand(composer, ['install', '--no-dev', '--no-scripts', '--no-plugins', '--no-interaction', '--no-progress'], directory, { COMPOSER_HOME: join(directory, '.composer-home'), COMPOSER_CACHE_DIR: join(directory, '.composer-cache') });
      }
    }
    async function http(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(api.client.baseUrl + path, { method, headers: { 'X-API-Key': api.client.keyA, ...(body === undefined ? {} : { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Independent documentation readback failed (' + response.status + ')');
      return { response, value: await response.json() };
    }
    async function runExample(command: string, args: string[], options: any) {
      const result = await execute(command, args, { ...options, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8' } as ExecFileOptionsWithStringEncoding);
      const receipt = JSON.parse(result.stdout.trim());
      assert.ok(['typescript', 'python', 'php'].includes(receipt.language));
      assert.deepEqual([receipt.binary, receipt.deletion, receipt.abort, receipt.cleanup], [true, true, true, true]);
      const workspace = (await http('/v1/workspaces/' + receipt.workspaceId)).value;
      assert.equal(workspace.version, 3, 'Two publications and a separate abort must preserve the accepted head');
      const base = '/v1/workspaces/' + workspace.id + '/revisions/' + workspace.currentRevisionId;
      const manifest = (await http(base + '/manifest')).value;
      const payload = Buffer.from([0, 255, 128, 10]);
      assert.deepEqual(manifest.entries, [{ path: 'empty', kind: 'directory' }, { path: 'output.bin', kind: 'file', byteLength: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }]);
      const read = await fetch(api.client.baseUrl + base + '/files?path=output.bin', { headers: { 'X-API-Key': api.client.keyA }, signal: AbortSignal.timeout(10000) });
      assert.equal(read.status, 200); assert.deepEqual(Buffer.from(await read.arrayBuffer()), payload);
      examples.push({ language: receipt.language, workspaceId: workspace.id, version: workspace.version, binary: true, deletion: true, abort: true, cleanup: true, packageArtifact: artifact.artifacts[receipt.language] });
      return result;
    }
    return {
      environment, postman, quickstart: { prepare, run: runExample },
      proof: { backend, api: api.proof, tooling: image, artifactSet: artifact.key, artifacts: artifact.artifacts, observations, examples },
      async verifyPublished() { return verifyDocumentation({ root, environment, quickstart: { prepare, run: runExample }, postman }); },
      async verifyComponents() {
        const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-docs-component-'));
        try {
          const specifications = JSON.parse(await readFile(join(root, 'tests/docs/workspace-docs.json'), 'utf8'));
          const markdown = specifications.quickstarts.map((spec: any) => '```sh cv-check:' + spec.block + '\n' + spec.display + '\n```').join('\n');
          await writeFile(join(directory, 'examples.md'), markdown);
          for (const spec of specifications.quickstarts) await runQuickstart(directory, { ...spec, file: 'examples.md' }, { environment, prepare, run: runExample });
          const report = await runPostman(root, specifications.postman[0], { environment, ...postman });
          return { quickstarts: examples.length, postman: 1, reports: [report] };
        } finally { await rm(directory, { recursive: true, force: true }); }
      },
      async dispose() { try { await api.dispose(); } finally { await removeOwnedNetwork(network, owner); } },
    };
  } catch (error) {
    try { if (server) await server.dispose(); } finally { if (networkCreated) await removeOwnedNetwork(network, owner); }
    throw error;
  }
}
