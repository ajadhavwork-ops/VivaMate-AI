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
  totalSizeBytes?: number;
  limitReached: boolean;
  /** Stable, cheap fingerprint that changes when the project tree changes. */
  fingerprint?: string;
  /**
   * Actual dependency names from the project's package.json (top N).
   * Optional — only present when a package.json was analyzable.
   */
  technologies?: string[];
  languages: Array<{ name: string; files: number; totalBytes: number }>;
  manifests: Array<{ ecosystem: string; relativePath: string }>;
  entryPoints: string[];
  keyFiles: string[];
  /**
   * Explorer data — the complete privacy-filtered file list. Optional so
   * summaries produced before P2.3 (and older cached profiles) stay valid.
   */
  allFiles?: Array<{ relativePath: string; sizeBytes: number }>;
  /** True when allFiles was capped (partial list). */
  allFilesTruncated?: boolean;
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
