/**
 * Content reader (P3.2) — reads ONLY files that were already discovered,
 * kept and selected by the existing analysis pipeline.
 *
 * Guarantees:
 * - Every planned file is re-checked against the privacy ignore rules; an
 *   excluded path is never read even if a plan item was somehow corrupted.
 * - Reading respects `vivaMate.analysisBudgetKb` (total chars) and
 *   `vivaMate.maxFileLines` (per-file lines). Both lines AND characters are
 *   capped per file, so pathological one-line minified files can never blow
 *   the plan's char math, and the total budget can never be exceeded.
 * - Raw file CONTENT never leaves this module except through the
 *   `onFile` callback — it is never returned in the result and never
 *   persisted into the profile. Consumers (symbols/imports/configs) extract
 *   structure in memory immediately.
 * - Cancellation: a lightweight `SignalLike` (compatible with
 *   `vscode.CancellationToken`) is checked between files; cancelled runs stop
 *   cleanly and honestly report themselves.
 * - Unreadable/deleted files record a status; nothing throws, nothing logs.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ContentPlanItem } from './filePrioritizer';
import type { WalkedFile } from './fileWalker';
import { fileIgnoreReason, type IgnoreRuleSet } from './ignoreRules';

/** Minimal cancellation contract (structurally satisfied by vscode.CancellationToken). */
export interface SignalLike {
  readonly isCancellationRequested: boolean;
}

export type FileReadStatus =
  | 'ok'
  | 'truncated'
  | 'unreadable'
  | 'excluded'
  | 'budgetExhausted';

/** Per-file metadata — measured and honest, never contains source content. */
export interface FileContentMeta {
  relativePath: string;
  status: FileReadStatus;
  /** Characters actually retained (after caps) — 0 unless content was used. */
  charsRead: number;
  /** Lines actually retained (after the maxFileLines cap). */
  linesRead: number;
  /** True when the per-file line limit cut the file. */
  truncatedByLines: boolean;
  /** True when the per-file char cap (plan.maxChars) cut the content. */
  truncatedByChars: boolean;
}

export interface ContentReadResult {
  files: FileContentMeta[];
  /** Files whose content was actually read (ok + truncated). */
  filesRead: number;
  filesUnreadable: number;
  /** Files refused because the privacy rules rematch flagged them. */
  filesExcluded: number;
  /** Files the selection plan contained but the budget could not cover. */
  filesSkippedBudget: number;
  /** Files after which the run observed a cancellation signal and stopped. */
  filesSkippedCancellation: number;
  /** Files with truncation (by lines or chars). */
  truncatedFiles: number;
  /** Measured: sum of charsRead across all read files. */
  totalCharsRead: number;
  /** The configured total budget (chars) — reported for comparison. */
  budgetChars: number;
  /** True when the signal stopped the run before the plan finished. */
  cancelled: boolean;
}

export interface ReadPlannedContentArgs {
  /** Absolute workspace root (same root handed to the walker). */
  root: string;
  /** The selection plan from buildContentPlan (possibly extended). */
  plan: readonly ContentPlanItem[];
  /** The kept file list from the walk — used to re-verify plan integrity. */
  files: readonly WalkedFile[];
  /** Privacy rules — re-checked on EVERY planned file before reading. */
  rules: IgnoreRuleSet;
  /** Per-file line limit (vivaMate.maxFileLines, already validated). */
  maxFileLines: number;
  /** Configured total char budget (budgetKb × 1024) — reported as budgetChars. */
  totalMaxChars?: number;
  /** Optional cancellation signal checked between files. */
  signal?: SignalLike;
}

/**
 * Called for each file whose content was successfully read. Receives the
 * RETAINED content (after caps). This is the ONLY way content leaves this
 * module; the result object itself never carries content.
 */
export type OnFileContent = (relativePath: string, content: string) => void;

