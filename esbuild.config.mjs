import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');

const hostConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  external: ['vscode', 'node-pty', 'fsevents'],
};

const webviewConfig = {
  entryPoints: ['src/view/webview/main.tsx'],
  bundle: true,
  outfile: 'out/webview/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // Inline in dev so the debugger has line info without an external fetch
  // (the webview CSP is `default-src 'none'` with no connect-src — an
  // external .map would be blocked AND 404 in production where the map is
  // .vscodeignore'd). No map at all in published builds keeps main.js lean.
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
};

// Tests + transcript watcher: compiled per-file so node:test can load them as CJS.
const testEntries = [
  'src/markers/extractMarkers.ts',
  'src/markers/extractMarkers.test.ts',
  'src/markers/transcriptWatcher.ts',
  'src/markers/transcriptWatcher.test.ts',
];
const testConfig = {
  entryPoints: testEntries,
  bundle: false,
  outdir: 'out',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
};

function copyStatic() {
  fs.mkdirSync('out/webview', { recursive: true });
  if (fs.existsSync('src/view/webview/index.html')) {
    fs.copyFileSync('src/view/webview/index.html', 'out/webview/index.html');
  }
  if (fs.existsSync('src/view/webview/styles.css')) {
    fs.copyFileSync('src/view/webview/styles.css', 'out/webview/styles.css');
  }
  fs.mkdirSync('out/markers', { recursive: true });
  if (fs.existsSync('src/markers/hook.mjs')) {
    fs.copyFileSync('src/markers/hook.mjs', 'out/markers/hook.mjs');
    fs.chmodSync('out/markers/hook.mjs', 0o755);
  }
  if (fs.existsSync('src/markers/mcp-server.mjs')) {
    fs.copyFileSync('src/markers/mcp-server.mjs', 'out/markers/mcp-server.mjs');
    fs.chmodSync('out/markers/mcp-server.mjs', 0o755);
  }
}

if (watch) {
  const hostCtx = await esbuild.context(hostConfig);
  const webCtx = await esbuild.context(webviewConfig);
  const testCtx = await esbuild.context(testConfig);
  await Promise.all([hostCtx.watch(), webCtx.watch(), testCtx.watch()]);
  copyStatic();
  // Re-copy on a simple interval; chokidar would be overkill here.
  setInterval(copyStatic, 1000);
  console.log('esbuild watching…');
} else {
  await Promise.all([
    esbuild.build(hostConfig),
    esbuild.build(webviewConfig),
    esbuild.build(testConfig),
  ]);
  copyStatic();
}
