import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildProfile,
  computeFingerprint,
  computeLanguageStats,
  toSummary,
  type BuildProfileArgs,
} from '../../src/analysis/profile';
import type { ScanStats } from '../../src/ui/messages';

const ZERO_SCAN: ScanStats = {
  keptFiles: 0,
  ignoredDirs: 0,
  ignoredFiles: 0,
  skippedBySize: 0,
  skippedByDepthDirs: 0,
  unreadableDirs: 0,
  unreadableFiles: 0,
  fileCapReached: false,
  depthLimitReached: false,
};

const EMPTY_ARGS: BuildProfileArgs = {
  workspaceName: 'demo',
  files: [],
  manifests: [],
  pkgSummary: null,
  entryPoints: [],
  plan: [],
  limitReached: false,
  scan: ZERO_SCAN,
};

describe('profile — computeLanguageStats', () => {
  it('groups aliased extensions and sorts by count', () => {
    const stats = computeLanguageStats([
      { relativePath: 'a.ts', sizeBytes: 10 },
      { relativePath: 'b.tsx', sizeBytes: 20 },
      { relativePath: 'c.js', sizeBytes: 30 },
      { relativePath: 'd.mjs', sizeBytes: 40 },
      { relativePath: 'e.yml', sizeBytes: 5 },
    ]);
    // equal counts break ties by total bytes (descending)
    assert.deepStrictEqual(
      stats.map((s) => [s.name, s.files]),
      [
        ['js', 2],
        ['ts', 2],
        ['yaml', 1],
      ]
    );
    assert.strictEqual(stats[0]?.totalBytes, 70); // js group: 30 + 40
    assert.strictEqual(stats[1]?.totalBytes, 30); // ts group: 10 + 20
  });
});

describe('profile — fingerprint', () => {
  it('is stable for identical input and changes when the tree changes', () => {
    const base = { totalFiles: 10, totalSizeBytes: 1000, manifestPaths: ['package.json'] };
    assert.strictEqual(computeFingerprint(base), computeFingerprint(base));
    assert.notStrictEqual(
      computeFingerprint(base),
      computeFingerprint({ ...base, totalFiles: 11 })
    );
  });
});

describe('profile — buildProfile + toSummary', () => {
  it('mirrors plan paths into keyFiles and trims the webview summary', () => {
    const profile = buildProfile({
      ...EMPTY_ARGS,
      files: [
        { relativePath: 'a.ts', sizeBytes: 100 },
        { relativePath: 'b.ts', sizeBytes: 200 },
      ],
      manifests: [{ ecosystem: 'node', relativePath: 'package.json' }],
      entryPoints: ['a.ts'],
      plan: [
        { relativePath: 'a.ts', reason: 'entry', maxChars: 100 },
        { relativePath: 'b.ts', reason: 'source', maxChars: 200 },
      ],
      limitReached: true,
    });

    assert.strictEqual(profile.schemaVersion, 1);
    assert.strictEqual(profile.workspaceName, 'demo');
    assert.strictEqual(profile.totalFiles, 2);
    assert.strictEqual(profile.totalSizeBytes, 300);
    assert.strictEqual(profile.limitReached, true);
    assert.deepStrictEqual(profile.keyFiles, ['a.ts', 'b.ts']);

    const summary = toSummary(profile);
    assert.strictEqual(summary.totalFiles, 2);
    assert.deepStrictEqual(summary.keyFiles, ['a.ts', 'b.ts']);
    assert.deepStrictEqual(summary.entryPoints, ['a.ts']);
  });

  it('caps the summary language list at 8', () => {
    const languages = Array.from({ length: 12 }, (_, i) => ({
      relativePath: `f${i}.${i}`,
      sizeBytes: 1,
    }));
    const profile = buildProfile({ ...EMPTY_ARGS, files: languages });
    const summary = toSummary(profile);
    assert.strictEqual(profile.languages.length, 12);
    assert.strictEqual(summary.languages.length, 8);
  });
});

