/**
 * File-detail view-model (P3.3) — pure transformation of a FileInsightsPayload
 * into the exact rows/labels/notices the Explorer detail panel renders.
 *
 * No DOM, no vscode import — unit-testable in plain Node. Honesty rules:
 * - import grouping follows the payload's own resolution kinds; nothing is
 *   re-classified or "fixed" here;
 * - unknown/missing insight states become explicit notice lines, never
 *   fabricated example data;
 * - truncation and redaction flags are surfaced, never hidden.
 */
import type { FileInsightsPayload } from '../../src/ui/messages';
import type { ImportKind } from '../../src/analysis/importsScanner';
import type { SymbolSource } from '../../src/analysis/symbols';

// ---------------------------------------------------------------------------
// Import grouping
// ---------------------------------------------------------------------------

export interface ImportsGroupRow {
  spec: string;
  /** Resolved project-local target (kind 'local' only). */
  to?: string;
}

export interface ImportsGroup {
  id: ImportKind;
  /**Human-facing group label (honest wording included). */
  label: string;
  rows: ImportsGroupRow[];
}

/** Presentation order: most useful first; unresolved keeps its honesty last. */
const IMPORT_GROUP_ORDER: ReadonlyArray<{ id: ImportKind; label: string }> = [
  { id: 'local', label: 'Resolved internal imports' },
  { id: 'package', label: 'External packages' },
  { id: 'builtin', label: 'Standard library / built-ins' },
  { id: 'dynamic', label: 'Dynamic imports' },
  { id: 'namespace', label: 'Namespace directives (.NET using)' },
  { id: 'alias', label: 'Path aliases (not resolved)' },
  { id: 'unresolved', label: 'Unresolved (target not found)' },
];

