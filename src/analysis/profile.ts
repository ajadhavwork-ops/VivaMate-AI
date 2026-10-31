/**
 * ProjectProfile — the deterministic "map" of the workspace.
 *
 * Building a profile never calls an AI provider and never reads file
 * *contents* (only names, sizes and a handful of small manifests), so it
 * is fast, private and cacheable.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 * Persistence lives in profileStore.ts.
 */
import * as crypto from 'crypto';
import type { WalkedFile } from './fileWalker';
import type { DetectedManifest, PackageJsonSummary } from './manifestDetector';
import type { ContentPlanItem } from './filePrioritizer';
import type { ContentReadResult } from './contentReader';
import type { FileSymbols, SymbolInfo } from './symbols';
import type { ImportsModel } from './importsScanner';
import type { ConfigInsight } from './configInsights';
import type { AnalysisSummary, ContentSummary, ScanStats } from '../ui/messages';

export interface LanguageStat {
  name: string;
  files: number;
  totalBytes: number;
}

/**
 * P3.2 content-layer results — structured insights ONLY.
 * Raw source content is never part of this type or the persisted profile.
 */
export interface ContentLayerData {
  /** Measured read metadata (statuses, counters, budget usage). */
  meta: ContentReadResult;
  /** Per-file symbols with an explicit `source` label. */
  symbols: FileSymbols[];
  /** De-duplicated import edges with resolution kinds. */
  imports: ImportsModel;
  /** Structural configuration insights (deny-by-default). */
  configs: ConfigInsight[];
}

export interface ProjectProfile {
  schemaVersion: 1;
  generatedAt: string;
  fingerprint: string;
  workspaceName: string;
  totalFiles: number;
  totalSizeBytes: number;
  /** True when the walk stopped early (cap on files or depth). */
  limitReached: boolean;
  /**
   * Measured scan counters. Optional so profiles saved before P3.1 stay
   * loadable; absent means "no detailed telemetry recorded".
   */
  scan?: ScanStats;
  /** Complete kept-file list for the Explorer (paths + sizes, privacy-filtered). */
  allFiles?: WalkedFile[];
  /**
   * P3.2 content-layer insights (optional so pre-P3.2 cached profiles stay
   * loadable — they simply degrade to "run an analysis" states).
   */
  content?: ContentLayerData;
  /**
   * Actual dependency names collected from the project's package.json
   * (optional — absent when no package.json exists or it was unreadable).
   */
  technologies?: string[];
  languages: LanguageStat[];
  manifests: DetectedManifest[];
  entryPoints: string[];
  /** Files the prioritizer selected for AI grounding (content read in Phase 2). */
  keyFiles: string[];
}

/** Collapses incidental extensions into clean display names. */
const EXT_ALIASES: Readonly<Record<string, string>> = {
  tsx: 'ts', mjs: 'js', cjs: 'js', jsx: 'js',
  h: 'c', hpp: 'cpp', cc: 'cpp',
  yml: 'yaml', md: 'markdown',
};

export function computeLanguageStats(files: readonly WalkedFile[]): LanguageStat[] {
  const map = new Map<string, LanguageStat>();
  for (const file of files) {
    const base = (file.relativePath.split('/').pop() ?? file.relativePath).toLowerCase();
    const dot = base.lastIndexOf('.');
    const raw = dot > 0 ? base.slice(dot + 1) : '(no extension)';
    const name = EXT_ALIASES[raw] ?? raw;
    const stat = map.get(name) ?? { name, files: 0, totalBytes: 0 };
    stat.files += 1;
    stat.totalBytes += file.sizeBytes;
    map.set(name, stat);
  }
  return [...map.values()].sort((a, b) => b.files - a.files || b.totalBytes - a.totalBytes);
}

/** Cheap, stable fingerprint that changes when the tree visibly changes. */
export function computeFingerprint(parts: {
  totalFiles: number;
  totalSizeBytes: number;
  manifestPaths: readonly string[];
}): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 16);
}

export interface BuildProfileArgs {
  workspaceName: string;
  files: readonly WalkedFile[];
  manifests: readonly DetectedManifest[];
  pkgSummary: PackageJsonSummary | null;
  entryPoints: readonly string[];
  plan: readonly ContentPlanItem[];
  limitReached: boolean;
  /** Measured walk counters. */
  scan: ScanStats;
  /** P3.2 content-layer results (optional — absent when reading was skipped). */
  content?: ContentLayerData;
}

