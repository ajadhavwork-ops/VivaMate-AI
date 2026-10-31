/**
 * Overview tab — the polished Phase 2.2 dashboard.
 *
 * Functional contract with Phase 1 is unchanged: identical messages, the
 * same `AnalysisSummary` data (plus NEW OPTIONAL fields: totalSizeBytes,
 * fingerprint, technologies — all sourced from the real ProjectProfile,
 * never invented), identical openFile behavior.
 */
import { el } from '../dom';
import {
  card,
  chip,
  emptyState,
  fileLink,
  progressBar,
  skeleton,
} from '../components/primitives';
import { vscodeApi } from '../state';
import type { AnalysisSummary, WebviewToHostMessage } from '../../src/ui/messages';
import { formatBytes, middleTruncate, relativeTime } from '../utils/format';
import { buildScanNotice } from '../utils/scanStatus';

// ---------------------------------------------------------------------------
// Elements (exist in index.html)
// ---------------------------------------------------------------------------

const analyzeBtn = document.getElementById('analyzeBtn') as HTMLButtonElement | null;
const overviewEl = document.getElementById('overview') as HTMLElement | null;
const outputEl = document.getElementById('output') as HTMLElement | null;

let triggerAnalyze: () => void = () => {};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initOverview(onAnalyze: () => void): void {
  triggerAnalyze = onAnalyze;
  if (analyzeBtn) {
    analyzeBtn.classList.add('vm-btn', 'vm-btn--primary'); // re-skin
    analyzeBtn.addEventListener('click', onAnalyze);
  }
  outputEl?.classList.add('vm-log');
}

export function setBusy(busy: boolean): void {
  if (analyzeBtn) analyzeBtn.disabled = busy;
}

/** Small timestamped log row (analysis progress / errors). */
export function logEntry(text: string, kind: 'info' | 'error' = 'info'): void {
  if (!outputEl) return;
  const entry = el('div', { className: kind === 'error' ? 'entry entry--error' : 'entry' });
  entry.appendChild(el('span', { className: 'time', text: new Date().toLocaleTimeString() }));
  entry.appendChild(el('div', { text }));
  outputEl.appendChild(entry);
}

