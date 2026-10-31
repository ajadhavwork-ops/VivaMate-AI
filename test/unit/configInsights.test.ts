import * as assert from 'assert';
import {
  analyzeConfigFile,
  detectConfigFormat,
} from '../../src/analysis/configInsights';

describe('configInsights — format detection', () => {
  it('detects supported formats', () => {
    assert.strictEqual(detectConfigFormat('package.json'), 'package-json');
    assert.strictEqual(detectConfigFormat('tsconfig.json'), 'json');
    assert.strictEqual(detectConfigFormat('config/settings.yaml'), 'yaml');
    assert.strictEqual(detectConfigFormat('Cargo.toml'), 'toml');
    assert.strictEqual(detectConfigFormat('pytest.ini'), 'ini');
    assert.strictEqual(detectConfigFormat('app.properties'), 'ini');
    assert.strictEqual(detectConfigFormat('.env.example'), 'env-example');
    assert.strictEqual(detectConfigFormat('.env.production.example'), 'env-example');
  });

  it('marks real .env files as env (never analyzed as example)', () => {
    assert.notStrictEqual(detectConfigFormat('.env'), 'env-example');
    assert.strictEqual(analyzeConfigFile('.env', 'A=1'), null);
  });
});

describe('configInsights — .env.example (key names ONLY, values NEVER)', () => {
  const content = [
    '# Server configuration',
    'PORT=3000',
    'DATABASE_URL=postgres://user:secretpw@host/db',
    'API_KEY=sk-live-abcdef123456',
    'FEATURE_FLAG=true',
    '',
    'MALformed line without key',
  ].join('\n');

  const insight = analyzeConfigFile('.env.example', content);

  it('returns an env-example insight', () => {
    assert.ok(insight);
    assert.strictEqual(insight.format, 'env-example');
  });

  it('captures key names but NEVER values', () => {
    const paths = insight?.entries.map((e) => e.path);
    assert.deepStrictEqual(paths, ['PORT', 'DATABASE_URL', 'API_KEY', 'FEATURE_FLAG']);
    assert.strictEqual(JSON.stringify(insight).includes('secretpw'), false);
    assert.strictEqual(JSON.stringify(insight).includes('sk-live'), false);
    assert.ok(insight?.entries.every((e) => e.type === 'env-key'));
    assert.ok(insight?.entries.every((e) => e.safeValue === undefined));
  });

  it('flags sensitive-looking key names conservatively', () => {
    assert.ok(insight?.entries.find((e) => e.path === 'DATABASE_URL')?.redacted);
    assert.ok(insight?.entries.find((e) => e.path === 'API_KEY')?.redacted);
    assert.strictEqual(insight?.entries.find((e) => e.path === 'PORT')?.redacted, undefined);
  });
});

describe('configInsights — JSON / package.json (deny by default)', () => {
  const pkg = {
    name: 'student-project',
    version: '1.2.3',
    type: 'module',
    license: 'MIT',
    scripts: { start: 'node server.js', deploy: 'script $SECRET_TOKEN_URL' },
    dependencies: { express: '^4.0.0' },
    config: { apiKey: 'AKIA-DO-NOT-LEAK', port: 8080 },
  };
  const insight = analyzeConfigFile('package.json', JSON.stringify(pkg, null, 2))!;

  it('parses and records structural key paths with types', () => {
    assert.strictEqual(insight.format, 'package-json');
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    assert.strictEqual(byPath.get('scripts')?.type, 'object');
    assert.strictEqual(byPath.get('dependencies')?.type, 'object');
    assert.strictEqual(byPath.get('config.port')?.type, 'number');
    assert.ok(byPath.has('dependencies.express'));
  });

  it('exposes only whitelisted safe metadata values (name/version/type/license)', () => {
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    assert.strictEqual(byPath.get('name')?.safeValue, 'student-project');
    assert.strictEqual(byPath.get('version')?.safeValue, '1.2.3');
    assert.strictEqual(byPath.get('license')?.safeValue, 'MIT');
    // deny: no other string value anywhere
    assert.strictEqual(byPath.get('scripts.start')?.safeValue, undefined);
    assert.ok(insight.entries.every((e) => !('safeValue' in e) || e.path.split('.').length === 1));
  });

  it('flags sensitive keys and denies their values even when structurally typed', () => {
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    const apiKeyEntry = byPath.get('config.apiKey');
    assert.ok(apiKeyEntry);
    assert.strictEqual(apiKeyEntry.redacted, true);
    assert.ok('AKIA-DO-NOT-LEAK'.length === 0 || JSON.stringify(insight).includes('AKIA-DO-NOT-LEAK') === false);
  });

  it('never leaks VALUES for unknown/unrecognized keys', () => {
    const serialized = JSON.stringify(insight);
    assert.ok(!serialized.includes('$SECRET_TOKEN_URL'));
    assert.ok(!serialized.includes('^4.0.0'));
    assert.ok(!serialized.includes('8080'));
    assert.ok(!serialized.includes('node server.js'));
  });

  it('reports naive JSON honestly as malformed', () => {
    const bad = analyzeConfigFile('broken.json', '{"a": 1,,');
    assert.ok(bad);
    assert.strictEqual(bad.malformed, true);
    assert.strictEqual(bad.entries.length, 0);
  });

  it('marks non-package JSON files with format json (still deny-by-default)', () => {
    const insight = analyzeConfigFile('tsconfig.json', '{"compilerOptions":{"target":"ES2022","paths":{}},"include":["src"]}')!;
    assert.strictEqual(insight.format, 'json');
    assert.ok(!JSON.stringify(insight).includes('ES2022'));
    assert.ok(insight.entries.some((e) => e.path === 'compilerOptions.target' && e.type === 'string'));
    assert.ok(insight.entries.some((e) => e.path === 'include' && e.type === 'array'));
  });
});

