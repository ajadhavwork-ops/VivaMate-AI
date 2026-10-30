import * as assert from 'assert';
import {
  createIgnoreRules,
  globToRegExp,
  isDirectoryIgnored,
  isFileIgnored,
} from '../../src/analysis/ignoreRules';

describe('ignoreRules — globToRegExp', () => {
  it('matches basename-style patterns at any depth', () => {
    const re = globToRegExp('*.lock');
    assert.ok(re.test('yarn.lock'));
    assert.ok(re.test('a/b/yarn.lock'));
    assert.ok(!re.test('yarn.locks'));
  });

  it('matches directory-name patterns at any depth', () => {
    const re = globToRegExp('**/node_modules');
    assert.ok(re.test('node_modules'));
    assert.ok(re.test('a/b/node_modules'));
    assert.ok(!re.test('a/node_modulesX'));
  });

  it('handles trailing **, ?, and regex-special characters', () => {
    assert.ok(globToRegExp('generated/**').test('generated/x/deep.ts'));
    assert.ok(globToRegExp('file?.ts').test('file1.ts'));
    assert.ok(!globToRegExp('file?.ts').test('file12.ts'));
    // dots inside a target name must be literal, not "any char"
    assert.ok(globToRegExp('.env.*').test('.env.local'));
    assert.ok(globToRegExp('.env.*').test('src/.env.local'));
    // critical false-positive guard: "environment.ts" must survive ".env.*"
    assert.ok(!globToRegExp('.env.*').test('src/environment.ts'));
  });
});

describe('ignoreRules — directory filtering', () => {
  const rules = createIgnoreRules();

  it('excludes dependency and build directories at any depth', () => {
    assert.ok(isDirectoryIgnored(rules, 'node_modules'));
    assert.ok(isDirectoryIgnored(rules, 'packages/app/node_modules'));
    assert.ok(isDirectoryIgnored(rules, 'dist'));
    assert.ok(isDirectoryIgnored(rules, '.git'));
  });

  it('keeps normal directories', () => {
    assert.ok(!isDirectoryIgnored(rules, 'src'));
    assert.ok(!isDirectoryIgnored(rules, 'src/components/ui'));
    assert.ok(!isDirectoryIgnored(rules, 'docs'));
  });
});

describe('ignoreRules — file filtering', () => {
  const rules = createIgnoreRules({ extraIgnores: ['generated/**'] });

  it('keeps ordinary source files', () => {
    assert.ok(!isFileIgnored(rules, 'src/app/main.ts', 800));
    assert.ok(!isFileIgnored(rules, 'README.md', 1200));
  });

  it('excludes secrets but keeps safe example variants', () => {
    assert.ok(isFileIgnored(rules, '.env', 500));
    assert.ok(isFileIgnored(rules, '.env.local', 500));
    assert.ok(isFileIgnored(rules, 'keys/id_rsa', 900));
    assert.ok(!isFileIgnored(rules, '.env.example', 500));
    assert.ok(!isFileIgnored(rules, 'config/.env.sample', 500));
  });

  it('excludes locked/generated file names and extra user globs', () => {
    assert.ok(isFileIgnored(rules, 'package-lock.json', 200_000));
    assert.ok(isFileIgnored(rules, 'yarn.lock', 50));
    assert.ok(isFileIgnored(rules, 'generated/tables.ts', 100));
    assert.ok(!isFileIgnored(rules, 'src/generated-data.ts', 100));
  });

  it('excludes binaries case-insensitively and oversized files', () => {
    assert.ok(isFileIgnored(rules, 'assets/logo.PNG', 10));
    assert.ok(isFileIgnored(rules, 'video.MOV', 10));
    assert.ok(isFileIgnored(rules, 'data.json', 256 * 1024 + 1));
    assert.ok(!isFileIgnored(rules, 'data.json', 256 * 1024));
  });

  it('excludes anything inside an ignored directory as a belt-and-braces check', () => {
    assert.ok(isFileIgnored(rules, 'node_modules/lib/index.js', 100));
  });
});
