/**
 * Symbol extraction (P3.2) — shared types, the pure regex FALLBACK extractor,
 * and the pure DocumentSymbol → SymbolInfo mapper.
 *
 * Honesty rules:
 * - every FileSymbols carries a `source` clearly distinguishing
 *   VS Code language-provider results from regex-fallback guesses;
 * - 'unsupported' marks file types no extractor covers;
 * - regex fallback is a heuristic: keywords inside comments or strings can
 *   match, and that is a documented, accepted limitation;
 * - nothing here claims complete language-level understanding;
 * - no code is executed — text is only pattern-matched.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 */

export type SymbolKindName =
  | 'class'
  | 'interface'
  | 'enum'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'variable'
  | 'constant'
  | 'type'
  | 'namespace'
  | 'struct'
  | 'other';

export interface SymbolInfo {
  name: string;
  kind: SymbolKindName;
  /** 1-based declaration line in the retained content. */
  line: number;
  /** 1-based end line when known (provider results only). */
  endLine?: number;
  /** Nearest enclosing declaration name, when apparent. */
  container?: string;
  /** Nested symbols where the source provides hierarchy. */
  children?: SymbolInfo[];
}

/** Where a file's symbols came from — never left implicit. */
export type SymbolSource = 'provider' | 'fallback' | 'unsupported';

export interface FileSymbols {
  relativePath: string;
  source: SymbolSource;
  symbols: SymbolInfo[];
  /** Present when per-file symbol storage was truncated (caps below). */
  truncated?: boolean;
}

/** Symbol entries kept per file and in total when persisted (profile bloat guard). */
export const SYMBOLS_PER_FILE_CAP = 60;
export const SYMBOLS_TOTAL_CAP = 600;

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

export type SymbolLanguage = 'tsLike' | 'python' | 'go' | 'csharp' | 'unsupported';

const EXT_TO_LANGUAGE: Readonly<Record<string, SymbolLanguage>> = {
  ts: 'tsLike', tsx: 'tsLike', js: 'tsLike', jsx: 'tsLike',
  mjs: 'tsLike', cjs: 'tsLike', vue: 'tsLike', svelte: 'tsLike',
  py: 'python',
  go: 'go',
  cs: 'csharp',
};

export function symbolsLanguageFor(relativePath: string): SymbolLanguage {
  const base = relativePath.split('/').pop() ?? relativePath;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return EXT_TO_LANGUAGE[ext] ?? 'unsupported';
}

// ---------------------------------------------------------------------------
// Regex fallback extraction
// ---------------------------------------------------------------------------

interface LineMatch {
  name: string;
  kind: SymbolKindName;
  line: number;
  indent: number;
  container?: string;
}

const KEYWORDS_NOT_METHODS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof',
  'new', 'delete', 'await', 'yield', 'do', 'else', 'try', 'void', 'case',
]);

/** Matches a TS/JS-ish method or function CALL-shaped declaration line. */
function matchTsLike(lineText: string, indent: number, container?: string): LineMatch | null {
  // class / interface / enum / type alias declarations
  let m = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'class', line: 0, indent, container };
  m = /^(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'interface', line: 0, indent, container };
  m = /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'enum', line: 0, indent, container };
  m = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'type', line: 0, indent, container };

  // top-level or container-scoped function declarations
  m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'function', line: 0, indent, container };

  // export const NAME = ... → constant (top-level exports are useful symbols)
  m = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/.exec(lineText);
  if (m?.[1] && indent === 0) return { name: m[1], kind: 'constant', line: 0, indent, container };

  // indented method declaration: modifiers? name(params) ... { on the same line.
  m = /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|override\s+|async\s+|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{=]+)?\{/.exec(
    lineText
  );
  if (m?.[1] && indent > 0 && !KEYWORDS_NOT_METHODS.has(m[1])) {
    return { name: m[1], kind: 'method', line: 0, indent, container };
  }
  return null;
}

