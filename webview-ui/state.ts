/**
 * Webview-side app state.
 *
 * Because the webview is created with `retainContextWhenHidden: false`, the
 * DOM is destroyed whenever the panel is hidden. Anything the user "did"
 * (e.g. which tab is open) must be persisted via the VS Code API's
 * setState/getState, which survives across invisibility and reloads.
 */

export type ViewId = 'overview' | 'explorer' | 'assistant' | 'prep' | 'mock';

/** Real VS Code API surface (we now use setState/getState, not just postMessage). */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi: VsCodeApi = acquireVsCodeApi();

export const VIEW_IDS: readonly ViewId[] = ['overview', 'explorer', 'assistant', 'prep', 'mock'];

const isValidView = (value: unknown): value is ViewId =>
  typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value);

/** Loads the last active tab (defaults to Overview for a fresh panel). */
export function loadInitialView(): ViewId {
  try {
    const state = vscodeApi.getState() as { view?: unknown } | null;
    if (state && isValidView(state.view)) return state.view;
  } catch {
    // getState can fail during very early teardown — fall through to default.
  }
  return 'overview';
}

/** Remembers the active tab so it survives hide/show and reloads. */
export function saveView(view: ViewId): void {
  try {
    vscodeApi.setState({ view });
  } catch {
    // Non-fatal: worst case the panel reopens on Overview.
  }
}
