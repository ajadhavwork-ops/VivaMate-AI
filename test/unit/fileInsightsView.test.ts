import * as assert from 'assert';
import {
  buildDetailModel,
  flattenSymbolTree,
  groupImports,
  symbolSourceLabel,
} from '../../webview-ui/utils/fileInsightsView';
import type { FileInsightsPayload } from '../../src/ui/messages';
import type { ImportEdge } from '../../src/analysis/importsScanner';

function payload(partial: Partial<FileInsightsPayload> = {}): FileInsightsPayload {
  return {
    relativePath: 'src/service.ts',
    hasContentLayer: true,
    onRecord: true,
    selectedForAnalysis: true,
    ...partial,
  };
}

function edge(partial: Partial<ImportEdge> & { spec: string; kind: ImportEdge['kind'] }): ImportEdge {
  return { from: 'src/service.ts', ...partial };
}

describe('fileInsightsView — groupImports', () => {
  it('groups by kind in presentation order with honest labels', () => {
    const groups = groupImports([
      edge({ spec: 'express', kind: 'package' }),
      edge({ spec: './util', kind: 'local', to: 'src/util.ts' }),
      edge({ spec: 'path', kind: 'builtin' }),
      edge({ spec: './nowhere', kind: 'unresolved' }),
      edge({ spec: '@/lib', kind: 'alias' }),
      edge({ spec: './late', kind: 'dynamic', to: 'src/late.ts' }),
      edge({ spec: 'System', kind: 'namespace' }),
    ]);
    assert.deepStrictEqual(
      groups.map((g) => g.id),
      ['local', 'package', 'builtin', 'dynamic', 'namespace', 'alias', 'unresolved']
    );
    const local = groups.find((g) => g.id === 'local');
    assert.strictEqual(local?.rows[0]?.to, 'src/util.ts');
    assert.strictEqual(groups.find((g) => g.id === 'unresolved')?.rows[0]?.to, undefined);
  });

  it('returns nothing for no imports', () => {
    assert.deepStrictEqual(groupImports([]), []);
  });

  it('carries resolved targets only where provided', () => {
    const groups = groupImports([
      edge({ spec: './a', kind: 'local', to: 'a.ts' }),
      edge({ spec: './b', kind: 'unresolved' }),
    ]);
    for (const g of groups) {
      for (const row of g.rows) {
        if (g.id === 'local') assert.strictEqual(row.to, 'a.ts');
        else assert.strictEqual(row.to, undefined);
      }
    }
  });
});

describe('fileInsightsView — flattenSymbolTree', () => {
  const tree = [
    {
      name: 'UserService', kind: 'class', line: 4,
      children: [
        { name: 'load', kind: 'method', line: 5, container: 'UserService' },
        { name: 'save', kind: 'method', line: 6, container: 'UserService' },
      ],
    },
    { name: 'main', kind: 'function', line: 10 },
  ];

  it('flattens with depth and preserves line/containers', () => {
    const { rows, seen, truncated } = flattenSymbolTree(tree);
    assert.strictEqual(truncated, false);
    assert.strictEqual(seen, rows.length);
    assert.strictEqual(rows.length, 4);
    const load = rows.find((r) => r.name === 'load');
    assert.ok(load);
    assert.strictEqual(load.depth, 1);
    assert.strictEqual(load.container, 'UserService');
    assert.strictEqual(load.line, 5);
    assert.strictEqual(rows.find((r) => r.name === 'main')?.depth, 0);
  });

  it('reports truncation honestly when the cap cuts the tree', () => {
    const { rows, seen, truncated } = flattenSymbolTree(tree, 3);
    assert.strictEqual(truncated, true);
    assert.strictEqual(rows.length, 3, 'rows capped');
    assert.strictEqual(seen, 4, 'traversal continued counting');
  });
});

describe('fileInsightsView — symbolSourceLabel', () => {
  it('labels all three sources and leaves undefined alone', () => {
    assert.strictEqual(symbolSourceLabel('provider'), 'VS Code language service');
    assert.strictEqual(symbolSourceLabel('fallback'), 'Pattern fallback (heuristic)');
    assert.strictEqual(symbolSourceLabel('unsupported'), 'Unsupported language');
    assert.strictEqual(symbolSourceLabel(undefined), undefined);
  });
});

describe('fileInsightsView — buildDetailModel: populated payload', () => {
  const p = payload({
    readMeta: { relativePath: 'src/service.ts', status: 'truncated', charsRead: 900, linesRead: 40, truncatedByLines: true, truncatedByChars: false },
    symbols: {
      source: 'provider',
      entries: [{ name: 'UserService', kind: 'class', line: 4 }],
    },
    imports: {
      entries: [
        edge({ spec: './util', kind: 'local', to: 'src/util.ts' }),
        edge({ spec: 'zod', kind: 'package' }),
      ],
      incoming: ['src/api.ts'],
    },
    config: undefined,
  });
  const model = buildDetailModel(p);

  it('produces no notices for a fully-populated file', () => {
    assert.deepStrictEqual(model.notices, []);
  });

  it('keeps grouped imports, incoming list and symbol rows', () => {
    assert.strictEqual(model.importGroups.length, 2);
    assert.deepStrictEqual(model.incoming, ['src/api.ts']);
    assert.strictEqual(model.symbolRows.length, 1);
    assert.strictEqual(model.symbolSource, 'provider');
    assert.strictEqual(model.symbolSourceLabel, 'VS Code language service');
    assert.strictEqual(model.readMeta?.status, 'truncated');
  });
});

