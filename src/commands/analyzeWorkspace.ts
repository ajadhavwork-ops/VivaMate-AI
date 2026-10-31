/**
 * `vivaMate.analyze` — walks the workspace and builds the ProjectProfile.
 *
 * Deterministic and private: only file names, sizes and a few small
 * manifests are read; ignore rules keep secrets/dependencies/build output
 * and binaries out of the picture before anything else happens.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelHost } from '../ui/panelHost';
import { createIgnoreRules } from '../analysis/ignoreRules';
import { walkWorkspace } from '../analysis/fileWalker';
import { resolveContentLimits, resolveScanLimits } from '../analysis/scanSettings';
import {
  detectManifests,
  guessEntryPoints,
  summarizePackageJson,
  type PackageJsonSummary,
} from '../analysis/manifestDetector';
import { buildContentPlan, type ContentPlanItem } from '../analysis/filePrioritizer';
import { readPlannedContent } from '../analysis/contentReader';
import { extractSymbolsFromContent, flattenSymbols, symbolsLanguageFor, SYMBOLS_TOTAL_CAP, type FileSymbols } from '../analysis/symbols';
import { tryProviderSymbols } from '../analysis/symbolsProvider';
import { scanImports } from '../analysis/importsScanner';
import { analyzeConfigFile, detectConfigFormat, CONFIG_LIMITS } from '../analysis/configInsights';
import { buildProfile, toSummary } from '../analysis/profile';
import { saveProfile } from '../analysis/profileStore';

const MAX_FILE_BYTES = 256 * 1024;

/**
 * Extra plan items for config-insight scanning (`.env.example` and other
 * recognized configuration formats the main content plan misses). They are
 * appended WITHIN the remaining content budget and the same maxFileLines
 * rule, so there is exactly ONE content budget — honesty preserved.
 */
function extendPlanWithConfigInsights(
  allFiles: ReadonlyArray<{ relativePath: string; sizeBytes: number }>,
  plan: readonly ContentPlanItem[],
  remainingChars: number
): ContentPlanItem[] {
  const inPlan = new Set(plan.map((p) => p.relativePath));
  const extras: ContentPlanItem[] = [];
  let budget = remainingChars;
  for (const file of allFiles) {
    if (extras.length >= CONFIG_LIMITS.extraScanFiles || budget <= 0) break;
    if (inPlan.has(file.relativePath)) continue;
    if (detectConfigFormat(file.relativePath) === 'unknown') continue;
    const maxChars = Math.min(4096, file.sizeBytes, budget);
    if (maxChars < 256) continue; // too large for the remaining budget — honestly skipped
    extras.push({ relativePath: file.relativePath, reason: 'config', maxChars });
    budget -= maxChars;
  }
  return extras;
}