describe('profile — P3.2 content layer integration', () => {
  const SOURCE = 'const AUTH_BEARER_TOKEN_IN_SOURCE = "xx-secret-xx";';

  const contentArgs = {
      meta: {
      files: [{ relativePath: 'a.ts', status: 'ok' as const, charsRead: 10, linesRead: 5, truncatedByLines: false, truncatedByChars: false }],
      filesRead: 1,
      filesUnreadable: 0,
      filesExcluded: 0,
      filesSkippedBudget: 0,
      filesSkippedCancellation: 0,
      truncatedFiles: 0,
      totalCharsRead: 10,
      budgetChars: 65_536,
      cancelled: false,
    },
    symbols: [{ relativePath: 'a.ts', source: 'fallback' as const, symbols: [{ name: 'a', kind: 'constant' as const, line: 1 }] }],
    imports: {
      edges: [{ from: 'a.ts', kind: 'package' as const, spec: 'zod' }],
      filesScanned: 1,
      filesSkipped: 0,
      truncated: false,
      counts: { local: 0, package: 1, builtin: 0, alias: 0, dynamic: 0, namespace: 0, unresolved: 0 },
    },
    configs: [{ relativePath: 'a.json', format: 'json' as const, entries: [{ path: 'a', type: 'number' as const }], truncated: false }],
  };

  it('stores structured content data and the measured summary aggregate', () => {
    const profile = buildProfile({ ...EMPTY_ARGS, content: contentArgs });
    assert.ok(profile.content);
    assert.strictEqual(profile.content.imports.counts.package, 1);
    assert.strictEqual(profile.content.symbols[0]?.source, 'fallback');

    const summary = toSummary(profile);
    assert.ok(summary.content, 'summary should carry the content aggregate');
    assert.strictEqual(summary.content.filesRead, 1);
    assert.strictEqual(summary.content.totalCharsRead, 10);
    assert.strictEqual(summary.content.symbolFilesFallback, 1);
    assert.strictEqual(summary.content.importEdgesPackage, 1);
    assert.strictEqual(summary.content.configFiles, 1);
  });

  it('summary WITHOUT content stays valid (pre-P3.2 profile shape)', () => {
    const summary = toSummary(buildProfile(EMPTY_ARGS));
    assert.strictEqual(summary.content, undefined);
  });

  it('NEVER persists raw source content', () => {
    const profile = buildProfile({ ...EMPTY_ARGS, content: contentArgs });
    const serialized = JSON.stringify(profile);
    assert.ok(serialized.includes('AUTH_BEARER_TOKEN_IN_SOURCE') === false, 'source text must not exist in profile');
    assert.ok(/"content"/.test(serialized), 'content metadata block exists');
  });

  it('preserves P3.1 scan telemetry alongside content data', () => {
    const scan: ScanStats = { ...ZERO_SCAN, keptFiles: 5, ignoredFiles: 2, fileCapReached: true };
    const profile = buildProfile({ ...EMPTY_ARGS, scan, content: contentArgs });
    assert.deepStrictEqual(profile.scan, scan);
    assert.strictEqual(toSummary(profile).scan?.fileCapReached, true);
  });

  it('old cached profiles (schemaVersion 1, no content) load unchanged', () => {
    // Simulates a JSON.parse of a P3.1-era profile after this release.
    const legacy = {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00Z',
      fingerprint: 'abc123',
      workspaceName: 'old',
      totalFiles: 3,
      totalSizeBytes: 100,
      limitReached: false,
      scan: ZERO_SCAN,
      languages: [],
      manifests: [],
      entryPoints: [],
      keyFiles: [],
    };
    const profile = legacy as unknown as ReturnType<typeof buildProfile>;
    const summary = toSummary(profile); // must not throw
    assert.strictEqual(summary.content, undefined);
    assert.strictEqual(summary.scan?.keptFiles, 0);
  });
});

describe('profile — persistence round-trip (profileStore)', () => {
  it('saves and restores a profile including content layer, without content values', async () => {
    const { saveProfile, loadProfile, clearProfiles } = await import(
      '../../src/analysis/profileStore.js'
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivamate-profile-'));
    try {
      const fakeContext = { storageUri: { fsPath: dir } } as never as Parameters<
        typeof saveProfile
      >[0];
      const scan: ScanStats = { ...ZERO_SCAN, keptFiles: 2 };
      const profile = buildProfile({
        ...EMPTY_ARGS,
        files: [{ relativePath: 'a.ts', sizeBytes: 5 }],
        scan,
        content: {
          meta: {
            files: [],
            filesRead: 1,
            filesUnreadable: 0,
            filesExcluded: 0,
            filesSkippedBudget: 0,
            filesSkippedCancellation: 0,
            truncatedFiles: 0,
            totalCharsRead: 5,
            budgetChars: 100,
            cancelled: false,
          },
          symbols: [],
          imports: {
            edges: [],
            filesScanned: 1,
            filesSkipped: 0,
            truncated: false,
            counts: { local: 0, package: 0, builtin: 0, alias: 0, dynamic: 0, namespace: 0, unresolved: 0 },
          },
          configs: [],
        },
      });
      await saveProfile(fakeContext, profile);
      const restored = await loadProfile(fakeContext);
      assert.ok(restored, 'profile should load back');
      assert.deepStrictEqual(restored.content?.meta.budgetChars, 100);
      assert.deepStrictEqual(restored.scan, scan);
      assert.deepStrictEqual(restored.content?.imports.counts.local, 0);
      // cleanup
      await clearProfiles(fakeContext);
      const cleared = await loadProfile(fakeContext);
      assert.strictEqual(cleared, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
