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
import {
  detectManifests,
  guessEntryPoints,
  summarizePackageJson,
  type PackageJsonSummary,
} from '../analysis/manifestDetector';
import { buildContentPlan } from '../analysis/filePrioritizer';
import { buildProfile, toSummary } from '../analysis/profile';
import { saveProfile } from '../analysis/profileStore';

const MAX_FILE_BYTES = 256 * 1024;

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
    const budgetKb = config.get<number>('analysisBudgetKb', 64);
    const maxFileLines = config.get<number>('maxFileLines', 150);

    const rules = createIgnoreRules({ extraIgnores, maxFileBytes: MAX_FILE_BYTES });

    const walk = await walkWorkspace(folder.uri.fsPath, rules);
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

    const plan = buildContentPlan(files, manifests, entryPoints, {
      totalMaxChars: Math.round(budgetKb * 1024),
      maxFileLines,
    });

    const profile = buildProfile({
      workspaceName: folder.name,
      files,
      manifests,
      pkgSummary: pkg,
      entryPoints,
      plan,
      limitReached: walk.limitReached,
    });

    await saveProfile(context, profile);
    await host.postMessage({ type: 'analysis', payload: toSummary(profile) });

    await vscode.window.showInformationMessage(
      `VivaMate: analyzed ${profile.totalFiles} files (${profile.languages.length} languages). ` +
        'See the Overview tab in the VivaMate panel.'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await host.postMessage({ type: 'error', payload: { message } });
    await vscode.window.showErrorMessage(`VivaMate: analysis failed — ${message}`);
  }
}
