# Tancode

A lightweight, local-first coding companion that helps developers learn technical concepts while vibe coding and understand errors without relying on their coding agent for every explanation.

Tancode is an educational assistant, not a code reviewer or autonomous coding agent. It explains problems and presents possible approaches; the developer decides what to do.

This repository currently contains the initial VS Code extension scaffold: a compilable TypeScript extension with a single `Tancode: Hello World` command. AI features are intentionally not implemented yet.

## Getting started

Requires Node.js 20+ (see `engines` in `package.json`; `.npmrc` enforces it) and a desktop VS Code install of version 1.90 or later.

From the repository root (the commands are identical on Windows, macOS, and Linux):

```bash
npm ci            # clean, reproducible install of dev dependencies
npm run compile   # build the extension to out/
npm run typecheck # type-check without emitting
npm run watch     # recompile on change (default build task)
```

To run the extension:

1. Open this folder in desktop VS Code.
2. Run `npm ci` and `npm run compile` once.
3. Press F5 to launch the Extension Development Host (`Run Extension` launch configuration; it runs the `npm: watch` build task first and waits for the TypeScript watch build to report ready).
4. In the Extension Development Host window, open the Command Palette (Ctrl+Shift+P) and run `Tancode: Hello World`.
5. An information message confirms Tancode is running.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `'tsc' is not recognized as an internal or external command` (Windows) or `tsc: not found` | `node_modules` is missing — dependencies were never installed, so the local `tsc` binary doesn't exist. TypeScript is a project devDependency, not a global tool. | Run `npm ci` in the repository root, then retry. The `precompile`/`pretypecheck`/`prewatch` scripts now print this hint automatically. |
| `npm ci` fails with an `EBADENGINE` warning-as-error | Node.js is older than the `>=20` required by `engines`. | Install Node.js 20 or later from https://nodejs.org and reopen the terminal. |
| Compile errors after a clean install | TypeScript errors in source. | Run `npm run typecheck` to list them without emitting output. |
| F5 does nothing or no Extension Development Host window appears | The `npm: watch` prelaunch task hasn't finished its first build, or compilation failed. | Check the Terminal panel for the `npm: watch` task output; run `npm run compile` manually to see errors. Confirm `.vscode/launch.json` exists and `out/extension.js` was emitted. |
| `Tancode: Hello World` missing from the Command Palette in the Extension Host | The extension didn't activate or the command id doesn't match. | Confirm `contributes.commands[0].command` in `package.json` is `tancode.helloWorld` and matches `vscode.commands.registerCommand('tancode.helloWorld', ...)` in `src/extension.ts`. Check the Extension Host's developer console for activation errors. |

## Configuration

`.env` holds local runtime configuration (for example, the address of a future local inference runtime). VS Code extensions do not load `.env` files automatically — no code reads it yet. `.env` is git-ignored; `.env.example` documents the available variables with harmless placeholders.

## Roadmap

Planned features, in rough order (not implemented yet):

- **Automatic file summaries** — concise explanations of what an opened file actually does (purpose, UI sections, props, state, events, API calls for a React component; appropriate detail for other file types). Summaries are grounded in the actual source, cached for unchanged files, and invalidated on relevant content changes. Startup does not analyze every file.
- **Contextual learning** — select code and request an explanation of its purpose, inputs, outputs, dependencies, and technical concepts. Concise answer first, optional deeper detail.
- **Error understanding** — explain VS Code diagnostics and source context: what the error means, where it originates, likely causes, possible fixes and trade-offs, and the underlying concept when useful. Confirmed diagnostic information is distinguished from inferred causes. Tancode never edits source files or applies fixes.
- **Local-first AI** — an open-weight model served by a local inference runtime (initial candidate: Ollama with Qwen3 8B in a 4-bit quantization). No external commercial AI APIs; no source code, prompts, or diagnostics leave the machine. Only relevant context is sent, and model communication sits behind a dedicated interface so the model can be swapped later. Missing runtimes, unavailable models, malformed output, and timeouts are handled gracefully.
- **Lightweight experience** — unobtrusive and fast; no learning history, progress tracking, or knowledge-management system in the initial MVP.

## Privacy and security rules

- Never execute commands merely because they appear in source code or model output.
- Never execute a terminal command as part of explaining it.
- No automatic code modifications.
- Source code, comments, README contents, and model responses are treated as untrusted input.
- No environment variables or secrets are written to logs.
- No telemetry or external data transmission without an explicit, reviewed requirement.
