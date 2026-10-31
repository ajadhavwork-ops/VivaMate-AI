/**
 * File-insights query (P3.3) — builds the per-file insight slice the
 * Explorer's detail panel is rendered from.
 *
 * Pure module — no `vscode` import, unit-testable in plain Node.
 * Uses ONLY the persisted ProjectProfile (may be absent when no analysis has
 * run yet); never fabricates data. Every missing insight is simply absent,
 * and every "why" is an explicit flag (no profile / not selected / unsupported
 * language / truncated scan).
 */
import type { ProjectProfile } from './profile';
import type { FileInsightsPayload } from '../ui/messages';

export function buildFileInsights(
  profile: ProjectProfile | undefined,
  relativePath: string
): FileInsightsPayload {
  const content = profile?.content ?? null;
  const allFiles = profile?.allFiles ?? [];
  const keyFiles = profile?.keyFiles ?? [];

  const readMeta = content?.meta.files.find((f) => f.relativePath === relativePath);
  const symbolsEntry = content?.symbols.find((s) => s.relativePath === relativePath);
  const config = content?.configs.find((c) => c.relativePath === relativePath);

  const outgoing = (content?.imports.edges ?? []).filter((edge) => edge.from === relativePath);
  const incoming = (content?.imports.edges ?? [])
    .filter((edge) => edge.to === relativePath)
    .map((edge) => edge.from);

  const payload: FileInsightsPayload = {
    relativePath,
    hasContentLayer: content !== null,
    onRecord: allFiles.some((f) => f.relativePath === relativePath),
    selectedForAnalysis: Boolean(readMeta) || keyFiles.includes(relativePath),
  };

  if (readMeta) payload.readMeta = readMeta;

  if (symbolsEntry) {
    payload.symbols = {
      source: symbolsEntry.source,
      entries: symbolsEntry.symbols,
      ...(symbolsEntry.truncated ? { truncated: true } : {}),
    };
  }

  if (content) {
    payload.imports = {
      entries: outgoing.map(({ kind, spec, to }) => ({
        kind,
        spec,
        ...(to !== undefined ? { to } : {}),
      })),
      incoming,
    };
    if (content.imports.truncated) payload.importsTruncated = true;
  }

  if (config) payload.config = config;
  return payload;
}
