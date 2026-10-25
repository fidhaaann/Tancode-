# Change log

Record each meaningful project change during the event, newest first. Update this file in the same commit as the change. Use a real timestamp with timezone, for example `YYYY-MM-DDTHH:MM:SS+05:30`.

## 2026-10-25T08:35:00+05:30 — Capture and explain terminal failures

- Changed: subscribed to VS Code shell integration start/end events and read terminal output as the command runs. Failed commands now produce an automatic Tancode explanation containing the command, working directory, exit code, and bounded ANSI-cleaned output.
- Safety: terminal text is passed as untrusted evidence; Tancode never executes or retries the command, and output is bounded locally before it reaches Ollama. Successful commands remain silent.
- Tests: added terminal capture and context-formatting tests. `npm run typecheck` and `npm test` pass — 147/147.
- Limitation: VS Code cannot expose output for every terminal type. Task terminals, terminals without shell integration, and commands that began before Tancode activation may provide only partial metadata or require pasted output.

## 2026-10-25T08:20:00+05:30 — Add evidence-aware diagnostic mentoring

- Root cause: diagnostic explanations did not consistently preserve VS Code's exact location/provider metadata, and chat had no separate path for error-focused questions.
- Changed: workspace diagnostics now retain severity, message, code, source/provider, start and end ranges, with active-file priority. Diagnostic prompts label confirmed editor evidence separately from inferred causes and fixes, teach the underlying concept, and explicitly suggest changes without applying them.
- Changed: error-related chat requests receive a compact diagnostic context block; requests with no current diagnostics are told to treat code concerns as potential rather than confirmed. Proactive diagnostic explanations remain a separate flow from user-initiated chat.
- Tests: added evidence metadata and location-sensitive diagnostic coverage. `npm run typecheck` and `npm test` pass — 145/145.
- Limitation: terminal output, runtime exceptions, debug-adapter events, and build/test results are not captured automatically; users can provide that evidence in chat.

## 2026-10-25T07:58:55+05:30 — Expand project file scanning and analysis

- Root cause: project orientation only peeked two directory levels, counted a small hard-coded extension map, and had no shared file registry or workspace-file retrieval path. Active-file analysis also rejected most valid VS Code language IDs.
- Changed: added `src/fileTypes.ts` and `src/fileScanner.ts` with recursive discovery, extension and special-filename detection, hidden configuration support, `.gitignore` handling, binary rejection, default generated/dependency exclusions, scan outcomes, and non-active file lookup.
- Changed: project facts now use the recursive inventory and report discovered/skipped/failed files; chat can retrieve a referenced in-workspace file such as CSS without requiring it to be open. Added configurable `tancode.scan.excludeDirs` and `tancode.scan.includeGenerated`.
- Changed: expanded language support across web, configuration, programming, infrastructure, documentation, data, notebook, and contract formats; added CSS-family structural fallback for selectors, custom properties, imports, and media queries.
- Tests: added registry/scanner coverage for CSS, nested monorepos, dotfiles, special filenames, binaries, ignored files, generated-directory configuration, and non-active reads. `npm run typecheck` and `npm test` pass — 144/144.
- Limitation: `.gitignore` matching is intentionally conservative (literal directory/file patterns); VS Code `files.exclude`/`search.exclude` settings are not yet mirrored by the vscode-free scanner.

## 2026-10-25T07:51:19+05:30 — Fix conversational chat routing

- Root cause: user chat was sent through a generate-style prompt framed around the active file, and the current user turn was duplicated in the serialized history. That made unrelated requests look like file-explanation requests and weakened follow-up context.
- Changed: added an Ollama `/api/chat` client path with real `system`/`user`/`assistant` roles for user-initiated chat; active-file, selection, and project facts are now separate untrusted workspace context and no longer override the user request. Existing `/api/generate` remains the separate path for file explanations, diagnostics, and proactive mentoring.
- Changed: the panel excludes the just-submitted visible turn from prior history before sending it as the current user message. Streaming, cancellation, malformed responses, model errors, and local-only behavior remain supported.
- Tests: added mocked `/api/chat` response/stream coverage and role/current-turn prompt assertions; updated service chat tests. `npm run compile`, `npm run typecheck`, and `npm test` pass — 141/141.
- Limitation: live response quality still depends on the configured local Ollama model and was not exercised in a running Extension Development Host.

## 2026-10-24 — Remove file-size rejection + README rewrite (UTC)

