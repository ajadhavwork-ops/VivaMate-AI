/**
 * Project Explorer tab (Phase 2.3 + 3.3).
 * Renders the actual, privacy-filtered file list carried by the analysis
 * profile — no extra rescans, no fabricated metadata.
 *
 * Interaction (VS Code Explorer semantics, P3.3):
 * - single click SELECTS a file → a per-file detail panel (symbols, imports,
 *   configuration insights) renders above the tree, fed by an on-demand
 *   `fileInsightsRequested` host round-trip;
 * - double click (or "Open in editor" in the detail header) opens the file
 *   in the editor via the existing `openFile` message;
 * - Escape closes the detail panel.
 *
 * One authoritative render pass per state change (search keystroke, category
 * click, folder toggle, selection): the DOM is rebuilt from pure tree data.
 */
import { el } from '../dom';
import { card, chip, emptyState, fileLink, skeleton } from '../components/primitives';
import { iconElement } from '../icons';
import { vscodeApi } from '../state';
import {
  buildTree,
  defaultExpandedPaths,
  expandableFolders,
  type ExplorerFile,
  type TreeNode,
} from '../utils/fileTree';
import { categorizeFiles, type FileCategory } from '../utils/fileCategories';
import { formatBytes } from '../utils/format';
import { buildScanNotice } from '../utils/scanStatus';
import { buildDetailModel } from '../utils/fileInsightsView';
import type { AnalysisSummary, FileInsightsPayload } from '../../src/ui/messages';

// ---------------------------------------------------------------------------
// Elements (built dynamically inside #view-explorer by initExplorer)
// ---------------------------------------------------------------------------

let searchInput: HTMLInputElement | null = null;
let tabsEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let countsEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;

let files: ExplorerFile[] = [];
let activeCategory: FileCategory = 'all';
let hasAnalysis = false;

// P3.3 selection state: `detailPayload === null` while awaiting the host's
// `fileInsights` reply (shows a loading state, never fabricated rows).
let detailPath: string | null = null;
let detailPayload: FileInsightsPayload | null = null;

function saveDetailState(): void {
  try {
    const state = (vscodeApi.getState() as Record<string, unknown> | null) ?? {};
    vscodeApi.setState({ ...state, explorerDetailPath: detailPath });
  } catch {
    // Non-fatal: selection just resets after a panel reload.
  }
}

function loadDetailState(): void {
  try {
    const state = vscodeApi.getState() as { explorerDetailPath?: unknown } | null;
    if (typeof state?.explorerDetailPath === 'string' && state.explorerDetailPath.length > 0) {
      // Path persists; the insight payload is re-requested (it may be stale).
      detailPath = state.explorerDetailPath;
      detailPayload = null;
    }
  } catch {
    detailPath = null;
    detailPayload = null;
  }
}

/** Expanded folder paths — persisted so they survive hide/show and reloads. */
let expanded = new Set<string>();

function saveExpansionState(): void {
  try {
    const state = (vscodeApi.getState() as Record<string, unknown> | null) ?? {};
    vscodeApi.setState({ ...state, explorerExpanded: [...expanded] });
  } catch {
    // Non-fatal: worst case folders re-collapse after a panel reload.
  }
}

