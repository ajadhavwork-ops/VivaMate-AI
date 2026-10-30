/**
 * Inline SVG icon set (16×16, stroke = currentColor so it follows the theme).
 * Static, developer-authored markup only — inserted via svg() in dom.ts.
 * No icon fonts, no CDN, no CSP exceptions.
 */

const base = 'width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

export const ICONS = {
  /** Overview — dashboard grid */
  dashboard: `<svg ${base}><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>`,

  /** Project Explorer — folder */
  explorer: `<svg ${base}><path d="M1.5 3.5h3.2l1.6 2h7.7a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9.5z"/></svg>`,

  /** AI Assistant — sparkle */
  spark: `<svg ${base}><path d="M8 1.5l1.4 3.6L13 6.5 9.4 7.9 8 11.5 6.6 7.9 3 6.5l3.6-1.4z"/><path d="M12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" opacity="0.85"/></svg>`,

  /** Viva Preparation — clipboard with check */
  clipboard: `<svg ${base}><rect x="3" y="2.5" width="10" height="12" rx="1.5"/><path d="M6 2.5V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.5"/><path d="M5.5 8.5L7 10l3-3"/></svg>`,

  /** Mock Viva — microphone */
  mic: `<svg ${base}><rect x="6" y="1.5" width="4" height="7.5" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0"/><path d="M8 12v2.5M5.5 14.5h5"/></svg>`,

  /** File (used for openable entries) */
  file: `<svg ${base}><path d="M4 1.5h5l3.5 3.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"/><path d="M9 1.5V5h3.5"/></svg>`,

  /** Play (begin session) */
  play: `<svg ${base}><path d="M4.5 2.8v10.4L12.8 8z"/></svg>`,

  /** Refresh / analyze */
  refresh: `<svg ${base}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.5v3h-3"/></svg>`,

  /** Chevron (tree expand/collapse) */
  chevron: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 4l4 4-4 4"/></svg>`,

  /** Warning */
  alert: `<svg ${base}><path d="M8 1.5L14.5 13.5H1.5z"/><path d="M8 6v3.5" stroke-width="1.6"/><circle cx="8" cy="11.6" r="0.5" fill="currentColor" stroke="none"/></svg>`,

  /** Chat bubble (assistant fallback) */
  chat: `<svg ${base}><path d="M2 3.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 2.5z"/><path d="M5 6h6M5 8.5h4" opacity="0.7"/></svg>`,
} as const;

export type IconName = keyof typeof ICONS;

export function iconElement(name: IconName): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = ICONS[name].trim();
  const node = template.content.firstElementChild;
  if (!(node instanceof SVGSVGElement)) {
    throw new Error(`icon markup for "${name}" is not a root <svg>`);
  }
  return node.cloneNode(true) as SVGSVGElement;
}
