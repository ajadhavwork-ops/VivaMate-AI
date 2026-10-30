/**
 * DOM helpers for the VivaMate webview.
 *
 * SECURITY: this is the ONE place where nodes are built from text.
 * Every view must render user-derived strings through these helpers
 * (which use `textContent`) — never through innerHTML.
 */

export interface ElOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: Node[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      node.setAttribute(key, value);
    }
  }
  for (const child of options.children ?? []) node.appendChild(child);
  return node;
}

/**
 * Inserts a *static, developer-authored* SVG string (our own icon set).
 * Never pass user/model-derived markup here — that stays forbidden.
 */
export function svg(iconMarkup: string): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = iconMarkup.trim();
  const node = template.content.firstElementChild;
  if (!(node instanceof SVGSVGElement)) {
    throw new Error('icons.ts contents must be root <svg> elements');
  }
  return node.cloneNode(true) as SVGSVGElement;
}
