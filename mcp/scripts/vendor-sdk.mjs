import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, '../sdk/typescript');
const digest = value => createHash('sha256').update(value).digest('hex');
const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const license = await readFile(resolve(source, '../../LICENSE'));
assert.equal(metadata.name, '@contextvault/sdk');
assert.equal(metadata.version, '0.1.0');
assert.equal(metadata.license, 'MIT');
assert.equal(metadata.engines.node, '>=18.0.0');
assert.ok(license.toString('utf8').startsWith('MIT License\n'));
const sourceHashes = {};
async function hashes(directory, prefix) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink());
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await hashes(join(directory, entry.name), relative + '/');
    else if (entry.isFile()) sourceHashes[relative] = digest(await readFile(join(directory, entry.name)));
    else throw new Error('SDK source contains a special file');
  }
}
await hashes(join(source, 'src'), 'src/');
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md']) sourceHashes[name] = digest(await readFile(join(source, name)));
const directory = await mkdtemp(join(root, '.sdk-build-'));
const vendor = join(root, 'vendor');
await mkdir(vendor, { recursive: true });
try {
  for (const name of ['src', 'package.json', 'tsconfig.json', 'README.md']) await cp(join(source, name), join(directory, name), { recursive: true });
  await writeFile(join(directory, 'LICENSE'), license);
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(directory, 'tsconfig.json')]);
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', vendor], { cwd: directory })).stdout)[0];
  assert.ok(packed.files.some(file => file.path === 'LICENSE'));
  assert.ok(packed.files.every(file => ['package.json', 'README.md', 'LICENSE'].includes(file.path) || file.path.startsWith('dist/')));
  const archive = await readFile(join(vendor, packed.filename));
  const compiler = JSON.parse(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
  await writeFile(join(vendor, 'sdk-provenance.json'), JSON.stringify({ schemaVersion: 1, package: metadata.name, version: metadata.version, license: metadata.license, licenseSource: { path: '../../LICENSE', sha256: digest(license) }, node: metadata.engines.node, compiler, archive: packed.filename, sha256: digest(archive), sourceHashes }, null, 2) + '\n');
  console.log(JSON.stringify({ archive: packed.filename, sha256: digest(archive), compiler, sourceFiles: Object.keys(sourceHashes).length }));
} finally { await rm(directory, { recursive: true, force: true }); }
