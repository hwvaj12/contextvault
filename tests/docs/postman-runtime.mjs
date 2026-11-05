import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ownerLabel = 'io.contextvault.docs-test.owner';
const sourceLabel = 'io.contextvault.docs-test.source';
const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'];
const runtimeEnvironment = () => Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
export async function docker(args, timeout = 30000) {
  return execute('docker', args, { timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: runtimeEnvironment(), encoding: 'utf8' });
}
async function inspect(name) { return JSON.parse((await docker(['inspect', name])).stdout)[0]; }
export async function removeOwnedContainer(name, owner) {
  let value;
  try { value = await inspect(name); } catch (error) { if (/No such (?:object|container)/i.test(error.stderr ?? error.message)) return; throw error; }
  if (value.Config.Labels?.[ownerLabel] !== owner) throw new Error('Refused another documentation container owner');
  await docker(['rm', '--force', name]);
}
export async function removeOwnedNetwork(name, owner) {
  let value;
  try { value = JSON.parse((await docker(['network', 'inspect', name])).stdout)[0]; } catch (error) { if (/not found|No such/i.test(error.stderr ?? error.message)) return; throw error; }
  if (value.Labels?.[ownerLabel] !== owner || Object.keys(value.Containers ?? {}).length) throw new Error('Refused a foreign or occupied documentation network');
  await docker(['network', 'rm', name]);
}
let imagePromise;
export async function postmanImage() {
  return imagePromise ??= (async () => {
    const base = JSON.parse((await docker(['image', 'inspect', 'node:22-bookworm-slim'])).stdout)[0];
    const reference = base.RepoDigests?.find(value => /(?:^|\/)node@sha256:[a-f0-9]{64}$/.test(value));
    if (!reference) throw new Error('Postman tooling requires the official digest-addressed Node22 image');
    const directory = path.join(root, 'tests/docs/tooling');
    const files = ['package.json', 'package-lock.json', 'Dockerfile', 'runner.cjs'];
    const digest = createHash('sha256').update('contextvault-docs-postman-v1\0').update(base.Id);
    const inputs = new Map();
    for (const file of files) { if (!(await lstat(path.join(directory, file))).isFile()) throw new Error('Postman build input identity changed'); const bytes = await readFile(path.join(directory, file)); inputs.set(file, bytes); digest.update('\0' + file + '\0').update(bytes); }
    const sourceHash = digest.digest('hex'); const image = 'cv-docs-postman:' + sourceHash;
    let existing;
    try { existing = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0]; } catch (error) { if (!/No such (?:image|object)/i.test(error.stderr ?? error.message)) throw error; }
    if (!existing) {
      const context = await mkdtemp(path.join(await realpath(tmpdir()), 'cv-postman-image-'));
      try {
        for (const [file, bytes] of inputs) await writeFile(path.join(context, file), bytes);
        await docker(['build', '--pull=false', '--build-arg', 'BASE_IMAGE=' + reference, '--label', sourceLabel + '=' + sourceHash, '--tag', image, context], 300000);
      } finally { await rm(context, { recursive: true, force: true }); }
      existing = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
    }
    if (existing.Config.Labels?.[sourceLabel] !== sourceHash) throw new Error('Postman tooling cache identity changed');
    return { image, imageId: existing.Id, sourceHash, baseId: base.Id, architecture: existing.Architecture };
  })();
}
async function reportSummary(directory) {
  try {
    const file = path.join(directory, 'report.json'); const info = await lstat(file);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return { reportPresent: false };
    const report = JSON.parse(await readFile(file, 'utf8')); const run = report.run;
    return { reportPresent: true, requests: run?.stats?.requests?.total, assertions: run?.stats?.assertions?.total, skipped: run?.executions?.flatMap(value => value.assertions ?? []).filter(value => value.skipped).length, failures: run?.failures?.length };
  } catch { return { reportPresent: false }; }
}
export function postmanExecutor({ image, network, owner, probe = false, observations = [], allowedPeerIds = [] }) {
  return async (command, args, options) => {
    if (command !== 'postman' || !Array.isArray(args)) throw new Error('Unexpected Postman runtime command');
    const directory = options.cwd; const name = 'cv-docs-postman-' + randomUUID();
    const mapped = args.map(value => value === directory ? '/work' : value.startsWith(directory + path.sep) ? '/work/' + path.relative(directory, value) : value);
    const secrets = [];
    try { const environment = JSON.parse(await readFile(path.join(directory, 'environment.json'), 'utf8')); for (const value of environment.values ?? []) if (/key|secret|token/i.test(value.key) && typeof value.value === 'string' && value.value) secrets.push(value.value); } catch { /* Version/help checks have no environment file. */ }
    const scrub = text => { for (const secret of secrets) text = text.split(secret).join('[redacted]'); return text; };
    let created = false; let result; let failure;
    try {
      if (network !== 'none') { const value = JSON.parse((await docker(['network', 'inspect', network])).stdout)[0]; if (!value.Internal || value.Labels?.[ownerLabel] !== owner) throw new Error('Postman requires its owned internal network'); }
      created = true;
      await docker(['create', '--init', '--pull=never', '--name', name, '--label', ownerLabel + '=' + owner, '--network', network, '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', String(process.getuid?.() ?? 1000) + ':' + String(process.getgid?.() ?? 1000), '--env', 'HOME=/tmp/contextvault-postman-home', '--env', 'CV_DOCS_PROBE_MODE=' + (probe ? '1' : '0'), ...proxyNames.flatMap(name => ['--env', name + '=']), '--workdir', '/work', '--mount', 'type=bind,src=' + directory + ',dst=/work', image.image, ...mapped]);
      const container = await inspect(name);
      if (container.Mounts.length !== 1 || container.Mounts[0].Destination !== '/work' || !container.Mounts[0].RW || Object.keys(container.NetworkSettings.Networks).length !== 1 || !container.NetworkSettings.Networks[network]) throw new Error('Postman container boundary changed');
      if (container.Config.Env.some(value => /^(?:AWS_|POSTMAN_|CV_S3_|CV_DATA_DIR=)/.test(value) || proxyNames.some(name => value.startsWith(name + '=') && value !== name + '='))) throw new Error('Postman inherited unexpected account, storage, or proxy settings');
      if (network !== 'none') {
        const actual = JSON.parse((await docker(['network', 'inspect', network])).stdout)[0]; const peers = Object.keys(actual.Containers);
        // Docker registers the created client's endpoint only when it starts.
        if (allowedPeerIds.some(id => !peers.includes(id)) || peers.some(id => ![...allowedPeerIds, container.Id].includes(id))) throw new Error('Postman internal network has unexpected peers');
      }
      try { result = await docker(['start', '--attach', name], options.timeout); }
      catch (error) { failure = error; }
      const stopped = await inspect(name);
      const observation = { containerId: stopped.Id, network, internal: network !== 'none', accountProfileMounted: false, canonicalStorageCredentials: false, exitCode: stopped.State.ExitCode, running: stopped.State.Running, ...await reportSummary(directory) };
      observations.push(observation);
      if (failure || stopped.State.Running || stopped.State.ExitCode !== 0) throw new Error('Postman runtime failed (' + (failure?.signal ?? stopped.State.ExitCode) + '): ' + scrub(String(failure?.stderr || failure?.stdout || '')).slice(-1500));
      return { stdout: scrub(result.stdout), stderr: scrub(result.stderr), observation };
    } finally { if (created) await removeOwnedContainer(name, owner); }
  };
}
export { ownerLabel };