/**
 * Reads the content plan under the configured budget.
 *
 * Order of operations per file:
 *   1. cancellation check (stop cleanly)
 *   2. privacy re-check  (excluded → status, never read)
 *   3. budget guard      (exhausted → status, never read)
 *   4. read + line/char caps + measured metadata
 */
export function readPlannedContent(
  args: ReadPlannedContentArgs,
  onFile?: OnFileContent
): ContentReadResult {
  const count: Omit<ContentReadResult, 'files'> = {
    filesRead: 0,
    filesUnreadable: 0,
    filesExcluded: 0,
    filesSkippedBudget: 0,
    filesSkippedCancellation: 0,
    truncatedFiles: 0,
    totalCharsRead: 0,
    budgetChars: 0,
    cancelled: false,
  };
  const metas: FileContentMeta[] = [];

  // Remaining chunk of the budget. The plan freezes per-file maxChars; the
  // CONFIGURED total is the hard ceiling (guards against a corrupted plan
  // whose assignments sum above the user's budget — it still can't exceed).
  const planAssigned = args.plan.reduce((sum, item) => sum + item.maxChars, 0);
  let remaining = planAssigned;
  if (args.totalMaxChars !== undefined) {
    remaining = Math.min(remaining, args.totalMaxChars);
  }
  count.budgetChars =
    args.totalMaxChars !== undefined ? args.totalMaxChars : planAssigned;

  const sizeByPath = new Map(args.files.map((f) => [f.relativePath, f.sizeBytes] as const));

  for (const item of args.plan) {
    if (args.signal?.isCancellationRequested) {
      count.cancelled = true;
      // Remaining plan items are honestly reported as skipped.
      const remainingItems = args.plan.length - metas.length;
      count.filesSkippedCancellation = Math.max(0, remainingItems);
      break;
    }

    const meta: FileContentMeta = {
      relativePath: item.relativePath,
      status: 'ok',
      charsRead: 0,
      linesRead: 0,
      truncatedByLines: false,
      truncatedByChars: false,
    };

    // 2. Privacy re-check — defense in depth: the plan is built from kept
    // files, but the rules are re-applied here so an excluded path can
    // never be read regardless of what produced the plan.
    const size = sizeByPath.get(item.relativePath);
    if (size === undefined || fileIgnoreReason(args.rules, item.relativePath, size) !== 'kept') {
      meta.status = 'excluded';
      count.filesExcluded += 1;
      metas.push(meta);
      continue;
    }

    // 3. Budget guard (measured budget can never be exceeded).
    if (item.maxChars > remaining) {
      meta.status = 'budgetExhausted';
      count.filesSkippedBudget += 1;
      metas.push(meta);
      continue;
    }

    // 4. Read + caps.
    const abs = path.join(args.root, ...item.relativePath.split('/'));
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      // unreadable, deleted, permission-denied, or vanished mid-analysis
      meta.status = 'unreadable';
      count.filesUnreadable += 1;
      metas.push(meta);
      continue;
    }

    let retained = raw;
    if (item.maxChars < retained.length) {
      retained = retained.slice(0, item.maxChars);
      meta.truncatedByChars = true;
    }
    if (args.maxFileLines < retained.length) {
      const lines = retained.split('\n');
      if (lines.length > args.maxFileLines) {
        retained = lines.slice(0, args.maxFileLines).join('\n');
        meta.truncatedByLines = true;
      }
    }

    meta.charsRead = retained.length;
    meta.linesRead = retained.length === 0 ? 0 : retained.split('\n').length;
    if (meta.truncatedByChars || meta.truncatedByLines) {
      meta.status = 'truncated';
      count.truncatedFiles += 1;
    }

    count.filesRead += 1;
    count.totalCharsRead += meta.charsRead;
    remaining -= meta.charsRead;
    if (onFile) onFile(item.relativePath, retained);
    metas.push(meta);
  }

  return { files: metas, ...count };
}