- Removed the arbitrary 64 KB file-size rejection (`tooLarge` state deleted): `tancode.maxSourceBytes` is now a prompt context budget — larger files go through sectioned analysis instead of being refused. Also removed the 512 KB rules-analysis cutoff and the oversized-selection rejection.
- New `src/model/sections.ts`: `splitSections` cuts on declaration/line boundaries (never drops content), `declarationsOf` feeds cross-section symbols. `ExplanationService.explainSectioned` runs sequential per-section summaries (bounded rolling context), then a combine pass that discloses the sectioned scope and any failed sections. Cancellable between sections; progress shown via streaming. Fixed an infinite loop when a single line exceeds the budget.
- Selections: only empty/unsupported states short-circuit; large selections are sent, not rejected.
- Rewrote README to match the verified implementation: features, Mermaid architecture, prerequisites, install, Ollama config, dev workflow, commands table, settings reference, usage examples, troubleshooting, dev/testing, privacy, honest roadmap.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 138/138 pass on Node v24.
- Not verified: live sectioned analysis latency/quality against qwen3:8b (no Ollama on this VM).

## 2026-10-24 — Fix: pinned chat context survives file clicks (UTC)

- Bug: while chatting, clicking/opening another source file silently re-pointed the conversation — `onDidChangeActiveTextEditor` re-explained the newly focused file and `currentDoc()` read `activeTextEditor`, so both the pinned context card and the doc chat answers describe switched files mid-conversation.
- Fix: the panel now pins the context file (uri + document) once an explanation renders; while `history` is non-empty, switching editors posts one dismissible note ("Context is still X — run Tancode: Explain Current File…") and keeps the pinned context. Chat answers (`currentDoc`) use the pinned doc, not the focused editor. `Explain Current File` / Back-to-file still repin intentionally; Clear Conversation resumes normal auto-tracking.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 128/128. Interactive click behavior needs the Extension Dev Host (no desktop VS Code here).

## 2026-10-24 — JSON intelligence + project version awareness (UTC)

- `.json`/`.jsonc` files are now supported: a tolerant JSONC parser (comments, trailing commas) drives a structural rules fallback (top-level keys, nesting depth) and never pretends invalid/incomplete JSON is valid.
- New project tech profile (`src/project.ts`): `package.json` deps/engines/scripts, `package-lock.json`/`npm-shrinkwrap.json` resolved versions, `tsconfig.json` compilerOptions, `.nvmrc`/`.node-version` toolchain files, and conservative text extraction for `requirements.txt`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `Dockerfile`.
- Versions are classified **declared / resolved / runtime / unknown** — a manifest range is never claimed installed; lockfile resolutions and exact-version conflicts are surfaced explicitly. `node --version` is probed as a real detected runtime and labelled as such.
- Secret-looking keys (`token`, `password`, `api_key`, …) are redacted before any config data reaches a prompt or log.
- Proactive manifest insight: opening a manifest/config file posts one grounded note (e.g. what `engines.node` actually means) or stays quiet (`NONE`); deduped by profile hash, budget-gated, dismissible.
- Chat answers now receive the tech profile as `<project_context>` so version/config questions are evidence-grounded.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 128/128 pass on Node v24.
- Not verified: live proactive note + chat answers in the Extension Development Host (no desktop VS Code/Ollama on this VM).

## Event build log

## 2026-10-25T04:30:00+05:30 — JARVIS mentor: project orientation, WHAT/HOW/WHY teaching, wrap-up, richer controls

- Changed: Tancode now opens with a one-time **project orientation** grounded only in deterministic local facts — `src/project.ts` collects the package manifest (scripts/deps), config files, top-level directories, language mix (bounded 2-level scan, node_modules etc. excluded), entry-point candidates, and a README excerpt; `buildOrientationPrompt` forbids inventing structure; `ExplanationService.projectOrientation` caches by facts hash and posts once per panel session through the same proactive budget.
- Added: **WHAT/HOW/WHY teaching frame** (`teachingFrame` in `src/model/prompt.ts`) applied to substantial explanations — the detail file prompt, Learn mode, and diagnostic notes now ask for what/how/why plus, when `tancode.explanation.simplified` is on, a plain-language version and a real-world analogy with its caveat. Short chat answers stay conversational — the frame is never forced.
- Added: **session wrap-up** — "wrap up" / "I'm done" / "recap what we built" routes to `service.sessionRecap` (never cached), grounded in session evidence only: project facts, files saved this session (bounded list tracked on saves), and conversation history. Ends with a "Can you explain it back to me?" section with two optional questions; the prompt forbids claiming mastery.
- Added: **user controls** — `tancode.proactive.frequency` (low=300s / balanced=90s / high=30s / custom→`cooldownSeconds`, mapped by `effectiveCooldownSeconds`), `tancode.explanation.depth` (detailed ≈1.5x output budgets via `capFor`), `tancode.explanation.simplified`, `tancode.explanation.interactiveQuestions` (gates knowledge checks), and `Tancode: Clear Conversation` (command, toolbar Clear button, or "clear the chat") wiping feed + history.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 102/102 pass; new tests cover `collectProjectFacts` on a fixture project, facts formatting bounds, frequency mapping, orientation/wrapup/teach-frame prompts, orientation caching + recap non-caching, detailed-depth caps, and wrap-up/clear intent routing.
- Limitations: live orientation/recap generation and the Clear button were not exercised in a running VS Code (no desktop/Ollama on the build VM); they need the user's Extension Development Host check.

