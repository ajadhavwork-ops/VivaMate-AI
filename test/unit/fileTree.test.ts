import * as assert from 'assert';
import {
  buildTree,
  defaultExpandedPaths,
  expandableFolders,
  matchesFilter,
  type ExplorerFile,
  type TreeNode,
} from '../../webview-ui/utils/fileTree';
import { categorizeFiles, classifyFile, CATEGORY_LABELS } from '../../webview-ui/utils/fileCategories';

function f(relativePath: string, sizeBytes?: number): ExplorerFile {
  return { relativePath, sizeBytes };
}

describe('fileTree — buildTree', () => {
  it('builds nested folders with correct depths and paths', () => {
    const { roots } = buildTree([f('src/app/main.ts'), f('src/util.ts')]);
    assert.strictEqual(roots.length, 1);
    const src = roots[0] as TreeNode;
    assert.strictEqual(src?.kind, 'folder');
    assert.strictEqual(src?.name, 'src');
    assert.strictEqual(src?.path, 'src');
    assert.strictEqual(src?.depth, 0);
    assert.strictEqual(src?.children.length, 2); // app/ + util.ts
    const app = src?.children[0] as TreeNode | undefined;
    assert.strictEqual(app?.kind, 'folder');
    assert.strictEqual(app?.path, 'src/app');
    assert.strictEqual(app?.depth, 1);
    const main = app?.children[0] as TreeNode | undefined;
    assert.strictEqual(main?.kind, 'file');
    assert.strictEqual(main?.name, 'main.ts');
    assert.strictEqual(main?.depth, 2);
  });

  it('merges duplicate intermediate folders', () => {
    const { roots } = buildTree([f('a/b/x.ts'), f('a/b/y.ts'), f('a/z.ts')]);
    const a = roots[0] as TreeNode | undefined;
    assert.ok(a);
    assert.strictEqual(a?.children.length, 2); // b/ + z.ts (a/ is not duplicated)
    const b = a?.children[0] as TreeNode | undefined;
    assert.ok(b);
    assert.strictEqual(b?.children.length, 2);
  });

  it('sorts folders before files, files of the same level alphabetically (case-insensitive)', () => {
    // 'Beta' here is a FILE at the root (no slash) — files have no priority over files.
    const { roots } = buildTree([f('zeta.ts'), f('alpha.ts'), f('Beta')]);
    const names = roots.map((n) => n.name);
    assert.deepStrictEqual(names, ['alpha.ts', 'Beta', 'zeta.ts']);

    // With an actual folder present, folders come first:
    const withFolder = buildTree([f('zeta.ts'), f('alpha.ts'), f('beta/b.ts'), f('Beta/a.ts')]);
    assert.strictEqual(withFolder.roots[0]?.name, 'beta'); // folder before files
    assert.strictEqual(withFolder.roots[0]?.kind, 'folder');
  });

  it('carries sizeBytes (only when provided) and counts files per folder', () => {
    const { roots } = buildTree([f('lib/index.ts', 120), f('lib/data.json', 45), f('README.md', 900)]);
    const lib = roots.find((n) => n.name === 'lib');
    assert.ok(lib);
    assert.strictEqual(lib?.fileCount, 2);
    const index = lib?.children.find((n) => n.name === 'index.ts');
    assert.strictEqual(index?.sizeBytes, 120);
    const readme = roots.find((n) => n.name === 'README.md');
    assert.strictEqual(readme?.sizeBytes, 900);
  });

  it('normalizes backslashes and leading ./ on Windows-style paths', () => {
    const { roots } = buildTree([f('.\\src\\main.ts'), f('./src/index.ts')]);
    const src = roots[0];
    assert.ok(src);
    assert.strictEqual(src.name, 'src');
    assert.strictEqual(src.children.length, 2); // both files merged under one src/
  });

  it('handles empty input and files at the root only', () => {
    assert.strictEqual(buildTree([]).roots.length, 0);
    const { roots } = buildTree([f('main.py')]);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0]?.kind, 'file');
  });
});

