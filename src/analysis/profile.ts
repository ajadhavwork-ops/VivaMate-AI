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
import type { AnalysisSummary } from '../ui/messages';

export interface LanguageStat {
  name: string;
  files: number;
  totalBytes: number;
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
}

export function buildProfile(args: BuildProfileArgs): ProjectProfile {
  const totalSizeBytes = args.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  return {
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
  };
}

/** Trimmed view sent to the webview (keeps the message payload small). */
export function toSummary(profile: ProjectProfile): AnalysisSummary {
  return {
    generatedAt: profile.generatedAt,
    workspaceName: profile.workspaceName,
    totalFiles: profile.totalFiles,
    limitReached: profile.limitReached,
    languages: profile.languages.slice(0, 8).map((l) => ({
      name: l.name,
      files: l.files,
      totalBytes: l.totalBytes,
    })),
    manifests: profile.manifests,
    entryPoints: profile.entryPoints,
    keyFiles: profile.keyFiles.slice(0, 12),
  };
}
