/**
 * Webview client for the VivaMate panel — Phase 2 bootstrap.
 * Pure UI: sends JSON messages to the host and renders messages from it.
 * No file access, no network — sandboxed by the CSP in index.html.
 *
 * Security rule: ALL dynamic/user-derived text is rendered via textContent
 * (see dom.ts). Static icon SVG markup is the only templated content.
 */
import type { HostToWebviewMessage } from '../src/ui/messages';
import { loadInitialView, saveView, vscodeApi, type ViewId } from './state';
import { iconElement } from './icons';
import { initNav, showView } from './components/navRail';
import {
  initOverview,
  logEntry,
  renderAnalysis,
  renderOverviewEmpty,
  renderOverviewError,
  setBusy,
  showOverviewLoading,
} from './views/overview';
import { initExplorer, renderExplorerError, setExplorerData, setExplorerDetail, showExplorerLoading } from './views/explorerView';
import { initAssistant } from './views/assistantView';
import { initPrep } from './views/prepView';
import { initMockViva } from './views/mockVivaView';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const navRoot = document.getElementById('nav') as HTMLElement | null;
const statusEl = document.getElementById('status') as HTMLSpanElement | null;

// Brand mark in the header (static SVG, theme-colored via CSS).
document.getElementById('logo')?.appendChild(iconElement('spark'));

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function analyzeRequested(): void {
  setBusy(true);
  logEntry('Analyzing workspace…');
  void vscodeApi.postMessage({ type: 'analyzeRequested' });
}

let activeView: ViewId = loadInitialView();

initOverview(analyzeRequested);
if (navRoot) {
  const viewsReady = document.getElementById('view-explorer');
  if (viewsReady) initExplorer(viewsReady);
  const assistantReady = document.getElementById('view-assistant');
  if (assistantReady) initAssistant(assistantReady);
  const prepReady = document.getElementById('view-prep');
  if (prepReady) initPrep(prepReady);
  const mockReady = document.getElementById('view-mock');
  if (mockReady) initMockViva(mockReady);

  initNav(
    navRoot,
    () => activeView,
    (view) => {
      activeView = view;
      showView(view);
    }
  );
}
showView(activeView);

// First paint without cached data — show an honest empty state until the
// host replies (hello + optional cached analysis).
renderOverviewEmpty();
setBusy(false);

// ---------------------------------------------------------------------------
// Host → webview messages
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebviewMessage;
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'hello': {
      logEntry(`Connected — VivaMate v${message.payload?.version ?? '0.0.1'}`);
      setStatus('ready');
      setBusy(false);
      return;
    }
    case 'analysisStarted': {
      showOverviewLoading();
      showExplorerLoading();
      setStatus('analyzing…');
      // Jump to Overview so the user sees progress.
      activeView = 'overview';
      showView('overview');
      saveView('overview');
      return;
    }
    case 'analysis': {
      renderAnalysis(message.payload);
      setExplorerData(message.payload);
      setStatus('ready');
      setBusy(false);
      return;
    }
    case 'fileInsights': {
      setExplorerDetail(message.payload);
      return;
    }
    case 'error': {
      logEntry(`Analysis failed: ${message.payload.message}`, 'error');
      renderOverviewError(message.payload.message);
      renderExplorerError(message.payload.message);
      setStatus('error');
      setBusy(false);
      return;
    }
  }
});

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

// Signal that the UI is up; the host replies with "hello" (and any cached analysis).
void vscodeApi.postMessage({ type: 'webviewLoaded' });
