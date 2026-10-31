/**
 * VS Code language-service symbol provider (P3.2) — the ONLY module in this
 * feature that touches the `vscode` API for symbols.
 *
 * Contract:
 * - asks VS Code's DocumentSymbolProvider machinery for a file's symbols
 *   (works with whatever language extensions the student has installed —
 *   TypeScript language features ship with VS Code itself);
 * - returns the provider's mapped symbols, or `undefined` when NO provider
 *   answered / gave nothing / errored — so the orchestrator can gracefully
 *   use the clearly-labeled regex fallback instead of pretending;
 * - never executes project code; symbol extraction is VS Code's own analysis.
 */
import * as vscode from 'vscode';
import {
  mapDocumentSymbol,
  type DocumentSymbolLike,
  type SymbolInfo,
} from './symbols';

/**
 * Queries the language service for hierarchical document symbols.
 * Returns undefined when no provider produced output for this file.
 */
export async function tryProviderSymbols(
  uri: vscode.Uri
): Promise<SymbolInfo[] | undefined> {
  try {
    // The provider machinery answers for loaded documents; open on demand
    // (no visible editor is opened — documents load invisibly).
    const document = await vscode.workspace.openTextDocument(uri);
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
    if (!result || result.length === 0) return undefined;
    return result.map((sym) => mapDocumentSymbol(sym as unknown as DocumentSymbolLike));
  } catch {
    // Provider missing, crashed, or unsupported language — honest undefined,
    // the caller decides whether a fallback exists.
    return undefined;
  }
}
