#!/usr/bin/env node
import { main } from '../dist/index.js';
try { await main(); }
catch {
  console.error('ContextVault MCP could not start. Check its configuration and dependencies.');
  process.exitCode = 1;
}
