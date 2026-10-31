import * as assert from 'assert';
import {
  extractSymbolsFromContent,
  mapDocumentSymbol,
  symbolsLanguageFor,
  flattenSymbols,
  SYMBOLS_PER_FILE_CAP,
  SYMBOLS_TOTAL_CAP,
  type DocumentSymbolLike,
} from '../../src/analysis/symbols';

const TS_LIKE = [
  'export interface User {',
  '  id: string;',
  '}',
  'export class UserService implements Repo {',
  '  private cache = new Map<string, User>();',
  '  load(id: string): User {',
  '    return this.cache.get(id) as User;',
  '  }',
  '  async save(user: User): Promise<void> {',
  '    this.cache.set(user.id, user);',
  '  }',
  '}',
  'export enum Kind { A, B }',
  'export type Config = Record<string, unknown>;',
  'function helper(x: number): number {',
  '  return x * 2;',
  '}',
  'export default function bootstrap() {',
  '  helper(2);',
  '}',
  'export const LIMIT = 10;',
].join('\n');

describe('symbols — language detection', () => {
  it('maps extensions to language families', () => {
    assert.strictEqual(symbolsLanguageFor('src/App.tsx'), 'tsLike');
    assert.strictEqual(symbolsLanguageFor('main.py'), 'python');
    assert.strictEqual(symbolsLanguageFor('cmd/server/main.go'), 'go');
    assert.strictEqual(symbolsLanguageFor('App.cs'), 'csharp');
  });

  it('marks unknown extensions as unsupported', () => {
    assert.strictEqual(symbolsLanguageFor('data/schema.sql'), 'unsupported');
    assert.strictEqual(symbolsLanguageFor('Makefile'), 'unsupported');
  });
});

