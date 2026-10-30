/**
 * Segmented tab bar (top of panel, sits under the header).
 * Implements the tablist ARIA pattern + arrow-key navigation.
 */
import { el } from '../dom';
import { iconElement } from '../icons';
import { saveView, VIEW_IDS, type ViewId } from '../state';
import type { IconName } from '../icons';

const TAB_LABELS: Readonly<Record<ViewId, string>> = {
  overview: 'Overview',
  explorer: 'Explorer',
  assistant: 'Assistant',
  prep: 'Prep',
  mock: 'Mock Viva',
};

const TAB_ICONS: Readonly<Record<ViewId, IconName>> = {
  overview: 'dashboard',
  explorer: 'explorer',
  assistant: 'spark',
  prep: 'clipboard',
  mock: 'mic',
};

export function initNav(navRoot: HTMLElement, getActive: () => ViewId, onChange: (view: ViewId) => void): void {
  navRoot.classList.add('vm-nav');
  navRoot.setAttribute('role', 'tablist');
  navRoot.setAttribute('aria-label', 'VivaMate sections');

  const buttons = new Map<ViewId, HTMLButtonElement>();

  const select = (view: ViewId, focus = false): void => {
    const previous = getActive();
    if (previous !== view) onChange(view);
    saveView(view);

    for (const [id, button] of buttons) {
      const active = id === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    if (focus) buttons.get(view)?.focus();
  };

  for (const id of VIEW_IDS) {
    const button = el('button', {
      className: 'vm-nav-item',
      attrs: {
        type: 'button',
        role: 'tab',
        id: `nav-${id}`,
        'aria-controls': `view-${id}`,
        'aria-selected': 'false',
        title: TAB_LABELS[id],
      },
      children: [
        el('span', { className: 'vm-nav-icon', children: [iconElement(TAB_ICONS[id])] }),
        el('span', { className: 'vm-nav-label', text: TAB_LABELS[id] }),
      ],
    });

    button.addEventListener('click', () => select(id));
    button.addEventListener('keydown', (event) => {
      const index = VIEW_IDS.indexOf(id);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : VIEW_IDS.length - 1;
        const next = VIEW_IDS[(index + delta) % VIEW_IDS.length] as ViewId;
        select(next, true);
      }
    });

    buttons.set(id, button);
    navRoot.appendChild(button);
  }

  // Initial selection without triggering a change callback.
  const initial = getActive();
  for (const [id, button] of buttons) {
    const active = id === initial;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
}

/** Applies the active-tab class to the five tab panels. */
export function showView(view: ViewId): void {
  for (const id of VIEW_IDS) {
    const panel = document.getElementById(`view-${id}`);
    panel?.classList.toggle('is-active', id === view);
    panel?.toggleAttribute('hidden', id !== view);
  }
}
