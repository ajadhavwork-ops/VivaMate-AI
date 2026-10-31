import * as assert from 'assert';
import { buildFileInsights } from '../../src/analysis/fileInsightsQuery';
import type { ProjectProfile } from '../../src/analysis/profile';
import type { ContentLayerData } from '../../src/analysis/profile';
import type { FileContentMeta } from '../../src/analysis/contentReader';
import type { ImportsModel, ImportEdge } from '../../src/analysis/importsScanner';

// ---------------------------------------------------------------------------
// Fixtures (mirrors the real P3.2 structures; no shared helper exists yet)
// ---------------------------------------------------------------------------

function readMeta(relativePath: string, overrides: Partial<FileContentMeta> = {}): FileContentMeta {
  return {
    relativePath,
    status: 'ok',
    charsRead: 120,
    linesRead: 8,
    truncatedByLines: false,
    truncatedByChars: false,
    ...overrides,
  };
}

function edge(partial: Partial<ImportEdge> & { from: string; spec: string; kind: ImportEdge['kind'] }): ImportEdge {
  return { ...partial };
}

function importsModel(partial: Partial<ImportsModel> = {}): ImportsModel {
  return {
    edges: [],
    filesScanned: 1,
    filesSkipped: 0,
    truncated: false,
    counts: { local: 0, package: 0, builtin: 0, alias: 0, dynamic: 0, namespace: 0, unresolved: 0 },
    ...partial,
  };
}

function contentLayer(partial: Partial<ContentLayerData> = {}): ContentLayerData {
  return {
    meta: {
      files: [],
      filesRead: 0,
      filesUnreadable: 0,
      filesExcluded: 0,
      filesSkippedBudget: 0,
      filesSkippedCancellation: 0,
      truncatedFiles: 0,
      totalCharsRead: 0,
      budgetChars: 65_536,
      cancelled: false,
    },
    symbols: [],
    imports: importsModel(),
    configs: [],
    ...partial,
  };
}

function profile(partial: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-31T00:00:00Z',
    fingerprint: 'fingerprint0000',
    workspaceName: 'demo',
    totalFiles: 3,
    totalSizeBytes: 300,
    limitReached: false,
    allFiles: [],
    keyFiles: [],
    languages: [],
    manifests: [],
    entryPoints: [],
    ...partial,
  };
}

const POPULATED: ContentLayerData = contentLayer({
  meta: {
    files: [readMeta('src/service.ts'), readMeta('src/util.ts', { status: 'truncated', truncatedByLines: true })],
    filesRead: 2,
    filesUnreadable: 0,
    filesExcluded: 0,
    filesSkippedBudget: 0,
    filesSkippedCancellation: 0,
    truncatedFiles: 1,
    totalCharsRead: 240,
    budgetChars: 65_536,
    cancelled: false,
  },
  symbols: [
    {
      relativePath: 'src/service.ts',
      source: 'provider',
      symbols: [{ name: 'UserService', kind: 'class', line: 4 }],
    },
    {
      relativePath: 'src/painter.rs',
      source: 'unsupported',
      symbols: [],
    },
  ],
  imports: importsModel({
    edges: [
      edge({ from: 'src/service.ts', spec: './util', kind: 'local', to: 'src/util.ts' }),
      edge({ from: 'src/service.ts', spec: 'zod', kind: 'package' }),
      edge({ from: 'src/api.ts', spec: './service', kind: 'local', to: 'src/service.ts' }),
      edge({ from: 'src/api2.ts', spec: './service', kind: 'local', to: 'src/service.ts' }),
      edge({ from: 'src/service.ts', spec: './nowhere', kind: 'unresolved' }),
    ],
    counts: { local: 3, package: 1, builtin: 0, alias: 0, dynamic: 0, namespace: 0, unresolved: 1 },
  }),
  configs: [
    {
      relativePath: 'tsconfig.json',
      format: 'json',
      entries: [{ path: 'compilerOptions.target', type: 'string' }],
      truncated: false,
    },
  ],
});

