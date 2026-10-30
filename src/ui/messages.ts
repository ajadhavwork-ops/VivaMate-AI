/**
 * Message contract between the extension host and the webview panel.
 * Single source of truth: both sides import from here (`webview-ui/main.ts`
 * uses a type-only import, which is erased at bundle time).
 *
 * The webview never touches files or the network — every interaction goes
 * through these JSON messages.
 */

export interface AnalysisSummary {
  generatedAt: string;
  workspaceName: string;
  totalFiles: number;
  limitReached: boolean;
  languages: Array<{ name: string; files: number; totalBytes: number }>;
  manifests: Array<{ ecosystem: string; relativePath: string }>;
  entryPoints: string[];
  keyFiles: string[];
}

export interface AnalysisError {
  message: string;
}

export type HostToWebviewMessage =
  | { type: 'hello'; payload?: { version: string } }
  | { type: 'analysisStarted' }
  | { type: 'analysis'; payload: AnalysisSummary }
  | { type: 'error'; payload: AnalysisError };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'analyzeRequested' }
  | { type: 'webviewLoaded' }
  | { type: 'openFile'; payload: { path: string } };
