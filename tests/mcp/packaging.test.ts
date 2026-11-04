import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';
const execute = promisify(execFile);
const image = 'node:20-bookworm-slim';
const label = 'io.contextvault.mcp-test.owner';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function command(program: string, args: string[], cwd = root) {
  return execute(program, args, { cwd, timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
}

it('standalone MCP-only artifact installs on Node20 and shares authenticated tools and lifecycle with current development/production', async () => {
  const f = await fixture(); const id = randomUUID(); const names = new Set<string>(); const peers: Protocol[] = [];
  const tooling = join(root, 'tests/mcp/tooling'); await mkdir(tooling, { recursive: true }); const directory = await mkdtemp(join(tooling, 'installed-'));
  try {
    await command(process.execPath, [join(root, 'mcp/node_modules/typescript/bin/tsc'), '--project', join(root, 'mcp/tsconfig.json')]);
    const archiveBefore = await readFile(join(root, 'mcp/vendor/contextvault-sdk-0.1.0.tgz')); const provenanceBefore = await readFile(join(root, 'mcp/vendor/sdk-provenance.json'));
    const lock = JSON.parse(await readFile(join(root, 'mcp/package-lock.json'), 'utf8')); expect(lock.packages['node_modules/@contextvault/sdk'].integrity).toBe('sha512-' + createHash('sha512').update(archiveBefore).digest('base64'));
    await command(process.execPath, [join(root, 'mcp/scripts/vendor-sdk.mjs')]);
    expect(hash(await readFile(join(root, 'mcp/vendor/contextvault-sdk-0.1.0.tgz')))).toBe(hash(archiveBefore)); expect(await readFile(join(root, 'mcp/vendor/sdk-provenance.json'))).toEqual(provenanceBefore);
    const packed = JSON.parse((await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], join(root, 'mcp'))).stdout)[0];
    expect(packed.bundled).toContain('@contextvault/sdk'); expect(packed.files.some((file: any) => file.path === 'node_modules/@contextvault/sdk/dist/session.js')).toBe(true); expect(packed.files.some((file: any) => file.path.startsWith('src/'))).toBe(false);
    const consumer = join(directory, 'consumer'); await mkdir(consumer); const state = join(directory, 'private-state'); await mkdir(state, { mode: 0o700 });
    const uid = process.getuid!(); const gid = process.getgid!(); const installation = 'cv-mcp-install-' + id; names.add(installation);
    await command('docker', ['run', '--rm', '--pull=never', '--name', installation, '--label', label + '=' + id, '--user', uid + ':' + gid, '--mount', `type=bind,src=${directory},dst=/artifacts,readonly`, '--mount', `type=bind,src=${consumer},dst=/consumer`, '--workdir', '/consumer', '-e', 'HOME=/consumer/home', '-e', 'NPM_CONFIG_CACHE=/consumer/cache', image, 'npm', 'install', '--ignore-scripts', '--omit=dev', '--engine-strict', '--no-audit', '--no-fund', '/artifacts/' + packed.filename]);
    const packageRoot = join(consumer, 'node_modules/contextvault-mcp'); expect((await lstat(packageRoot)).isSymbolicLink()).toBe(false);
    const sdk = join(packageRoot, 'node_modules/@contextvault/sdk'); expect((await lstat(sdk)).isSymbolicLink()).toBe(false); expect(await realpath(sdk)).toBe(sdk);
    expect(await readFile(join(sdk, 'LICENSE'), 'utf8')).toBe(await readFile(join(root, 'LICENSE'), 'utf8'));
    expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toBe(await readFile(join(root, 'LICENSE'), 'utf8'));
    expect(JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8')).engines.node).toBe('>=18.0.0'); expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).engines.node).toBe('>=20.0.0');
    await command('docker', ['run', '--rm', '--network=none', '--pull=never', '--user', uid + ':' + gid, '--mount', `type=bind,src=${consumer},dst=/consumer,readonly`, '--workdir', '/consumer', image, 'node', '--input-type=module', '-e', 'import {configuration, createMcpServer, main} from "contextvault-mcp"; if([configuration, createMcpServer, main].some(value => typeof value !== "function")) process.exit(1);']);
    const runtime = 'cv-mcp-runtime-' + id; names.add(runtime);
    const env = { CV_API_URL: f.server.client.baseUrl, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'development-state') };
    const dev = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env }).initialize(); peers.push(dev);
    const production = await new Protocol(join(consumer, 'node_modules/.bin/contextvault-mcp'), [], { cwd: f.directory, env: { ...env, CV_MCP_STATE_DIR: join(f.directory, 'production-state') } }).initialize(); peers.push(production);
    const minimum = await new Protocol('docker', ['run', '--rm', '-i', '--pull=never', '--name', runtime, '--label', label + '=' + id, '--user', uid + ':' + gid, '--mount', `type=bind,src=${consumer}/node_modules,dst=/installed/node_modules,readonly`, '--mount', `type=bind,src=${state},dst=/state`, '--workdir', '/tmp', '-e', 'CV_API_URL=' + f.server.client.baseUrl.replace('127.0.0.1', 'host.docker.internal'), '-e', 'CV_API_KEY=' + f.server.client.keyA, '-e', 'CV_MCP_STATE_DIR=/state', image, 'node', '/installed/node_modules/contextvault-mcp/bin/contextvault-mcp.mjs'], { cwd: f.directory, env: {} }).initialize(); peers.push(minimum);
    const toolSets = await Promise.all(peers.map(peer => peer.call('tools/list'))); const namesAt = (index: number) => toolSets[index].tools.map((tool: any) => tool.name).sort(); expect(namesAt(1)).toEqual(namesAt(0)); expect(namesAt(2)).toEqual(namesAt(0));
    await expect(lstat(join(f.directory, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    await command('docker', ['exec', runtime, 'node', '-e', 'if(require("node:fs").existsSync("/tmp/data"))process.exit(1)']);
    const workspace = await canonicalWorkspace(f.server);
    for (const [index, peer] of peers.entries()) {
      expect((await peer.tool('list_workspaces')).value.map((value: any) => value.id)).toContain(workspace.id);
      const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'installed-' + index }); expect(opened.isError).not.toBe(true); const handle = opened.value.workspaceHandle;
      const checkpointBytes = Buffer.from([0, 255, 128, index]).toString('base64'); const finalBytes = Buffer.from([0, 255, 128, index + 10]).toString('base64');
      expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'binary.bin', base64: checkpointBytes, truncate: true })).isError).not.toBe(true);
      const checkpoint = await peer.tool('checkpoint_workspace', { workspaceHandle: handle, writersStopped: true }); expect(checkpoint.isError).not.toBe(true); expect(checkpoint.value.checkpointReceipt.operation.result.changed).toBe(true);
      expect((await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'binary.bin', base64: finalBytes, truncate: true })).isError).not.toBe(true);
      const finalized = await peer.tool('finalize_workspace', { workspaceHandle: handle, writersStopped: true }); expect(finalized.isError).not.toBe(true); expect(finalized.value.run.state).toBe('finalized');
      expect((await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true })).value.cleanupState).toBe('complete');
      const readback = await peer.tool('checkout_workspace', { workspaceId: workspace.id, mode: 'read-only', access: 'remote', requestId: 'installed-readback-' + index }); expect(readback.isError).not.toBe(true); const readbackHandle = readback.value.workspaceHandle;
      expect((await peer.tool('read_workspace_file', { workspaceHandle: readbackHandle, path: 'binary.bin' })).value.base64).toBe(finalBytes);
      expect((await peer.tool('abort_workspace', { workspaceHandle: readbackHandle, writersStopped: true, reason: 'owned installed artifact verification complete' })).value.run.state).toBe('aborted');
      expect((await peer.tool('cleanup_workspace', { workspaceHandle: readbackHandle, writersStopped: true })).value.cleanupState).toBe('complete');
    }
    const version = (await command('docker', ['run', '--rm', '--network=none', '--pull=never', image, '/bin/sh', '-c', 'if command -v git >/dev/null 2>&1; then exit 1; fi; exec node -p process.versions.node'])).stdout.trim(); expect(version).toMatch(/^20\./);
    const evidence = { backend: process.env.CV_TEST_BACKEND ?? 'git', currentNode: process.versions.node, minimumNode: version, archive: packed.filename, sha256: hash(await readFile(join(directory, packed.filename))), bundledSdk: hash(archiveBefore), tools: namesAt(0), sourceSiblingRequired: false, minimumImageHasGit: false };
    await writeFile(join(tooling, 'package-evidence-' + evidence.backend + '.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.info('MCP_PACKAGE_EVIDENCE ' + JSON.stringify(evidence));
  } finally {
    for (const peer of peers.reverse()) await peer.close();
    for (const name of names) {
      let owner; try { owner = (await command('docker', ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name])).stdout.trim(); } catch (error) { if (/No such (?:object|container)/i.test((error as any).stderr ?? (error as Error).message)) continue; throw error; }
      expect(owner).toBe(id); await command('docker', ['rm', '-f', name]);
    }
    await f.dispose(); await rm(directory, { recursive: true, force: true });
  }
}, 240000);
