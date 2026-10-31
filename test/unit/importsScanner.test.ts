import * as assert from 'assert';
import { scanImports, IMPORT_LIMITS, type ImportScanOptions } from '../../src/analysis/importsScanner';

function opts(
  files: readonly string[],
  contents: Record<string, string>,
  extra: Partial<ImportScanOptions> = {}
): ImportScanOptions {
  return {
    files: new Map(files.map((f) => [f, 0] as const)),
    contents: new Map(Object.entries(contents)),
    ...extra,
  };
}

describe('importsScanner — JS/TS detection', () => {
  it('detects import, export-from, side-effect, require and dynamic import', () => {
    const model = scanImports(opts(['src/app.ts'], {
      'src/app.ts': [
        "import { Router } from 'express';",
        "import * as path from 'path';",
        "import './startup';",
        "export { helper } from './util';",
        "export * from './types';",
        "const fs = require('fs');",
        "async function load() { const cfg = await import('./config'); }",
      ].join('\n'),
    }));
    const specs = model.edges.map((e) => e.spec).sort();
    assert.ok(specs.includes('express'));
    assert.ok(specs.includes('path'));
    assert.ok(specs.includes('./startup'));
    assert.ok(specs.includes('./util'));
    assert.ok(specs.includes('./types'));
    assert.ok(specs.includes('fs'));
    assert.ok(specs.includes('./config'));
    assert.strictEqual(model.edges.length, 7, 'no duplicate edges');
  });

  it('classifies packages vs builtins vs local relative targets', () => {
    const model = scanImports(opts(
      ['src/a.ts', 'src/util.ts', 'src/util/index.ts', 'src/util/helper.js', 'src/util2/index.ts'],
      {
        'src/a.ts': [
          "import { x } from './util';",          // file wins over directory (Node/TS order)
          "import { y } from './util2';",         // directory → index.ts convention
          "import './util/helper.js';",           // exact with extension
          "import { y } from './missing';",       // unresolvable relative
          "import fs from 'node:fs';",            // builtin
          "import z from 'zod';",                 // package
        ].join('\n'),
      }
    ));
    const bySpec = new Map(model.edges.map((e) => [e.spec, e]));
    assert.strictEqual(bySpec.get('./util')?.kind, 'local');
    assert.strictEqual(bySpec.get('./util')?.to, 'src/util.ts');
    assert.strictEqual(bySpec.get('./util2')?.to, 'src/util2/index.ts');
    assert.strictEqual(bySpec.get('./util/helper.js')?.to, 'src/util/helper.js');
    assert.strictEqual(bySpec.get('./missing')?.kind, 'unresolved');
    assert.strictEqual(bySpec.get('./missing')?.to, undefined);
    assert.strictEqual(bySpec.get('node:fs')?.kind, 'builtin');
    assert.strictEqual(bySpec.get('zod')?.kind, 'package');
    assert.strictEqual(model.counts.local, 3);
    assert.strictEqual(model.counts.builtin, 1);
    assert.strictEqual(model.counts.package, 1);
    assert.strictEqual(model.counts.unresolved, 1);
  });

  it('marks dynamic imports with the dynamic kind (even when resolvable)', () => {
    const model = scanImports(opts(
      ['d.ts', 'late.ts'],
      { 'd.ts': "const m = await import('./late');" }
    ));
    assert.strictEqual(model.edges[0]?.kind, 'dynamic');
    assert.strictEqual(model.edges[0]?.to, 'late.ts');
    assert.strictEqual(model.counts.dynamic, 1);
  });

  it('marks path aliases as alias (unresolved by design)', () => {
    const model = scanImports(opts(['a.ts'], {
      'a.ts': "import { API } from '@/api/client';\nimport styles from '~/styles/theme.css';",
    }));
    assert.ok(model.edges.every((e) => e.kind === 'alias'));
    assert.strictEqual(model.counts.alias, 2);
  });

  it('handles ../ relative specs without inventing targets', () => {
    const model = scanImports(opts(
      ['src/ui/panel.ts', 'src/core/engine.ts'],
      { 'src/ui/panel.ts': "import { engine } from '../core/engine';" }
    ));
    assert.strictEqual(model.edges[0]?.kind, 'local');
    assert.strictEqual(model.edges[0]?.to, 'src/core/engine.ts');
  });
});

