/**
 * Limited, ignore-aware directory walk.
 * Pure Node (`fs/promises`) — unit-testable without VS Code.
 *
 * Designed to be cheap: no content is read here, only names and sizes.
 */
import { promises as fs, Dirent } from 'fs';
import * as path from 'path';
import { isDirectoryIgnored, isFileIgnored, type IgnoreRuleSet } from './ignoreRules';

export interface WalkedFile {
  /** POSIX-style path relative to the workspace root (e.g. `src/app/main.ts`). */
  relativePath: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** True when the file-count cap stopped the walk early. */
  limitReached: boolean;
}

export interface WalkOptions {
  /** Stop after this many kept files (default 5000). */
  maxFiles?: number;
  /** Maximum directory depth below the root (default 12). */
  maxDepth?: number;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 12;

export async function walkWorkspace(
  root: string,
  rules: IgnoreRuleSet,
  options: WalkOptions = {}
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const files: WalkedFile[] = [];
  let limitReached = false;

  const walk = async (absDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      limitReached = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable or vanished folder — skip silently
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        limitReached = true;
        return;
      }
      if (entry.isSymbolicLink()) continue; // never follow links out of the workspace

      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (isDirectoryIgnored(rules, rel)) continue;
        await walk(path.join(absDir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fs.stat(path.join(absDir, entry.name))).size;
        } catch {
          continue; // vanished between readdir and stat
        }
        if (isFileIgnored(rules, rel, size)) continue;
        files.push({ relativePath: rel, sizeBytes: size });
      }
    }
  };

  await walk(root, '', 0);
  return { files, limitReached };
}
