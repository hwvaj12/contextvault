import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const requireBrowser = createRequire(resolve(root, 'src/vault-browser/package.json'));
const React = requireBrowser('react');
const { renderToStaticMarkup } = requireBrowser('react-dom/server');
const { buildSync } = requireBrowser('esbuild');

function render(file: string, props: Record<string, unknown>, state?: unknown[]) {
  vi.stubGlobal('window', { location: { origin: 'http://browser.test' } });
  vi.stubGlobal('localStorage', { getItem: () => null });
  const output = buildSync({ entryPoints: [resolve(root, file)], bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom'],
    loader: { '.css': 'empty' } }).outputFiles[0].text;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', output)(requireBrowser, module, module.exports);
  if (state) {
    let index = 0;
    vi.spyOn(React, 'useState').mockImplementation((initial: unknown) => [index < state.length ? state[index++] : typeof initial === 'function' ? initial() : initial, () => {}]);
  }
  return renderToStaticMarkup(React.createElement(module.exports.default, props));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const workspace = { id: 'workspace-binary', customerId: 'customer-a', name: 'Binary files', latestCommitId: 'revision-binary' };
const binary = { path: 'binary.bin', content: 'AP8B', encoding: 'base64' };

it('the vault workspace carries binary encoding into its actual file viewer', () => {
  const html = render('src/vault-browser/src/pages/Workspace.tsx', { workspaceId: workspace.id },
    [workspace, [binary], [], binary.path, null, false, null, '', [], false, false]);
  expect(html).toContain('Binary file (base64)');
  expect(html).toContain('AP8B');
  expect(html).not.toContain('1 lines');
  expect(html).not.toContain('language-');
});

it('the vault text viewer retains text, escaping, and text line counts', () => {
  const html = render('src/vault-browser/src/components/FileViewer.tsx', { path: 'readme.txt', content: '<safe>\ntext', encoding: 'utf8' });
  expect(html).toContain('&lt;safe&gt;');
  expect(html).toContain('text');
  expect(html).toContain('2 lines');
  expect(html).not.toContain('Binary file');
});

it('the vault diff labels binary changes instead of zero text line counts', () => {
  const file = { path: binary.path, status: 'modified', additions: 0, deletions: 0, binary: true, hunks: [] };
  const html = render('src/vault-browser/src/pages/Diff.tsx', { workspaceId: workspace.id },
    [[], 'revision-before', 'revision-after', { files: [file] }, false, false, null, 'unified']);
  expect(html).toContain('Binary file changed');
  expect(html).not.toContain('>+0</span>');
  expect(html).not.toContain('>-0</span>');
});

it('the vault diff retains text line counts and unified text changes', () => {
  const file = { path: 'readme.txt', status: 'modified', additions: 1, deletions: 1, binary: false,
    hunks: [{ header: '@@ -1 +1 @@', content: '-before\n+after' }] };
  const html = render('src/vault-browser/src/pages/Diff.tsx', { workspaceId: workspace.id },
    [[], 'revision-before', 'revision-after', { files: [file] }, false, false, null, 'unified']);
  expect(html).toContain('>+1</span>');
  expect(html).toContain('>-1</span>');
  expect(html).toContain('-before');
  expect(html).toContain('+after');
  expect(html).not.toContain('Binary file changed');
});

it('the secondary browser identifies base64 binary pull contents', () => {
  const html = render('ui/src/App.tsx', {}, ['test-key', '', false, false, [workspace], workspace.id,
    '', '', '', '', [], '', { files: [binary] }, [], '', '', null, 'pull']);
  expect(html).toContain('Binary file (base64)');
  expect(html).toContain('AP8B');
});
