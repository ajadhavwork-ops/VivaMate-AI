import * as assert from 'assert';
import { buildScanNotice, type ScanSeverity } from '../../webview-ui/utils/scanStatus';
import type { AnalysisSummary, ScanStats } from '../../src/ui/messages';

function scanStats(overrides: Partial<ScanStats> = {}): ScanStats {
  return {
    keptFiles: 100,
    ignoredDirs: 0,
    ignoredFiles: 0,
    skippedBySize: 0,
    skippedByDepthDirs: 0,
    unreadableDirs: 0,
    unreadableFiles: 0,
    fileCapReached: false,
    depthLimitReached: false,
    ...overrides,
  };
}

function summary(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
  return {
    generatedAt: '2026-10-31T12:00:00Z',
    workspaceName: 'demo',
    totalFiles: 100,
    limitReached: false,
    languages: [],
    manifests: [],
    entryPoints: [],
    keyFiles: [],
    ...overrides,
  };
}

describe('scanStatus — complete scans', () => {
  it('reports a complete scan without telemetry', () => {
    const notice = buildScanNotice(summary({ limitReached: false }));
    assert.strictEqual(notice.severity, 'ok');
    assert.ok(notice.lines[0]?.startsWith('Scan complete'));
    // No counts invented when telemetry is absent.
    assert.strictEqual(notice.lines.length, 1);
  });

  it('reports measured exclusion counts alongside a complete scan', () => {
    const notice = buildScanNotice(
      summary({
        scan: scanStats({ ignoredFiles: 12, ignoredDirs: 2, skippedBySize: 3 }),
      })
    );
    assert.strictEqual(notice.severity, 'ok');
    const text = notice.lines.join(' ');
    assert.ok(text.includes('12 files excluded by privacy rules'));
    assert.ok(text.includes('2 folders excluded'));
    assert.ok(text.includes('3 oversized files skipped'));
  });

  it('omits exclusion counts that are zero', () => {
    const notice = buildScanNotice(summary({ scan: scanStats({ ignoredFiles: 5 }) }));
    const text = notice.lines.join(' ');
    assert.ok(text.includes('5 files excluded'));
    assert.ok(!text.includes('oversized'));
    assert.ok(!text.includes('folders excluded'));
  });
});

describe('scanStatus — partial scans', () => {
  it('names the file cap cause and the maxFiles setting', () => {
    const notice = buildScanNotice(
      summary({
        limitReached: true,
        totalFiles: 5000,
        scan: scanStats({ keptFiles: 5000, fileCapReached: true }),
      })
    );
    assert.strictEqual(notice.severity, 'partial');
    const text = notice.lines.join(' ');
    assert.ok(text.includes('maximum file count'));
    assert.ok(text.includes('5000'));
    assert.ok(text.includes('"vivaMate.maxFiles"'));
    assert.ok(!text.includes('maxFileLines') && !text.includes('analysisBudgetKb'));
  });

  it('names the depth cause with measured folder count only', () => {
    const notice = buildScanNotice(
      summary({
        limitReached: true,
        scan: scanStats({ depthLimitReached: true, skippedByDepthDirs: 4 }),
      })
    );
    const text = notice.lines.join(' ');
    assert.ok(text.includes('maximum directory depth'));
    assert.ok(text.includes('4 folders were not explored'));
    assert.ok(text.includes('"vivaMate.maxDepth"'));
    assert.ok(!text.includes('maximum file count'));
  });

  it('warns when BOTH caps were reached', () => {
    const notice = buildScanNotice(
      summary({
        limitReached: true,
        scan: scanStats({ fileCapReached: true, depthLimitReached: true }),
      })
    );
    assert.strictEqual(notice.severity, 'warning');
    const text = notice.lines.join(' ');
    assert.ok(text.includes('maximum file count'));
    assert.ok(text.includes('not explored'));
  });

  it('handles an inconsistent legacy payload honestly', () => {
    const notice = buildScanNotice(
      summary({ limitReached: true, scan: scanStats({}) }) // limitReached but no flags
    );
    assert.strictEqual(notice.severity, 'partial');
    assert.ok(notice.lines[0]?.includes('stopped early'));
  });
});

describe('scanStatus — legacy cached profiles (no telemetry)', () => {
  it('stays honest without inventing numbers or settings advice', () => {
    const notice = buildScanNotice(summary({ limitReached: true }));
    assert.strictEqual(notice.severity as ScanSeverity, 'partial');
    const text = notice.lines.join(' ');
    assert.ok(text.includes('Re-run the analysis'));
    assert.ok(!/\d+ files/.test(text)); // no manufactured counts
    assert.ok(!text.includes('vivaMate.maxFiles') && !text.includes('maxDepth'));
  });
});