describe('fileTree — search & category filtering', () => {
  const FILES = [
    f('src/components/Button.tsx', 900),
    f('src/components/TextField.tsx', 400),
    f('src/utils.ts', 200),
    f('docs/setup.md', 300),
    f('README.md', 1000),
    f('assets/logo.png', 5000),
  ];

  it('matches search terms against file names (case-insensitive)', () => {
    const result = buildTree(FILES, { term: 'textfield' });
    assert.strictEqual(result.shownFiles, 1);
    assert.ok((result.roots[0] as TreeNode).children.length <= 2); // src > components > TextField.tsx chain
  });

  it('matches search terms against the full relative path', () => {
    const result = buildTree(FILES, { term: 'components/button' });
    assert.strictEqual(result.shownFiles, 1);
    const src = result.roots[0] as TreeNode;
    const components = src?.children[0] as TreeNode;
    assert.strictEqual(components?.children.length, 1); // only Button.tsx survives
  });

  it('returns isEmptyResult for a term with zero matches', () => {
    const result = buildTree(FILES, { term: 'does-not-exist' });
    assert.strictEqual(result.shownFiles, 0);
    assert.strictEqual(result.roots.length, 0);
    assert.strictEqual(result.isEmptyResult, true);
  });

  it('filters by category and reports no-match empties for categories', () => {
    const result = buildTree(FILES, { category: 'documentation' });
    assert.strictEqual(result.shownFiles, 2); // docs/setup.md + README.md
    const none = buildTree([f('a.ts')], { category: 'assets' });
    assert.strictEqual(none.isEmptyResult, true);
  });

  it('combines term + category filters (AND semantics)', () => {
    const result = buildTree(FILES, { term: 'setup', category: 'documentation' });
    assert.strictEqual(result.shownFiles, 1);
    const combined = buildTree(FILES, { term: 'setup', category: 'source' });
    assert.strictEqual(combined.isEmptyResult, true);
  });

  it('matchesFilter is exact for non-matching rows', () => {
    assert.strictEqual(matchesFilter(f('src/utils.ts'), { term: 'assets' }), false);
    assert.strictEqual(matchesFilter(f('assets/logo.png'), { category: 'assets' }), true);
  });
});

describe('fileTree — expansion helpers', () => {
  it('defaultExpandedPaths returns folders up to maxDepth', () => {
    const { roots } = buildTree([f('a/b/c/deep.ts'), f('top.ts')]);
    const expanded = defaultExpandedPaths(roots, 2);
    assert.ok(expanded.includes('a'));
    assert.ok(expanded.includes('a/b'));
    assert.ok(!expanded.includes('a/b/c')); // depth 2 not < 2
  });

  it('expandableFolders returns every folder path', () => {
    const { roots } = buildTree([f('a/b/c.ts'), f('x/y.ts')]);
    const folders = expandableFolders(roots);
    assert.ok(folders.includes('a'));
    assert.ok(folders.includes('a/b'));
    assert.ok(folders.includes('x'));
    assert.strictEqual(folders.length, 3);
  });
});

describe('fileCategories — classification', () => {
  it('classifies source code by extension (never binaries/media)', () => {
    assert.strictEqual(classifyFile('src/main.ts'), 'source');
    assert.strictEqual(classifyFile('app.py'), 'source');
    assert.strictEqual(classifyFile('styles.scss'), 'source');
    // aliases collapse
    assert.strictEqual(classifyFile('a.tsx'), 'source');
    assert.strictEqual(classifyFile('b.jsx'), 'source');
  });

  it('puts images, fonts and media in assets, not languages', () => {
    assert.strictEqual(classifyFile('logo.png'), 'assets');
    assert.strictEqual(classifyFile('icon.svg'), 'assets');
    assert.strictEqual(classifyFile('font.woff2'), 'assets');
    assert.strictEqual(classifyFile('video.mp4'), 'assets');
    assert.strictEqual(classifyFile('bundle.js.zip'), 'assets'); // trailing ext wins
  });

  it('classifies manifests and tooling configs as configuration', () => {
    assert.strictEqual(classifyFile('package.json'), 'configuration');
    assert.strictEqual(classifyFile('tsconfig.json'), 'configuration');
    assert.strictEqual(classifyFile('config/settings.yml'), 'configuration');
    assert.strictEqual(classifyFile('docker-compose.yaml'), 'configuration');
    assert.strictEqual(classifyFile('.gitignore'), 'configuration');
    assert.strictEqual(classifyFile('vite.config.ts'), 'configuration');
  });

  it('classifies documentation', () => {
    assert.strictEqual(classifyFile('README.md'), 'documentation');
    assert.strictEqual(classifyFile('docs/guide.rst'), 'documentation');
    assert.strictEqual(classifyFile('notes.txt'), 'documentation');
  });

  it('files without a known extension fall through to other', () => {
    assert.strictEqual(classifyFile('datafile'), 'other');
    assert.strictEqual(classifyFile('weird.xyz'), 'other');
  });
});

describe('fileCategories — categorizeFiles counts', () => {
  it('counts all categories in one pass with stable ordering and labels', () => {
    const stats = categorizeFiles([
      f('a.ts'), f('b.ts'), f('package.json'), f('README.md'),
      f('logo.png'), f('mystery.xyz'),
    ]);
    const byId = new Map(stats.map((s) => [s.id, s]));
    assert.strictEqual(byId.get('source')?.count, 2);
    assert.strictEqual(byId.get('configuration')?.count, 1);
    assert.strictEqual(byId.get('documentation')?.count, 1);
    assert.strictEqual(byId.get('assets')?.count, 1);
    assert.strictEqual(byId.get('other')?.count, 1);
    assert.strictEqual(byId.get('source')?.label, CATEGORY_LABELS.source);
  });

  it('counts an empty file list as all zeros', () => {
    for (const stat of categorizeFiles([])) {
      assert.strictEqual(stat.count, 0);
    }
  });
});
