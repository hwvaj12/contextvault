'use strict';
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
let server;
async function main() {
  if (process.env.CV_DOCS_PROBE_MODE === '1') {
    server = createServer((request, response) => {
      const send = () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ header: request.headers['x-probe'], path: request.url, value: 'retained-value' })); };
      if (request.url === '/slow' || request.url === '/hang') setTimeout(send, request.url === '/hang' ? 10000 : 1000).unref(); else send();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18080, '127.0.0.1', resolve); });
  }
  const child = spawn(process.execPath, ['/opt/contextvault-docs/node_modules/postman-cli/bin/postman.js', ...process.argv.slice(2)], { stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; server?.close(); });
  child.once('close', (code, signal) => { server?.closeAllConnections(); server?.close(); process.exitCode = code ?? (signal ? 1 : 0); });
  process.once('SIGTERM', () => child.kill('SIGTERM'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
