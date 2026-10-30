import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createIgnoreRules } from '../../src/analysis/ignoreRules';
import { walkWorkspace } from '../../src/analysis/fileWalker';

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
});