describe('importsScanner — Python', () => {
  it('resolves local modules and marks stdlib vs unresolved', () => {
    const model = scanImports(opts(
      ['app/main.py', 'app/helpers/util.py', 'app/tools/__init__.py'],
      {
        'app/main.py': [
          'import helpers.util',
          'from tools import run',
          'import os, json',
          'from .helpers.util import fix',
          'from missingpkg import thing',
        ].join('\n'),
      }
    ));
    const bySpec = new Map(model.edges.map((e) => [e.spec, e]));
    // absolute: root-relative miss, then sibling-dir fallback (best effort)
    assert.strictEqual(bySpec.get('helpers.util')?.kind, 'local');
    assert.strictEqual(bySpec.get('helpers.util')?.to, 'app/helpers/util.py');
    assert.strictEqual(bySpec.get('tools')?.kind, 'local');
    assert.strictEqual(bySpec.get('tools')?.to, 'app/tools/__init__.py');
    assert.strictEqual(bySpec.get('os')?.kind, 'builtin');
    assert.strictEqual(bySpec.get('json')?.kind, 'builtin');
    // dotted relative: walks up from the importing file's directory
    assert.ok(bySpec.has('.helpers.util'), 'relative from-import detected');
    assert.strictEqual(bySpec.get('.helpers.util')?.kind, 'local');
    assert.strictEqual(bySpec.get('.helpers.util')?.to, 'app/helpers/util.py');
    assert.strictEqual(bySpec.get('missingpkg')?.kind, 'unresolved');
  });

  it('never invents targets for packages installed in site-packages', () => {
    const model = scanImports(opts(['m.py'], { 'm.py': 'import fastapi' }));
    assert.strictEqual(model.edges[0]?.kind, 'unresolved');
    assert.strictEqual(model.edges[0]?.to, undefined);
  });
});

describe('importsScanner — C# and Go', () => {
  it('records using directives as namespace kind (not file-resolvable)', () => {
    const model = scanImports(opts(['Program.cs'], {
      'Program.cs': 'using System;\nusing System.Collections.Generic;\nusing static System.Math;',
    }));
    assert.strictEqual(model.edges.length, 3);
    assert.ok(model.edges.every((e) => e.kind === 'namespace'));
    assert.strictEqual(model.counts.namespace, 3);
  });

  it('parses Go single and grouped imports; stdlib vs package vs local module', () => {
    const model = scanImports(opts(
      ['cmd/main.go', 'internal/server/server.go'],
      { 'cmd/main.go': 'import "fmt"\n\nimport (\n\tgin "github.com/gin-gonic/gin"\n\t"example.com/app/internal/server"\n)' },
      { goModulePath: 'example.com/app' }
    ));
    const bySpec = new Map(model.edges.map((e) => [e.spec, e]));
    assert.strictEqual(bySpec.get('fmt')?.kind, 'builtin');
    assert.strictEqual(bySpec.get('github.com/gin-gonic/gin')?.kind, 'package');
    const local = bySpec.get('example.com/app/internal/server');
    assert.ok(local);
    assert.strictEqual(local.kind, 'local');
    assert.strictEqual(local.to, 'internal/server');
  });
});

describe('importsScanner — honesty and limits', () => {
  it('files without imports contribute no edges', () => {
    const model = scanImports(opts(['README.md', 'styles.css'], { 'README.md': 'hello', 'styles.css': 'body{}' }));
    assert.strictEqual(model.edges.length, 0);
    assert.strictEqual(model.filesScanned, 2);
  });

  it('de-duplicates identical edges', () => {
    const model = scanImports(opts(['a.ts', 'x.ts'], { 'a.ts': "import './x';\nimport './x';\nrequire('./x');" }));
    assert.strictEqual(model.edges.length, 1);
    assert.strictEqual(model.counts.local, 1);
    assert.strictEqual(model.edges[0]?.to, 'x.ts');
  });

  it('respects the per-file import cap and flags truncation', () => {
    const specs = Array.from({ length: IMPORT_LIMITS.maxPerFile + 10 }, (_, i) => `import p${i} from 'pkg${i}';`).join('\n');
    const model = scanImports(opts(['a.ts'], { 'a.ts': specs }));
    assert.strictEqual(model.edges.length, IMPORT_LIMITS.maxPerFile);
    assert.strictEqual(model.truncated, true);
  });

  it('respects the total edge cap', () => {
    const contents: Record<string, string> = {};
    const files: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = `f${i}.ts`;
      files.push(p);
      contents[p] = Array.from({ length: 10 }, (_, j) => `import x from './x${j}';`).join('\n');
    }
    const model = scanImports(opts(files, contents, { maxEdges: 100, maxFiles: files.length + 1 }));
    assert.strictEqual(model.edges.length, 100);
    assert.strictEqual(model.truncated, true);
  });

  it('respects the file-count cap and counts skipped files', () => {
    const contents: Record<string, string> = {};
    const files: string[] = [];
    for (let i = 0; i < IMPORT_LIMITS.maxFiles + 3; i++) {
      const p = `f${i}.ts`;
      files.push(p);
      contents[p] = "import 'x';";
    }
    const model = scanImports(opts(files, contents));
    assert.strictEqual(model.filesScanned, IMPORT_LIMITS.maxFiles);
    assert.strictEqual(model.filesSkipped, 3);
    assert.strictEqual(model.truncated, true);
  });
});
