import * as assert from 'assert';
import { buildContentPlan, type ContentPlanOptions } from '../../src/analysis/filePrioritizer';
import type { WalkedFile } from '../../src/analysis/fileWalker';

function f(relativePath: string, sizeBytes = 100): WalkedFile {
  return { relativePath, sizeBytes };
}

const OPTIONS: ContentPlanOptions = { totalMaxChars: 1_000_000, maxFileLines: 100 };

describe('filePrioritizer — tier ordering', () => {
  const files = [
    f('README.md', 2000),
    f('docs/README.md', 800),
    f('package.json', 1200),
    f('src/index.ts', 4000),
    f('tsconfig.json', 300),
    f('deep/nested/util.ts', 500),
    f('src/util.ts', 400),
    f('assets/logo.png', 10_000),
  ];
  const manifests = [{ ecosystem: 'node', relativePath: 'package.json' }];
  const entryPoints = ['src/index.ts'];

  it('selects readme before manifest before entry, config, then sources', () => {
    const plan = buildContentPlan(files, manifests, entryPoints, OPTIONS);
    const reasons = plan.map((p) => p.reason);
    // first three in priority order; no binaries ever
    assert.strictEqual(plan[0]?.relativePath, 'README.md'); // shallow README first
    assert.strictEqual(plan[1]?.relativePath, 'package.json');
    assert.strictEqual(plan[2]?.relativePath, 'src/index.ts');
    assert.ok(reasons.includes('config'));
    assert.ok(reasons.includes('source'));
    assert.ok(!plan.some((p) => p.relativePath.includes('logo.png')));
    assert.ok(!plan.some((p) => p.reason === 'readme' && p.relativePath === 'docs/README.md'));
  });

  it('orders source files shallow-first, small-first within a depth', () => {
    const plan = buildContentPlan(files, manifests, entryPoints, OPTIONS)
      .filter((p) => p.reason === 'source');
    const paths = plan.map((p) => p.relativePath);
    assert.ok(paths.indexOf('src/util.ts') >= 0);
    assert.ok(paths.indexOf('deep/nested/util.ts') >= 0);
    assert.ok(paths.indexOf('src/util.ts') < paths.indexOf('deep/nested/util.ts'));
  });
});

describe('filePrioritizer — budget', () => {
  it('stops selecting files once the character budget is exhausted', () => {
    const files = [
      f('README.md', 2000),
      f('package.json', 1500),
      f('src/index.ts', 8000),
      f('tsconfig.json', 900),
      f('src/app.ts', 700),
    ];
    const plan = buildContentPlan(files, [{ ecosystem: 'node', relativePath: 'package.json' }], [], {
      totalMaxChars: 3600, // covers README + manifest, then stops
      maxFileLines: 100,
    });
    const included = plan.map((p) => p.relativePath);
    assert.ok(included.includes('README.md'));
    assert.ok(included.includes('package.json'));
    assert.ok(!included.includes('tsconfig.json'));
    assert.ok(!included.includes('src/app.ts'));
  });

  it('caps per-file chars even for huge files', () => {
    const plan = buildContentPlan([f('others/first.ts', 500_000)], [], [], {
      totalMaxChars: 1_000_000,
      maxFileLines: 50, // → 50 * 100 = 5000 chars max
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0]?.maxChars, 5000);
  });
});
