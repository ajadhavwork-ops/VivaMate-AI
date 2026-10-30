/**
 * Pure file-tree construction + filtering for the Project Explorer.
 * No DOM, no Node APIs — unit-testable in plain Node.
 */

import { classifyFile, type FileCategory } from './fileCategories';

/** Minimal file shape the Explorer needs (matches AnalysisSummary.allFiles). */
export interface ExplorerFile {
  relativePath: string;
  sizeBytes?: number;
}

export type NodeKind = 'folder' | 'file';

export interface TreeNode {
  kind: NodeKind;
  /** Folder name or file name ("src", "main.ts"). */
  name: string;
  /** Full relative path (POSIX style, no leading slash). */
  path: string;
  depth: number;
  /** Files only: actual size if the backend provided it. */
  sizeBytes?: number;
  /** Folders only. */
  children: TreeNode[];
  /** Folders only: number of matching files anywhere below this folder. */
  fileCount: number;
}

export interface TreeFilter {
  /** Substring match on file name OR full relative path, case-insensitive. */
  term?: string;
  /** Category filter ('all' ignores category). */
  category?: FileCategory;
}

export interface TreeBuildResult {
  roots: TreeNode[];
  /** Matching files shown. */
  shownFiles: number;
  /** Total files available (pre-filter). */
  totalFiles: number;
  /** True when a filter is active and it excluded everything. */
  isEmptyResult: boolean;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Stable comparison: folders before files, then case-insensitive by name. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/** Does one file match the current filter? */
export function matchesFilter(file: ExplorerFile, filter: TreeFilter): boolean {
  if (filter.term) {
    const t = filter.term.toLowerCase();
    const path = normalize(file.relativePath).toLowerCase();
    const name = path.split('/').pop() ?? path;
    if (!name.includes(t) && !path.includes(t)) return false;
  }
  if (filter.category && filter.category !== 'all') {
    if (classifyFile(file.relativePath) !== filter.category) return false;
  }
  return true;
}

/**
 * Builds a hierarchical tree from a flat, privacy-filtered file list.
 * Duplicate intermediate folders are merged automatically.
 */
export function buildTree(
  files: readonly ExplorerFile[],
  filter: TreeFilter = {}
): TreeBuildResult {
  const normalizable = files.filter((f) => typeof f.relativePath === 'string');
  const matching = normalizable.filter((f) => matchesFilter(f, filter));

  const root: TreeNode = {
    kind: 'folder', name: '', path: '', depth: -1, children: [], fileCount: matching.length,
  };

  for (const file of matching) {
    const segments = normalize(file.relativePath).split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let current = root;
    for (let depth = 0; depth < segments.length; depth++) {
      const isLeaf = depth === segments.length - 1;
      const name = segments[depth] as string;
      const path = segments.slice(0, depth + 1).join('/');

      if (isLeaf) {
        const fileNode: TreeNode = {
          kind: 'file', name, path, depth, sizeBytes: file.sizeBytes, children: [], fileCount: 0,
        };
        current.children.push(fileNode);
      } else {
        let folder = current.children.find(
          (c) => c.kind === 'folder' && c.name === name
        );
        if (!folder) {
          folder = { kind: 'folder', name, path, depth, children: [], fileCount: 0 };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  // Bubble per-folder file counts (files under nested folders).
  const fixCounts = (node: TreeNode): number => {
    if (node.kind === 'file') return 1;
    let count = 0;
    for (const child of node.children) count += fixCounts(child);
    node.fileCount = count;
    return count;
  };
  fixCounts(root);

  const sortRec = (node: TreeNode): void => {
    node.children.sort(compareNodes);
    for (const child of node.children) if (child.kind === 'folder') sortRec(child);
  };
  sortRec(root);

  return {
    roots: root.children,
    shownFiles: matching.length,
    totalFiles: normalizable.length,
    isEmptyResult: normalizable.length > 0 && matching.length === 0,
  };
}

/** Folder paths that contain at least the shown root-level content — used for initial expansion. */
export function defaultExpandedPaths(roots: readonly TreeNode[], maxDepth = 2): string[] {
  const out: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.kind !== 'folder' || node.depth < 0) return;
    if (node.depth < maxDepth) {
      out.push(node.path);
      for (const child of node.children) visit(child);
    }
  };
  for (const child of roots) visit(child);
  return out;
}

/** All folder paths that are ancestors of matching files (auto-expand on search/filter). */
export function expandableFolders(roots: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.kind !== 'folder') return;
    out.push(node.path);
    for (const child of node.children) visit(child);
  };
  for (const child of roots) visit(child);
  return out;
}
