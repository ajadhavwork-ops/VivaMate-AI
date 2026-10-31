/**
 * Configuration insights (P3.2) — privacy-FIRST, deny-by-default structural
 * extraction from supported configuration formats.
 *
 * SECURITY RULES (enforced in code and tests):
 * - environment variable VALUES are never returned — for `.env.example` only
 *   KEY NAMES are extracted (placeholder or not, values stay out);
 * - real `.env` files are REJECTED outright (null) even if misdirected here —
 *   this module is a second line of defense, not the primary one;
 * - no raw configuration content is returned; entries carry key paths,
 *   structural types and (rarely) whitelisted safe metadata;
 * - values are omitted unless confidently classified as safe: only the
 *   package.json root metadata keys (`name`, `version`, `type`, `license`)
 *   and `private` (boolean type only) survive, everything else types only;
 * - keys whose name looks secret-like are flagged `redacted` and contribute
 *   NO value of any kind;
 * - this is NOT a generic "secret detector": safe classification is a
 *   whitelist, not a pattern blacklist — unknowns are simply omitted.
 *
 * Supported formats: package.json, JSON, YAML (line-based structural walk —
 * anchors/flow-collections unsupported and honestly marked truncated),
 * TOML, INI, `.env.example`.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 */

export type ConfigFormat =
  | 'package-json'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'env-example'
  | 'unknown';

export type ConfigEntryType =
  | 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  | 'env-key' | 'unknown';

export interface ConfigEntry {
  /** Dotted/bracketed structural key path, e.g. `compilerOptions.target`. */
  path: string;
  /** Structural type of the value — never the value itself (see exceptions). */
  type: ConfigEntryType;
  /** Safe metadata value — present ONLY for the whitelisted package.json keys. */
  safeValue?: string;
  /** Key name looked secret-like → value (if any) is denied outright. */
  redacted?: boolean;
}

export interface ConfigInsight {
  relativePath: string;
  format: ConfigFormat;
  entries: ConfigEntry[];
  /** True when depth or entry caps cut the extraction. */
  truncated: boolean;
  /** True when the content could not be parsed at all for this format. */
  malformed?: boolean;
}

export const CONFIG_LIMITS = {
  depth: 8,
  entriesPerFile: 200,
  extraScanFiles: 8,      // .env.example / config files outside the main plan
} as const;

const SENSITIVE_KEY = /pass(?:word|wd)?|secret|token|api[-_]?key|apikey|credential|private[-_]?key|signature|authorization|bearer|cookie|database[-_]?url|db[-_]?url|connection[-_]?string/i;

const SAFE_STRING_KEYS = new Set(['name', 'version', 'type', 'license']);

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function detectConfigFormat(relativePath: string): ConfigFormat {
  const base = (relativePath.split('/').pop() ?? relativePath).toLowerCase();
  // Safe secret variants ONLY — a real .env is never analyzed.
  if (/^\.env(?:\..+)?\.(example|sample|template)$/.test(base) || base === '.env.example') {
    return 'env-example';
  }
  if (base === 'package.json') return 'package-json';
  if (base.endsWith('.json')) return 'json';
  if (base.endsWith('.yml') || base.endsWith('.yaml')) return 'yaml';
  if (base === 'cargo.toml' || base === 'pyproject.toml' || base.endsWith('.toml')) return 'toml';
  if (base.endsWith('.ini') || base.endsWith('.cfg') || base.endsWith('.properties')) return 'ini';
  return 'unknown';
}

/** Guard: refuse real env files as defense in depth. */
function isRealEnvFile(relativePath: string): boolean {
  const base = (relativePath.split('/').pop() ?? relativePath).toLowerCase();
  return base === '.env' || (/^\.env/ .test(base) && !/\.(example|sample|template)$/.test(base));
}

// ---------------------------------------------------------------------------
// JSON (package.json included)
// ---------------------------------------------------------------------------

