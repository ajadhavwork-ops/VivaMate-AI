/**
 * Privacy-first exclusion engine for workspace analysis.
 *
 * Everything that could contain secrets, generated output, dependencies,
 * or large binaries is excluded BEFORE it can ever be selected for an
 * AI prompt or stored in an analysis profile.
 *
 * This module is pure (no `vscode` import) so unit tests can run in plain Node.
 */

export interface IgnoreOptions {
  /** User-configured extra globs (setting `vivaMate.extraIgnores`). */
  extraIgnores?: readonly string[];
  /** Files larger than this are excluded. Default: 256 KB. */
  maxFileBytes?: number;
}

export interface IgnoreRuleSet {
  ignoredDirNames: ReadonlySet<string>;
  binaryExtensions: ReadonlySet<string>;
  fileGlobs: readonly RegExp[];
  maxFileBytes: number;
}

/** Directory names excluded anywhere in the tree (case-insensitive). */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git', '.svn', '.hg',
  // dependencies
  'node_modules', 'bower_components', 'vendor', 'Pods', 'site-packages',
  // build output
  'dist', 'out', 'build', 'target', 'obj', 'dev-dist',
  // tooling caches / state
  'coverage', '.nyc_output', '.next', '.nuxt', '.output', '.turbo', '.cache',
  '.parcel-cache', '.expo', '.angular', '.svelte-kit', '.gradle', '.idea', '.vs',
  '.vscode-test', '.terraform', 'DerivedData',
  // python
  'venv', '.venv', '.tox', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.ipynb_checkpoints',
];

/** File-name globs excluded anywhere in the tree. */
export const DEFAULT_IGNORED_FILES: readonly string[] = [
  // secrets and credentials (safe "example" variants are kept — see below)
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks',
  '*.keystore', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  'credentials.*', 'secrets.*', '.npmrc', '.netrc', '.git-credentials', 'auth.json',
  // lock files and OS noise
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'poetry.lock', '.DS_Store', 'Thumbs.db', 'desktop.ini',
];

/** File extensions treated as binaries or large assets (no dot). */
export const DEFAULT_IGNORED_EXTENSIONS: readonly string[] = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'tif',
  'pdf', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'msi', 'deb', 'rpm', 'apk', 'appimage',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'avi', 'mov', 'mkv', 'webm',
  'wasm', 'pyc', 'pyo', 'class', 'jar', 'bin', 'dat', 'db',
  'sqlite', 'sqlite3', 'pdb', 'o', 'a', 'lib', 'node',
];

/** Files matching a secret-like glob but ending in one of these are kept. */
const SAFE_SECRET_VARIANTS = /\.(?:example|sample|template)$/i;

/**
 * Converts a small glob subset (used by `*.lock`, `.env.*`, `** /node_modules`
 * style directory globs, and `generated/**` suffix globs) into a
 * case-insensitive RegExp over POSIX-style paths.
 * Patterns without a `/` match the basename or any path segment.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string;
    if (ch === '?') {
      source += '[^/]'; // any single character except a path separator
      continue;
    }
    if (ch !== '*') {
      source += ch.replace(/[^a-zA-Z0-9_/-]/g, '\\$&');
      continue;
    }
    if (g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2; // consume "**/" — loop's i++ then lands on next char
      } else {
        source += '.*';
        i += 1;
      }
    } else {
      source += '[^/]*';
    }
  }
  const prefix = g.includes('/') ? '^' : '^(?:.*/)?';
  return new RegExp(prefix + source + '$', 'i');
}

export function createIgnoreRules(options: IgnoreOptions = {}): IgnoreRuleSet {
  const extraGlobs = (options.extraIgnores ?? []).map((g) => globToRegExp(g));
  return {
    ignoredDirNames: new Set(DEFAULT_IGNORED_DIRS.map((d) => d.toLowerCase())),
    binaryExtensions: new Set(DEFAULT_IGNORED_EXTENSIONS),
    fileGlobs: [...DEFAULT_IGNORED_FILES.map((g) => globToRegExp(g)), ...extraGlobs],
    maxFileBytes: options.maxFileBytes ?? 256 * 1024,
  };
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

export function isDirectoryIgnored(rules: IgnoreRuleSet, relativePath: string): boolean {
  const rp = toPosix(relativePath);
  for (const segment of rp.split('/')) {
    if (rules.ignoredDirNames.has(segment.toLowerCase())) return true;
  }
  return rules.fileGlobs.some((re) => re.test(rp));
}

export function isFileIgnored(
  rules: IgnoreRuleSet,
  relativePath: string,
  sizeBytes?: number
): boolean {
  const rp = toPosix(relativePath);
  for (const segment of rp.split('/')) {
    if (rules.ignoredDirNames.has(segment.toLowerCase())) return true;
  }

  const base = toPosix(rp).split('/').pop() ?? rp;
  const lowerBase = base.toLowerCase();
  const dot = lowerBase.lastIndexOf('.');
  const slash = lowerBase.lastIndexOf('/');
  const ext = dot > slash ? lowerBase.slice(dot + 1) : '';
  if (ext && rules.binaryExtensions.has(ext)) return true;

  if (rules.fileGlobs.some((re) => re.test(rp))) {
    // Keep safe variants such as .env.example — they document required config
    // without containing real secrets.
    return !SAFE_SECRET_VARIANTS.test(lowerBase);
  }

  if (sizeBytes !== undefined && sizeBytes > rules.maxFileBytes) return true;
  return false;
}
