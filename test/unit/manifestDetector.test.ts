import * as assert from 'assert';
import { detectManifests, guessEntryPoints, summarizePackageJson } from '../../src/analysis/manifestDetector';
import type { WalkedFile } from '../../src/analysis/fileWalker';

function f(relativePath: string, sizeBytes = 100): WalkedFile {
  return { relativePath, sizeBytes };
}

describe('manifestDetector — detectManifests', () => {
  it('recognizes well-known manifests by basename', () => {
    const out = detectManifests([f('package.json'), f('app/pyproject.toml'), f('go.mod')]);
    assert.deepStrictEqual(out, [
      { ecosystem: 'node', relativePath: 'package.json' },
      { ecosystem: 'python', relativePath: 'app/pyproject.toml' },
      { ecosystem: 'go', relativePath: 'go.mod' },
    ]);
  });

  it('recognizes dotnet manifests by extension', () => {
    const out = detectManifests([f('server/App.csproj'), f('something.sln')]);
    assert.deepStrictEqual(out.map((m) => m.ecosystem), ['dotnet', 'dotnet']);
  });

  it('ignores ordinary files', () => {
    assert.strictEqual(detectManifests([f('src/main.ts'), f('logo.png')]).length, 0);
  });
});

describe('manifestDetector — summarizePackageJson', () => {
  it('parses name, scripts, dependencies and entry candidates', () => {
    const summary = summarizePackageJson(
      JSON.stringify({
        name: 'my-app',
        version: '1.2.3',
        main: './out/main.js',
        bin: { 'my-cli': './bin/cli.js' },
        scripts: { start: 'node server.js', test: 'vitest' },
        dependencies: { express: '^4', lodash: '^4' },
        devDependencies: { vitest: '^1' },
      })
    );
    assert.ok(summary);
    assert.strictEqual(summary?.name, 'my-app');
    assert.strictEqual(summary?.version, '1.2.3');
    assert.ok(summary?.scripts.includes('start'));
    assert.ok(summary?.dependencies.includes('express'));
    assert.ok(summary?.dependencies.includes('vitest'));
    assert.ok(summary?.entryCandidates.includes('out/main.js'));
    assert.ok(summary?.entryCandidates.includes('bin/cli.js'));
    assert.ok(summary?.entryCandidates.includes('server.js'));
  });

  it('returns null for malformed JSON or non-object roots', () => {
    assert.strictEqual(summarizePackageJson('{not json'), null);
    assert.strictEqual(summarizePackageJson('[1,2,3]'), null);
  });
});

describe('manifestDetector — guessEntryPoints', () => {
  it('prefers manifest candidates but only keeps ones that exist', () => {
    const files = [f('src/index.ts'), f('server.js')];
    const pkg = summarizePackageJson(JSON.stringify({ main: 'missing.js' }));
    assert.ok(pkg);
    const out = guessEntryPoints(files, pkg);
    // missing.js is dropped; well-known server.js is found; src/index.ts found
    assert.ok(out.includes('server.js'));
    assert.ok(out.includes('src/index.ts'));
    assert.ok(!out.includes('missing.js'));
  });

  it('finds well-known entries without a manifest', () => {
    const out = guessEntryPoints([f('x.py'), f('manage.py')], null);
    assert.deepStrictEqual(out, ['manage.py']);
  });

  it('caps the list at 10', () => {
    // files exist for every well-known name → more than 10 matches, must cap
    const files = WELL_KNOWN.map((name) => f(name));
    const out = guessEntryPoints(files, null);
    assert.strictEqual(out.length, 10);
  });
});

const WELL_KNOWN = [
  'index.js', 'main.js', 'server.js', 'app.js', 'main.py', 'app.py', 'manage.py',
  'main.go', 'Main.java', 'Program.cs', 'index.ts', 'src/index.ts',
];
