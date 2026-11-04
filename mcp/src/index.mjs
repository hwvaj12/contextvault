// Development loads the maintained TypeScript implementation.
import { tsImport } from 'tsx/esm/api';
try {
  const { main } = await tsImport('./index.ts', import.meta.url);
  await main();
} catch {
  console.error('ContextVault MCP could not start. Check its configuration and dependencies.');
  process.exitCode = 1;
}