/** Groups outgoing import rows by their kind, in presentation order. */
export function groupImports(
  entries: ReadonlyArray<{ kind: ImportKind; spec: string; to?: string }>
): ImportsGroup[] {
  const buckets = new Map<ImportKind, ImportsGroupRow[]>();
  for (const entry of entries) {
    const list = buckets.get(entry.kind) ?? [];
    list.push(entry.to !== undefined ? { spec: entry.spec, to: entry.to } : { spec: entry.spec });
    buckets.set(entry.kind, list);
  }
  // An unresolvable relative spec may carry a `to` absent — rows built above
  // handle that; unknown kinds (future-proofing) get an honest fallback group.
  const out: ImportsGroup[] = [];
  for (const g of IMPORT_GROUP_ORDER) {
    const rows = buckets.get(g.id);
    if (rows && rows.length > 0) {
      out.push({ id: g.id, label: g.label, rows });
      buckets.delete(g.id);
    }
  }
  for (const [id, rows] of buckets) {
    out.push({ id, label: 'Other imports', rows });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Symbol flattening (depth from nesting)
// ---------------------------------------------------------------------------

export interface SymbolRow {
  name: string;
  kind: string;
  /** 1-based line when known; provider trees always supply it. */
  line?: number;
  container?: string;
  /** Nesting depth (0 = top level). */
  depth: number;
}

/**
 * Flattens a (possibly nested) symbol tree to depth-annotated rows.
 * Returns the SHOWN rows plus the total count seen, so truncation can be
 * reported honestly even when the payload's flag was already set upstream.
 */
export function flattenSymbolTree(
  entries: ReadonlyArray<{
    name: string;
    kind: string;
    line?: number;
    container?: string;
    children?: ReadonlyArray<unknown>;
  }>,
  maxRows = 60
): { rows: SymbolRow[]; seen: number; truncated: boolean } {
  const rows: SymbolRow[] = [];
  let seen = 0;
  let truncated = false;

  const walk = (list: ReadonlyArray<SymbolNodeInput>, depth: number): void => {
    for (const entry of list) {
      seen += 1;
      if (rows.length < maxRows) {
        rows.push({
          name: entry.name,
          kind: entry.kind,
          ...(entry.line !== undefined ? { line: entry.line } : {}),
          ...(entry.container !== undefined ? { container: entry.container } : {}),
          depth,
        });
      } else {
        truncated = true; // keep counting; display is capped
      }
      if (entry.children && entry.children.length > 0) {
        walk(entry.children as ReadonlyArray<SymbolNodeInput>, depth + 1);
      }
    }
  };
  walk(entries as ReadonlyArray<SymbolNodeInput>, 0);
  return { rows, seen, truncated };
}

interface SymbolNodeInput {
  name: string;
  kind: string;
  line?: number;
  container?: string;
  children?: SymbolNodeInput[];
}

/** Clear, student-friendly source labels — never leaves the origin implicit. */
export function symbolSourceLabel(source: SymbolSource | undefined): string | undefined {
  switch (source) {
    case 'provider':
      return 'VS Code language service';
    case 'fallback':
      return 'Pattern fallback (heuristic)';
    case 'unsupported':
      return 'Unsupported language';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Detail model + honest notices
// ---------------------------------------------------------------------------

export interface DetailNotice {
  severity: 'info' | 'warning';
  text: string;
}

export interface ConfigRow {
  path: string;
  type: string;
  redacted?: boolean;
  safeValue?: string;
}

export interface DetailModel {
  path: string;
  notices: DetailNotice[];
  readMeta?: { status: string; linesRead: number; charsRead: number };
  symbolSource?: SymbolSource;
  symbolSourceLabel?: string;
  symbolRows: SymbolRow[];
  symbolCountShown: number;
  symbolsTruncated?: boolean;
  importGroups: ImportsGroup[];
  /** Files whose resolved imports point AT this file. */
  incoming: string[];
  importsTruncated?: boolean;
  config?: {
    format: string;
    entries: ConfigRow[];
    truncated?: boolean;
    malformed?: boolean;
  };
}

export function buildDetailModel(payload: FileInsightsPayload): DetailModel {
  const notices: DetailNotice[] = [];

  // Why-am-I-empty banners — every absence explained, nothing guessed.
  if (!payload.hasContentLayer) {
    notices.push({
      severity: 'warning',
      text: 'This analysis was made before VivaMate collected code insights — run the analysis again to see symbols, imports and configuration details.',
    });
  }
  if (!payload.onRecord) {
    notices.push({
      severity: 'warning',
      text: 'Not in the analyzed file record — the file is new, moved, or excluded by privacy rules. Run the analysis again to include it.',
    });
  } else if (payload.hasContentLayer && !payload.selectedForAnalysis) {
    notices.push({
      severity: 'info',
      text: 'Part of the project, but not selected for deep reading under the analysis budget — no code insights were collected for this file.',
    });
  }

  // Symbols.
  let symbolSource = payload.symbols?.source;
  let symbolRows: SymbolRow[] = [];
  let symbolsTruncated = payload.symbols?.truncated ?? false;
  if (payload.symbols) {
    const flat = flattenSymbolTree(payload.symbols.entries);
    symbolRows = flat.rows;
    symbolsTruncated = symbolsTruncated || flat.truncated;
  } else if (payload.onRecord && payload.hasContentLayer && payload.selectedForAnalysis) {
    notices.push({
      severity: 'info',
      text: 'No symbols recorded for this file — it may not have been readable, or its language produced none.',
    });
  }
  if (symbolsTruncated) {
    notices.push({
      severity: 'info',
      text: 'Symbol list was truncated — some symbols may be missing.',
    });
  }
  if (symbolSource === 'unsupported') {
    notices.push({
      severity: 'info',
      text: 'This file type is not supported for symbol extraction — no symbols were collected rather than guessed.',
    });
  }

  // Imports.
  let importGroups: ImportsGroup[] = [];
  let importsTruncated = payload.importsTruncated ?? false;
  if (payload.imports) {
    importGroups = groupImports(payload.imports.entries);
    if (importsTruncated) {
      notices.push({
        severity: 'info',
        text: 'The import scan hit its limits — some imports may be missing.',
      });
    }
  } else if (payload.onRecord && payload.hasContentLayer && payload.selectedForAnalysis) {
    notices.push({
      severity: 'info',
      text: 'No import data recorded for this file.',
    });
  }

  // Configuration.
  let config: DetailModel['config'] | undefined;
  if (payload.config) {
    const entries = payload.config.entries.map((e) => ({
      path: e.path,
      type: e.type,
      ...(e.redacted ? { redacted: true } : {}),
      ...(e.safeValue !== undefined ? { safeValue: e.safeValue } : {}),
    }));
    config = {
      format: payload.config.format,
      entries,
      ...(payload.config.truncated ? { truncated: true } : {}),
      ...(payload.config.malformed ? { malformed: true } : {}),
    };
    if (payload.config.malformed) {
      notices.push({
        severity: 'warning',
        text: 'The configuration file could not be parsed — structure was not extracted.',
      });
    }
    if (payload.config.truncated) {
      notices.push({
        severity: 'info',
        text: 'Configuration entries were truncated — some keys may be missing.',
      });
    }
  }

  return {
    path: payload.relativePath,
    notices,
    ...(payload.readMeta
      ? {
          readMeta: {
            status: payload.readMeta.status,
            linesRead: payload.readMeta.linesRead,
            charsRead: payload.readMeta.charsRead,
          },
        }
      : {}),
    ...(symbolSource !== undefined ? { symbolSource } : {}),
    ...(payload.symbols ? { symbolSourceLabel: symbolSourceLabel(symbolSource) } : {}),
    symbolRows,
    symbolCountShown: symbolRows.length,
    ...(symbolsTruncated ? { symbolsTruncated: true } : {}),
    importGroups,
    incoming: payload.imports?.incoming ?? [],
    ...(importsTruncated ? { importsTruncated: true } : {}),
    ...(config ? { config } : {}),
  };
}