function loadExpansionState(): void {
  try {
    const state = vscodeApi.getState() as { explorerExpanded?: unknown } | null;
    if (Array.isArray(state?.explorerExpanded)) {
      expanded = new Set(state.explorerExpanded.filter((p): p is string => typeof p === 'string'));
    }
  } catch {
    expanded = new Set();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function initExplorer(section: HTMLElement): void {
  section.replaceChildren();

  // Search bar
  const searchWrap = el('div', { className: 'vm-search' });
  const searchIcon = el('span', { className: 'vm-search-icon', children: [iconElement('explorer')] });
  const input = el('input', {
    className: 'vm-search-input',
    attrs: { type: 'search', placeholder: 'Search files and paths…', 'aria-label': 'Search files' },
  }) as HTMLInputElement;
  input.addEventListener('input', () => render());
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(input);
  section.appendChild(searchWrap);
  searchInput = input;

  // Category tabs
  tabsEl = el('div', {
    className: 'vm-chiprow vm-filters',
    attrs: { role: 'group', 'aria-label': 'File categories' },
  });
  section.appendChild(tabsEl);

  // Scan-limit / truncated banner (kept hidden until relevant).
  bannerEl = el('div', { className: 'vm-banner vm-banner--warning', attrs: { role: 'status' } });
  bannerEl.hidden = true;
  section.appendChild(bannerEl);

  // Counts
  countsEl = el('p', { className: 'vm-counts vm-muted', attrs: { 'aria-live': 'polite' } });
  section.appendChild(countsEl);

  // Content area
  contentEl = el('div', { className: 'vm-explorer-content' });
  section.appendChild(contentEl);

  // Escape closes the file-detail panel (when focus is inside this view).
  section.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape' && detailPath) {
      event.stopPropagation();
      closeDetail();
    }
  });

  loadExpansionState();
  loadDetailState();
  render();
  // A restored selection has no payload yet — re-request it so the panel
  // does not stay in its loading state after a webview reload.
  if (detailPath) {
    void vscodeApi.postMessage({ type: 'fileInsightsRequested', payload: { path: detailPath } });
  }
}

// ---------------------------------------------------------------------------
// Selection / detail panel (P3.3)
// ---------------------------------------------------------------------------

/** Selects a file: opens (or re-targets) the detail panel and fetches insights. */
function selectFile(path: string): void {
  detailPath = path;
  detailPayload = null;
  saveDetailState();
  render();
  void vscodeApi.postMessage({ type: 'fileInsightsRequested', payload: { path } });
}

function closeDetail(): void {
  detailPath = null;
  detailPayload = null;
  saveDetailState();
  render();
}