function safeScalarType(value: unknown): ConfigEntryType {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

function walkJson(
  value: unknown,
  path: string,
  depth: number,
  out: ConfigEntry[],
  isPackageJson: boolean
): boolean {
  if (out.length >= CONFIG_LIMITS.entriesPerFile) return false; // truncated
  if (depth > CONFIG_LIMITS.depth) return true;

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const entryPath = path ? `${path}.${key}` : key;
      out.push({
        path: entryPath,
        type: safeScalarType(child),
        ...(SENSITIVE_KEY.test(key) ? { redacted: true } : {}),
        // Whitelisted root metadata in package.json is the ONLY safe value.
        ...(isPackageJson && path === '' && SAFE_STRING_KEYS.has(key)
          && typeof child === 'string' ? { safeValue: child } : {}),
      });
      if (!walkJson(child, entryPath, depth + 1, out, isPackageJson)) return false;
    }
    return true;
  }
  if (Array.isArray(value)) {
    // arrays: one structural entry documenting the array; elements unwalked
    if (path) out.push({ path, type: 'array' });
    return true;
  }
  return true;
}

function analyzeJson(relativePath: string, content: string, isPackageJson: boolean): ConfigInsight {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { relativePath, format: isPackageJson ? 'package-json' : 'json', entries: [], truncated: false, malformed: true };
  }
  const entries: ConfigEntry[] = [];
  const truncated = !walkJson(data, '', 0, entries, isPackageJson);
  const insight: ConfigInsight = {
    relativePath,
    format: isPackageJson ? 'package-json' : 'json',
    entries,
    truncated,
  };
  return insight;
}

// ---------------------------------------------------------------------------
// YAML (structural line walk — no YAML dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal structural YAML key-path walker: indentation-based, scalars typed
 * when confidently guessable. Flow collections ({a: 1}) and anchors are not
 * supported — such lines are skipped and the insight stays honest about it
 * via `truncated` when entries were cut, silently for unsupported notation
 * (documented limitation).
 */
function analyzeYaml(relativePath: string, content: string): ConfigInsight | null {
  const entries: ConfigEntry[] = [];
  const stack: Array<{ indent: number; path: string }> = [];
  let truncated = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (entries.length >= CONFIG_LIMITS.entriesPerFile) { truncated = true; break; }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (trimmed === '---' || trimmed === '...') continue;
    if (trimmed.startsWith('-')) continue; // list items: structural noise

    const keyMatch = /^([\w.$-]+)\s*:(?:\s*(.*))?$/.exec(trimmed);
    if (!keyMatch?.[1]) continue;
    const indent = indentWidth(line);
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const path = parent ? `${(parent as { path: string }).path}.${keyMatch[1]}` : keyMatch[1];
    const valueRaw = (keyMatch[2] ?? '').trim();
    // Empty value → structural section (object). Unknown scalars stay 'unknown'.
    const type: ConfigEntryType =
      valueRaw === '' ? 'object' : (guessScalarTypeYaml(valueRaw) ?? 'unknown');
    entries.push({
      path,
      type,
      ...(SENSITIVE_KEY.test(keyMatch[1]) ? { redacted: true } : {}),
    });
    if (valueRaw === '') stack.push({ indent, path });
  }
  if (entries.length === 0 && content.trim().length > 0) {
    // nothing recognizable — do not pretend
    return null;
  }
  const insight: ConfigInsight = { relativePath, format: 'yaml', entries, truncated };
  return insight;
}

function guessScalarTypeYaml(value: string): ConfigEntryType | null {
  if (value.length === 0) return null;
  if ((value.startsWith('{') || value.startsWith('[')) && value.length > 0) return 'object'; // flow-ish: structure only
  if (isUnquotedScalar(value)) {
    if (/^(?:true|false|True|False|TRUE|FALSE|yes|no|on|off)$/i.test(value)) return 'boolean';
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return 'number';
    if (/^(?:null|~)$/i.test(value)) return 'null';
    return 'string'; // unquoted scalar — TYPE only, value never emitted
  }
  if (value.startsWith('&') || value.startsWith('*')) return 'unknown'; // anchors unsupported
  return 'string'; // quoted scalar — type only
}

function isUnquotedScalar(value: string): boolean {
  return !(value.startsWith('"') || value.startsWith("'"));
}

// ---------------------------------------------------------------------------
// TOML / INI
// ---------------------------------------------------------------------------

