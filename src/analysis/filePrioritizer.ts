/**
 * Decides WHICH files (and how much of each) are worth showing to an AI
 * provider or listing as "important" in the Overview, under a strict
 * character budget. Deterministic and dependency-free.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 */
import type { WalkedFile } from './fileWalker';
import type { DetectedManifest } from './manifestDetector';

export type ContentReason = 'readme' | 'manifest' | 'entry' | 'config' | 'source';

export interface ContentPlanItem {
  relativePath: string;
  reason: ContentReason;
  maxChars: number;
}

export interface ContentPlanOptions {
  /** Total character budget across all selected files. */
  totalMaxChars: number;
  /** Per-file cap expressed as a line count (chars ≈ lines × 100). */
  maxFileLines: number;
}

const CONFIG_PATTERNS: readonly RegExp[] = [
  /^tsconfig[^/]*\.json$/i, /^jsconfig\.json$/i, /^vite\.config\./i, /^webpack\.config\./i,
  /^rollup\.config\./i, /^babel\.config\./i, /^eslint\.config\./i, /^prettier\.config\./i,
  /^tailwind\.config\./i, /^next\.config\./i, /^vue\.config\./i, /^svelte\.config\./i,
  /^angular\.json$/i, /^nest-cli\.json$/i, /^astro\.config\./i,
  /^(?:\.?eslint|\.?prettier)rc/i, /^dockerfile$/i, /^docker-compose[^/]*\.ya?ml$/i,
  /^makefile$/i, /^pytest\.ini$/i, /^setup\.cfg$/i, /^alembic\.ini$/i,
];

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'rb',
  'php', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'scala', 'dart',
  'vue', 'svelte', 'html', 'css', 'scss', 'less', 'sql', 'sh', 'bat', 'ps1',
]);

const MAX_ITEMS = 40;

function depthOf(relativePath: string): number {
  return relativePath.split('/').length - 1;
}

function baseName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

export function isConfigFile(relativePath: string): boolean {
  return CONFIG_PATTERNS.some((re) => re.test(relativePath));
}

function looksLikeSource(relativePath: string): boolean {
  const base = baseName(relativePath).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(base.slice(dot + 1));
}

/**
 * Builds a prioritized content plan.
 *
 * Order of priority:
 *   1. README documents      — describe the project best
 *   2. manifests             — dependencies and tooling
 *   3. entry points          — where execution starts
 *   4. configuration files   — build/dev setup
 *   5. other source files    — shallow and small first
 *
 * Selection stops when the overall budget is exhausted.
 */
export function buildContentPlan(
  files: readonly WalkedFile[],
  manifests: readonly DetectedManifest[],
  entryPoints: readonly string[],
  options: ContentPlanOptions
): ContentPlanItem[] {
  const byPath = new Map(files.map((f) => [f.relativePath, f]));
  const taken = new Set<string>();
  const plan: ContentPlanItem[] = [];
  let budget = options.totalMaxChars;

  const consider = (relativePath: string, reason: ContentReason): void => {
    if (budget <= 0 || plan.length >= MAX_ITEMS) return;
    const file = byPath.get(relativePath);
    if (!file || taken.has(relativePath)) return;
    const maxChars = Math.max(1, Math.min(file.sizeBytes, options.maxFileLines * 100));
    // Strict fit: oversize items are skipped so that smaller, cheaper files
    // in later tiers still have a chance to use the remaining budget.
    if (maxChars > budget) return;
    plan.push({ relativePath, reason, maxChars });
    taken.add(relativePath);
    budget -= maxChars;
  };

  // The shallowest README describes the project best; nested READMEs are noise.
  const readmes = files
    .filter((f) => /^readme(?:\.[^/]*)?$/i.test(baseName(f.relativePath)))
    .sort((a, b) => depthOf(a.relativePath) - depthOf(b.relativePath))
    .slice(0, 1);
  readmes.forEach((f) => consider(f.relativePath, 'readme'));

  manifests.forEach((m) => consider(m.relativePath, 'manifest'));

  entryPoints.forEach((e) => consider(e, 'entry'));

  files
    .filter((f) => isConfigFile(f.relativePath))
    .slice(0, 8)
    .forEach((f) => consider(f.relativePath, 'config'));

  files
    .filter((f) => !taken.has(f.relativePath) && looksLikeSource(f.relativePath))
    .sort((a, b) => depthOf(a.relativePath) - depthOf(b.relativePath) || a.sizeBytes - b.sizeBytes)
    .slice(0, 30)
    .forEach((f) => consider(f.relativePath, 'source'));

  return plan;
}