function matchPython(lineText: string, indent: number): LineMatch | null {
  let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'function', line: 0, indent };
  m = /^class\s+([A-Za-z_]\w*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'class', line: 0, indent };
  return null;
}

function matchGo(lineText: string, indent: number): LineMatch | null {
  indent = 0; // Go declarations are top-level by convention
  let m = /^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)\)\s*([A-Za-z_]\w*)\s*\(/.exec(lineText);
  if (m?.[1] && m[2]) return { name: m[2], kind: 'method', line: 0, indent, container: m[1] };
  m = /^func\s+([A-Za-z_]\w*)\s*\(/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'function', line: 0, indent };
  m = /^type\s+([A-Za-z_]\w*)\s+struct\b/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'struct', line: 0, indent };
  m = /^type\s+([A-Za-z_]\w*)\s+interface\b/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'interface', line: 0, indent };
  m = /^type\s+([A-Za-z_]\w*)\s+/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'type', line: 0, indent };
  return null;
}

function matchCSharp(lineText: string, indent: number): LineMatch | null {
  let m = /^(?:public\s+|internal\s+|private\s+|\s)*namespace\s+([\w.]+)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'namespace', line: 0, indent };
  m = /^(?:public\s+|internal\s+|private\s+|protected\s+|abstract\s+|sealed\s+|static\s+|partial\s+|\s)*class\s+([A-Za-z_]\w*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'class', line: 0, indent };
  m = /^(?:public\s+|internal\s+|private\s+|\s)*interface\s+([A-Za-z_]\w*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'interface', line: 0, indent };
  m = /^(?:public\s+|internal\s+|\s)*enum\s+([A-Za-z_]\w*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'enum', line: 0, indent };
  m = /^(?:public\s+|internal\s+|\s)*(?:readonly\s+)?struct\s+([A-Za-z_]\w*)/.exec(lineText);
  if (m?.[1]) return { name: m[1], kind: 'struct', line: 0, indent };
  return null;
}

/**
 * Heuristic regex-based symbol extraction. Languages not covered yield
 * `source: 'unsupported'` with zero symbols — stated honestly, never guessed.
 */
export function extractSymbolsFromContent(relativePath: string, content: string): FileSymbols {
  const language = symbolsLanguageFor(relativePath);
  if (language === 'unsupported') {
    return { relativePath, source: 'unsupported', symbols: [] };
  }

  const out: SymbolInfo[] = [];
  // Python-style scope stack for real nesting; TS-like uses a single
  // container hint via indentation (documented heuristic).
  const scopeStack: Array<{ indent: number; name: string }> = [];
  const lines = content.split('\n');
  const maxLines = Math.min(lines.length, SYMBOLS_PER_FILE_CAP * 40); // scan guard
  let truncated = false;

  for (let i = 0; i < maxLines; i++) {
    const rawLine = lines[i] as string;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

    const noIndent = rawLine.replace(/^\s+/, '');
    const indent = indentOf(rawLine);

    let match: LineMatch | null;
    switch (language) {
      case 'tsLike': match = matchTsLike(noIndent, indent); break;
      case 'python': match = matchPython(noIndent, indent); break;
      case 'go': match = matchGo(noIndent, indent); break;
      case 'csharp': match = matchCSharp(noIndent, indent); break;
      default: match = null;
    }
    if (!match) continue;

    match.line = i + 1;

    // Container resolution.
    if (language === 'python') {
      while (
        scopeStack.length > 0 &&
        indent <= (scopeStack[scopeStack.length - 1] as { indent: number }).indent
      ) {
        scopeStack.pop();
      }
      const parent = scopeStack[scopeStack.length - 1];
      if (match.kind === 'function' && parent) match.kind = 'method';
      if (parent) match.container = (parent as { name: string }).name;
      if (match.kind === 'class') scopeStack.push({ indent, name: match.name });
    } else if (language === 'tsLike') {
      // Method detection: deeper indent than the nearest class/interface.
      if (match.kind === 'method') {
        // container comes from the nearest earlier declaration
        const parent = [...out].reverse().find(
          (s) =>
            (s.kind === 'class' || s.kind === 'interface' || s.kind === 'type') &&
            (s.endLine === undefined || s.endLine >= matchLineNo(match))
        );
        if (parent) match.container = parent.name;
      }
    }

    const info: SymbolInfo = { name: match.name, kind: match.kind, line: match.line };
    if (match.container !== undefined) info.container = match.container;
    if (out.length >= SYMBOLS_PER_FILE_CAP) {
      truncated = true;
      break;
    }
    out.push(info);
  }

  const fileSymbols: FileSymbols = { relativePath, source: 'fallback', symbols: out };
  if (truncated || lines.length > maxLines) fileSymbols.truncated = true;
  return fileSymbols;
}

