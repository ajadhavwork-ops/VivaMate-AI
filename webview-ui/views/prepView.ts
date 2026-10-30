/**
 * Viva Preparation tab — question generation and study checklist.
 * Shell only in P2.1; content comes with the Phase 3 AI backend.
 */
import { emptyState } from '../components/primitives';

export function initPrep(root: HTMLElement): void {
  root.replaceChildren(
    emptyState({
      icon: 'clipboard',
      title: 'Viva Preparation',
      hint: 'AI-generated viva questions, a study checklist and presenter notes for your project. Arrives with the Phase 3 backend.',
      action: { label: 'Phase 3 — AI backend', disabled: true },
    })
  );
}