describe('fileInsightsQuery — populated profile', () => {
  it('returns flags, read meta, symbols, imports and config for a known file', () => {
    const p = profile({
      allFiles: [{ relativePath: 'src/service.ts', sizeBytes: 100 }, { relativePath: 'src/util.ts', sizeBytes: 50 }],
      keyFiles: ['src/service.ts'],
      content: POPULATED,
    });
    const payload = buildFileInsights(p, 'src/service.ts');

    assert.strictEqual(payload.relativePath, 'src/service.ts');
    assert.strictEqual(payload.hasContentLayer, true);
    assert.strictEqual(payload.onRecord, true);
    assert.strictEqual(payload.selectedForAnalysis, true);
    assert.strictEqual(payload.readMeta?.linesRead, 8);
    assert.strictEqual(payload.symbols?.source, 'provider');
    assert.strictEqual(payload.symbols?.entries.length, 1);
    assert.strictEqual(payload.symbols?.entries[0]?.name, 'UserService');
    assert.strictEqual(payload.imports?.entries.length, 3, 'two outgoing specs (local counts: util + unresolved)');
    const localEntry = payload.imports?.entries.find((e) => e.spec === './util');
    assert.strictEqual(localEntry?.kind, 'local');
    assert.strictEqual(localEntry?.to, 'src/util.ts');
    assert.deepStrictEqual(payload.imports?.incoming, ['src/api.ts', 'src/api2.ts']);
    assert.strictEqual(payload.config, undefined, 'not a config file → no config section');
  });

  it('returns only the own config insight when the file IS a config file', () => {
    const p = profile({
      allFiles: [{ relativePath: 'tsconfig.json', sizeBytes: 60 }],
      content: POPULATED,
    });
    const payload = buildFileInsights(p, 'tsconfig.json');
    assert.ok(payload.config);
    assert.strictEqual(payload.config.format, 'json');
    assert.strictEqual(payload.config.entries.length, 1);
    assert.strictEqual(payload.symbols, undefined, 'config files never got symbols');
  });

  it('propagates truncation flags from the scan, and truncated read meta', () => {
    const layer = contentLayer({
      imports: importsModel({ truncated: true }),
      symbols: [{ relativePath: 'src/service.ts', source: 'fallback', symbols: [], truncated: true }],
    });
    const p = profile({
      allFiles: [{ relativePath: 'src/service.ts', sizeBytes: 10 }],
      content: layer,
    });
    const payload = buildFileInsights(p, 'src/service.ts');
    assert.strictEqual(payload.importsTruncated, true);
    assert.strictEqual(payload.symbols?.truncated, true);
  });
});

describe('fileInsightsQuery — legacy / off-record / not-selected honesty', () => {
  it('flags a legacy profile (no content layer) with generous defaults unset', () => {
    const p = profile({
      allFiles: [{ relativePath: 'src/old.ts', sizeBytes: 10 }],
      keyFiles: ['src/old.ts'],
    });
    const payload = buildFileInsights(p, 'src/old.ts');
    assert.strictEqual(payload.hasContentLayer, false);
    assert.strictEqual(payload.onRecord, true);
    assert.strictEqual(payload.symbols, undefined);
    assert.strictEqual(payload.imports, undefined);
    assert.strictEqual(payload.importsTruncated, undefined);
    assert.strictEqual(payload.readMeta, undefined);
    // selectedForAnalysis keys off plan/read data or keyFiles membership;
    // without the content layer only keyFiles can say yes. The UI's legacy
    // notice takes precedence over this flag either way.
    assert.strictEqual(payload.selectedForAnalysis, true);
  });

  it('unknown path is off-record entirely', () => {
    const p = profile({ content: POPULATED });
    const payload = buildFileInsights(p, 'src/newfile.ts');
    assert.strictEqual(payload.onRecord, false);
    assert.strictEqual(payload.selectedForAnalysis, false);
    assert.strictEqual(payload.symbols, undefined);
  });

  it('a kept file outside the plan is onRecord but not selected', () => {
    const p = profile({
      allFiles: [{ relativePath: 'docs/notes.md', sizeBytes: 400 }],
      content: POPULATED, // read meta only covers src/service.ts + src/util.ts
    });
    const payload = buildFileInsights(p, 'docs/notes.md');
    assert.strictEqual(payload.onRecord, true);
    assert.strictEqual(payload.selectedForAnalysis, false);
    assert.strictEqual(payload.readMeta, undefined);
    // imports are still provided (the layer exists) but empty for THIS file
    assert.ok(payload.imports);
    assert.strictEqual(payload.imports.entries.length, 0);
    assert.deepStrictEqual(payload.imports.incoming, []);
  });

  it('no profile at all yields the fully-empty honest payload', () => {
    const payload = buildFileInsights(undefined, 'src/anything.ts');
    assert.deepStrictEqual(payload, {
      relativePath: 'src/anything.ts',
      hasContentLayer: false,
      onRecord: false,
      selectedForAnalysis: false,
    });
  });

  it('unsupported-language files still surface their source label with zero entries', () => {
    const p = profile({
      allFiles: [{ relativePath: 'src/painter.rs', sizeBytes: 20 }],
      keyFiles: ['src/painter.rs'],
      content: POPULATED,
    });
    const payload = buildFileInsights(p, 'src/painter.rs');
    assert.strictEqual(payload.symbols?.source, 'unsupported');
    assert.strictEqual(payload.symbols?.entries.length, 0);
  });
});
