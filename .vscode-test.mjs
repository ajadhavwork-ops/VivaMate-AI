// Configuration for `npm run test:integration` (@vscode/test-cli).
// Downloads a local copy of VS Code and runs integration tests inside it.
//
// Notes:
// - The user-data-dir must contain NO spaces: some tooling passes these args
//   through a shell without escaping, and paths like C:\Users\<name with space>
//   get split mid-token (that was the "EPERM: mkdir 'C:\Users\Aditya'" error).
// - `--disable-extensions` gives a quiet test window; the extension under
//   development is still loaded (and activated) explicitly.
// - The isolated user-data-dir also lets tests run while a normal VS Code
//   window is open on this machine.
import { defineConfig } from '@vscode/test-cli';
import * as path from 'path';

const userDataDir = path.join(import.meta.dirname, '.vscode-test', 'userdata');

export default defineConfig({
  files: 'dist/test/integration/*.test.js',
  extensionDevelopmentPath: import.meta.dirname,
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    '--disable-extensions',
  ],
});
