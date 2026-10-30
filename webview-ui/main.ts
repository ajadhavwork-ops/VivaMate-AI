/**
 * Webview client for the VivaMate panel.
 * Pure UI: sends JSON messages to the host and renders messages from it.
 * No file access, no network — sandboxed by the CSP in index.html.
 *
 * Security rule: ALL dynamic text is rendered via textContent (never innerHTML)
 * so file names or future model output can never inject HTML.
 */
import type { AnalysisSummary, HostToWebviewMessage, WebviewToHostMessage } from '../src/ui/messages';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();

const statusEl = document.getElementById('status') as HTMLSpanElement | null;
const outputEl = document.getElementById('output') as HTMLElement | null;
const overviewEl = document.getElementById('overview') as HTMLElement | null;
const analyzeBtn = document.getElementById('analyzeBtn') as HTMLButtonElement | null;

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function setBusy(busy: boolean): void {
  if (analyzeBtn) analyzeBtn.disabled = busy;
  setStatus(busy ? 'analyzing…' : 'ready');
}

function appendEntry(text: string): void {
  if (!outputEl) return;
  const entry = document.createElement('div');
  entry.className = 'entry';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString();

  const body = document.createElement('div');
  body.textContent = text; // textContent, never innerHTML

  entry.appendChild(time);
  entry.appendChild(body);
  outputEl.appendChild(entry);
}

function el(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function fileLink(relativePath: string): HTMLElement {
  const link = document.createElement('a');
  link.className = 'clickable';
  link.textContent = relativePath;
  link.addEventListener('click', () => {
    vscode.postMessage({ type: 'openFile', payload: { path: relativePath } } satisfies WebviewToHostMessage);
  });
  return link;
}

function renderAnalysis(summary: AnalysisSummary): void {
  if (!overviewEl) return;
  overviewEl.hidden = false;
  overviewEl.textContent = '';

  overviewEl.appendChild(el('h2', `${summary.workspaceName} — ${summary.totalFiles} files analyzed`));

  const languages = el('h3', 'Languages');
  const langList = el('ul');
  for (const lang of summary.languages) {
    langList.appendChild(el('li', `${lang.name} — ${lang.files} file${lang.files === 1 ? '' : 's'}`));
  }
  overviewEl.appendChild(languages);
  overviewEl.appendChild(langList);

  if (summary.manifests.length > 0) {
    overviewEl.appendChild(el('h3', 'Detected project type(s)'));
    const mList = el('ul');
    for (const manifest of summary.manifests) {
      const item = el('li');
      item.appendChild(el('span', `${manifest.ecosystem}: `));
      item.appendChild(fileLink(manifest.relativePath));
      mList.appendChild(item);
    }
    overviewEl.appendChild(mList);
  }

  if (summary.entryPoints.length > 0) {
    overviewEl.appendChild(el('h3', 'Likely entry points'));
    const entryList = el('ul');
    for (const entry of summary.entryPoints) {
      const item = el('li');
      item.appendChild(fileLink(entry));
      entryList.appendChild(item);
    }
    overviewEl.appendChild(entryList);
  }

  if (summary.keyFiles.length > 0) {
    overviewEl.appendChild(el('h3', 'Key files (for AI grounding)'));
    const keyList = el('ul');
    for (const keyFile of summary.keyFiles) {
      const item = el('li');
      item.appendChild(fileLink(keyFile));
      keyList.appendChild(item);
    }
    overviewEl.appendChild(keyList);
  }

  if (summary.limitReached) {
    const note = el('p', 'Some files were skipped because the analysis reached its size or depth limits.');
    note.className = 'muted';
    overviewEl.appendChild(note);
  }
}

if (analyzeBtn) {
  analyzeBtn.addEventListener('click', () => {
    setBusy(true);
    vscode.postMessage({ type: 'analyzeRequested' } satisfies WebviewToHostMessage);
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebviewMessage;
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'hello': {
      appendEntry(`Connected — VivaMate v${message.payload?.version ?? '0.0.1'}`);
      setBusy(false);
      return;
    }
    case 'analysisStarted': {
      appendEntry('Analyzing workspace…');
      return;
    }
    case 'analysis': {
      renderAnalysis(message.payload);
      setBusy(false);
      return;
    }
    case 'error': {
      appendEntry(`Analysis failed: ${message.payload.message}`);
      setBusy(false);
      return;
    }
  }
});

// Signal to the host that the UI is up; the host replies with "hello" (and any cached analysis).
vscode.postMessage({ type: 'webviewLoaded' } satisfies WebviewToHostMessage);