describe('configInsights — YAML (structural only)', () => {
  const yaml = [
    '# workflow',
    'app:',
    '  name: demo-app',
    '  port: 8080',
    '  debug: true',
    '  secrets:',
    '    api_key: "value-not-leaked"',
    '  services:',
    '    - web',
    '    - db',
  ].join('\n');
  const insight = analyzeConfigFile('docker-compose.yml', yaml)!;

  it('extracts nested key paths', () => {
    assert.strictEqual(insight.format, 'yaml');
    const paths = insight.entries.map((e) => e.path);
    assert.ok(paths.includes('app'));
    assert.ok(paths.includes('app.name'));
    assert.ok(paths.includes('app.secrets.api_key'));
    assert.ok(paths.includes('app.services'));
  });

  it('types scalars but NEVER emits their values', () => {
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    assert.strictEqual(byPath.get('app.name')?.type, 'string');
    assert.strictEqual(byPath.get('app.port')?.type, 'number');
    assert.strictEqual(byPath.get('app.debug')?.type, 'boolean');
    const serialized = JSON.stringify(insight);
    assert.ok(!serialized.includes('demo-app'));
    assert.ok(!serialized.includes('8080'));
    assert.ok(!serialized.includes('value-not-leaked'));
  });

  it('redacts sensitive keys', () => {
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    assert.strictEqual(byPath.get('app.secrets.api_key')?.redacted, true);
  });
});

describe('configInsights — TOML & INI', () => {
  it('walks TOML sections and keys without values', () => {
    const insight = analyzeConfigFile(
      'pyproject.toml',
      '[project]\nname = "student"\nversion = "0.1.0"\n\n[tool.pytest]\napi_token = "abc"'
    )!;
    assert.strictEqual(insight.format, 'toml');
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    assert.strictEqual(byPath.get('project')?.type, 'object');
    assert.ok(byPath.has('project.name'));
    assert.strictEqual(byPath.get('project.name')?.type, 'string');
    assert.strictEqual(byPath.get('tool.pytest')?.type, 'object');
    assert.strictEqual(byPath.get('tool.pytest.api_token')?.redacted, true);
    assert.ok(!JSON.stringify(insight).includes('student'));
    assert.ok(!JSON.stringify(insight).includes('abc'));
  });

  it('walks INI/properties without values', () => {
    const insight = analyzeConfigFile('config.ini', '[database]\nhost = localhost\ndb_password = hunter2')!;
    assert.strictEqual(insight.format, 'ini');
    const byPath = new Map(insight.entries.map((e) => [e.path, e]));
    assert.ok(byPath.has('database.host'));
    assert.strictEqual(byPath.get('database.db_password')?.redacted, true);
    assert.ok(!JSON.stringify(insight).includes('hunter2'));
    assert.ok(!JSON.stringify(insight).includes('localhost'));
  });
});

describe('configInsights — honesty', () => {
  it('returns null for unknown formats instead of guessing', () => {
    assert.strictEqual(analyzeConfigFile('data.csv', 'a,b\n1,2'), null);
    assert.strictEqual(analyzeConfigFile('main.go', 'package main'), null);
  });

  it('returns null for empty content', () => {
    assert.strictEqual(analyzeConfigFile('empty.json', '   \n'), null);
  });

  it('returns null for unrecognized YAML/INI content rather than fabricating entries', () => {
    assert.strictEqual(analyzeConfigFile('weird.yaml', '<<<<< not yaml at all >>>>>'), null);
  });

  it('marks entry truncation when caps are exceeded', () => {
    const many = JSON.stringify(Object.fromEntries(Object.entries({
      ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])),
    })));
    const insight = analyzeConfigFile('big.json', many)!;
    assert.strictEqual(insight.truncated, true);
    assert.ok(insight.entries.length <= 200);
  });
});
