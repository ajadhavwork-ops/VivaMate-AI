/**
 * Honest scan-status messaging — pure, shared by Overview and Explorer.
 *
 * Rules:
 * - ONLY measured counters are shown; anything unavailable is simply absent.
 * - Content-analysis coverage is NOT claimed here: source-file content
 *   reading does not exist yet, so analysisBudgetKb / maxFileLines are never
 *   mentioned as scan-limit remedies.
 * - Old cached profiles lack `scan`; for those only the legacy
 *   `limitReached` boolean can be reported, with an honest note about it.
 */
import type { AnalysisSummary } from '../../src/ui/messages';

export type ScanSeverity = 'ok' | 'partial' | 'warning';

export interface ScanNotice {
  severity: ScanSeverity;
  lines: string[];
}

export function buildScanNotice(summary: AnalysisSummary): ScanNotice {
  const scan = summary.scan;

  // No discovery limits hit — scan is complete. Surface measured exclusion
  // counts when telemetry exists (never invented when it doesn't).
  if (!summary.limitReached) {
    const lines: string[] = ['Scan complete — all discovered entries were within configured limits.'];
    if (scan) {
      const exclusions: string[] = [];
      if (scan.ignoredFiles > 0) exclusions.push(`${scan.ignoredFiles} file${scan.ignoredFiles === 1 ? '' : 's'} excluded by privacy rules`);
      if (scan.ignoredDirs > 0) exclusions.push(`${scan.ignoredDirs} folder${scan.ignoredDirs === 1 ? '' : 's'} excluded by privacy rules`);
      if (scan.skippedBySize > 0) exclusions.push(`${scan.skippedBySize} oversized file${scan.skippedBySize === 1 ? '' : 's'} skipped`);
      if (scan.unreadableDirs + scan.unreadableFiles > 0) {
        const unreadable = scan.unreadableDirs + scan.unreadableFiles;
        exclusions.push(`${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} unreadable`);
      }
      if (exclusions.length > 0) {
        lines.push(`Total excluded: ${exclusions.join(', ')}.`);
      }
    }
    return { severity: 'ok', lines };
  }

  // Partial: prefer precise causes when telemetry exists.
  if (scan) {
    const lines: string[] = [];
    if (scan.fileCapReached && scan.depthLimitReached) {
      lines.push(
        `Partial scan — stopped at the maximum file count (${summary.totalFiles} files), and folders deeper than the depth limit were not explored. Raise "vivaMate.maxFiles" or "vivaMate.maxDepth" in Settings to widen the scan.`
      );
    } else if (scan.fileCapReached) {
      lines.push(
        `Partial scan — maximum file count reached (${summary.totalFiles} files kept). Raise "vivaMate.maxFiles" in Settings to widen the scan.`
      );
    } else if (scan.depthLimitReached) {
      lines.push(
        `Partial scan — some entries were skipped because the maximum directory depth was reached.${scan.skippedByDepthDirs > 0 ? ` ${scan.skippedByDepthDirs} folder${scan.skippedByDepthDirs === 1 ? '' : 's'} were not explored.` : ''} Raise "vivaMate.maxDepth" in Settings to explore deeper.`
      );
    }
    if (lines.length > 0) {
      return { severity: scan.fileCapReached && scan.depthLimitReached ? 'warning' : 'partial', lines };
    }
    // limitReached but no flag set — can only be an inconsistent legacy payload.
  }

  return {
    severity: 'partial',
    lines: [
      'Partial scan — the scan stopped early due to discovery limits. Re-run the analysis for a detailed breakdown.',
    ],
  };
}