function matchLineNo(match: LineMatch): number {
  return match.line;
}

/** Width of leading whitespace (tabs count as 4 for heuristic consistency). */
function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

// ---------------------------------------------------------------------------
// DocumentSymbol mapping (provider path)
// ---------------------------------------------------------------------------

/**
 * Structural subset of vscode.DocumentSymbol — lets the mapper stay pure and
 * unit-testable while remaining assignment-compatible with the real type.
 */
export interface DocumentSymbolLike {
  name: string;
  kind: number; // vscode.SymbolKind numeric values
  /**
   * Structural echo of vscode.Range: zero-based {line, character} objects.
   * (A real vscode.DocumentSymbol.range is assignment-compatible.)
   */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: DocumentSymbolLike[];
}

// vscode.SymbolKind numeric values (File=0 … TypeParameter=25)
const KIND_MAP: Readonly<Record<number, SymbolKindName>> = {
  0: 'other',       // File
  1: 'namespace',   // Module
  2: 'namespace',   // Namespace
  3: 'namespace',   // Package
  4: 'class',       // Class
  5: 'method',      // Method
  6: 'property',    // Property
  7: 'property',    // Field
  8: 'constructor', // Constructor
  9: 'enum',        // Enum
  10: 'interface',  // Interface
  11: 'function',   // Function
  12: 'variable',   // Variable
  13: 'constant',   // Constant
  14: 'other',      // String
  15: 'other',      // Number
  16: 'other',      // Boolean
  17: 'other',      // Array
  18: 'other',      // Object
  19: 'other',      // Key
  20: 'other',      // Null
  21: 'constant',   // EnumMember
  22: 'struct',     // Struct
  23: 'other',      // Event
  24: 'other',      // Operator
  25: 'type',       // TypeParameter
};

/**
 * Maps a (possibly nested) provider DocumentSymbol tree into our SymbolInfo
 * tree, labeling each child's `container` with its parent's name.
 */
export function mapDocumentSymbol(sym: DocumentSymbolLike, container?: string): SymbolInfo {
  const kind: SymbolKindName = KIND_MAP[sym.kind] ?? 'other';
  const info: SymbolInfo = {
    name: sym.name,
    kind,
    line: sym.range.start.line + 1, // provider ranges are 0-based; store 1-based
  };
  if (sym.range.end.line >= sym.range.start.line) {
    info.endLine = sym.range.end.line + 1;
  }
  if (container !== undefined && container.length > 0) info.container = container;
  if (Array.isArray(sym.children) && sym.children.length > 0) {
    info.children = sym.children.map((child) =>
      mapDocumentSymbol(child, sym.name)
    );
  }
  return info;
}

/** Flattens nested SymbolInfo trees to a bounded list (profile bloat guard). */
export function flattenSymbols(
  symbols: readonly SymbolInfo[],
  cap: number = SYMBOLS_PER_FILE_CAP
): { symbols: SymbolInfo[]; truncated: boolean } {
  const out: SymbolInfo[] = [];
  let truncated = false;
  const walk = (list: readonly SymbolInfo[]): void => {
    for (const s of list) {
      if (out.length >= cap) {
        truncated = true;
        return;
      }
      out.push(s);
      if (s.children) walk(s.children);
    }
  };
  walk(symbols);
  return { symbols: out, truncated };
}
