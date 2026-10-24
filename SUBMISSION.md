# Project submission

Complete this file during the hackathon and use it to prepare your submission through the method announced by the organizers. Do not submit your project to the template repository.

## Project

- **Project name:** Tancode
- **Short description:** A local-first VS Code extension that explains the active source file — summary, key declarations, expandable detail — so developers learn technical concepts while vibe coding without spending coding-agent credits.
- **Code repository URL:** https://github.com/fidhaaann/Tancode-
- **Final submitted implementation commit SHA:** TODO
- **Working demo URL or local demo steps:** Open in desktop VS Code → `npm ci` → `npm run compile` → press F5 → in the Extension Development Host open a source file → Command Palette → `Tancode: Explain Current File`.
- **Demo access requirements:** Node.js 20+, VS Code 1.90+. No accounts, keys, or network access needed.

## Participants

Participate solo or in a team of up to 4. Remove unused rows.

| Participant name | GitHub handle | Contribution |
| --- | --- | --- |
| TODO | TODO | TODO |

## Run and demonstrate

- **Prerequisites and versions:** Node.js 20+, desktop VS Code 1.90+
- **Install command:** `npm ci`
- **Required environment variable names:** none — `.env.example` holds inert placeholders for a future local model runtime.
- **Start command:** `npm run compile`, then F5 in VS Code
- **Demo walkthrough:** open any supported source file in the Extension Development Host, run `Tancode: Explain Current File`, switch tabs to watch the panel follow the active file, expand "More detail".
- **Checks performed and results:** `npm ci` (clean install), `npm run compile`, `npm run typecheck` — all pass on Node 20. F5 interactive test pending (requires desktop VS Code).
- **Known limitations or incomplete features:** rule-based heuristics, not AI explanations; no model integration, selected-code explanation, or error explanation yet.
- **Libraries, APIs, and public datasets used:** VS Code Extension API only (`@types/vscode`); no external services or datasets.
- **AI usage record:** [AI_USAGE.md](AI_USAGE.md)
- **Development change log:** [CHANGELOG.md](CHANGELOG.md)

## Submission checklist

- [ ] The project implementation started from scratch at the event.
- [ ] I participated solo or with no more than 4 team members in total.
- [ ] Codex was used during development and its usage is documented.
- [ ] The code repository URL, short description, and working demo are provided.
- [ ] README setup and demo instructions match the submitted code.
- [ ] Actual checks and known limitations are documented.
- [ ] Meaningful changes are documented and committed throughout development.
- [ ] The final implementation is committed and pushed, and its SHA is recorded above.
- [ ] No credentials or private data are included in the repository or demo instructions.
- [ ] The organizers' announced submission method and timing have been followed.

Event reference: [DevDay Exchange Community: Kochi on Luma](https://luma.com/z10nz8gp). The event wraps up by **10:00 AM IST on 11 October 2026**.