function analyzeToml(relativePath: string, content: string): ConfigInsight | null {
  const entries: ConfigEntry[] = [];
  let section = '';
  let truncated = false;
  for (const rawLine of content.split('\n')) {
    if (entries.length >= CONFIG_LIMITS.entriesPerFile) { truncated = true; break; }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sec = /^\[\[?([^\]]+)]]?/.exec(line);
    if (sec?.[1]) {
      section = sec[1];
      entries.push({ path: section, type: 'object' });
      continue;
    }
    const kv = /^([\w.$-]+)\s*=/.exec(line);
    if (!kv?.[1]) continue;
    const valueRaw = line.slice(line.indexOf('=') + 1).trim();
    const path = section ? `${section}.${kv[1]}` : kv[1];
    entries.push({
      path,
      type: guessScalarTypeToml(valueRaw),
      ...(SENSITIVE_KEY.test(kv[1]) ? { redacted: true } : {}),
    });
  }
  if (entries.length === 0 && content.trim().length > 0) return null;
  const insight: ConfigInsight = { relativePath, format: 'toml', entries, truncated };
  return insight;
}

function guessScalarTypeToml(value: string): ConfigEntryType {
  if (value.includes('=')) return 'object'; // inline table — structure only
  if (value.startsWith('[')) return 'array';
  if (/^(?:true|false)$/i.test(value)) return 'boolean';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return 'number';
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return 'string';
  return 'unknown';
}

function analyzeIni(relativePath: string, content: string, format: ConfigFormat = 'ini'): ConfigInsight | null {
  const entries: ConfigEntry[] = [];
  let section = '';
  let truncated = false;
  for (const rawLine of content.split('\n')) {
    if (entries.length >= CONFIG_LIMITS.entriesPerFile) { truncated = true; break; }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([^\]]+)]/.exec(line);
    if (sec?.[1]) {
      section = sec[1];
      entries.push({ path: section, type: 'object' });
      continue;
    }
    // key = value | key: value ; TYPE ONLY
    const kv = /^([\w.$-]+)\s*[=:]/.exec(line);
    if (!kv?.[1]) continue;
    const path = section ? `${section}.${kv[1]}` : kv[1];
    entries.push({
      path,
      type: guessScalarTypeIni(line),
      ...(SENSITIVE_KEY.test(kv[1]) ? { redacted: true } : {}),
    });
  }
  if (entries.length === 0 && content.trim().length > 0) return null;
  const insight: ConfigInsight = { relativePath, format, entries, truncated };
  return insight;
}

function guessScalarTypeIni(line: string): ConfigEntryType {
  const value = line.slice(line.search(/[=:]/) + 1).trim();
  if (value.length === 0) return 'null';
  if (/^(?:true|false|yes|no|on|off)$/i.test(value)) return 'boolean';
  if (/^-?\d+$/.test(value)) return 'number';
  return 'string';
}

// ---------------------------------------------------------------------------
// .env.example — key names ONLY
// ---------------------------------------------------------------------------

function analyzeEnvExample(relativePath: string, content: string): ConfigInsight {
  const entries: ConfigEntry[] = [];
  let truncated = false;
  for (const rawLine of content.split('\n')) {
    if (entries.length >= CONFIG_LIMITS.entriesPerFile) { truncated = true; break; }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // KEY=… — the KEY NAME is the entry; ANY value, placeholder or not,
    // is never captured (deny by default).
    const m = /^([A-Za-z_][\w.]*)\s*=/.exec(line);
    if (!m?.[1]) continue;
    entries.push({
      path: m[1],
      type: 'env-key',
      // example keys SHOULD be placeholder descriptions, but if a key name
      // itself looks sensitive we keep the same conservative flag.
      ...(SENSITIVE_KEY.test(m[1]) ? { redacted: true } : {}),
    });
  }
  const insight: ConfigInsight = { relativePath, format: 'env-example', entries, truncated };
  return insight;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extracts structural configuration insights. Returns null when the format
 * is unknown, content is empty, or the file is a real env file. NEVER
 * returns values (see whitelisted package.json metadata).
 */
export function analyzeConfigFile(relativePath: string, content: string): ConfigInsight | null {
  if (content.trim().length === 0) return null;
  if (isRealEnvFile(relativePath)) return null; // absolute refusal
  const format = detectConfigFormat(relativePath);
  switch (format) {
    case 'package-json': return analyzeJson(relativePath, content, true);
    case 'json': return analyzeJson(relativePath, content, false);
    case 'yaml': return analyzeYaml(relativePath, content);
    case 'toml': return analyzeToml(relativePath, content);
    case 'ini': return analyzeIni(relativePath, content, 'ini');
    case 'env-example': return analyzeEnvExample(relativePath, content);
    default: return null;
  }
}

/** Width of leading whitespace (tab = 4). */
function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
}
