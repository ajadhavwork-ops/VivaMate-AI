/**
 * Mock Viva tab — timed question-by-question practice sessions.
 * Shell only in P2.1; the session engine arrives with the Phase 3 backend.
 */
import { emptyState } from '../components/primitives';

export function initMockViva(root: HTMLElement): void {
  root.replaceChildren(
    emptyState({
      icon: 'mic',
      title: 'Mock Viva',
      hint: 'A timed, realistic viva rehearsal: random questions from your project, your answers, then model feedback. Arrives with the Phase 3 backend.',
      action: { label: 'Phase 3 — AI backend', disabled: true },
    })
  );
}
