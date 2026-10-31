/**
 * Static import scanner (P3.2) — lightweight pattern-matching import
 * detection. NO code execution, NO heavyweight parsing, NO runtime deps.
 *
 * Supported per language:
 * - JS/TS(+/mdx-ish siblings): import … from 'x', export … from 'x',
 *   side-effect `import 'x'`, require('x'), and statically-string-literal
 *   dynamic `import('x')` (kind 'dynamic').
 * - Python: `import a.b` and `from a import …` (incl. relative dots).
 * - C#: `using` directives (kind 'namespace' — aspires are not file targets
 *   and are honestly never resolved).
 * - Go: single and grouped `import` declarations, with best-effort local
 *   module resolution when the go.mod module path is known.
 *
 * Resolution is best-effort against the ALREADY-KEPT file list only:
 * - relative JS/TS specs try exact, extension (.ts/.tsx/.js/.jsx/.mjs/.cjs),
 *   and /index.* conventions;
 * - Python modules try `<name>.py` and `<name>/__init__.py`;
 * - everything unresolvable is reported unresolved (kind 'unresolved') —
 *   targets are NEVER invented;
 * - path aliases (@/, ~/) are marked kind 'alias' (unresolved by design —
 *   tsconfig paths are not interpreted here; documented limitation);
 * - npm/@scope package specs are kind 'package', Node builtins kind
 *   'builtin', Python stdlib kind 'builtin'.
 *
 * Duplicate edges are removed; hard caps guard memory on large workspaces.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 */

export type ImportKind =
  | 'local'      // resolved to a project-local file target via `to`
  | 'package'    // external dependency specifier
  | 'builtin'    // known standard-library module
  | 'alias'      // path alias (@/, ~/) — unresolved by design
  | 'dynamic'    // statically-identifiable dynamic import
  | 'namespace'  // C#-style using directive (no file target exists)
  | 'unresolved'; // relative/local-looking but unresolvable — honest

export interface ImportEdge {
  /** Importing file (POSIX relative path). */
  from: string;
  /** Resolved project-local target — set ONLY for kind 'local'. */
  to?: string;
  kind: ImportKind;
  /** The literal import specifier as written. */
  spec: string;
}

export interface ImportsModel {
  /** De-duplicated edges, insertion order preserved. */
  edges: ImportEdge[];
  filesScanned: number;
  /** Files containing imports but skipped due to per-file caps. */
  filesSkipped: number;
  /** True when ANY cap cut results (per-file, total, or file count). */
  truncated: boolean;
  counts: Readonly<Record<
    'local' | 'package' | 'builtin' | 'alias' | 'dynamic' | 'namespace' | 'unresolved',
    number
  >>;
}

export interface ImportScanOptions {
  /** Map of kept files (relative POSIX path → irrelevant value). */
  files: ReadonlyMap<string, unknown>;
  /** Retained content per file (from the content reader — never persisted). */
  contents: ReadonlyMap<string, string>;
  /** go.mod module path for Go local-import resolution (optional). */
  goModulePath?: string;
  maxFiles?: number;
  maxEdges?: number;
  maxPerFile?: number;
}

export const IMPORT_LIMITS = {
  maxFiles: 200,
  maxEdges: 2000,
  maxPerFile: 100,
} as const;

const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'fs', 'path', 'http', 'https', 'os', 'util', 'crypto', 'events', 'stream',
  'url', 'child_process', 'worker_threads', 'buffer', 'process', 'cluster',
  'net', 'dns', 'tls', 'zlib', 'readline', 'assert', 'perf_hooks', 'node:fs',
]);

const PY_STDLIB: ReadonlySet<string> = new Set([
  'os', 'sys', 'json', 'math', 're', 'typing', 'datetime', 'collections',
  'itertools', 'functools', 'logging', 'argparse', 'pathlib', 'subprocess',
  'unittest', 'io', 'time', 'random', 'enum', 'abc', 'dataclasses', 'csv',
]);

const JS_CODE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;

// ---------------------------------------------------------------------------
// Regex extractors (line/statistical-pattern based — heuristic, documented)
// ---------------------------------------------------------------------------

function extractJsSpecs(content: string): Array<{ spec: string; dynamic: boolean }> {
  const dyn = new Map<string, boolean>();
  const add = (spec: string | undefined, dynamic: boolean): void => {
    if (!spec) return;
    dyn.set(spec, (dyn.get(spec) ?? false) || dynamic);
  };
  // import … from 'x'   (multi-word captures within the clause)
  for (const m of content.matchAll(/import\s+(?:[\w$*{},\s]+?)\s+from\s+['"]([^'"]+)['"]/g)) add(m[1], false);
  // export … from 'x'
  for (const m of content.matchAll(/export\s+(?:[\w$*{},\s]+?)\s+from\s+['"]([^'"]+)['"]/g)) add(m[1], false);
  // export * from 'x'
  for (const m of content.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) add(m[1], false);
  // side-effect import  import 'x'
  for (const m of content.matchAll(/import\s+['"]([^'"]+)['"]/g)) add(m[1], false);
  // require('x')
  for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], false);
  // dynamic import with a static string — statically identifiable → tagged
  for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], true);
  return [...dyn.entries()].map(([spec, dynamic]) => ({ spec, dynamic }));
}

