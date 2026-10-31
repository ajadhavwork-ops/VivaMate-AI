import * as assert from 'assert';
import {
  clampLimit,
  LIMIT_BOUNDS,
  resolveScanLimits,
  resolveContentLimits,
} from '../../src/analysis/scanSettings';

describe('scanSettings — clampLimit', () => {
  it('keeps in-range values unchanged', () => {
    assert.strictEqual(clampLimit(5000, LIMIT_BOUNDS.maxFiles), 5000);
    assert.strictEqual(clampLimit(12, LIMIT_BOUNDS.maxDepth), 12);
  });

  it('clamps values that exceed the bounds', () => {
    assert.strictEqual(clampLimit(999999, LIMIT_BOUNDS.maxFiles), LIMIT_BOUNDS.maxFiles.max);
    assert.strictEqual(clampLimit(0, LIMIT_BOUNDS.maxFiles), LIMIT_BOUNDS.maxFiles.min);
    assert.strictEqual(clampLimit(999, LIMIT_BOUNDS.maxDepth), LIMIT_BOUNDS.maxDepth.max);
    assert.strictEqual(clampLimit(-50, LIMIT_BOUNDS.maxDepth), LIMIT_BOUNDS.maxDepth.min);
  });

  it('falls back to defaults for invalid values', () => {
    assert.strictEqual(clampLimit(Number.NaN, LIMIT_BOUNDS.maxFiles), LIMIT_BOUNDS.maxFiles.default);
    assert.strictEqual(clampLimit(Number.POSITIVE_INFINITY, LIMIT_BOUNDS.maxFiles), LIMIT_BOUNDS.maxFiles.default);
    assert.strictEqual(clampLimit('5000', LIMIT_BOUNDS.maxFiles), LIMIT_BOUNDS.maxFiles.default);
    assert.strictEqual(clampLimit(null, LIMIT_BOUNDS.maxDepth), LIMIT_BOUNDS.maxDepth.default);
    assert.strictEqual(clampLimit(undefined, LIMIT_BOUNDS.maxDepth), LIMIT_BOUNDS.maxDepth.default);
    assert.strictEqual(clampLimit({ deep: 1 }, LIMIT_BOUNDS.maxDepth), LIMIT_BOUNDS.maxDepth.default);
  });

  it('rounds fractional values to whole entries', () => {
    assert.strictEqual(clampLimit(5000.7, LIMIT_BOUNDS.maxFiles), 5001);
  });

  it('defaults can never be unlimited', () => {
    for (const bounds of [LIMIT_BOUNDS.maxFiles, LIMIT_BOUNDS.maxDepth]) {
      assert.ok(bounds.max < Number.POSITIVE_INFINITY);
      assert.ok(bounds.min > 0);
    }
  });
});

describe('scanSettings — resolveScanLimits', () => {
  it('applies safe defaults when settings are absent', () => {
    const limits = resolveScanLimits({});
    assert.deepStrictEqual(limits, { maxFiles: 5000, maxDepth: 12 });
  });

  it('applies valid custom settings', () => {
    const limits = resolveScanLimits({ maxFiles: 800, maxDepth: 5 });
    assert.deepStrictEqual(limits, { maxFiles: 800, maxDepth: 5 });
  });

  it('falls back per-setting when one setting is invalid', () => {
    const limits = resolveScanLimits({ maxFiles: 'garbage', maxDepth: 6 });
    assert.deepStrictEqual(limits, { maxFiles: 5000, maxDepth: 6 });
  });

  it('clamps both settings when both are extreme', () => {
    const limits = resolveScanLimits({ maxFiles: -10, maxDepth: 400 });
    assert.deepStrictEqual(limits, {
      maxFiles: LIMIT_BOUNDS.maxFiles.min,
      maxDepth: LIMIT_BOUNDS.maxDepth.max,
    });
  });
});

describe('scanSettings — resolveContentLimits (P3.2)', () => {
  it('applies safe defaults when settings are absent', () => {
    const limits = resolveContentLimits({});
    assert.deepStrictEqual(limits, { totalMaxChars: 64 * 1024, maxFileLines: 150 });
  });

  it('applies valid custom settings', () => {
    const limits = resolveContentLimits({ analysisBudgetKb: 32, maxFileLines: 40 });
    assert.deepStrictEqual(limits, { totalMaxChars: 32 * 1024, maxFileLines: 40 });
  });

  it('clamps extreme values into documented bounds', () => {
    const limits = resolveContentLimits({ analysisBudgetKb: 99_999, maxFileLines: 5 });
    assert.deepStrictEqual(limits, { totalMaxChars: 512 * 1024, maxFileLines: 20 });
  });

  it('falls back to defaults for invalid values (∞, NaN, strings)', () => {
    assert.deepStrictEqual(
      resolveContentLimits({ analysisBudgetKb: Number.POSITIVE_INFINITY, maxFileLines: Number.NaN }),
      { totalMaxChars: 64 * 1024, maxFileLines: 150 }
    );
    assert.deepStrictEqual(
      resolveContentLimits({ analysisBudgetKb: 'huge', maxFileLines: 'lines' }),
      { totalMaxChars: 64 * 1024, maxFileLines: 150 }
    );
  });

  it('per-setting fallback keeps the valid sibling', () => {
    const limits = resolveContentLimits({ analysisBudgetKb: null, maxFileLines: 90 });
    assert.deepStrictEqual(limits, { totalMaxChars: 64 * 1024, maxFileLines: 90 });
  });
});
