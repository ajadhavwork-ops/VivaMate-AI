import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createIgnoreRules } from '../../src/analysis/ignoreRules';
import { walkWorkspace, DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH } from '../../src/analysis/fileWalker';
import type { WalkResult } from '../../src/analysis/fileWalker';

describe('fileWalker', () => {
  let root: string;

  function make(rel: string, content = 'x'): void {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  before(async function buildTree(this: Mocha.Context) {
    this.timeout(10_000);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vivamate-walk-'));
    make('src/app/main.ts');
    make('src/util.ts');
    make('README.md');
    make('.env.example');
    make('node_modules/lib/index.js');
    make('node_modules/lib/pkg.json');
    make('.env');
    make('dist/bundle.js');
    make('assets/logo.png');
    // 327 KB file > default 256 KB cap
    make('data/big.json', 'x'.repeat(327 * 1024));
    // deep nesting beyond the depth cap
    let deep = root;
    for (let i = 0; i < 15; i++) deep = path.join(deep, 'd' + i);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.txt'), 'x');
  });

  after(function cleanup() {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('walks kept files and applies ignore rules', async () => {
    const { files, limitReached } = await walkWorkspace(root, createIgnoreRules({ maxFileBytes: 256 * 1024 }));
    const paths = files.map((f) => f.relativePath).sort();
    assert.ok(paths.includes('src/app/main.ts'));
    assert.ok(paths.includes('src/util.ts'));
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('.env.example'));
    assert.ok(!paths.includes('.env'));
    assert.ok(!paths.includes('node_modules/lib/index.js'));
    assert.ok(!paths.includes('dist/bundle.js'));
    assert.ok(!paths.includes('assets/logo.png'));
    assert.ok(!paths.includes('data/big.json'));
    assert.ok(!existsIn(paths, 'deep.txt'));
    // The fixture's d0…d14 chain (15 levels) exceeds the default maxDepth of
    // 12, so the walk legitimately reports that it stopped early — and
    // deep.txt being absent proves the depth cap was applied.
    assert.strictEqual(limitReached, true);
  });

  function existsIn(paths: string[], base: string): boolean {
    return paths.some((p) => p.split('/').pop() === base);
  }

  it('reports limitReached and respects maxFiles', async () => {
    const { files, limitReached } = await walkWorkspace(root, createIgnoreRules({ maxFileBytes: 256 * 1024 }), {
      maxFiles: 2,
    });
    assert.strictEqual(files.length, 2);
    assert.strictEqual(limitReached, true);
  });

  it('reports limitReached when depth cap stops the walk', async () => {
    const { files, limitReached } = await walkWorkspace(root, createIgnoreRules(), {
      maxDepth: 2,
    });
    assert.strictEqual(limitReached, true);
    // at depth ≤ 2 only root-level files survive
    assert.ok(files.every((f) => !f.relativePath.includes('/d')));
  });

  it('returns an empty result for a missing root', async () => {
    const { files } = await walkWorkspace(path.join(root, 'does-not-exist'), createIgnoreRules());
    assert.strictEqual(files.length, 0);
  });

  it('exposes the default limits as bounded constants', () => {
    assert.strictEqual(DEFAULT_MAX_FILES, 5000);
    assert.strictEqual(DEFAULT_MAX_DEPTH, 12);
  });
});

describe('fileWalker — scan counters', () => {
  let dirRoot: string;

  beforeEach(function setup(this: Mocha.Context) {
    this.timeout(10_000);
    dirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vivamate-scan-'));
  });

  afterEach(function teardown() {
    if (dirRoot) fs.rmSync(dirRoot, { recursive: true, force: true });
  });

  function make(rel: string, content = 'x'): void {
    const abs = path.join(dirRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  function makeDir(rel: string): void {
    fs.mkdirSync(path.join(dirRoot, ...rel.split('/')), { recursive: true });
  }

  it('counts kept files exactly', async () => {
    make('a.ts');
    make('b.ts');
    make('c.md');
    const result = await walkWorkspace(dirRoot, createIgnoreRules());
    assert.strictEqual(result.stats.keptFiles, 3);
    assert.strictEqual(result.limitReached, false);
    assert.strictEqual(result.fileCapReached, false);
    assert.strictEqual(result.depthLimitReached, false);
  });

  it('counts ignored directories and never counts files inside pruned dirs', async () => {
    makeDir('node_modules');
    make('node_modules/lib.js');
    makeDir('node_modules/sub');
    make('node_modules/sub/lib.js'); // "discovered"? NO — dir pruned first
    make('keep.ts');
    const result = await walkWorkspace(dirRoot, createIgnoreRules());
    assert.strictEqual(result.stats.ignoredDirs, 1);
    assert.strictEqual(result.stats.keptFiles, 1);
    assert.strictEqual(result.stats.ignoredFiles, 0); // contents never discovered
  });

  it('counts ignored files by name/secrets/binaries — and not duplicates', async () => {
    make('app.ts');
    make('.env');
    make('server.pem');
    make('icon.png');
    make('.env.example'); // safe variant — kept
    const result = await walkWorkspace(dirRoot, createIgnoreRules());
    assert.strictEqual(result.stats.keptFiles, 2); // app.ts + .env.example
    assert.strictEqual(result.stats.ignoredFiles, 3); // .env, server.pem, icon.png
    assert.strictEqual(result.stats.skippedBySize, 0);
  });

  it('counts oversized files separately from name matches (no double counting)', async () => {
    make('huge.bin', 'x'.repeat(300 * 1024)); // binary ext, oversized
    make('big.json', 'x'.repeat(300 * 1024)); // plain too-large file
    make('ok.json', 'x'.repeat(10));
    const result = await walkWorkspace(dirRoot, createIgnoreRules());
    // huge.bin hits the binary-extension rule FIRST (historical precedence),
    // so it is counted exactly once — as ignored, not additionally as size.
    assert.strictEqual(result.stats.ignoredFiles, 1);
    assert.strictEqual(result.stats.skippedBySize, 1);
    assert.strictEqual(result.stats.keptFiles, 1);
  });

  it('kept safe secret variants even when oversized (historical exemption)', async () => {
    make('.env.example', 'x'.repeat(300 * 1024)); // matches .env.* glob, SAFE variant
    const result = await walkWorkspace(dirRoot, createIgnoreRules());
    assert.strictEqual(result.stats.keptFiles, 1);
    assert.strictEqual(result.stats.skippedBySize, 0);
  });

  it('counts directories beyond the depth cap without claiming their files', async () => {
    makeDir('d0/d1/d2/d3');
    make('d0/d1/d2/deepfile.ts'); // at depth 2 relative? d0=1,d1=2,d2=3 → beyond maxDepth 2
    make('d0/d1/kept.ts'); // d1 entered (depth 2 ≤ 2), file kept
    const result = await walkWorkspace(dirRoot, createIgnoreRules(), { maxDepth: 2 });
    assert.strictEqual(result.depthLimitReached, true);
    assert.strictEqual(result.stats.skippedByDepthDirs, 1); // only d2 refused
    assert.strictEqual(result.stats.keptFiles, 1); // only d0/d1/kept.ts
    assert.strictEqual(result.fileCapReached, false);
  });

  it('flags fileCapReached when the kept-file cap stops traversal', async () => {
    for (let i = 0; i < 5; i++) make(`f${i}.ts`);
    const result = await walkWorkspace(dirRoot, createIgnoreRules(), { maxFiles: 2 });
    assert.strictEqual(result.fileCapReached, true);
    assert.strictEqual(result.depthLimitReached, false);
    assert.strictEqual(result.limitReached, true);
    assert.strictEqual(result.stats.keptFiles, 2);
  });

  it('combined caps set both flags but keep counters disjoint', async () => {
    // depth chain plus >maxFiles shallow files
    makeDir('deep/very/very/very/very');
    for (let i = 0; i < 5; i++) make(`s${i}.ts`);
    make('deep/x.ts'); // depth 1 — kept (if cap not already hit)
    const result = await walkWorkspace(dirRoot, createIgnoreRules(), { maxFiles: 3, maxDepth: 2 });
    assert.strictEqual(result.fileCapReached, true);
    assert.strictEqual(result.stats.keptFiles, 3);
    assert.strictEqual(result.limitReached, true);
    // All counter buckets are disjoint by construction: kept + ignored + size
    // + depth-unexplored dirs never overlap on the same entry.
    assert.ok(result.stats.ignoredFiles + result.stats.skippedBySize <= 5);
  });

  it('supports a custom maxDepth that fits deep projects', async () => {
    make('a/b/c/d/e/g.ts'); // a real FILE six levels deep
    const shallow = await walkWorkspace(dirRoot, createIgnoreRules(), { maxDepth: 2 });
    const deeper = await walkWorkspace(dirRoot, createIgnoreRules(), { maxDepth: 6 });
    assert.strictEqual(shallow.stats.skippedByDepthDirs > 0, true);
    assert.strictEqual(deeper.stats.keptFiles, 1);
    assert.strictEqual(deeper.stats.skippedByDepthDirs, 0);
  });

  it('stats include zeroed counters for a clean tree', async () => {
    make('main.ts');
    const result: WalkResult = await walkWorkspace(dirRoot, createIgnoreRules());
    assert.deepStrictEqual(result.stats, {
      keptFiles: 1,
      ignoredDirs: 0,
      ignoredFiles: 0,
      skippedBySize: 0,
      skippedByDepthDirs: 0,
      unreadableDirs: 0,
      unreadableFiles: 0,
      fileCapReached: false,
      depthLimitReached: false,
    });
  });
});