function openPath(path: string): void {
  void vscodeApi.postMessage({ type: 'openFile', payload: { path } } satisfies WebviewToHostMessage);
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** Polished skeleton while a fresh analysis is running. */
export function showOverviewLoading(): void {
  if (!overviewEl) return;
  overviewEl.hidden = false;
  overviewEl.replaceChildren(
    loadingBanner(),
    tileSkeleton(),
    card({ title: 'Languages' }).root,
    card({ title: 'Key files' }).root
  );
}

function loadingBanner(): HTMLElement {
  const banner = el('div', { className: 'vm-hero vm-hero--loading' });
  const spinner = el('div', { className: 'vm-spinner', attrs: { 'aria-hidden': 'true' } });
  const text = el('div', { className: 'vm-hero-text' });
  text.appendChild(el('h2', { className: 'vm-hero-title', text: 'Analyzing workspace…' }));
  text.appendChild(el('p', { className: 'vm-hero-sub', text: 'Walking files, detecting manifests, prioritizing key sources — nothing leaves your machine.' }));
  banner.appendChild(spinner);
  banner.appendChild(text);
  return banner;
}

function tileSkeleton(): HTMLElement {
  const tiles = el('div', { className: 'vm-tiles' });
  for (let i = 0; i < 4; i++) {
    const tile = el('div', { className: 'vm-tile vm-skeleton' });
    const line = el('div', { className: 'vm-skeleton-line vm-skeleton-line--auto' });
    line.style.width = '60%'; // numeric only
    line.style.margin = '10px auto'; // numeric only
    line.style.animationDelay = `${i * 100}ms`; // numeric only
    tile.appendChild(line);
    tiles.appendChild(tile);
  }
  return tiles;
}

/** Honest empty state shown when no analysis exists yet. */
export function renderOverviewEmpty(): void {
  if (!overviewEl) return;
  overviewEl.hidden = false;
  const state = emptyState({
    icon: 'dashboard',
    title: 'No analysis yet',
    hint: 'Build a private map of your project — languages, technologies, entry points and viva-ready key files.',
    action: { label: 'Analyze workspace' },
  });
  state.querySelector('button')?.addEventListener('click', () => triggerAnalyze());
  layoutEmptyShell(state);
}

/** Distinct error state with a working retry. */
export function renderOverviewError(message: string): void {
  if (!overviewEl) return;
  overviewEl.hidden = false;

  const retry = el('button', {
    className: 'vm-btn vm-btn--primary',
    text: 'Try again',
    attrs: { type: 'button' },
  });
  retry.addEventListener('click', () => triggerAnalyze());

  const errorCard = card({ icon: 'alert', title: 'Analysis failed' });
  errorCard.root.classList.add('vm-card--danger');
  errorCard.body.appendChild(el('p', { className: 'vm-error-message', text: message }));
  errorCard.body.appendChild(retry);

  layoutEmptyShell(errorCard.root);
}

function layoutEmptyShell(...blocks: Node[]): void {
  if (!overviewEl) return;
  const wrapper = el('div', { className: 'vm-empty-layout' });
  for (const block of blocks) wrapper.appendChild(block);
  overviewEl.replaceChildren(wrapper);
}

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------

export function renderAnalysis(summary: AnalysisSummary): void {
  if (!overviewEl) return;
  overviewEl.hidden = false;
  overviewEl.replaceChildren();
  overviewEl.setAttribute('aria-live', 'polite');

  overviewEl.appendChild(heroCard(summary));
  overviewEl.appendChild(tiles(summary));
  overviewEl.appendChild(languageCard(summary));
  overviewEl.appendChild(technologiesCard(summary));
  overviewEl.appendChild(entryPointsCard(summary));
  overviewEl.appendChild(keyFilesCard(summary));
  // Always show an honest scan status: complete (green) or partial (orange).
  overviewEl.appendChild(limitBanner(summary));
}

// --- Hero: name + freshness + fingerprint + status --------------------------

function heroCard(summary: AnalysisSummary): HTMLElement {
  const root = el('div', { className: 'vm-hero' });

  const titleRow = el('div', { className: 'vm-hero-titlerow' });
  titleRow.appendChild(el('h2', { className: 'vm-hero-title', text: summary.workspaceName }));
  const notice = buildScanNotice(summary);
  titleRow.appendChild(el('span', {
    className: `vm-pill ${notice.severity === 'ok' ? 'vm-pill--ok' : 'vm-pill--warning'}`,
    text: notice.severity === 'ok' ? 'scan complete' : 'partial scan',
  }));
  root.appendChild(titleRow);

  const meta = el('div', { className: 'vm-hero-meta' });
  const parts = [
    `${summary.totalFiles} files`,
    summary.totalSizeBytes !== undefined ? formatBytes(summary.totalSizeBytes) : undefined,
    `analyzed ${relativeTime(summary.generatedAt)}`,
  ].filter((p): p is string => p !== undefined);
  meta.appendChild(el('p', { className: 'vm-hero-sub', text: parts.join(' · ') }));
  const fingerprint = el('span', {
    className: 'vm-fingerprint',
    text: `◦ ${middleTruncate(summary.fingerprint ?? 'no fingerprint', 20)}`,
    attrs: { title: 'Project fingerprint — changes only when your project tree changes' },
  });
  meta.appendChild(fingerprint);
  root.appendChild(meta);

  return root;
}

// --- Metric tiles ------------------------------------------------------------

function tiles(summary: AnalysisSummary): HTMLElement {
  const container = el('div', { className: 'vm-tiles' });
  const tileData: Array<{ label: string; value: string; title?: string }> = [
    { label: 'Files', value: String(summary.totalFiles), title: 'Files kept after privacy filtering' },
    {
      label: 'Size',
      value: summary.totalSizeBytes !== undefined ? formatBytes(summary.totalSizeBytes) : '—',
      title: 'Total size of analyzed files',
    },
    { label: 'Languages', value: String(summary.languages.length), title: 'Distinct file types' },
    {
      label: 'Entry pts',
      value: String(summary.entryPoints.length),
      title: 'Likely program entry points',
    },
  ];
  for (const tile of tileData) {
    const node = el('div', { className: 'vm-tile', attrs: tile.title ? { title: tile.title } : {} });
    node.appendChild(el('span', { className: 'vm-tile-value', text: tile.value }));
    node.appendChild(el('span', { className: 'vm-tile-label', text: tile.label }));
    container.appendChild(node);
  }
  return container;
}

// --- Languages with share bars -------------------------------------------------

function languageCard(summary: AnalysisSummary): HTMLElement {
  if (summary.languages.length === 0) {
    const muted = card({ icon: 'explorer', title: 'Languages' });
    muted.body.appendChild(el('p', { className: 'vm-muted', text: 'No language files found in this workspace.' }));
    return muted.root;
  }

  const maxFiles = Math.max(1, ...summary.languages.map((l) => l.files));
  const totalBytes = summary.languages.reduce((sum, l) => sum + l.totalBytes, 0);
  const langCard = card({ icon: 'explorer', title: 'Languages' });
  const list = el('ul', { className: 'vm-barlist' });

  for (const lang of summary.languages) {
    const row = el('li', { className: 'vm-barlist-row' });
    row.appendChild(el('span', {
      className: 'vm-barlist-name',
      text: lang.name,
      attrs: { title: `${formatBytes(lang.totalBytes)} total` },
    }));

    const barWrap = el('div', { className: 'vm-barlist-barwrap' });
    const track = progressBar((lang.files / maxFiles) * 100, {
      label: `${lang.name}: ${lang.files} files`,
    });
    track.classList.add('vm-barlist-bar');
    barWrap.appendChild(track);
    row.appendChild(barWrap);

    const share = totalBytes > 0 ? Math.round((lang.totalBytes / totalBytes) * 100) : 0;
    row.appendChild(el('span', {
      className: 'vm-barlist-count',
      text: `${lang.files}`,
      attrs: { title: `${lang.files} file${lang.files === 1 ? '' : 's'} · ${formatBytes(lang.totalBytes)} · ~${share}% of code by size` },
    }));
    list.appendChild(row);
  }
  langCard.body.appendChild(list);
  return langCard.root;
}

// --- Technologies (REAL dependency names only) ----------------------------------

function technologiesCard(summary: AnalysisSummary): HTMLElement {
  const hasTech = (summary.technologies?.length ?? 0) > 0;
  if (!hasTech && summary.manifests.length === 0) {
    const muted = card({ icon: 'file', title: 'Technologies' });
    muted.body.appendChild(el('p', {
      className: 'vm-muted',
      text: 'No package manifest detected — technologies appear when a package.json (or similar) is present.',
    }));
    return muted.root;
  }

  const techCard = card({ icon: 'spark', title: 'Technologies' });
  const chips = el('div', { className: 'vm-chiprow' });
  for (const tech of summary.technologies ?? []) {
    chips.appendChild(chip(tech));
  }

  if (hasTech && summary.manifests.length > 0) {
    techCard.body.appendChild(chips);
    const divider = el('div', { className: 'vm-carddivider' });
    techCard.body.appendChild(divider);
    techCard.body.appendChild(el('h3', { className: 'vm-cardsubtitle', text: 'Detected manifests' }));
    const manifestChips = el('div', { className: 'vm-chiprow' });
    for (const manifest of summary.manifests) {
      manifestChips.appendChild(
        chip(`${manifest.ecosystem}: ${manifest.relativePath}`, () => openPath(manifest.relativePath))
      );
    }
    techCard.body.appendChild(manifestChips);
    techCard.body.appendChild(el('p', {
      className: 'vm-muted',
      text: 'Dependency names come from your package.json — click a manifest to verify.',
    }));
  } else if (hasTech) {
    techCard.body.appendChild(chips);
    techCard.body.appendChild(el('p', {
      className: 'vm-muted',
      text: 'Dependency names read from your package.json.',
    }));
  } else {
    techCard.body.appendChild(el('h3', { className: 'vm-cardsubtitle', text: 'Detected manifests' }));
    const manifestChips = el('div', { className: 'vm-chiprow' });
    for (const manifest of summary.manifests) {
      manifestChips.appendChild(
        chip(`${manifest.ecosystem}: ${manifest.relativePath}`, () => openPath(manifest.relativePath))
      );
    }
    techCard.body.appendChild(manifestChips);
  }
  return techCard.root;
}

// --- Entry points -------------------------------------------------------------------

function entryPointsCard(summary: AnalysisSummary): HTMLElement {
  const entryCard = card({ icon: 'play', title: 'Likely entry points' });
  if (summary.entryPoints.length === 0) {
    entryCard.body.appendChild(el('p', {
      className: 'vm-muted',
      text: 'No obvious entry points found — this is normal for libraries.',
    }));
    return entryCard.root;
  }
  entryCard.body.appendChild(fileList(summary.entryPoints));
  entryCard.body.appendChild(el('p', {
    className: 'vm-muted',
    text: 'Inferred from your manifest and conventional file names.',
  }));
  return entryCard.root;
}

// --- Key files ------------------------------------------------------------------------

function keyFilesCard(summary: AnalysisSummary): HTMLElement {
  const keyCard = card({ icon: 'file', title: `Key files${summary.keyFiles.length > 0 ? ` (${summary.keyFiles.length})` : ''}` });
  if (summary.keyFiles.length === 0) {
    keyCard.body.appendChild(el('p', {
      className: 'vm-muted',
      text: 'No key files selected yet — they appear after readability analysis.',
    }));
    return keyCard.root;
  }
  keyCard.body.appendChild(fileList(summary.keyFiles));
  keyCard.body.appendChild(el('p', {
    className: 'vm-muted',
    text: 'Prioritized for AI grounding — click to open.',
  }));
  return keyCard.root;
}

// --- Scan-status banner (honest, telemetry-driven) -------------------------------------

function limitBanner(summary: AnalysisSummary): HTMLElement {
  const notice = buildScanNotice(summary);
  const severityClass =
    notice.severity === 'warning'
      ? 'vm-banner--warning'
      : notice.severity === 'partial'
        ? 'vm-banner--warning'
        : 'vm-banner--ok';

  const banner = el('div', { className: `vm-banner ${severityClass}`, attrs: { role: 'status' } });
  banner.appendChild(el('span', { className: 'vm-banner-dot' }));
  const text = el('div', { className: 'vm-banner-text' });
  for (const line of notice.lines) {
    text.appendChild(el('p', { className: 'vm-banner-text-item', text: line }));
  }
  banner.appendChild(text);
  return banner;
}

// --- File list helper ------------------------------------------------------------------------

function fileList(paths: readonly string[]): HTMLElement {
  const list = el('ul', { className: 'vm-filelist' });
  for (const path of paths) {
    list.appendChild(el('li', { children: [fileLink(path, openPath)] }));
  }
  return list;
}
