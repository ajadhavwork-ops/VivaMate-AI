# VivaMate AI

A VS Code extension that helps college students understand **their own** software projects, prepare project presentations, and practise **viva examinations** — with AI answers grounded in the actual repository.

## Features (planned for MVP)

1. **Workspace analysis** — builds a lightweight map of the open workspace (languages, manifests, entry points, important files). Secrets, env files, build output, dependency folders, and large binaries are excluded by default.
2. **Architecture explanations** — AI answers cite real files (`path:line`); unverified claims are flagged.
3. **Viva question generation** — easy / intermediate / difficult questions grounded in the repository.
4. **Mock viva** — interactive question → answer → feedback → follow-up sessions with adaptive difficulty.
5. **Progress tracking** — scores, topic mastery, and streaks saved **locally** only.

## Privacy

- No telemetry, no accounts.
- Code is sent to an AI provider **only** when you ask a question or generate questions — never on keystrokes.
- The AI provider is configurable: VS Code Language Model API, any OpenAI-compatible endpoint, or a **fully local Ollama** server.
- API keys are stored in VS Code's encrypted secret storage, never in settings files.

## Development

```bash
npm install
npm run compile     # bundle extension + webview into dist/
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
```

Open the project in VS Code and press **F5** to launch the Extension Development Host with the extension loaded.

## Status

- **Phase 0 — scaffold** (complete): sidebar webview panel, commands, strict-CSP HTML with nonce, esbuild bundling.
- **Phase 1 — workspace analysis engine** (complete): privacy-first walk of the workspace (`vivaMate.analyze` or the panel button) that ignores secrets, dependencies, build output and binaries; detects project manifests; guesses entry points; prioritizes key files under a character budget; and stores the resulting ProjectProfile locally (`storageUri`), shown as an Overview in the panel with clickable file links.
- Tests: `npm test` runs 30 unit tests (pure logic, plain Node) + 5 integration tests (real VS Code, isolated user-data-dir).
