/**
 * AI Assistant tab.
 * P2.1 ships an honest shell: the chat interface arrives with the Phase 3
 * AI backend (free `vscode-lm` provider path already configured in
 * settings). No fake affordances — the input is visibly not interactive yet.
 */
import { emptyState } from '../components/primitives';

export function initAssistant(root: HTMLElement): void {
  root.replaceChildren(
    emptyState({
      icon: 'spark',
      title: 'AI Assistant',
      hint: 'Ask questions about your own project and get answers grounded in your real code. Enabled in Phase 3 — free via the built-in VS Code language model, no API key.',
      action: { label: 'Phase 3 — AI backend', disabled: true },
    })
  );
}
