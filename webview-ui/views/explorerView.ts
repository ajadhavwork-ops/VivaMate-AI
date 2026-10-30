/**
 * Project Explorer tab (P2.2 scope).
 * P2.1 ships the shell; the searchable file list is populated in the next
 * sub-phase once the analysis summary carries the full walked file list.
 */
import { emptyState } from '../components/primitives';

export function initExplorer(root: HTMLElement): void {
  root.replaceChildren(
    emptyState({
      icon: 'explorer',
      title: 'Project Explorer',
      hint: 'A searchable map of your workspace appears here after you run an analysis.',
      action: { label: 'Coming in the next sub-step', disabled: true },
    })
  );
}
