import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HostToWebviewMessage, WebviewToHostMessage } from './messages';
import { loadProfile } from '../analysis/profileStore';
import { buildFileInsights } from '../analysis/fileInsightsQuery';
import { toSummary } from '../analysis/profile';

/**
 * Hosts the single VivaMate sidebar panel (a WebviewView).
 *
 * Responsibilities:
 * - Build safe HTML (strict CSP, nonce, no inline scripts).
 * - Route messages between webview and extension host.
 * - Expose `postMessage` so commands/engines can push state into the UI.
 */
export class PanelHost implements vscode.WebviewViewProvider {
  static readonly viewId = 'vivaMate.panel';

  private view?: vscode.WebviewView;
  private html?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };

    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage(
      (message: WebviewToHostMessage) => void this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );

    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Push a message from the extension host into the webview (fire-and-forget). */
  async postMessage(message: HostToWebviewMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'webviewLoaded':
        await this.postMessage({ type: 'hello', payload: { version: '0.0.1' } });
        await this.sendCachedProfile();
        return;
      case 'analyzeRequested':
        // Reuse the same command so button and palette behave identically.
        await vscode.commands.executeCommand('vivaMate.analyze');
        return;
      case 'openFile':
        await this.openWorkspaceFile(message.payload.path);
        return;
      case 'fileInsightsRequested':
        await this.sendFileInsights(message.payload.path);
        return;
      case 'ready':
        // Reserved for future use.
        return;
    }
  }

  /**
   * Builds the per-file insight slice from the persisted profile and pushes
   * it to the webview. ALWAYS answers — legacy/off-record/legal-absent cases
   * produce an honest empty payload (explicit flags) instead of silence, so
   * the UI never waits for a reply that never comes.
   */
  private async sendFileInsights(relativePath: string): Promise<void> {
    const profile = await loadProfile(this.context);
    if (profile !== undefined && profile.schemaVersion !== 1) {
      // Unknown future schema: answer with the same honest empty payload.
      await this.postMessage({
        type: 'fileInsights',
        payload: { relativePath, hasContentLayer: false, onRecord: false, selectedForAnalysis: false },
      });
      return;
    }
    await this.postMessage({
      type: 'fileInsights',
      payload: buildFileInsights(profile, relativePath),
    });
  }

  private async sendCachedProfile(): Promise<void> {
    const profile = await loadProfile(this.context);
    if (profile && profile.schemaVersion === 1) {
      await this.postMessage({ type: 'analysis', payload: toSummary(profile) });
    }
  }

  private async openWorkspaceFile(relativePath: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !relativePath) return;
    try {
      const uri = vscode.Uri.joinPath(folder.uri, relativePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      // Binary or missing file — silently ignore; VS Code may not preview it.
    }
  }

  private getHtml(webview: vscode.Webview): string {
    if (!this.html) {
      const file = path.join(this.context.extensionUri.fsPath, 'dist', 'webview', 'index.html');
      this.html = fs.readFileSync(file, 'utf8');
    }

    // Nonce (number-used-once) for the strict CSP.
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'styles.css')
    );

    return this.html
      .replace(/%NONCE%/g, nonce)
      .replace(/%SCRIPT%/g, scriptUri.toString())
      .replace(/%STYLE%/g, styleUri.toString())
      .replace(/%CSP_SOURCE%/g, webview.cspSource);
  }
}
