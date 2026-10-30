/**
 * Reusable UI primitives — the VivaMate design system building blocks.
 * All views compose these instead of styling raw tags, so the look stays
 * consistent and theme-aware (dark/light/high-contrast) via CSS tokens.
 */
import { el, type ElOptions } from '../dom';
import { iconElement, type IconName } from '../icons';

/** A card with optional header (icon + title) and body. */
export function card(options: { icon?: IconName; title?: string; children?: Node[] } = {}): {
  root: HTMLDivElement;
  body: HTMLDivElement;
} {
  const root = el('div', { className: 'vm-card' });

  if (options.title) {
    const header = el('div', { className: 'vm-card-header' });
    if (options.icon) {
      header.appendChild(el('span', { className: 'vm-card-icon', children: [iconElement(options.icon)] }));
    }
    header.appendChild(el('h2', { className: 'vm-card-title', text: options.title }));
    root.appendChild(header);
  }

  const body = el('div', { className: 'vm-card-body', children: options.children });
  root.appendChild(body);
  return { root, body };
}

/** Small pill used for languages, ecosystems, statuses. Optional click action. */
export function chip(
  text: string,
  onClick?: () => void,
  options: { icon?: IconName } = {}
): HTMLElement {
  const cls = onClick ? 'vm-chip vm-chip--clickable' : 'vm-chip';
  const node = el(onClick ? 'a' : 'span', { className: cls, text });

  if (options.icon) {
    node.prepend(el('span', { className: 'vm-chip-icon', children: [iconElement(options.icon)] }));
  }
  if (onClick) {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.addEventListener('click', onClick);
    node.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') {
        event.preventDefault();
        onClick();
      }
    });
  }
  return node;
}

/** Status pill (e.g. "ready", "analyzing…", "error"). */
export function statusBadge(id: string, text: string): HTMLSpanElement {
  return el('span', {
    className: 'vm-badge',
    text,
    attrs: { id, 'aria-live': 'polite' },
  });
}

/** Horizontal progress bar (0–100). Decorative — pair it with a text label. */
export function progressBar(percent: number, options: { label?: string } = {}): HTMLDivElement {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const track = el('div', {
    className: 'vm-progress',
    attrs: {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(clamped),
    },
  });
  const fill = el('div', { className: 'vm-progress-fill' });
  fill.style.width = `${clamped}%`; // numeric value only — CSP-safe
  track.appendChild(fill);

  if (options.label) {
    track.setAttribute('aria-label', options.label);
  }
  return track;
}

/** Shimmer placeholder shown while an operation is in flight. */
export function skeleton(lines = 3): HTMLDivElement {
  const block = el('div', { className: 'vm-skeleton' });
  for (let i = 0; i < lines; i++) {
    const line = el('div', { className: `vm-skeleton-line vm-skeleton-line--${i === 0 ? 'wide' : 'auto'}` });
    line.style.animationDelay = `${i * 120}ms`; // numeric value only
    block.appendChild(line);
  }
  return block;
}

/** Big friendly empty state (icon, title, one-line hint, optional action). */
export function emptyState(options: {
  icon: IconName;
  title: string;
  hint?: string;
  action?: { label: string; disabled?: boolean };
}): HTMLDivElement {
  const root = el('div', { className: 'vm-empty' });
  root.appendChild(el('div', { className: 'vm-empty-icon', children: [iconElement(options.icon)] }));
  root.appendChild(el('p', { className: 'vm-empty-title', text: options.title }));
  if (options.hint) {
    root.appendChild(el('p', { className: 'vm-empty-hint', text: options.hint }));
  }
  if (options.action) {
    const button = el('button', {
      className: 'vm-btn vm-btn--primary',
      text: options.action.label,
      attrs: { type: 'button' },
    });
    if (options.action.disabled) button.disabled = true;
    root.appendChild(button);
  }
  return root;
}

/** Inline helper for "lists of clickable file chips/rows" open-file coupling. */
export function fileLink(relativePath: string, onOpen: (p: string) => void): HTMLAnchorElement {
  const link = el('a', {
    className: 'vm-filelink',
    text: relativePath,
    attrs: { role: 'button', tabindex: '0', title: `Open ${relativePath}` },
  });
  link.appendChild(el('span', { className: 'vm-filelink-icon', children: [iconElement('file')] }));
  link.addEventListener('click', () => onOpen(relativePath));
  link.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(relativePath);
    }
  });
  return link;
}

export type { ElOptions };