function extractPySpecs(content: string): Array<{ spec: string; topLevel: boolean }> {
  const out: Array<{ spec: string; topLevel: boolean }> = [];
  for (const m of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s/gm)) {
    out.push({ spec: m[1] ?? '', topLevel: false });
  }
  for (const m of content.matchAll(/^\s*import\s+([\w., ]+)/gm)) {
    for (const part of (m[1] ?? '').split(',')) {
      const spec = part.trim().split(/\s+as\s+/)[0]?.trim() ?? '';
      if (spec) out.push({ spec, topLevel: true });
    }
  }
  return out;
}

function extractCsSpecs(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)/gm)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function extractGoSpecs(content: string): string[] {
  const out: string[] = [];
  // single: import "x"   | import alias "x"
  for (const m of content.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) {
    if (m[1]) out.push(m[1]);
  }
  // grouped block
  const block = /import\s*\(\s*([\s\S]*?)\)/.exec(content);
  if (block?.[1]) {
    for (const m of block[1].matchAll(/(?:[\w.]+\s+)?"([^"]+)"/g)) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

interface ResolvedSpec {
  kind: ImportKind;
  to?: string;
}

function isAlias(spec: string): boolean {
  return spec.startsWith('@/') || spec.startsWith('~/');
}

/** Best-effort relative resolution for JS/TS specs against the kept file set. */
function resolveJsRelative(from: string, spec: string, files: ReadonlyMap<string, unknown>): ResolvedSpec {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  // resolve ./ and ../ segments against the importing file's directory
  const parts: string[] = [];
  for (const seg of `${dir}/${spec}`.split('/')) {
    if (seg === '..') { parts.pop(); continue; }
    if (seg === '.' || seg === '') continue;
    parts.push(seg);
  }
  const base = parts.join('/');

  // 1. already-extensioned spec
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  if (JS_CODE_EXTS.includes(ext as (typeof JS_CODE_EXTS)[number]) && files.has(base)) {
    return { kind: 'local', to: base };
  }
  // 2. extension probing
  for (const e of JS_CODE_EXTS) {
    if (files.has(`${base}.${e}`)) return { kind: 'local', to: `${base}.${e}` };
  }
  // 3. index-file conventions
  for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.jsx']) {
    if (files.has(`${base}/${idx}`)) return { kind: 'local', to: `${base}/${idx}` };
  }
  return { kind: 'unresolved' };
}

/** Best-effort Python module resolution against the kept file set. */
function resolvePyModule(from: string, spec: string, files: ReadonlyMap<string, unknown>): ResolvedSpec {
  // count leading dots → relative depth
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  const name = dots > 0 ? spec.slice(dots) : spec;
  // dots inside the module name are package separators → directory segments
  const pathName = name.split('.').join('/');
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';

  if (dots === 0) {
    // Absolute imports: try PROJECT-ROOT-relative candidates first, then a
    // sibling-directory fallback (best effort for scripts run without a
    // package root on sys.path — documented behavior).
    for (const base of [pathName, `${dir}${dir ? '/' : ''}${pathName}`]) {
      if (files.has(`${base}.py`)) return { kind: 'local', to: `${base}.py` };
      if (files.has(`${base}/__init__.py`)) return { kind: 'local', to: `${base}/__init__.py` };
    }
    const top = spec.split('.')[0] ?? spec;
    if (PY_STDLIB.has(top)) return { kind: 'builtin' };
    return { kind: 'unresolved' };
  }

  // Relative (dotted) imports: walk up the tree from the importing file's dir.
  let base = dir;
  for (let i = 1; i < dots; i++) {
    base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  }
  if (!name) {
    // `from . import x` — current package internals; unresolved honestly
    return { kind: 'unresolved' };
  }
  if (base) {
    if (files.has(`${base}/${pathName}.py`)) return { kind: 'local', to: `${base}/${pathName}.py` };
    if (files.has(`${base}/${pathName}/__init__.py`)) return { kind: 'local', to: `${base}/${pathName}/__init__.py` };
  } else {
    if (files.has(`${pathName}.py`)) return { kind: 'local', to: `${pathName}.py` };
    if (files.has(`${pathName}/__init__.py`)) return { kind: 'local', to: `${pathName}/__init__.py` };
  }
  return { kind: 'unresolved' };
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

export function scanImports(options: ImportScanOptions): ImportsModel {
  const maxFiles = options.maxFiles ?? IMPORT_LIMITS.maxFiles;
  const maxEdges = options.maxEdges ?? IMPORT_LIMITS.maxEdges;
  const maxPerFile = options.maxPerFile ?? IMPORT_LIMITS.maxPerFile;

  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const counts = {
    local: 0, package: 0, builtin: 0, alias: 0, dynamic: 0, namespace: 0, unresolved: 0,
  };
  let filesScanned = 0;
  let filesSkipped = 0;
  let truncated = false;

  const push = (edge: ImportEdge): void => {
    if (edges.length >= maxEdges) {
      truncated = true;
      return;
    }
    const key = `${edge.from}|${edge.kind}|${edge.to ?? ''}|${edge.spec}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
    counts[edge.kind] += 1;
  };

  for (const relativePath of options.contents.keys()) {
    if (filesScanned >= maxFiles) {
      filesSkipped = options.contents.size - filesScanned;
      truncated = true;
      break;
    }
    const content = options.contents.get(relativePath) ?? '';
    const base = (relativePath.split('/').pop() ?? relativePath).toLowerCase();
    const dot = base.lastIndexOf('.');
    const lang = dot > 0 ? base.slice(dot + 1) : '';

    const collected: ImportEdge[] = [];

    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(lang)) {
      for (const { spec, dynamic } of extractJsSpecs(content)) {
        if (collected.length >= maxPerFile) { truncated = true; break; }
        collected.push(...classifyJs(relativePath, spec, options.files, dynamic));
      }
    } else if (lang === 'py') {
      for (const { spec } of extractPySpecs(content)) {
        if (collected.length >= maxPerFile) { truncated = true; break; }
        collected.push(classifyPy(relativePath, spec, options.files));
      }
    } else if (lang === 'cs') {
      for (const ns of extractCsSpecs(content)) {
        if (collected.length >= maxPerFile) { truncated = true; break; }
        collected.push({ from: relativePath, kind: 'namespace', spec: ns });
      }
    } else if (lang === 'go') {
      for (const spec of extractGoSpecs(content)) {
        if (collected.length >= maxPerFile) { truncated = true; break; }
        collected.push(classifyGo(spec, relativePath, options.files, options.goModulePath));
      }
    }

    if (collected.length >= maxPerFile && !truncated) truncated = true;
    filesScanned += 1;
    for (const edge of collected.slice(0, maxPerFile)) push(edge);
  }

  return {
    edges,
    filesScanned,
    filesSkipped,
    truncated,
    counts: { ...counts },
  };
}

function packageKind(spec: string): ResolvedSpec {
  if (isAlias(spec)) return { kind: 'alias' };
  if (spec.startsWith('/')) return { kind: 'unresolved' };
  if (NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.replace(/^node:/, '')) || spec.startsWith('node:')) {
    return { kind: 'builtin' };
  }
  // bare specifier → npm package (scoped or not); never resolved locally
  return { kind: 'package' };
}

function classifyJs(
  from: string,
  spec: string,
  files: ReadonlyMap<string, unknown>,
  dynamic: boolean
): ImportEdge[] {
  let kind: ImportKind = 'unresolved';
  let to: string | undefined;
  if (spec.startsWith('.')) {
    const r = resolveJsRelative(from, spec, files);
    kind = r.kind;
    to = r.to;
  } else {
    const r = packageKind(spec);
    kind = r.kind;
    to = r.to;
  }
  if (dynamic) {
    // Statically-identifiable dynamic import: resolution stays best-effort,
    // but the kind always labels the dynamic nature honestly.
    return [{ from, kind: 'dynamic', spec, ...(to !== undefined ? { to } : {}) }];
  }
  return [{ from, kind, spec, ...(to !== undefined ? { to } : {}) }];
}

function classifyPy(from: string, spec: string, files: ReadonlyMap<string, unknown>): ImportEdge {
  const r = resolvePyModule(from, spec, files);
  if (r.kind === 'local' && r.to) return { from, kind: 'local', spec, to: r.to };
  if (r.kind === 'builtin') return { from, kind: 'builtin', spec };
  return { from, kind: 'unresolved', spec };
}

function classifyGo(
  spec: string,
  from: string,
  files: ReadonlyMap<string, unknown>,
  goModulePath?: string
): ImportEdge {
  // module-internal import: modulePath/xxx — best effort directory resolve
  if (goModulePath && spec.startsWith(`${goModulePath}/`)) {
    const rel = spec.slice(goModulePath.length + 1);
    const hasDir = [...files.keys()].some((k) => k.startsWith(`${rel}/`));
    if (hasDir) return { from, kind: 'local', spec, to: rel };
    return { from, kind: 'unresolved', spec };
  }
  // contains a dot (github.com/…) → external package; else stdlib (no dot)
  if (spec.includes('.')) return { from, kind: 'package', spec };
  return { from, kind: 'builtin', spec };
}
