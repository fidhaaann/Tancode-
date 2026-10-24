# Change log

Record each meaningful project change during the event, newest first. Update this file in the same commit as the change. Use a real timestamp with timezone, for example `YYYY-MM-DDTHH:MM:SS+05:30`.

## Event build log

## 2026-10-24T23:45:00+05:30 — Milestone 3: selected-code learning + Test My Understanding

- Changed: New `Tancode: Explain Selected Code` command (`src/extension.ts`, `package.json` command + `editor/context` menu gated on `editorHasSelection`) — explains just the selected lines with a few lines of surrounding context clearly separated (`<selection>` vs `<context>` tags). `src/model/prompt.ts` adds selection/learn/question/assessment prompt builders and `parseSections`. `src/model/service.ts` adds `explainSelection` (cache key includes mode + line range), `generateQuestion`, and `assessAnswer` (quiz calls never cached). `src/messages.ts` is a new vscode-free dispatch table for every webview message — Phase-1 audit made the message contract directly testable. `src/view.ts` gains selection/learn/quiz/quizResult states, a textarea answer input, and per-mode actions (Explain / Learn / Test My Understanding / Retry / Back to file). `src/explanationPanel.ts` now tracks a file-or-selection target, keeps selection/quiz views stable across editor switches, and routes Retry to the last attempted flow (explanation, question, or assessment).
- Why: Learn-while-vibe-coding milestone — teach selected code in structured sections and verify understanding with a practice question, while keeping the existing file explanation and all safety properties.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 55/55 pass, incl. dispatch coverage for every message type, selection/learn/quiz prompt builders, cache separation by mode+range, a wire-level e2e asserting `<selection>` tags reach `/api/generate`, and a render test that fails if any button's `data-action` lacks a dispatcher handler.
- Limitations: Interactive flows (context menu, textarea submit, expandable sections) need desktop VS Code verification; live inference against real Ollama remains the user's manual check.

## 2026-10-25T03:30:00+05:30 — Faster Qwen replies + webview click logging

- Changed: `src/model/ollama.ts` sends `think: false` with every generate request — qwen3-style reasoning models spend most of their latency on a hidden thinking pass; disabling it is several times faster (ignored by non-thinking models and older Ollama versions). `src/explanationPanel.ts` logs every incoming webview message (`webview message: type=…`) so dead-button reports can be told apart: a click that logs nothing means stale build/script, not dispatch.
- Why: User reports Retry/detail still not working (merged fix may not be rebuilt locally) and asks for faster responses.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 34/34 pass; e2e asserts `think: false` reaches the wire.
- Limitations: If clicks still log nothing after pulling + recompiling + restarting the Extension Host, the build is stale.

## 2026-10-25T03:00:00+05:30 — Fix: Retry/detail buttons actually dispatch requests

- Changed: `src/explanationPanel.ts` — `lastDoc` now tracks `mode`, so clicking "Explain in more detail" no longer hits the uri+version early-return (the real reason the button did nothing); added a `summary` message handler; forced retries always render the loading state (removing the buttons and preventing double-clicks). `src/view.ts` — detail mode shows a "Back to summary" button that restores the cached short explanation.
- Why: The message names matched and `postMessage` worked, but `update()` early-returned on unchanged uri+version so `detail` requests were never dispatched; retries ran but showed no loading state.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 34/34 pass.
- Limitations: Interactive button clicks still need verification in desktop VS Code.

## 2026-10-25T02:45:00+05:30 — Fix: panel no longer wipes when it gains focus + Ollama health probe

- Changed: `src/explanationPanel.ts` ignores active-editor changes where the webview itself holds focus (clicking the panel previously fired the event with `undefined` and `update()` rendered the "No active editor" state, losing the explanation); `buildService()` now probes `GET /api/tags` (4s timeout) and logs `ollama health:` reachability + installed model names to the `Tancode` output channel.
- Why: User reported the panel closing when clicked and still showing only the rule-based summary.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 34/34 pass. Focus behavior needs desktop VS Code to verify.
- Limitations: Health result is logged only; a dedicated health UI is out of scope.

## 2026-10-25T02:10:00+05:30 — Fix: default timeout too short for local inference + diagnostics

