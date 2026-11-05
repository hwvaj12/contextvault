import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPostman } from '../../scripts/verify-workspace-docs.mjs';
import { postmanImage, postmanExecutor } from './postman-runtime.mjs';

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const item = (name, url, script) => ({ name, request: { method: 'GET', url }, event: [{ listen: 'test', script: { exec: script } }] });
export async function verifyRuntimeProbes() {
  const image = await postmanImage();
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'cv-postman-runtime-probes-'));
  const owner = randomUUID(); const results = [];
  let version;
  const status = "pm.test('status', () => pm.response.to.have.status(200));";
  const cases = [
    { name: 'positive', items: [item('first', '{{baseUrl}}/first', [status, "pm.test('prerequest header', () => pm.expect(pm.response.json().header).to.eql('from-prerequest'));", "pm.environment.set('retained', pm.response.json().value);"]), item('second', '{{baseUrl}}/second?value={{retained}}', [status, "pm.test('environment propagation', () => pm.expect(pm.response.json().path).to.eql('/second?value=retained-value'));"])], pass: true },
    { name: 'assertion-failure', script: "pm.test('bad assertion', () => pm.expect(false).to.be.true);", exitFailure: true },
    { name: 'script-failure', script: "throw new Error('probe script failure'); pm.test('unreachable', () => {});", exitFailure: true },
    { name: 'request-failure', script: status, baseUrl: 'http://127.0.0.1:1', exitFailure: true },
    { name: 'request-timeout', script: status, url: '{{baseUrl}}/slow', requestTimeoutMs: 100, exitFailure: true },
    { name: 'skipped-assertion', script: [status, "pm.test.skip('skipped', () => {});"], error: /skipped/i },
    { name: 'zero-assertions', script: "if (false) { pm.test('unreachable', () => {}); }", error: /assertion.*coverage/i },
    { name: 'wall-timeout', script: status, url: '{{baseUrl}}/hang', wallTimeoutMs: 500, error: /runtime failed/i },
  ];
  try {
    const versionRuntime = postmanExecutor({ image, network: 'none', owner });
    version = (await versionRuntime('postman', ['--version'], { cwd: directory, timeout: 15000 })).stdout.trim();
    assert.equal(version, '1.85.0');
    for (const probe of cases) {
      const file = probe.name + '.json'; const observations = [];
      const collection = { info: { name: probe.name, schema }, event: [{ listen: 'prerequest', script: { exec: ["pm.request.headers.upsert({key:'x-probe',value:'from-prerequest'});"] } }], item: probe.items ?? [item(probe.name, probe.url ?? '{{baseUrl}}/probe', Array.isArray(probe.script) ? probe.script : [probe.script])] };
      await writeFile(path.join(directory, file), JSON.stringify(collection), { mode: 0o600 });
      const executor = postmanExecutor({ image, network: 'none', owner, probe: true, observations });
      const run = probe.wallTimeoutMs ? (command, args, options) => executor(command, args, { ...options, timeout: probe.wallTimeoutMs }) : executor;
      const specification = { file, variables: { baseUrl: probe.baseUrl ?? 'http://127.0.0.1:18080' }, requestTimeoutMs: probe.requestTimeoutMs, timeoutMs: 10000 };
      let summary; let failure;
      try { summary = await runPostman(directory, specification, { run }); } catch (error) { failure = error; }
      assert.equal(observations.length, 1, probe.name + ' must execute the actual container runtime');
      const observed = observations[0];
      if (probe.pass) { assert.equal(failure, undefined); assert.deepEqual(summary, { requests: 2, assertions: 4, skipped: 0 }); assert.equal(observed.exitCode, 0); }
      else {
        assert.ok(failure, probe.name + ' must fail the documentation gate');
        if (probe.error) assert.match(failure.message, probe.error);
        if (probe.exitFailure) { assert.notEqual(observed.exitCode, 0, probe.name + ' must preserve runtime failure'); assert.equal(observed.reportPresent, true); assert.ok(observed.failures > 0); }
        if (probe.name === 'skipped-assertion') { assert.equal(observed.exitCode, 0); assert.ok(observed.skipped > 0); }
        if (probe.name === 'zero-assertions') { assert.equal(observed.exitCode, 0); assert.equal(observed.assertions, 0); }
        if (probe.name === 'wall-timeout') assert.equal(observed.running, true);
      }
      results.push({ name: probe.name, expected: probe.pass ? 'accepted' : 'rejected', actual: failure ? 'rejected' : 'accepted', ...observed });
    }
    return { version, ...image, cases: results };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
