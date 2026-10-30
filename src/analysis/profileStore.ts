/**
 * Saves/loads the ProjectProfile in VS Code's per-workspace storage
 * (context.storageUri). Nothing leaves the machine.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ProjectProfile } from './profile';

const PROFILE_FILE = 'analysis.json';

function storageDir(context: vscode.ExtensionContext): string | undefined {
  if (!context.storageUri) return undefined; // no workspace storage (no folder open)
  return context.storageUri.fsPath;
}

export async function saveProfile(
  context: vscode.ExtensionContext,
  profile: ProjectProfile
): Promise<void> {
  const dir = storageDir(context);
  if (!dir) return;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, PROFILE_FILE), JSON.stringify(profile, null, 2), 'utf8');
}

export async function loadProfile(
  context: vscode.ExtensionContext
): Promise<ProjectProfile | undefined> {
  const dir = storageDir(context);
  if (!dir) return undefined;
  try {
    const raw = await fs.promises.readFile(path.join(dir, PROFILE_FILE), 'utf8');
    return JSON.parse(raw) as ProjectProfile;
  } catch {
    return undefined;
  }
}

export async function clearProfiles(context: vscode.ExtensionContext): Promise<void> {
  const dir = storageDir(context);
  if (!dir) return;
  try {
    await fs.promises.rm(path.join(dir, PROFILE_FILE), { force: true });
  } catch {
    // nothing to clear
  }
}
