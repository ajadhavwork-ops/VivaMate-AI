/**
 * Scan-limit settings resolution — pure, unit-testable, no vscode import.
 *
 * Values come from user-editable settings, so they are validated defensively:
 * non-numeric or non-finite values fall back to the default; numbers are
 * clamped into allowed bounds. Unlimited scans are not possible.
 */

export interface LimitBounds {
  min: number;
  max: number;
  default: number;
}

export const LIMIT_BOUNDS: Readonly<{
  maxFiles: LimitBounds;
  maxDepth: LimitBounds;
}> = {
  maxFiles: { min: 100, max: 20000, default: 5000 },
  maxDepth: { min: 1, max: 32, default: 12 },
};

/** Clamps one raw setting value; anything non-numeric (incl. NaN) falls back. */
export function clampLimit(value: unknown, bounds: LimitBounds): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
  }
  return bounds.default;
}

export interface ResolvedScanLimits {
  maxFiles: number;
  maxDepth: number;
}

export type RawScanSettings = {
  maxFiles?: unknown;
  maxDepth?: unknown;
};

/** Resolves both scan-limit settings with defaults + bounds. */
export function resolveScanLimits(raw: RawScanSettings = {}): ResolvedScanLimits {
  return {
    maxFiles: clampLimit(raw.maxFiles, LIMIT_BOUNDS.maxFiles),
    maxDepth: clampLimit(raw.maxDepth, LIMIT_BOUNDS.maxDepth),
  };
}

// --- Content-layer limits (P3.2) -------------------------------------------------
// The bounds mirror the values declared in package.json so a hand-edited
// settings file can never push analysis outside documented ranges.
export const CONTENT_BOUNDS: Readonly<{
  budgetKb: LimitBounds;
  maxFileLines: LimitBounds;
}> = {
  budgetKb: { min: 8, max: 512, default: 64 },
  maxFileLines: { min: 20, max: 2000, default: 150 },
};

export interface ResolvedContentLimits {
  /** Total character budget for content reading (budgetKb × 1024). */
  totalMaxChars: number;
  /** Per-file line limit during content reading. */
  maxFileLines: number;
}

export type RawContentSettings = {
  analysisBudgetKb?: unknown;
  maxFileLines?: unknown;
};

/** Resolves the content-reading settings with defaults + bounds. */
export function resolveContentLimits(raw: RawContentSettings = {}): ResolvedContentLimits {
  const budgetKb = clampLimit(raw.analysisBudgetKb, CONTENT_BOUNDS.budgetKb);
  return {
    totalMaxChars: budgetKb * 1024,
    maxFileLines: clampLimit(raw.maxFileLines, CONTENT_BOUNDS.maxFileLines),
  };
}
