import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createIgnoreRules } from '../../src/analysis/ignoreRules';
import { readPlannedContent, type SignalLike } from '../../src/analysis/contentReader';
import { buildContentPlan } from '../../src/analysis/filePrioritizer';
import type { WalkedFile } from '../../src/analysis/fileWalker';
import type { ContentPlanItem } from '../../src/analysis/filePrioritizer';

describe('contentReader', () => {
  let root: string;

  function write(rel: string, content: string): void {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  beforeEach(function setup(this: Mocha.Context) {
    this.timeout(10_000);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vivamate-read-'));
  });

  afterEach(function teardown() {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function planItem(relativePath: string, maxChars: number): ContentPlanItem {
    return { relativePath, reason: 'source', maxChars };
  }

  it('reads planned files and reports measured metadata', () => {
    write('src/app.ts', 'const a = 1;\nconst b = 2;');
    const files: WalkedFile[] = [{ relativePath: 'src/app.ts', sizeBytes: 25 }];
    const contents: Array<[string, string]> = [];
    const result = readPlannedContent(
      {
        root,
        plan: [planItem('src/app.ts', 1000)],
        files,
        rules: createIgnoreRules(),
        maxFileLines: 150,
        totalMaxChars: 65_536,
      },
      (p, c) => contents.push([p, c])
    );
    assert.strictEqual(result.filesRead, 1);
    assert.strictEqual(result.totalCharsRead, 25);
    assert.strictEqual(result.files[0]?.status, 'ok');
    assert.strictEqual(result.files[0]?.linesRead, 2);
    assert.strictEqual(result.files[0]?.truncatedByLines, false);
    assert.deepStrictEqual(contents, [['src/app.ts', 'const a = 1;\nconst b = 2;']]);
  });

  it('enforces the per-file line limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    write('big.py', many);
    const result = readPlannedContent({
      root,
      plan: [planItem('big.py', 100_000)],
      files: [{ relativePath: 'big.py', sizeBytes: many.length }],
      rules: createIgnoreRules(),
      maxFileLines: 10,
    });
    const meta = result.files[0];
    assert.ok(meta);
    assert.strictEqual(meta.status, 'truncated');
    assert.strictEqual(meta.linesRead, 10);
    assert.strictEqual(meta.truncatedByLines, true);
    assert.strictEqual(meta.charsRead, 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9'.length);
    assert.strictEqual(result.truncatedFiles, 1);
  });

  it('never exceeds the per-file char cap from the plan (long-line bomb)', () => {
    // one huge minified "line" — line limit would NOT cut it, char cap must
    write('min.js', 'x'.repeat(50_000));
    const result = readPlannedContent({
      root,
      plan: [planItem('min.js', 1024)],
      files: [{ relativePath: 'min.js', sizeBytes: 50_000 }],
      rules: createIgnoreRules(),
      maxFileLines: 100,
    });
    const meta = result.files[0];
    assert.ok(meta);
    assert.strictEqual(meta.status, 'truncated');
    assert.ok(meta.charsRead <= 1024, `charsRead ${meta.charsRead} must be ≤ plan maxChars`);
    assert.strictEqual(meta.truncatedByChars, true);
    assert.strictEqual(result.totalCharsRead, meta.charsRead);
  });

  it('never exceeds the total content budget across files', () => {
    // 3 files of 400 chars each; plan assigns 400 per file but the total
    // assignment (1200) exceeds a configured 1000 — reader must stop honestly.
    for (const name of ['a.ts', 'b.ts', 'c.ts']) write(name, 'y'.repeat(400));
    const kept: WalkedFile[] = ['a.ts', 'b.ts', 'c.ts'].map((p) => ({ relativePath: p, sizeBytes: 400 }));
    const plan: ContentPlanItem[] = [planItem('a.ts', 400), planItem('b.ts', 400), planItem('c.ts', 400)];
    const result = readPlannedContent({
      root,
      plan,
      files: kept,
      rules: createIgnoreRules(),
      maxFileLines: 100,
      totalMaxChars: 1000,
    });
    assert.ok(result.totalCharsRead <= 1000, `total ${result.totalCharsRead} ≤ budget 1000`);
    assert.strictEqual(result.filesSkippedBudget, 1); // c.ts could not fit
    assert.ok(result.files.find((f) => f.status === 'budgetExhausted'));
  });

  it('records unreadable/deleted files without throwing', () => {
    const result = readPlannedContent({
      root,
      plan: [planItem('ghost.ts', 100)],
      files: [{ relativePath: 'ghost.ts', sizeBytes: 10 }],
      rules: createIgnoreRules(),
      maxFileLines: 10,
    });
    const meta = result.files[0];
    assert.ok(meta);
    assert.strictEqual(meta.status, 'unreadable');
    assert.strictEqual(result.filesUnreadable, 1);
    assert.strictEqual(result.filesRead, 0);
    assert.strictEqual(meta.charsRead, 0);
  });

  it('stops cleanly on cancellation and reports honestly', () => {
    for (const name of ['f1.ts', 'f2.ts', 'f3.ts']) write(name, 'z'.repeat(100));
    const kept: WalkedFile[] = [1, 2, 3].map((i) => ({ relativePath: `f${i}.ts`, sizeBytes: 100 }));
    let calls = 0;
    const signal: SignalLike = {
      get isCancellationRequested(): boolean {
        return calls >= 2; // cancel after two files were processed
      },
    };
    const result = readPlannedContent(
      { root, plan: kept.map((f) => planItem(f.relativePath, 200)), files: kept, rules: createIgnoreRules(), maxFileLines: 10, signal },
      () => { calls += 1; }
    );
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.filesRead, 2);
    assert.strictEqual(result.filesSkippedCancellation, 1);
    assert.strictEqual(result.files.length, 2); // skipped files not listed
  });

  it('NEVER reads excluded files, even if a corrupted plan contains them', () => {
    write('.env', 'SECRET_KEY=supersecretvalue');
    write('node_modules/lib.js', 'module.exports = 1;');
    const contents: Array<[string, string]> = [];
    const rules = createIgnoreRules({ maxFileBytes: 256 * 1024 });
    const result = readPlannedContent(
      {
        root,
        // deliberately corrupted plan — includes secrets/dependency paths
        plan: [planItem('.env', 4000), planItem('node_modules/lib.js', 400)],
        files: [
          { relativePath: '.env', sizeBytes: 40 },
          { relativePath: 'node_modules/lib.js', sizeBytes: 20 },
        ],
        rules,
        maxFileLines: 100,
      },
      (p, c) => contents.push([p, c])
    );
    assert.strictEqual(result.filesExcluded, 2);
    assert.strictEqual(result.filesRead, 0);
    assert.strictEqual(contents.length, 0, 'callback must never fire for excluded files');
    assert.ok(result.files.every((f) => f.status === 'excluded'));
  });

  it('excluded files do not consume the budget', () => {
    for (const name of ['ok.ts', '.pem'] as const) write(name, 'q'.repeat(300));
    const result = readPlannedContent({
      root,
      plan: [planItem('ok.ts', 250), planItem('.pem', 250)],
      files: [
        { relativePath: 'ok.ts', sizeBytes: 300 },
        { relativePath: '.pem', sizeBytes: 300 },
      ],
      rules: createIgnoreRules(),
      maxFileLines: 100,
    });
    assert.strictEqual(result.totalCharsRead, 250); // only ok.ts
    assert.strictEqual(result.files[1]?.status, 'excluded');
  });

  it('result metadata never carries raw file content', () => {
    const source = 'const TOP_SECRET_SOURCE_MARKER = "value123";';
    write('src/x.ts', source);
    const result = readPlannedContent({
      root,
      plan: [planItem('src/x.ts', 5000)],
      files: [{ relativePath: 'src/x.ts', sizeBytes: source.length }],
      rules: createIgnoreRules(),
      maxFileLines: 100,
    });
    // The ONLY contractually safe place for content is the onFile callback.
    assert.strictEqual(JSON.stringify(result).includes('TOP_SECRET_SOURCE_MARKER'), false);
  });

  it('works end-to-end with a real buildContentPlan output', () => {
    write('README.md', '# demo\nAll about this project.');
    write('package.json', '{"name":"demo","version":"1.0.0"}');
    write('src/index.ts', 'export function main(): void {}');
    const walked: WalkedFile[] = [
      { relativePath: 'README.md', sizeBytes: 40 },
      { relativePath: 'package.json', sizeBytes: 33 },
      { relativePath: 'src/index.ts', sizeBytes: 31 },
    ];
    const plan = buildContentPlan(walked, [{ ecosystem: 'node', relativePath: 'package.json' }], ['src/index.ts'], {
      totalMaxChars: 10_000,
      maxFileLines: 100,
    });
    const got: string[] = [];
    const result = readPlannedContent(
      { root, plan, files: walked, rules: createIgnoreRules(), maxFileLines: 100 },
      (p) => got.push(p)
    );
    assert.strictEqual(result.filesRead, plan.length);
    assert.ok(plan.length >= 2, 'plan should include at least README + manifest');
    assert.strictEqual(result.filesUnreadable, 0);
    assert.strictEqual(got.length, plan.length);
  });
});
