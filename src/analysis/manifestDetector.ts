/**
 * Detects project manifests ("what kind of project is this?") from a walked
 * file list, and summarizes the most common one (package.json) without
 * adding any runtime dependencies.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 */
import type { WalkedFile } from './fileWalker';

export interface DetectedManifest {
  ecosystem: string;
  relativePath: string;
}

const MANIFEST_BASENAMES: Readonly<Record<string, string>> = {
  'package.json': 'node',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'setup.py': 'python',
  'setup.cfg': 'python',
  'go.mod': 'go',
  'cargo.toml': 'rust',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  'settings.gradle': 'java',
  'settings.gradle.kts': 'java',
  'composer.json': 'php',
  'gemfile': 'ruby',
  'pubspec.yaml': 'dart',
  'package.swift': 'swift',
};

const MANIFEST_EXTENSIONS: Readonly<Record<string, string>> = {
  '.csproj': 'dotnet',
  '.sln': 'dotnet',
};

export function detectManifests(files: readonly WalkedFile[]): DetectedManifest[] {
  const out: DetectedManifest[] = [];
  for (const file of files) {
    const base = (file.relativePath.split('/').pop() ?? file.relativePath).toLowerCase();
    let ecosystem: string | undefined = MANIFEST_BASENAMES[base];
    if (!ecosystem) {
      const dot = base.lastIndexOf('.');
      if (dot >= 0) ecosystem = MANIFEST_EXTENSIONS[base.slice(dot)];
    }
    if (ecosystem) out.push({ ecosystem, relativePath: file.relativePath });
  }
  return out;
}

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  scripts: string[];
  dependencies: string[];
  /** File paths mentioned as entry points (main/module/bin/star-script target). */
  entryCandidates: string[];
}

function asNameList(value: unknown, limit: number): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, limit);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Extracts file-ish tokens from a script value, e.g. "node server.js" → server.js. */
function scriptFileTokens(scriptValue: unknown): string[] {
  if (typeof scriptValue !== 'string') return [];
  const matches = scriptValue.match(/[\w@.\-/\\]+\.(?:m|c)?[jt]sx?/g);
  return (matches ?? []).map((t) => t.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/** Safe JSON.parse wrapper — malformed or exotic package.json never throws. */
export function summarizePackageJson(content: string): PackageJsonSummary | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  const root = data as Record<string, unknown>;
  const scriptsRaw = root['scripts'];
  const scripts =
    typeof scriptsRaw === 'object' && scriptsRaw !== null && !Array.isArray(scriptsRaw)
      ? Object.keys(scriptsRaw).slice(0, 30)
      : [];

  const dependencies = [
    ...asNameList(root['dependencies'], 30),
    ...asNameList(root['devDependencies'], 30),
  ];

  const entryCandidates: string[] = [];
  const pushEntry = (value: unknown): void => {
    const s = asString(value);
    if (s) entryCandidates.push(s.replace(/\\/g, '/').replace(/^\.\//, ''));
  };
  pushEntry(root['main']);
  pushEntry(root['module']);
  const bin = root['bin'];
  if (typeof bin === 'string') pushEntry(bin);
  if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    for (const key of Object.keys(bin).slice(0, 10)) {
      pushEntry((bin as Record<string, unknown>)[key]);
    }
  }
  for (const token of scriptFileTokens(scriptsRaw && typeof scriptsRaw === 'object' && !Array.isArray(scriptsRaw)
    ? (scriptsRaw as Record<string, unknown>)['start']
    : undefined)) {
    pushEntry(token);
  }

  const summary: PackageJsonSummary = {
    scripts,
    dependencies: [...new Set(dependencies)].slice(0, 40),
    entryCandidates,
  };
  const name = asString(root['name']);
  const version = asString(root['version']);
  if (name) summary.name = name;
  if (version) summary.version = version;
  return summary;
}

const WELL_KNOWN_ENTRY_FILES: readonly string[] = [
  'index.js', 'index.ts', 'main.js', 'main.ts', 'server.js', 'app.js',
  'src/index.js', 'src/index.ts', 'src/main.ts', 'index.tsx', 'src/index.tsx',
  'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py',
  'main.go', 'src/main.go', 'Main.java', 'Program.cs', 'lib/main.dart',
];

/** Picks entry points that actually exist in the walked file list. */
export function guessEntryPoints(
  files: readonly WalkedFile[],
  pkg: PackageJsonSummary | null
): string[] {
  const present = new Set(files.map((f) => f.relativePath));
  const out: string[] = [];
  const candidates = [...(pkg?.entryCandidates ?? []), ...WELL_KNOWN_ENTRY_FILES];
  for (const candidate of candidates) {
    if (out.length >= 10) break;
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (present.has(normalized) && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}