describe('symbols — regex fallback (tsLike)', () => {
  const fileSymbols = extractSymbolsFromContent('src/service.ts', TS_LIKE);

  it('labels the result source as fallback', () => {
    assert.strictEqual(fileSymbols.source, 'fallback');
  });

  it('extracts classes, interfaces, enums, types, functions, methods and constants', () => {
    const byName = new Map(fileSymbols.symbols.map((s) => [s.name, s]));
    assert.strictEqual(byName.get('UserService')?.kind, 'class');
    assert.strictEqual(byName.get('User')?.kind, 'interface');
    assert.strictEqual(byName.get('Kind')?.kind, 'enum');
    assert.strictEqual(byName.get('Config')?.kind, 'type');
    assert.strictEqual(byName.get('helper')?.kind, 'function');
    assert.strictEqual(byName.get('LIMIT')?.kind, 'constant');
    assert.strictEqual(byName.get('load')?.kind, 'method');
    assert.strictEqual(byName.get('bcrypt'), undefined); // no invented names
  });

  it('attaches 1-based line info and containers for methods', () => {
    const byName = new Map(fileSymbols.symbols.map((s) => [s.name, s]));
    assert.strictEqual(byName.get('UserService')?.line, 4);
    assert.ok(byName.get('load')?.line && byName.get('load')!.line >= 5);
    assert.strictEqual(byName.get('load')?.container, 'UserService');
    assert.strictEqual(byName.get('helper')?.container, undefined);
  });

  it('does not confuse control-flow calls with methods', () => {
    const tricky = [
      'class A {',
      '  run() {',
      '    if (ok()) {',
      '      return done();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const names = extractSymbolsFromContent('a.ts', tricky).symbols.map((s) => s.name);
    assert.ok(names.includes('A'));
    assert.ok(names.includes('run'));
    assert.ok(!names.includes('ok'), 'calls must not become symbols');
    assert.ok(!names.includes('done'), 'calls must not become symbols');
  });
});

describe('symbols — regex fallback (python)', () => {
  const py = [
    '# top comment',
    'class Calculator:',
    '    history = []',
    '    def add(self, x, y):',
    '        return x + y',
    '    async def slow_run(self):',
    '        pass',
    '',
    'def standalone():',
    '    pass',
  ].join('\n');
  const fileSymbols = extractSymbolsFromContent('calc.py', py);

  it('nests methods under their class via container', () => {
    const byName = new Map(fileSymbols.symbols.map((s) => [s.name, s]));
    assert.strictEqual(byName.get('Calculator')?.kind, 'class');
    assert.strictEqual(byName.get('add')?.kind, 'method');
    assert.strictEqual(byName.get('add')?.container, 'Calculator');
    assert.strictEqual(byName.get('slow_run')?.kind, 'method');
    assert.strictEqual(byName.get('standalone')?.kind, 'function');
    assert.strictEqual(byName.get('standalone')?.container, undefined);
  });

  it('pops scope when dedent ends the class', () => {
    const later = 'class A:\n    def m(self):\n        pass\n\ndef top():\n    pass';
    const syms = extractSymbolsFromContent('m.py', later).symbols;
    const top = syms.find((s) => s.name === 'top');
    assert.ok(top);
    assert.strictEqual(top.kind, 'function');
    assert.strictEqual(top.container, undefined);
  });
});

describe('symbols — regex fallback (go & csharp)', () => {
  it('extracts go funcs with receiver as methods', () => {
    const go = [
      'package main',
      '',
      'func (s *Server) Start() error {',
      '\treturn nil',
      '}',
      '',
      'func main() {',
      '\t_ = &Server{}',
      '}',
      '',
      'type Config struct {',
      '\tPort int',
      '}',
      'type Handler interface {',
      '\tHandle(req Request) error',
      '}',
    ].join('\n');
    const fileSymbols = extractSymbolsFromContent('server.go', go);
    const byName = new Map(fileSymbols.symbols.map((s) => [s.name, s]));
    assert.strictEqual(byName.get('Start')?.kind, 'method');
    assert.strictEqual(byName.get('Start')?.container, 'Server');
    assert.strictEqual(byName.get('main')?.kind, 'function');
    assert.strictEqual(byName.get('Config')?.kind, 'struct');
    assert.strictEqual(byName.get('Handler')?.kind, 'interface');
  });

  it('extracts csharp classes, enums and namespaces (fallback without methods)', () => {
    const cs = [
      'namespace App.Core {',
      '  public class Engine {',
      '    public void Turn() {}',
      '  }',
      '  public enum Mode { On, Off }',
      '}',
    ].join('\n');
    const fileSymbols = extractSymbolsFromContent('Engine.cs', cs);
    const byName = new Map(fileSymbols.symbols.map((s) => [s.name, s]));
    assert.strictEqual(byName.get('App.Core')?.kind, 'namespace');
    assert.strictEqual(byName.get('Engine')?.kind, 'class');
    assert.strictEqual(byName.get('Mode')?.kind, 'enum');
  });
});

describe('symbols — unsupported languages are honest', () => {
  it('returns source "unsupported" with zero symbols — no guessing', () => {
    for (const [path, content] of [
      ['schema.sql', 'CREATE TABLE users (id INT);'],
      ['Makefile', 'all: build'],
      ['main.rs', 'fn main() {}'],
      ['style.css', 'body { margin: 0; }'],
    ] as Array<[string, string]>) {
      const fileSymbols = extractSymbolsFromContent(path, content);
      assert.strictEqual(fileSymbols.source, 'unsupported', path);
      assert.strictEqual(fileSymbols.symbols.length, 0, path);
    }
  });
});

describe('symbols — caps and scan guards', () => {
  it('caps symbols per file with an honest truncated flag', () => {
    const many = Array.from(
      { length: SYMBOLS_PER_FILE_CAP + 30 },
      (_, i) => `function f${i}() {}`
    ).join('\n');
    const fileSymbols = extractSymbolsFromContent('many.ts', many);
    assert.strictEqual(fileSymbols.symbols.length, SYMBOLS_PER_FILE_CAP);
    assert.strictEqual(fileSymbols.truncated, true);
  });

  it('caps deeply nested provider trees when flattened', () => {
    const leaf: DocumentSymbolLike = {
      name: 'x', kind: 6,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    let node: DocumentSymbolLike = leaf;
    for (let i = 0; i < SYMBOLS_TOTAL_CAP + 5; i++) {
      node = {
        name: `n${i}`, kind: 4,
        range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
        children: [node],
      };
    }
    const mapped = mapDocumentSymbol(node);
    const flat = flattenSymbols([mapped], SYMBOLS_TOTAL_CAP);
    assert.strictEqual(flat.symbols.length, SYMBOLS_TOTAL_CAP);
    assert.strictEqual(flat.truncated, true);
  });
});

describe('symbols — mapDocumentSymbol (provider path)', () => {
  it('maps kinds, 1-based lines and containers, preserving hierarchy', () => {
    const doc: DocumentSymbolLike = {
      name: 'Calculator',
      kind: 4, // vscode.SymbolKind.Class
      range: {
        start: { line: 3, character: 0 },
        end: { line: 19, character: 0 },
      },
      children: [
        {
          name: 'add',
          kind: 5, // vscode.SymbolKind.Method
          range: {
            start: { line: 4, character: 0 },
            end: { line: 7, character: 0 },
          },
        },
      ],
    };
    const mapped = mapDocumentSymbol(doc);
    assert.strictEqual(mapped.kind, 'class');
    assert.strictEqual(mapped.line, 4); // 0-based 3 → 1-based 4
    assert.strictEqual(mapped.endLine, 20);
    const child = mapped.children?.[0];
    assert.ok(child);
    assert.strictEqual(child.kind, 'method');
    assert.strictEqual(child.line, 5);
    assert.strictEqual(child.container, 'Calculator');
  });

  it('maps unknown kinds to the honest "other"', () => {
    const mapped = mapDocumentSymbol({
      name: 'mystery', kind: 999,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
    assert.strictEqual(mapped.kind, 'other');
  });
});
