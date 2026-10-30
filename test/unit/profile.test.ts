import * as assert from 'assert';
import {
  buildProfile,
  computeFingerprint,
  computeLanguageStats,
  toSummary,
  type BuildProfileArgs,
} from '../../src/analysis/profile';

const EMPTY_ARGS: BuildProfileArgs = {
  workspaceName: 'demo',
  files: [],
  manifests: [],
  pkgSummary: null,
  entryPoints: [],
  plan: [],
  limitReached: false,
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
