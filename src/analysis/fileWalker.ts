/**
 * Limited, ignore-aware directory walk.
 * Pure Node (`fs/promises`) — unit-testable without VS Code.
 *
 * Designed to be cheap: no content is read here, only names and sizes.
 * Every counter refers to entries that were actually observed — entries
 * behind an un-entered directory are unknown and never claimed as skips.
 */
import { promises as fs, Dirent } from 'fs';
import * as path from 'path';
import { fileIgnoreReason, isDirectoryIgnored, type IgnoreRuleSet } from './ignoreRules';
import type { ScanStats } from '../ui/messages';

export interface WalkedFile {
  /** POSIX-style path relative to the workspace root (e.g. `src/app/main.ts`). */
  relativePath: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** True when ANY discovery limit stopped the walk early (cap or depth). */
  limitReached: boolean;
  /** True specifically when the kept-file cap stopped the walk. */
  fileCapReached: boolean;
  /** True specifically when the depth cap prevented entering a directory. */
  depthLimitReached: boolean;
  /** Measured counters (see ScanStats for exact semantics). */
  stats: ScanStats;
}

export interface WalkOptions {
  /** Stop after this many kept files (default 5000). */
  maxFiles?: number;
  /** Maximum directory depth below the root (default 12). */
  maxDepth?: number;
}

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_DEPTH = 12;

export async function walkWorkspace(
  root: string,
  rules: IgnoreRuleSet,
  options: WalkOptions = {}
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const files: WalkedFile[] = [];
  const counts = {
    keptFiles: 0,
    ignoredDirs: 0,
    ignoredFiles: 0,
    skippedBySize: 0,
    skippedByDepthDirs: 0,
    unreadableDirs: 0,
    unreadableFiles: 0,
    fileCapReached: false,
    depthLimitReached: false,
  } as ScanStats;

  const walk = async (absDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      counts.depthLimitReached = true;
      counts.skippedByDepthDirs += 1;
      // The directory itself is skipped; its contents were never
      // discovered, so no entry inside it is counted anywhere.
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      counts.unreadableDirs += 1;
      return; // unreadable or vanished folder — counted, then skipped
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        counts.fileCapReached = true;
        return; // remaining entries stay undiscovered — not counted as skips
      }
      if (entry.isSymbolicLink()) continue; // never follow links out of the workspace

      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (isDirectoryIgnored(rules, rel)) {
          counts.ignoredDirs += 1;
          continue;
        }
        await walk(path.join(absDir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fs.stat(path.join(absDir, entry.name))).size;
        } catch {
          counts.unreadableFiles += 1;
          continue; // vanished between readdir and stat
        }
        switch (fileIgnoreReason(rules, rel, size)) {
          case 'kept':
            files.push({ relativePath: rel, sizeBytes: size });
            break;
          case 'ignoredName':
            counts.ignoredFiles += 1;
            break;
          case 'skippedSize':
            counts.skippedBySize += 1;
            break;
          case 'ignoredDir':
            // Defensive: reachable only for odd rule configurations.
            counts.ignoredFiles += 1;
            break;
        }
      }
    }
  };

  await walk(root, '', 0);

  const stats: ScanStats = {
    keptFiles: files.length,
    ignoredDirs: counts.ignoredDirs,
    ignoredFiles: counts.ignoredFiles,
    skippedBySize: counts.skippedBySize,
    skippedByDepthDirs: counts.skippedByDepthDirs,
    unreadableDirs: counts.unreadableDirs,
    unreadableFiles: counts.unreadableFiles,
    fileCapReached: counts.fileCapReached,
    depthLimitReached: counts.depthLimitReached,
  };

  return {
    files,
    limitReached: stats.fileCapReached || stats.depthLimitReached,
    fileCapReached: stats.fileCapReached,
    depthLimitReached: stats.depthLimitReached,
    stats,
  };
}
