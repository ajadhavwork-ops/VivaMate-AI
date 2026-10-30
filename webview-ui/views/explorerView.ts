/**
 * Project Explorer tab (Phase 2.3).
 * Renders the actual, privacy-filtered file list carried by the analysis
 * profile — no extra rescans, no fabricated metadata. Clicking a file opens
 * it in the editor via the existing `openFile` message.
 *
 * One authoritative render pass per state change (search keystroke, category
 * click, folder toggle): the DOM is rebuilt from pure tree data.
 */
import { el } from '../dom';
import { card, emptyState, skeleton } from '../components/primitives';
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
import type { AnalysisSummary } from '../../src/ui/messages';

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

  loadExpansionState();
  render();
}

// ---------------------------------------------------------------------------
// Data hooks (called from main.ts message dispatch)
// ---------------------------------------------------------------------------

/** While an analysis is running, show a committed skeleton in the Explorer. */
export function showExplorerLoading(): void {
  hasAnalysis = false;
  hideBanner();
  if (!contentEl) return;
  contentEl.replaceChildren(
    card({ icon: 'explorer', title: 'Building file map…' }).root,
    skeleton(5)
  );
}

export function setExplorerData(summary: AnalysisSummary): void {
  hasAnalysis = true;
  files = summary.allFiles ?? [];

  const isPartial = summary.allFilesTruncated === true || summary.limitReached;
  if (bannerEl) {
    bannerEl.hidden = !isPartial;
    if (isPartial) {
      bannerEl.replaceChildren(
        el('span', { className: 'vm-banner-dot' }),
        el('p', {
          className: 'vm-banner-text',
          text: summary.limitReached
            ? 'Scan limits were reached — this list may be incomplete. Raise "vivaMate.analysisBudgetKb" or "vivaMate.maxFileLines" in Settings for full coverage.'
            : 'The stored file list was capped — this view may be incomplete.',
        })
      );
    }
  }
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
  contentEl.replaceChildren(tree);
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
  const row = el('button', {
    className: `vm-tree-row${node.kind === 'folder' ? ' vm-tree-row--folder' : ''}`,
    attrs: {
      type: 'button',
      role: 'treeitem',
      'aria-level': String(node.depth + 1),
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
    row.addEventListener('click', () => openFile(node.path));
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