/** Renders a detail panel region above the tree for the current selection. */
function renderFileDetail(): HTMLElement | null {
  if (!detailPath) return null;
  const root = el('div', {
    className: 'vm-file-detail',
    attrs: { role: 'region', 'aria-label': `File details for ${detailPath}` },
  });

  // Header: path, open-in-editor, close.
  const header = el('div', { className: 'vm-file-detail-header' });
  const openBtn = el('button', {
    className: 'vm-btn vm-btn--small vm-file-detail-open',
    text: 'Open in editor',
    attrs: { type: 'button', title: `Open ${detailPath} in the editor` },
  }) as HTMLButtonElement;
  openBtn.addEventListener('click', () => {
    if (detailPath) openFile(detailPath);
  });
  const closeBtn = el('button', {
    className: 'vm-file-detail-close',
    text: '✕',
    attrs: { type: 'button', 'aria-label': 'Close file details', title: 'Close (Esc)' },
  }) as HTMLButtonElement;
  closeBtn.addEventListener('click', closeDetail);
  header.appendChild(el('span', {
    className: 'vm-file-detail-path',
    text: detailPath,
    attrs: { title: detailPath },
  }));
  header.appendChild(openBtn);
  header.appendChild(closeBtn);
  root.appendChild(header);

  const body = el('div', { className: 'vm-file-detail-body' });
  root.appendChild(body);

  if (!detailPayload) {
    body.appendChild(el('p', { className: 'vm-muted vm-detail-loading', text: 'Loading insights…' }));
    body.appendChild(skeleton(2));
    return root;
  }

  const model = buildDetailModel(detailPayload);

  // Honest notice banner(s).
  if (model.notices.length > 0) {
    const noticeWrap = el('div', { className: 'vm-detail-notices' });
    for (const notice of model.notices) {
      noticeWrap.appendChild(el('p', {
        className: `vm-detail-notice vm-detail-notice--${notice.severity}`,
        text: notice.text,
      }));
    }
    body.appendChild(noticeWrap);
  }

  // Read status line (measured, from the content pass).
  if (model.readMeta) {
    const meta = model.readMeta;
    const parts = [`Read: ${meta.linesRead} line${meta.linesRead === 1 ? '' : 's'}`];
    if (meta.status === 'truncated') parts.push('truncated');
    else if (meta.status === 'unreadable') parts.splice(0, parts.length, 'Could not be read');
    body.appendChild(el('p', { className: 'vm-detail-meta vm-muted', text: parts.join(' · ') }));
  }

  // --- Symbols --------------------------------------------------------------
  body.appendChild(renderDetailSection('Symbols', (sec) => {
    if (model.symbolSourceLabel) {
      sec.appendChild(chip(model.symbolSourceLabel, undefined));
    }
    if (model.symbolRows.length > 0) {
      const list = el('ul', { className: 'vm-symbol-list' });
      for (const row of model.symbolRows) {
        const line = el('span', { className: 'vm-symbol-line vm-muted', text: row.line !== undefined ? ` :${row.line}` : '' });
        const item = el('li', {
          className: 'vm-symbol-row',
          children: [
            el('span', { className: 'vm-symbol-kind', text: row.kind }),
            el('span', { className: 'vm-symbol-name', text: row.name }),
            line,
          ],
        });
        item.style.paddingLeft = `${row.depth * 12 + 4}px`; // numeric only — CSP-safe
        item.setAttribute('title', row.container !== undefined ? `${row.kind} ${row.name} (in ${row.container})` : `${row.kind} ${row.name}`);
        list.appendChild(item);
      }
      sec.appendChild(list);
    } else {
      sec.appendChild(el('p', {
        className: 'vm-detail-null vm-muted',
        text: model.symbolSource === 'unsupported'
          ? 'No symbols collected for this file type.'
          : 'No symbols were detected in this file.',
      }));
    }
  }));

  // --- Imports ---------------------------------------------------------------
  body.appendChild(renderDetailSection('Imports', (sec) => {
    if (!detailPayload?.imports) {
      sec.appendChild(el('p', { className: 'vm-detail-null vm-muted', text: 'Import data was not collected for this file.' }));
      return;
    }
    if (model.importGroups.length === 0) {
      sec.appendChild(el('p', { className: 'vm-detail-null vm-muted', text: 'No imports detected in this file.' }));
    }
    for (const group of model.importGroups) {
      const head = el('div', { className: 'vm-import-group-head' });
      head.appendChild(el('span', { className: 'vm-import-group-label', text: group.label }));
      head.appendChild(el('span', { className: 'vm-detail-muted vm-muted', text: String(group.rows.length) }));
      sec.appendChild(head);
      const list = el('ul', { className: 'vm-import-list' });
      for (const row of group.rows) {
        const item = el('li', { className: 'vm-import-row' });
        item.appendChild(el('span', { className: 'vm-import-spec', text: row.spec }));
        if (row.to) {
          // Resolved internal target — clickable to navigate the detail panel.
          item.appendChild(el('span', { className: 'vm-import-arrow', text: ' → ', attrs: { 'aria-hidden': 'true' } }));
          item.appendChild(fileLink(row.to, (p) => selectFile(p)));
        }
        list.appendChild(item);
      }
      sec.appendChild(list);
    }
    // Incoming edges — who imports this file.
    const incomingHead = el('div', { className: 'vm-import-group-head' });
    incomingHead.appendChild(el('span', { className: 'vm-import-group-label', text: 'Imported by' }));
    incomingHead.appendChild(el('span', { className: 'vm-detail-muted vm-muted', text: String(model.incoming.length) }));
    sec.appendChild(incomingHead);
    if (model.incoming.length === 0) {
      sec.appendChild(el('p', { className: 'vm-detail-null vm-muted', text: 'No file in this project imports it (among scanned files).' }));
    } else {
      const list = el('ul', { className: 'vm-import-list' });
      for (const from of model.incoming) {
        const item = el('li', { className: 'vm-import-row' });
        item.appendChild(fileLink(from, (p) => selectFile(p)));
        list.appendChild(item);
      }
      sec.appendChild(list);
    }
  }));

  // --- Configuration insights (only when the file is a config) ---------------
  if (model.config) {
    body.appendChild(renderDetailSection('Configuration insights', (sec) => {
      sec.appendChild(chip(model.config?.format ?? 'config', undefined));
      if (model.config && model.config.entries.length > 0) {
        const list = el('ul', { className: 'vm-config-list' });
        for (const entry of model.config.entries) {
          const item = el('li', { className: 'vm-config-row' });
          item.appendChild(el('span', { className: 'vm-config-path', text: entry.path }));
          const typeText = entry.redacted ? 'redacted' : entry.type;
          item.appendChild(el('span', { className: 'vm-detail-muted vm-muted vm-config-type', text: `· ${typeText}` }));
          if (entry.safeValue !== undefined) {
            item.appendChild(el('span', { className: 'vm-detail-muted vm-muted vm-config-value', text: `= ${entry.safeValue}` }));
          }
          list.appendChild(item);
        }
        sec.appendChild(list);
      } else {
        sec.appendChild(el('p', { className: 'vm-detail-null vm-muted', text: 'No configuration keys extracted.' }));
      }
    }));
  }

  return root;
}