describe('fileInsightsView — buildDetailModel: honest empty states', () => {
  it('legacy profile → the run-analysis-again warning, no fabricated data', () => {
    const model = buildDetailModel(payload({ hasContentLayer: false, selectedForAnalysis: false }));
    assert.strictEqual(model.notices[0]?.severity, 'warning');
    assert.ok(model.notices[0]?.text.includes('run the analysis again'));
    assert.strictEqual(model.symbolRows.length, 0);
    assert.strictEqual(model.importGroups.length, 0);
    assert.strictEqual(model.config, undefined);
  });

  it('off-record file → explains new/moved/excluded', () => {
    const model = buildDetailModel(payload({ onRecord: false }));
    const notice = model.notices.find((n) => n.text.includes('Not in the analyzed file record'));
    assert.ok(notice);
    assert.strictEqual(notice.severity, 'warning');
  });

  it('kept-but-unselected file → explains the budget, as info', () => {
    const model = buildDetailModel(payload({ selectedForAnalysis: false }));
    const notice = model.notices.find((n) => n.text.includes('not selected for deep reading'));
    assert.ok(notice);
    assert.strictEqual(notice.severity, 'info');
    // Without selection there is no symbol/import data collected — no extra
    // "missing" notices on top of the budget explanation.
    assert.ok(!model.notices.some((n) => n.text.includes('No symbols recorded')));
  });

  it('selected file without symbols → missing-data notice only (no unsupported claim)', () => {
    const model = buildDetailModel(payload({ symbols: undefined }));
    assert.ok(model.notices.some((n) => n.text.includes('No symbols recorded for this file')));
    assert.ok(!model.notices.some((n) => n.text.includes('not supported for symbol')));
  });

  it('unsupported language → explicit unsupported notice', () => {
    const model = buildDetailModel(
      payload({ symbols: { source: 'unsupported', entries: [] } })
    );
    assert.ok(model.notices.some((n) => n.text.includes('not supported for symbol extraction')));
    assert.strictEqual(model.symbolSource, 'unsupported');
    assert.strictEqual(model.symbolRows.length, 0);
  });

  it('truncation flags surface as notices (symbols + imports)', () => {
    const model = buildDetailModel(
      payload({
        symbols: { source: 'fallback', entries: [], truncated: true },
        imports: { entries: [], incoming: [] },
        importsTruncated: true,
      })
    );
    assert.ok(model.notices.some((n) => n.text.includes('Symbol list was truncated')));
    assert.ok(model.notices.some((n) => n.text.includes('import scan hit its limits')));
    assert.strictEqual(model.symbolsTruncated, true);
    assert.strictEqual(model.importsTruncated, true);
  });

  it('flat-truncation inside entries also flags (seen > shown)', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}`, kind: 'function' as const, line: i + 1 }));
    const model = buildDetailModel(payload({ symbols: { source: 'provider', entries: many } }));
    assert.strictEqual(model.symbolRows.length, 60);
    assert.strictEqual(model.symbolsTruncated, true);
    assert.ok(model.notices.some((n) => n.text.includes('Symbol list was truncated')));
  });

  it('a selected file with no imports still gets an honest empty structure', () => {
    const model = buildDetailModel(payload({ imports: { entries: [], incoming: [] } }));
    assert.strictEqual(model.importGroups.length, 0);
    assert.deepStrictEqual(model.incoming, []);
  });

  it('malformed config → warning notice; truncated config → info notice', () => {
    const model = buildDetailModel(
      payload({
        config: { relativePath: 'x.json', format: 'json', entries: [{ path: 'a', type: 'number' }], truncated: true },
      })
    );
    // Only truncated (not malformed) here.
    assert.ok(model.notices.some((n) => n.text.includes('Configuration entries were truncated')));
    assert.ok(!model.notices.some((n) => n.text.includes('could not be parsed')));

    const bad = buildDetailModel(
      payload({ config: { relativePath: 'x.json', format: 'json', entries: [], truncated: false, malformed: true } })
    );
    assert.ok(bad.notices.some((n) => n.text.includes('could not be parsed')));
  });

  it('redaction flag is preserved per config entry', () => {
    const model = buildDetailModel(
      payload({
        config: {
          relativePath: '.env.example',
          format: 'env-example',
          entries: [
            { path: 'PORT', type: 'env-key' },
            { path: 'API_KEY', type: 'env-key', redacted: true },
          ],
          truncated: false,
        },
      })
    );
    const apiKey = model.config?.entries.find((e) => e.path === 'API_KEY');
    assert.strictEqual(apiKey?.redacted, true);
    const port = model.config?.entries.find((e) => e.path === 'PORT');
    assert.strictEqual(port?.redacted, undefined);
  });
});
