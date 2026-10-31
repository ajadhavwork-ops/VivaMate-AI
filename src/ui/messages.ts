/**
 * Message contract between the extension host and the webview panel.
 * Single source of truth: both sides import from here (`webview-ui/main.ts`
 * uses a type-only import, which is erased at bundle time).
 *
 * The webview never touches files or the network — every interaction goes
 * through these JSON messages.
 */

import type { ImportKind } from '../analysis/importsScanner';
import type { SymbolInfo, SymbolSource } from '../analysis/symbols';
import type { ConfigInsight } from '../analysis/configInsights';
import type { FileContentMeta } from '../analysis/contentReader';

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
  /** Measured scan counters. Optional — absent in older cached profiles. */
  scan?: ScanStats;
  /** Measured P3.2 content-layer aggregate. Optional — absent before P3.2. */
  content?: ContentSummary;
}

/** Measurable scan counters — every number is actually observed by the walker. */
export interface ScanStats {
  /** Files kept after privacy filtering (equals totalFiles). */
  keptFiles: number;
  /** Directory entries pruned because their name matched ignore rules. */
  ignoredDirs: number;
  /** Discovered files excluded by ignore rules (names, secrets, binaries). */
  ignoredFiles: number;
  /** Discovered files excluded because they exceed the size cap. */
  skippedBySize: number;
  /** Directories NOT explored because they are deeper than the depth cap. Their contents were never discovered, so no file count can exist for them. */
  skippedByDepthDirs: number;
  /** Directories that could not be read (permissions/IO errors). */
  unreadableDirs: number;
  /** Files which vanished or could not be stat'ed between listing and measuring. */
  unreadableFiles: number;
  /** Traversal stopped because the kept-file cap was reached. */
  fileCapReached: boolean;
  /** The walk refused to enter at least one directory due to depth. */
  depthLimitReached: boolean;
}

export interface AnalysisError {
  message: string;
}

/**
 * Measured aggregate of the P3.2 content-layer pass. Counts only — no file
 * content, no symbol lists (they live in the persisted profile only).
 * Optional so summaries produced before P3.2 stay valid.
 */
export interface ContentSummary {
  /** Selection plan size actually passed to the reader. */
  filesPlanned: number;
  filesRead: number;
  filesUnreadable: number;
  filesExcluded: number;
  filesSkippedBudget: number;
  filesSkippedCancellation: number;
  truncatedFiles: number;
  budgetChars: number;
  totalCharsRead: number;
  /** Symbol extraction outcome per source kind. */
  symbolFilesProvider: number;
  symbolFilesFallback: number;
  symbolFilesUnsupported: number;
  totalSymbols: number;
  /** Import scan outcome. */
  importFilesScanned: number;
  importEdgesLocal: number;
  importEdgesPackage: number;
  importEdgesUnresolved: number;
  importsTruncated: boolean;
  /** Config insight outcome. */
  configFiles: number;
}

export type HostToWebviewMessage =
  | { type: 'hello'; payload?: { version: string } }
  | { type: 'analysisStarted' }
  | { type: 'analysis'; payload: AnalysisSummary }
  | { type: 'fileInsights'; payload: FileInsightsPayload }
  | { type: 'error'; payload: AnalysisError };

/**
 * Per-file insight slice, built by the host from the persisted profile when
 * the user selects a file in the Explorer. Every questionable case is an
 * explicit flag — the UI never has to guess.
 */
export interface FileInsightsPayload {
  relativePath: string;
  /** False for profiles produced before P3.2 — UI shows "re-run analysis". */
  hasContentLayer: boolean;
  /** False when the path is not in the profile's kept-file list at all. */
  onRecord: boolean;
  /** True when the content pass actually planned/read this file. */
  selectedForAnalysis: boolean;
  /** Measured read metadata (present when the file went through the reader). */
  readMeta?: FileContentMeta;
  /** Symbol extraction result — absent when the file was never analyzed. */
  symbols?: {
    source: SymbolSource;
    truncated?: boolean;
    entries: SymbolInfo[];
  };
  /** Outgoing import edges for this file — absent without a content layer. */
  imports?: {
    entries: Array<{ kind: ImportKind; spec: string; to?: string }>;
    /** Files whose resolved imports point AT this file. */
    incoming: string[];
  };
  /** True when the ORIGINAL import scan hit its caps (edges may be missing). */
  importsTruncated?: boolean;
  /** Structural configuration insights — absent when not a config file. */
  config?: ConfigInsight;
}

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'analyzeRequested' }
  | { type: 'webviewLoaded' }
  | { type: 'openFile'; payload: { path: string } }
  | { type: 'fileInsightsRequested'; payload: { path: string } };