export async function analyzeWorkspace(
  context: vscode.ExtensionContext,
  host: PanelHost
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    await vscode.window.showErrorMessage(
      'VivaMate: open a folder (workspace) first — there is nothing to analyze.'
    );
    return;
  }

  await host.postMessage({ type: 'analysisStarted' });

  try {
    const config = vscode.workspace.getConfiguration('vivaMate');
    const extraIgnores = config.get<string[]>('extraIgnores', []);
    // Content settings are validated defensively too — same rules as the
    // scan limits: non-numeric or extreme values fall back to safe defaults.
    const contentLimits = resolveContentLimits({
      analysisBudgetKb: config.get<unknown>('analysisBudgetKb'),
      maxFileLines: config.get<unknown>('maxFileLines'),
    });
    // Scan-limit settings are validated defensively (see scanSettings.ts):
    // invalid or extreme values fall back to safe defaults — never unlimited.
    const scanLimits = resolveScanLimits({
      maxFiles: config.get<unknown>('maxFiles'),
      maxDepth: config.get<unknown>('maxDepth'),
    });

    const rules = createIgnoreRules({ extraIgnores, maxFileBytes: MAX_FILE_BYTES });

    const walk = await walkWorkspace(folder.uri.fsPath, rules, {
      maxFiles: scanLimits.maxFiles,
      maxDepth: scanLimits.maxDepth,
    });
    const files = walk.files;

    const manifests = detectManifests(files);

    let pkg: PackageJsonSummary | null = null;
    const rootPkg = manifests.find(
      (m) => m.ecosystem === 'node' && m.relativePath.toLowerCase().endsWith('package.json')
    );
    if (rootPkg) {
      try {
        const content = await fs.promises.readFile(
          path.join(folder.uri.fsPath, rootPkg.relativePath),
          'utf8'
        );
        pkg = summarizePackageJson(content);
      } catch {
        pkg = null; // unreadable manifest — degrade gracefully
      }
    }

    const entryPoints = guessEntryPoints(files, pkg);

    let plan = buildContentPlan(files, manifests, entryPoints, {
      totalMaxChars: contentLimits.totalMaxChars,
      maxFileLines: contentLimits.maxFileLines,
    });
    // P3.2: add budget-safe config-insight files (.env.example etc.) so the
    // SAME content budget covers everything we read.
    const planAssigned = plan.reduce((sum, item) => sum + item.maxChars, 0);
    const extras = extendPlanWithConfigInsights(
      files,
      plan,
      contentLimits.totalMaxChars - planAssigned
    );
    plan = [...plan, ...extras];

    // --- P3.2 content layer --------------------------------------------------
    // One cancellation source covers the whole content pass; nothing cancels
    // it yet (UI hook arrives with a later phase) but every unit supports it.
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const contents = new Map<string, string>();
      const contentMeta = readPlannedContent(
        {
          root: folder.uri.fsPath,
          plan,
          files,
          rules,
          maxFileLines: contentLimits.maxFileLines,
          totalMaxChars: contentLimits.totalMaxChars,
          signal: cancellation.token,
        },
        (relativePath, content) => {
          contents.set(relativePath, content); // in-memory only, never persisted
        }
      );

      // Symbols: provider first, clearly-labeled regex fallback, honest
      // 'unsupported' when neither applies. Providers are expensive-ish, so
      // they are queried at most once per planned file.
      const symbols: FileSymbols[] = [];
      let symbolBudget = SYMBOLS_TOTAL_CAP;
      for (const item of plan) {
        if (symbolBudget <= 0) break;
        const language = symbolsLanguageFor(item.relativePath);
        const content = contents.get(item.relativePath);
        if (language === 'unsupported' && !content) continue;
        let fileSymbols: FileSymbols | null = null;
        if (language !== 'unsupported') {
          const providerSymbols = await tryProviderSymbols(
            vscode.Uri.joinPath(folder.uri, ...item.relativePath.split('/'))
          );
          if (providerSymbols) {
            const flat = flattenSymbols(providerSymbols);
            fileSymbols = {
              relativePath: item.relativePath,
              source: 'provider',
              symbols: flat.symbols.slice(0, symbolBudget),
              ...(flat.truncated ? { truncated: true } : {}),
            };
            symbolBudget -= flat.symbols.length;
          }
        }
        // No provider output → regex fallback on already-read content.
        if (!fileSymbols) {
          if (!content) continue; // not read (canceled/budget) — no guesswork
          const fallback = extractSymbolsFromContent(item.relativePath, content);
          if (fallback.source === 'unsupported' && fallback.symbols.length === 0) continue;
          const flat = flattenSymbols(fallback.symbols);
          fileSymbols = {
            relativePath: item.relativePath,
            source: fallback.source,
            symbols: flat.symbols.slice(0, symbolBudget),
            ...(fallback.truncated || flat.truncated ? { truncated: true } : {}),
          };
          symbolBudget -= flat.symbols.length;
        }
        symbols.push(fileSymbols);
      }

      // Imports: static scan of retained content against the kept-file set.
      const imports = scanImports({
        files: new Map(files.map((f) => [f.relativePath, f.sizeBytes] as const)),
        contents,
        maxFiles: plan.length,
      });

      // Config insights: structural only, from retained content.
      const configs = [];
      for (const item of plan) {
        const content = contents.get(item.relativePath);
        if (content === undefined) continue;
        const insight = analyzeConfigFile(item.relativePath, content);
        if (insight) configs.push(insight);
      }

      const profile = buildProfile({
        workspaceName: folder.name,
        files,
        manifests,
        pkgSummary: pkg,
        entryPoints,
        plan,
        limitReached: walk.limitReached,
        scan: walk.stats,
        content: { meta: contentMeta, symbols, imports, configs },
      });

      await saveProfile(context, profile);
      await host.postMessage({ type: 'analysis', payload: toSummary(profile) });

      await vscode.window.showInformationMessage(
        `VivaMate: analyzed ${profile.totalFiles} files (${profile.languages.length} languages). ` +
          'See the Overview tab in the VivaMate panel.'
      );
    } finally {
      cancellation.dispose();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await host.postMessage({ type: 'error', payload: { message } });
    await vscode.window.showErrorMessage(`VivaMate: analysis failed — ${message}`);
  }
}
