import * as assert from 'assert';
import { formatBytes, middleTruncate, relativeTime } from '../../webview-ui/utils/format';

describe('format — formatBytes', () => {
  it('renders bytes under 1 KB without decimals', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1023), '1023 B');
  });

  it('renders KB/MB/GB with one decimal', () => {
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(2048), '2.0 KB');
    assert.strictEqual(formatBytes(1536 * 1024), '1.5 MB');
    assert.strictEqual(formatBytes(2 * 1024 ** 3), '2.0 GB');
  });

  it('switches to zero decimals for large values', () => {
    assert.strictEqual(formatBytes(120 * 1024), '120 KB');
  });

  it('degrades gracefully for invalid input', () => {
    assert.strictEqual(formatBytes(-5), '—');
    assert.strictEqual(formatBytes(Number.NaN), '—');
  });
});

describe('format — relativeTime', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z');

  it('renders just-now / seconds / minutes / hours / days', () => {
    assert.strictEqual(relativeTime('2026-10-31T11:59:58Z', NOW), 'just now');
    assert.strictEqual(relativeTime('2026-10-31T11:59:30Z', NOW), '30s ago');
    assert.strictEqual(relativeTime('2026-10-31T11:55:00Z', NOW), '5m ago');
    assert.strictEqual(relativeTime('2026-10-31T10:00:00Z', NOW), '2h ago');
    assert.strictEqual(relativeTime('2026-10-26T12:00:00Z', NOW), '5d ago');
  });

  it('falls back to a locale string for invalid timestamps', () => {
    const out = relativeTime('not-a-date', NOW);
    assert.ok(typeof out === 'string' && out.length > 0);
    assert.notStrictEqual(out, 'NaN');
  });
});

describe('format — middleTruncate', () => {
  it('keeps short strings unchanged', () => {
    assert.strictEqual(middleTruncate('ab12cd34', 24), 'ab12cd34');
  });

  it('truncates the middle with an ellipsis', () => {
    const out = middleTruncate('abcdefghijklmnopqrstuvwxyz', 11);
    assert.strictEqual(out.length, 11);
    assert.ok(out.includes('…'));
    assert.ok(out.startsWith('abcde'));
    assert.ok(out.endsWith('vwxyz'));
  });
});
