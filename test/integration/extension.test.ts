import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

suite('VivaMate Phase 0 + Phase 1', () => {
  test('extension bundles to dist/extension.js', () => {
    // __dirname = <root>/dist/test/integration → two levels up is dist/
    const dist = path.resolve(__dirname, '..', '..', 'extension.js');
    assert.ok(fs.existsSync(dist), 'dist/extension.js should exist after npm run compile');
  });

  test('extension is discovered by VS Code', () => {
    const ext = vscode.extensions.getExtension('vivamate.viva-mate');
    assert.ok(ext, 'extension vivamate.viva-mate should be discovered');
  });

  // NOTE: replaces the former "commands visible BEFORE activation" diagnostic.
  // Its premise was invalidated on purpose by the `onStartupFinished` fix
  // (the extension now activates at startup, so command registration moves
  // to activation time). The stronger contract below is the real regression
  // test for the original "icon and panel never appeared" issue.
  test('extension activates without error', async () => {
    const ext = vscode.extensions.getExtension('vivamate.viva-mate');
    assert.ok(ext, 'extension vivamate.viva-mate should be discovered');
    await ext!.activate(); // throws with a real error message if activation fails
    assert.strictEqual(ext!.isActive, true);
  });

  test('contributed commands are registered after activation', async () => {
    const ext = vscode.extensions.getExtension('vivamate.viva-mate');
    assert.ok(ext);
    await ext!.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('vivaMate.analyze'), 'vivaMate.analyze should be registered');
    assert.ok(commands.includes('vivaMate.focusPanel'), 'vivaMate.focusPanel should be registered');
  });

  test('webview view is registered and can be opened (vivaMate.panel.focus)', async () => {
    // The workbench only creates "<viewId>.focus" for a REGISTERED view;
    // it rejects with "command not found" otherwise. This failing would mean
    // the manifest contribution or the provider registration is broken.
    const ext = vscode.extensions.getExtension('vivamate.viva-mate');
    assert.ok(ext);
    await ext!.activate();
    await vscode.commands.executeCommand('vivaMate.panel.focus');
  });
});