/** Section wrapper: heading + content built by `fill`. */
function renderDetailSection(title: string, fill: (sectionEl: HTMLDivElement) => void): HTMLDivElement {
  const sectionEl = el('div', { className: 'vm-detail-section' });
  sectionEl.appendChild(el('h3', { className: 'vm-detail-section-title', text: title }));
  const sec = el('div', { className: 'vm-detail-section-body' }) as HTMLDivElement;
  sectionEl.appendChild(sec);
  fill(sec);
  return sectionEl;
}

// ---------------------------------------------------------------------------
// Data hooks (called from main.ts message dispatch)
// ---------------------------------------------------------------------------

/** While an analysis is running, show a committed skeleton in the Explorer. */
export function showExplorerLoading(): void {
  hasAnalysis = false;
  hideBanner();
  // The outgoing detail is stale by definition once a re-analysis begins.
  detailPath = null;
  detailPayload = null;
  saveDetailState();
  if (!contentEl) return;
  contentEl.replaceChildren(
    card({ icon: 'explorer', title: 'Building file map…' }).root,
    skeleton(5)
  );
}

export function setExplorerData(summary: AnalysisSummary): void {
  hasAnalysis = true;
  files = summary.allFiles ?? [];
  // New data invalidates any open detail selection (paths may have changed).
  detailPath = null;
  detailPayload = null;
  saveDetailState();

  const notice = buildScanNotice(summary);
  if (bannerEl) {
    bannerEl.hidden = notice.severity === 'ok';
    if (notice.severity !== 'ok') {
      bannerEl.replaceChildren(
        el('span', { className: 'vm-banner-dot' }),
        el('p', { className: 'vm-banner-text', text: notice.lines.join(' ') })
      );
    }
  }
  render();
}

/**
 * Receives the host's per-file insight reply. Stale replies (path changed
 * since the request) are ignored — the panel only ever shows the payload of
 * the file that is currently selected.
 */
export function setExplorerDetail(payload: FileInsightsPayload): void {
  if (!detailPath || payload.relativePath !== detailPath) return;
  detailPayload = payload;
  render();
}

export function renderExplorerError(message: string): void {
  hasAnalysis = false;
  hideBanner();
  const errorCard = card({ icon: 'alert', title: 'Explorer unavailable' });
  errorCard.body.appendChild(el('p', { className: 'vm-error-message', text: message }));
  const retry = el('button', {
    className: 'vm-btn vm-btn--primary',
    text: 'Re-run analysis',
    attrs: { type: 'button' },
  });
  retry.addEventListener('click', () => {
    void vscodeApi.postMessage({ type: 'analyzeRequested' });
  });
  errorCard.body.appendChild(retry);
  if (contentEl) contentEl.replaceChildren(errorCard.root);
}

