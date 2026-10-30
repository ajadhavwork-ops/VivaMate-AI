/**
 * File category classification for the Project Explorer.
 * Pure logic — no DOM, no Node APIs — unit-testable in plain Node.
 *
 * Order of classification (first match wins):
 *   1. configuration (manifests + tooling configs + data formats)
 *   2. documentation
 *   3. assets (images, fonts, media, binaries — NEVER counted as code)
 *   4. source code
 *   5. other
 */

export type FileCategory = 'all' | 'source' | 'configuration' | 'documentation' | 'assets' | 'other';

export interface CategoryStat {
  id: Exclude<FileCategory, 'all'>;
  label: string;
  count: number;
}

export const CATEGORY_LABELS: Readonly<Record<Exclude<FileCategory, 'all'>, string>> = {
  source: 'Source Code',
  configuration: 'Configuration',
  documentation: 'Documentation',
  assets: 'Assets & Media',
  other: 'Other Files',
};

const EXT_ALIASES: Readonly<Record<string, string>> = {
  mjs: 'js', cjs: 'js', jsx: 'js', tsx: 'ts',
  hpp: 'cpp', cc: 'cpp', yml: 'yaml',
};

/** Programming / markup source extensions (explicitly excludes images, fonts, binaries). */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js', 'ts', 'py', 'java', 'cs', 'go', 'rs', 'rb', 'php', 'kt', 'kts',
  'swift', 'c', 'cpp', 'h', 'scala', 'dart', 'vue', 'svelte', 'html',
  'css', 'scss', 'less', 'sql', 'sh', 'bat', 'ps1', 'pl', 'lua', 'r',
]);

/** Documentation extensions. */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org', 'tex',
]);

/** Images, fonts, media, archives, binaries — always "assets", never source. */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'svg', 'avif',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // media
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'avi', 'mov', 'mkv', 'webm',
  // archives / binaries
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3',
  'jar', 'class', 'pyc', 'wasm', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx',
]);

/** Configuration data formats. */
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  'json', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'xml', 'plist', 'lock',
]);

/** Manifest basenames → always configuration. */
const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg',
  'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'composer.json', 'gemfile',
  'pubspec.yaml', 'package.swift', 'makefile', 'dockerfile', 'license',
]);

/** Tooling config file patterns (basename, case-insensitive). */
const CONFIG_PATTERNS: readonly RegExp[] = [
  /^tsconfig[^/]*\.json$/i, /^jsconfig\.json$/i, /^vitest\./i, /^vite\.config\./i,
  /^webpack\.config\./i, /^rollup\.config\./i, /^babel\.config\./i, /^eslint\./i,
  /^prettier\./i, /^tailwind\.config\./i, /^next\.config\./i, /^jest\.config\./i,
  /^angular\.json$/i, /^nest-cli\.json$/i, /^astro\.config\./i, /^\.gitignore$/i,
  /^\.editorconfig$/i, /^\.npmrc$/i, /^docker-compose[^/]*\.ya?ml$/i, /^pytest\.ini$/i,
  /^alembic\.ini$/i, /\.rc$/i,
];

function extensionOf(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot + 1) : '';
}

function baseNameOf(relativePath: string): string {
  return (relativePath.split('/').pop() ?? relativePath).toLowerCase();
}

/** Classifies one file by its relative path. Never returns 'all'. */
export function classifyFile(relativePath: string): Exclude<FileCategory, 'all'> {
  const base = baseNameOf(relativePath);

  if (MANIFEST_BASENAMES.has(base) || CONFIG_PATTERNS.some((re) => re.test(base))) {
    return 'configuration';
  }

  const rawExt = extensionOf(relativePath);
  const ext = EXT_ALIASES[rawExt] ?? rawExt;

  if (DOC_EXTENSIONS.has(ext)) return 'documentation';
  if (ASSET_EXTENSIONS.has(ext)) return 'assets';
  if (SOURCE_EXTENSIONS.has(ext)) return 'source';
  if (CONFIG_EXTENSIONS.has(ext)) return 'configuration';
  return 'other';
}

/** Counts per category in one pass. */
export function categorizeFiles(
  files: readonly { relativePath: string }[]
): CategoryStat[] {
  const counts: Record<Exclude<FileCategory, 'all'>, number> = {
    source: 0, configuration: 0, documentation: 0, assets: 0, other: 0,
  };
  for (const file of files) {
    counts[classifyFile(file.relativePath)] += 1;
  }
  const order: Array<Exclude<FileCategory, 'all'>> = [
    'source', 'configuration', 'documentation', 'assets', 'other',
  ];
  return order.map((id) => ({ id, label: CATEGORY_LABELS[id], count: counts[id] }));
}
