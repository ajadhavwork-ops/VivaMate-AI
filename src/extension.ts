import * as vscode from 'vscode';
import { PanelHost } from './ui/panelHost';
import { analyzeWorkspace } from './commands/analyzeWorkspace';

export function activate(context: vscode.ExtensionContext): void {
  const host = new PanelHost(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PanelHost.viewId,
      host,
      { webviewOptions: { retainContextWhenHidden: false } }
    ),
    vscode.commands.registerCommand('vivaMate.focusPanel', async () => {
      await vscode.commands.executeCommand('vivaMate.panel.focus');
    }),
    vscode.commands.registerCommand('vivaMate.analyze', async () => {
      await analyzeWorkspace(context, host);
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up yet.
}