function hideBanner(): void {
  if (bannerEl) bannerEl.hidden = true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function openFile(path: string): void {
  void vscodeApi.postMessage({ type: 'openFile', payload: { path } } satisfies { type: 'openFile'; payload: { path: string } });
}

function renderEmpty(title: string, hint: string): void {
  contentEl?.replaceChildren(emptyState({ icon: 'explorer', title, hint }));
}

function currentFilter(): { term?: string; category: FileCategory } {
  const term = searchInput?.value.trim();
  return { term: term ? term : undefined, category: activeCategory };
}

function isFiltering(): boolean {
  const f = currentFilter();
  return Boolean(f.term) || f.category !== 'all';
}

function countFolders(): number {
  const seen = new Set<string>();
  for (const file of files) {
    const segments = file.relativePath.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (dir) seen.add(dir);
    }
  }
  return seen.size;
}

function render(): void {
  renderCategoryTabs();

  if (!contentEl) return;

  if (!hasAnalysis) {
    renderEmpty(
      'Explorer not populated',
      'Files appear here after the first workspace analysis — no extra scan is performed.'
    );
    renderCounts(0, 0);
    return;
  }
  if (files.length === 0) {
    renderEmpty(
      'No accessible files',
      'Every file was excluded by privacy/ignore rules, or the workspace is empty.'
    );
    renderCounts(0, 0);
    return;
  }

  const result = buildTree(files, currentFilter());
  renderCounts(result.totalFiles, result.shownFiles);

  if (result.isEmptyResult) {
    contentEl.replaceChildren(
      emptyState({
        icon: 'file',
        title: 'No matching files',
        hint: 'Try a shorter search term or a different category.',
      })
    );
    return;
  }

  if (isFiltering()) {
    // While filtering, auto-reveal every folder that contains matches.
    expanded = new Set(expandableFolders(result.roots));
  } else if (expanded.size === 0) {
    // First render without a filter: expand the first two levels.
    for (const p of defaultExpandedPaths(result.roots)) expanded.add(p);
    saveExpansionState();
  }

  const tree = el('div', {
    className: 'vm-tree',
    attrs: { role: 'tree', 'aria-label': 'Project files' },
  });
  appendNodes(tree, result.roots);
  // Detail panel renders ABOVE the tree (VS Code Explorer feel).
  const detail = renderFileDetail();
  contentEl.replaceChildren(...(detail ? [detail] : []), tree);
}

function renderCounts(totalFiles: number, shownFiles: number): void {
  if (!countsEl) return;
  const parts: string[] = [];
  if (isFiltering()) parts.push(`${shownFiles} of ${totalFiles} files`);
  else parts.push(`${totalFiles} files`);
  parts.push(`${countFolders()} folder${countFolders() === 1 ? '' : 's'}`);
  countsEl.textContent = parts.join(' · ');
}

function renderCategoryTabs(): void {
  if (!tabsEl) return;
  tabsEl.replaceChildren();

  const addChip = (id: FileCategory, label: string, count: number): HTMLButtonElement => {
    const chipButton = el('button', {
      className: `vm-chip vm-filter-chip${activeCategory === id ? ' is-active' : ''}`,
      text: `${label} (${count})`,
      attrs: { type: 'button', 'aria-pressed': String(activeCategory === id) },
    }) as HTMLButtonElement;
    chipButton.disabled = count === 0;
    chipButton.addEventListener('click', () => {
      activeCategory = id;
      render();
    });
    tabsEl?.appendChild(chipButton);
    return chipButton;
  };

  addChip('all', 'All', files.length);
  for (const stat of categorizeFiles(files)) {
    // Zero-count categories stay visible but disabled so the layout is stable.
    addChip(stat.id, stat.label, stat.count);
  }
}

// --- Tree rows ------------------------------------------------------------------

function appendNodes(container: HTMLElement, nodes: readonly TreeNode[]): void {
  for (const node of nodes) {
    container.appendChild(renderRow(node));
    // Children render inside this flat sequence with indentation as the depth cue.
    if (node.kind === 'folder' && expanded.has(node.path)) {
      appendNodes(container, node.children);
    }
  }
}