export function buildProfile(args: BuildProfileArgs): ProjectProfile {
  const totalSizeBytes = args.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const profile: ProjectProfile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fingerprint: computeFingerprint({
      totalFiles: args.files.length,
      totalSizeBytes,
      manifestPaths: args.manifests.map((m) => m.relativePath),
    }),
    workspaceName: args.workspaceName,
    totalFiles: args.files.length,
    totalSizeBytes,
    limitReached: args.limitReached,
    languages: computeLanguageStats(args.files),
    manifests: [...args.manifests],
    entryPoints: [...args.entryPoints],
    keyFiles: args.plan.map((item) => item.relativePath),
    scan: { ...args.scan },
  };
  // Only REAL dependency names (from an analyzable package.json) surface
  // here — never inventions. Old cached profiles keep working (optional).
  const technologies = args.pkgSummary?.dependencies ?? [];
  if (technologies.length > 0) {
    profile.technologies = technologies.slice(0, 12);
  }
  // Explorer data: keep plain-path copies so the persisted profile does not
  // share array references with the walk result. The walker already caps
  // the list at its configured maxFiles, so no extra truncation is needed.
  if (args.files.length > 0) {
    profile.allFiles = args.files.map((f) => ({
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
    }));
  }
  // Content-layer data is copied verbatim (all structured, no raw content)
  // only when the content pass actually ran.
  if (args.content) {
    profile.content = args.content;
  }
  return profile;
}

/** Trimmed view sent to the webview (keeps the message payload small). */
export function toSummary(profile: ProjectProfile): AnalysisSummary {
  return {
    generatedAt: profile.generatedAt,
    workspaceName: profile.workspaceName,
    totalFiles: profile.totalFiles,
    totalSizeBytes: profile.totalSizeBytes,
    fingerprint: profile.fingerprint,
    technologies: profile.technologies,
    limitReached: profile.limitReached,
    languages: profile.languages.slice(0, 8).map((l) => ({
      name: l.name,
      files: l.files,
      totalBytes: l.totalBytes,
    })),
    manifests: profile.manifests,
    entryPoints: profile.entryPoints,
    keyFiles: profile.keyFiles.slice(0, 12),
    allFiles: profile.allFiles?.map((f) => ({ relativePath: f.relativePath, sizeBytes: f.sizeBytes })),
    scan: profile.scan,
    ...profileToContentSummary(profile),
  };
}

/** Builds the measured summary aggregate from the content layer (or omits it). */
function profileToContentSummary(profile: ProjectProfile): { content?: ContentSummary } {
  const layer = profile.content;
  if (!layer) return {};
  const symbolFilesProvider = layer.symbols.filter((s) => s.source === 'provider').length;
  const symbolFilesFallback = layer.symbols.filter((s) => s.source === 'fallback').length;
  const symbolFilesUnsupported = layer.symbols.filter((s) => s.source === 'unsupported').length;
  const totalSymbols = layer.symbols.reduce((sum, s) => {
    const countNested = (list: readonly SymbolInfo[]): number =>
      list.reduce((acc, sym) => acc + 1 + countNested(sym.children ?? []), 0);
    return sum + countNested(s.symbols);
  }, 0);
  return {
    content: {
      filesPlanned: layer.meta.files.length,
      filesRead: layer.meta.filesRead,
      filesUnreadable: layer.meta.filesUnreadable,
      filesExcluded: layer.meta.filesExcluded,
      filesSkippedBudget: layer.meta.filesSkippedBudget,
      filesSkippedCancellation: layer.meta.filesSkippedCancellation,
      truncatedFiles: layer.meta.truncatedFiles,
      budgetChars: layer.meta.budgetChars,
      totalCharsRead: layer.meta.totalCharsRead,
      symbolFilesProvider,
      symbolFilesFallback,
      symbolFilesUnsupported,
      totalSymbols,
      importFilesScanned: layer.imports.filesScanned,
      importEdgesLocal: layer.imports.counts.local,
      importEdgesPackage: layer.imports.counts.package,
      importEdgesUnresolved: layer.imports.counts.unresolved,
      importsTruncated: layer.imports.truncated,
      configFiles: layer.configs.length,
    },
  };
}
