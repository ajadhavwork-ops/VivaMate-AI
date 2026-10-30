/**
 * Pure formatting helpers for the Overview dashboard.
 * No DOM imports — unit-testable in plain Node.
 */

/** Human-readable byte size. International units (KB = 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/** "just now", "45s ago", "3m ago", "2h ago", "5d ago" — or a locale date. */
export function relativeTime(isoTimestamp: string, now = Date.now()): string {
  const then = Date.parse(isoTimestamp);
  if (!Number.isFinite(then)) {
    try {
      return new Date(isoTimestamp).toLocaleString();
    } catch {
      return 'unknown time';
    }
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** Truncates long identifiers from the middle, keeping both ends visible. */
export function middleTruncate(text: string, maxLength = 24): string {
  if (text.length <= maxLength) return text;
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