## 2026-10-25T03:30:00+05:30 — Proactive conversational mentor

- Changed: the panel is now a conversation — a pinned context card (current file/selection explanation) above a chronological feed of user messages, streamed answers, and tagged assistant notes (learning moment / error / question / feedback), with a chat composer at the bottom, a Stop-generation control while anything generates, a pause/resume toggle, and a footer showing the proactive message budget (`proactive N/12`).
- Added: `src/conversation.ts` (feed entry model + bounded in-memory history), `src/proactive.ts` (content/diagnostic hashing, diagnostic picker, `ProactiveBudget` — dedupe by stable key, configurable cooldown, per-session cap; `check()` is non-mutating so blocked insights can still post later), `src/chat.ts` (intent router: pause/resume/why/quiz-answer/direct). New prompts: `buildDiagnosticPrompt` (confirmed editor diagnostic vs inferred cause, ends with one follow-up question), `buildInsightPrompt` (one grounded insight or literal `NONE`), `buildChatPrompt` (bounded history + untrusted `<user_question>` + selection/file context). New service methods: `explainDiagnostic` (cached by diagnostic key), `findInsight` (cached by content hash), `chatAnswer` (never cached). New settings: `tancode.proactive.enabled` (also toggled live from the toolbar or by saying "pause proactive"), `tancode.proactive.level` (all | errors-only), `tancode.proactive.cooldownSeconds`, `tancode.proactive.maxPerSession`.
- Proactive behavior: only event-driven — debounced `onDidChangeDiagnostics` (active file only, errors prioritized, each unique diagnostic explained at most once), debounced `onDidSaveTextDocument` (insight only when the model finds something worth teaching; `NONE` = stay quiet), and at most one knowledge-check question after a Learn explanation. Cooldown-blocked items retry when the budget frees up; model failures mark the diagnostic seen so there is no retry storm. Stop aborts user-driven and proactive requests alike; a stopped run posts a quiet "Generation stopped." note instead of an error banner.
- Chat: direct questions route to `chatAnswer` with the current selection or active file plus recent history (12 turns, truncated); pause/resume/why handled locally without inference; answering a pending knowledge-check question gets assessed reasoning feedback. Quiz moved into the feed as state entries so the conversation stays visible.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 90/90 pass; new unit tests cover the budget/dedupe/cooldown rules, intent routing, conversation rendering (tags, dismiss, pause toggle, escaping), the three new prompts, and the three new service methods.
- Limitations: Proactive triggers and the live webview were not exercised in a running VS Code (no desktop or Ollama on the build VM); the diagnostics listener, save listener, streaming chat, and toolbar controls need the user's Extension Development Host check.

## 2026-10-25T00:00:00+05:30 — Performance: streaming, output caps, model warm-up

- Changed: `src/model/ollama.ts` now supports NDJSON streaming (`stream: true` when an `onToken` callback is passed — thinking fields are ignored, malformed chunks fail as `malformed`), per-request `num_predict`, `keep_alive: 10m`, and user cancellation via `AbortSignal` (maps to a new `cancelled` error kind). `src/model/service.ts` adds a `NUM_PREDICT` table (summary 200 / detail 500 / selection 300 / learn 500 / question 180 / assessment 500) and logs `explain cache hit`, `explain dedupe`, `explain first token` (time-to-first-byte), and `num_predict` per request. `src/explanationPanel.ts` cancels in-flight requests when a newer update starts and renders streamed text progressively (throttled to ~120ms, escaped, buttons hidden until complete). `src/view.ts` adds a `partial` model state. `src/model/prompt.ts` instructs the model to answer directly without preamble. README documents the performance model.
- Why: make first-useful-text appear fast on qwen3:8b on the user's RTX 4060 laptop — streaming + no-thinking + capped output + warm model are the big latency levers; measurement lands via the Output channel.
- Validation: `npm run compile`, `npm run typecheck`, `npm test` — 69/69 pass, incl. real-HTTP e2e tests for stream reassembly, thinking-field exclusion, and `num_predict`/`keep_alive`/`think` on the wire; unit tests for cancellation, malformed chunks, and per-mode caps.
- Limitations: No Ollama or GPU on the build VM — measured latency claims need the user's machine; the `explain first token:`/`duration=` log lines provide the numbers. Interactive streaming render needs desktop VS Code verification.

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
