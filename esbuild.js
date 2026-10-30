// esbuild.js — bundles both entry points:
//   src/extension.ts    -> dist/extension.js    (Node.js, inside VS Code)
//   webview-ui/main.ts  -> dist/webview/main.js (browser, inside the webview)
// Static assets (index.html, styles.css) are copied to dist/webview/.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const isProd = process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !isProd,
  minify: isProd,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['webview-ui/main.ts'],
  outfile: 'dist/webview/main.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !isProd,
  minify: isProd,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const testOptions = {
  entryPoints: ['test/integration/*.test.ts', 'test/unit/*.test.ts'],
  outdir: 'dist/test',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode', 'mocha', 'assert', 'path', 'fs', 'url'],
  sourcemap: false,
  logLevel: 'info',
};

function copyAssets() {
  const dest = path.join(__dirname, 'dist', 'webview');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'webview-ui', 'index.html'), path.join(dest, 'index.html'));
  fs.copyFileSync(path.join(__dirname, 'webview-ui', 'styles.css'), path.join(dest, 'styles.css'));
}

copyAssets();

if (watch) {
  // Watch mode: rebuild both bundles on change, keep processes alive.
  let contexts;
  esbuild
    .context(extensionOptions)
    .then((extCtx) => {
      contexts = [extCtx];
      return esbuild.context(webviewOptions);
    })
    .then((webCtx) => {
      contexts.push(webCtx);
      for (const ctx of contexts) ctx.watch();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
    esbuild.build(testOptions),
  ]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