- Changed: `tancode.requestTimeoutMs` default 30s → 120s (with `stream:false` the entire generation must finish inside the budget; qwen3:8b on CPU regularly exceeds 30s → silent-feeling fallback); `updateSeq` staleness guard in `src/explanationPanel.ts`; `parseResponse` also strips an unterminated `<think>` tail; service logging now includes endpoint, status, and duration; new `src/test/e2e.test.ts` drives real HTTP + real fetch through to `renderBody`.
- Why: User reported only the rule-based summary despite a working Ollama. The request path was verified correct; the most probable live cause is the 30s timeout aborting generation, surfacing as an error + fallback. Logging now names the exact failure kind.
- Validation: `npm ci`, `npm run compile`, `npm run typecheck`, `npm test` — 34/34 pass, including e2e tests over a real local HTTP server proving the model response reaches the rendered panel. Live EDH inference still unverified in this environment (no Ollama).
- Limitations: Windows EDH confirmation remains manual — check the `Tancode` output channel for the request's logged outcome.

## 2026-10-24T22:50:00+05:30 — Ollama provenance indicator and request logging

- Changed: `src/view.ts` now renders an explicit source badge (`Generated by local model: <model>` / `Rule-based fallback — the model did not generate this`); `src/log.ts` adds a `Tancode` output channel logging each explain request and outcome; `src/model/service.ts` logs through it; added tests for modelMissing/timeout/logging and source labels.
- Why: A "normal-looking" explanation gave no way to confirm it came from Ollama — the provenance marker was too subtle and there was no request log. The code path itself was verified correct (default endpoint `http://127.0.0.1:11434`, default model `qwen3:8b`).
- Validation: `npm ci`, `npm run compile`, `npm run typecheck`, `npm test` — 29/29 tests pass with mocked Ollama. Live inference still unverified in this environment.
- Limitations: Confirm live against Windows Ollama via the `Tancode` output channel.

## 2026-10-24T22:20:00+05:30 — Milestone 2: local Ollama integration

- Changed: Added `src/model/` (`prompt.ts`, `ollama.ts`, `cache.ts`, `service.ts`), `src/settings.ts`, `src/view.ts`; reworked `src/explanationPanel.ts` to request model explanations with loading/error states, debounce, dedupe, and a detail mode; added `tancode.*` VS Code settings; added `src/test/` unit tests and `npm test`.
- Why: Replace the deterministic placeholder with explanations from a local Ollama model while keeping a labelled rule-based fallback.
- Validation: `npm ci`, `npm run compile`, `npm run typecheck`, `npm test` — 25 unit tests pass (Ollama mocked). Real-model inference and the interactive webview were not exercised — no Ollama in the build environment.
- Limitations: Needs a running local Ollama with a pulled model; manual F5 + live-model check remains.

## 2026-10-24T21:30:00+05:30 — Applied hackathon template docs

- Changed: Added `RULES.md`, `AGENTS.md`, `SUBMISSION.md`, `.github/pull_request_template.md`, this change log, and `AI_USAGE.md` from the DevDay Kochi hackathon template; merged its secret-file ignore rules into `.gitignore`.
- Why: Align Tancode with the participant repository conventions (documented changes, AI usage record, submission details).
- Validation: Markdown-only change; links and file list checked.
- Limitations: Participant names and final submission SHA in `SUBMISSION.md` remain TODO.

## 2026-10-24T20:45:00+05:30 — Milestone 1: rule-based file explanation panel

- Changed: `src/analysis.ts` (deterministic explanations for 15 languages), `src/explanationPanel.ts` (CSP-locked `Tancode` webview that follows the active editor), `tancode.explainCurrentFile` command, README usage.
- Why: First usable feature — explain the active file locally without any AI model.
- Validation: `npm ci`, `npm run compile`, `npm run typecheck` pass; analyzer smoke-tested on sample TypeScript/Python inputs.
- Limitations: Interactive webview test requires desktop VS Code — pending manual F5 check.

## 2026-10-24T20:10:00+05:30 — Build reliability hardening

- Changed: `engines.node >=20`, `.npmrc` `engine-strict=true`, `scripts/preflight.js` wired as pre-scripts, troubleshooting docs.
- Why: `npm run compile` failed with `'tsc' is not recognized` when `node_modules` was missing — needed a clear failure path instead of a raw `tsc` error.
- Validation: clean `npm ci` → compile/typecheck pass; preflight prints the `npm ci` hint when dependencies are missing.
- Limitations: F5 launch still requires manual verification in desktop VS Code.

## 2026-10-24T19:55:00+05:30 — Initial VS Code extension scaffold

- Changed: Created `package.json`, `src/extension.ts`, `tsconfig.json`, `.vscode/` launch+tasks, `.gitignore`/`.vscodeignore`, `.env`/`.env.example`, README.
- Why: Project foundation per the initial milestone spec.
- Validation: `npm install`, `tsc` compile and `--noEmit` typecheck pass; `git check-ignore` confirmed `.env` untracked and `.env.example` tracked.
- Limitations: Extension Development Host launch not exercised in the build environment.
