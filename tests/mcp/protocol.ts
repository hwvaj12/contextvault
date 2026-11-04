import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceServer } from '../helpers/workspace-server.mjs';

export const root = resolve(import.meta.dirname, '../..');
export async function fixture(backend = process.env.CV_TEST_BACKEND ?? 'git') {
  const server = await startWorkspaceServer({ backend });
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-mcp-test-'));
  return { server, directory, async dispose() { await server.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
export class Protocol {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private output = 0;
  private stderr = '';
  constructor(command: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
    const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'].filter(name => process.env[name]).map(name => [name, process.env[name]!]));
    this.child = spawn(command, args, { cwd: options.cwd, env: { ...environment, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      this.output += Buffer.byteLength(line);
      if (this.output > 8 * 1024 * 1024) { this.child.kill('SIGKILL'); return; }
      let message; try { message = JSON.parse(line); } catch { this.child.kill('SIGKILL'); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    });
    const failed = () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('MCP process closed: ' + this.stderr)); }
      this.pending.clear(); lines.close();
    };
    this.child.once('error', failed); this.child.once('exit', failed);
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP request timed out: ' + method + '; ' + this.stderr)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contextvault-independent-consumer', version: '1.0.0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }
  async tool(name: string, args: Record<string, unknown> = {}) {
    const result = await this.call('tools/call', { name, arguments: args });
    const text = result.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
    let value; try { value = text ? JSON.parse(text) : null; } catch { value = { error: { message: text } }; }
    return { ...result, value };
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); }); this.child.kill('SIGTERM');
    });
  }
}
export async function canonicalWorkspace(server: Awaited<ReturnType<typeof startWorkspaceServer>>) {
  const c = server.client;
  const response = await fetch(c.baseUrl + '/v1/workspaces', { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: c.customerA, name: 'MCP canonical workspace' }) });
  if (response.status !== 201) throw new Error('Canonical fixture workspace creation failed');
  return response.json();
}