function renderRow(node: TreeNode): HTMLButtonElement {
  const isSelected = node.kind === 'file' && node.path === detailPath;
  const row = el('button', {
    className: `vm-tree-row${node.kind === 'folder' ? ' vm-tree-row--folder' : ''}${isSelected ? ' is-selected' : ''}`,
    attrs: {
      type: 'button',
      role: 'treeitem',
      'aria-level': String(node.depth + 1),
      'aria-selected': String(isSelected),
      tabindex: '-1',
    },
  }) as HTMLButtonElement;

  // Indentation by depth (numeric string only — CSP-safe).
  row.style.paddingLeft = `${Math.max(0, node.depth) * 12 + 6}px`;

  if (node.kind === 'folder') {
    const isOpen = expanded.has(node.path);
    row.setAttribute('aria-expanded', String(isOpen));
    row.setAttribute('tabindex', '0');
    row.appendChild(el('span', {
      className: `vm-tree-chev${isOpen ? ' is-open' : ''}`,
      attrs: { 'aria-hidden': 'true' },
      children: [iconElement('chevron')],
    }));
    row.appendChild(el('span', { className: 'vm-tree-icon', children: [iconElement('explorer')] }));
    row.appendChild(el('span', { className: 'vm-tree-name', text: node.name }));
    row.appendChild(el('span', {
      className: 'vm-tree-meta',
      text: `${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`,
    }));
    row.setAttribute('title', `${node.path} · ${node.fileCount} files`);
    row.addEventListener('click', () => {
      if (expanded.has(node.path)) expanded.delete(node.path);
      else expanded.add(node.path);
      saveExpansionState();
      render();
    });
  } else {
    row.appendChild(el('span', { className: 'vm-tree-chev vm-tree-chev--spacer', attrs: { 'aria-hidden': 'true' } }));
    row.appendChild(el('span', { className: 'vm-tree-icon', children: [iconElement('file')] }));
    row.appendChild(el('span', { className: 'vm-tree-name', text: node.name }));
    const sizeText = node.sizeBytes !== undefined ? formatBytes(node.sizeBytes) : '';
    row.appendChild(el('span', { className: 'vm-tree-meta', text: sizeText }));
    row.setAttribute(
      'title',
      `${node.path}${node.sizeBytes !== undefined ? ` · ${formatBytes(node.sizeBytes)}` : ''}`
    );
    // P3.3: single click SELECTS (detail panel); double click opens in editor.
    row.addEventListener('click', () => selectFile(node.path));
    row.addEventListener('dblclick', () => openFile(node.path));
  }

  row.addEventListener('keydown', (event) => onRowKeydown(event, node, row));
  return row;
}

function onRowKeydown(event: Event, node: TreeNode, row: HTMLButtonElement): void {
  const key = (event as KeyboardEvent).key;
  const rows = Array.from(contentEl?.querySelectorAll<HTMLButtonElement>('.vm-tree-row') ?? []);
  const rowIndex = rows.indexOf(row);

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    const delta = key === 'ArrowDown' ? 1 : rows.length - 1;
    rows[(rowIndex + delta) % rows.length]?.focus();
    return;
  }
  if (node.kind === 'folder') {
    if (key === 'ArrowRight' && !expanded.has(node.path)) {
      event.preventDefault();
      expanded.add(node.path);
      saveExpansionState();
      render();
      // Refocus the same folder after the rebuild.
      refocusPath(node.path);
      return;
    }
    if (key === 'ArrowLeft' && expanded.has(node.path)) {
      event.preventDefault();
      expanded.delete(node.path);
      saveExpansionState();
      render();
      refocusPath(node.path);
      return;
    }
  }
  if (key === 'Enter' || key === ' ') {
    // Native button click behavior handles activation; nothing extra needed.
  }
}

function refocusPath(path: string): void {
  const all = Array.from(contentEl?.querySelectorAll<HTMLButtonElement>('.vm-tree-row') ?? []);
  for (const candidate of all) {
    if (candidate.title.toLowerCase().startsWith(path.toLowerCase())) {
      candidate.focus();
      return;
    }
  }
}
