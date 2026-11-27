# AGENTS.md

## Scope and purpose

These instructions apply to the integration repository `job-match-and-apply`. The project joins
the independently versioned `job-search-mcp` and `bewerbungs-schreib-assistent` submodules behind
owned ports. Explicit user instructions take precedence.

## Sources of truth

Use evidence in this order:

1. explicit user requirements and confirmations
2. the closest applicable `AGENTS.md`
3. active Todo artifacts and their unchanged schemas
4. source code, tests, configuration, and runtime evidence
5. documentation

For application claims, the candidate profile and the evidence policy in
`integrations/bewerbungs-schreib-assistent` are authoritative. A search preference is never
candidate evidence.

## Repository boundaries

- Keep Angular and integration orchestration in this repository.
- Keep portal discovery, browser sessions, credentials, and portal policy in `job-search-mcp`.
- Keep candidate evidence, ATS rules, drafting checks, and review roles in
  `bewerbungs-schreib-assistent`.
- Commit changes inside a submodule to that repository first. Then update only its commit pointer
  here. Never duplicate a submodule Todo in the root Todo system.
- Integrate submodules only through narrow ports or their published CLI/MCP contracts.

## Todo workflow

The root `todos/` directory tracks development of this integration repository only.

- `todos/feature/`: proposed work
- `todos/active/`: accepted work being implemented
- `todos/archiv/`: completed or superseded work with evidence

Do not use Todos for job-search results or application artifacts. Those belong under the ignored
`.application-work/` directory. Do not modify `todos/todo.schema.json` or
`todos/todo.track.schema.json` unless the user explicitly requests a schema change.

Use `todo`, `in_progress`, `partial`, `blocked`, and `done` consistently. A task is `done` only
after its acceptance criteria and relevant verification are satisfied. Validate every changed
Todo against its declared schema and keep summaries consistent.

## Application safety

- Treat `SearchProfile` as preferences and `CandidateProfile` as factual evidence. Do not map one
  to the other implicitly.
- Label the deterministic search ranking as `searchPreferenceScore`; never call it an ATS score.
- Use the complete application skill pipeline for real documents: validate profiles, analyze the
  job, build a claim-backed match matrix, draft with evidence annotations, audit, review, and only
  then finalize.
- Incognito identities are allowed for previews and UI tests only. Block finalization and external
  submission while an incognito identity is active.
- Never invent candidate facts. Never publish `inferred`, `unverified`, or `do_not_use` claims.
- Keep profiles, sessions, work artifacts, credentials, and generated documents out of Git.

## Agent roles

Use specialized review contexts only when the application skill requests them. Author, evidence,
ATS, recruiter/style, and finalizer roles must receive raw artifacts and role-specific criteria.
Do not describe a sequential single-context review as independent validation.

## Working method and verification

Before changing behavior, inspect the relevant port, adapter, submodule contract, tests, and Todo.
Prefer a small testable vertical slice and Red-Green-Refactor. Run focused tests first, then:

```powershell
npm.cmd test
npm.cmd run build
```

Before finalizing, review the diff, submodule status, secrets, ignored personal data, Todo evidence,
and known limitations.

## Agent tool setup

This file is the single source of instructions for every coding agent. Codex, OpenCode, Cursor and
GitHub Copilot read it natively; `CLAUDE.md` imports it, `.gemini/settings.json` points Gemini CLI to
it, and `.github/copilot-instructions.md` only refers here. Change rules here, not in those files.

Do not add agent-managed MCP servers or plugins to project config (`.mcp.json`,
`.claude/settings*.json`, `.codex/config.toml`, `opencode.json[c]`, `.opencode/opencode.json[c]`):
`server/src/agents/provider-sandbox.ts` treats such declarations as a policy violation and blocks every
Agent Control Center run. Shared skills live in `.agents/skills/`.

User-facing docs, UI strings and error messages are German; keep new ones German.

## Commands

Node.js 22+ (npm 10). On Windows use `npm.cmd`. There are three npm packages: root, `server/`, `web/`.

```sh
npm install && npm --prefix server install && npm --prefix web install
git submodule update --init --recursive    # many server tests need integrations/*

npm run dev            # API on 127.0.0.1:3000 (tsx watch) + Angular on 127.0.0.1:4201 (proxies /api)
npm test               # scripts/*.test.mjs + server vitest + web unit tests
npm run build          # server tsc + ng build
npm run security:scan  # repository secret/privacy scan (also in CI)
npm run diagnose       # local tools: pdftotext/pdftoppm, tesseract deu+eng, runtimes
```

Focused checks:

```sh
cd server && npx vitest run src/services/match-service.test.ts      # one file
cd server && npx vitest run src/agents -t "<test name>"             # by test name
cd server && npx tsc -p tsconfig.json --noEmit                      # typecheck only
cd web && npm test -- --watch=false                                 # Angular unit tests
cd web && npm run e2e                                               # Playwright, serves on :43117
cd web && npm run e2e:update                                        # refresh *-win32.png snapshots
```

Server tests run with `--maxWorkers=1` and resolve `../contracts` and `../integrations` relative to
`server/`. Tests for the CV skill, candidate/style profile and application pipeline need the
submodules and `python` 3.12 with PyYAML on PATH. Without them they fail with `spawn python ENOENT` or
"CV-Skillvertrag nicht verfügbar"; that is an environment gap, not a regression.

Other entry points: `npm run agent:mcp` (root domain MCP server), `npm run mail:server` (receive-only
SMTP, needs `LOCAL_MAIL_SECRET`), `npm run job-mcp:smoke`, `npm run setup:integrations` (PowerShell;
writes `.local-data/job-search-mcp-launch.json`), `npm --prefix server run benchmark`.

## Architecture orientation

Angular UI -> Express 5 API bound to `127.0.0.1` -> submodules reached only through `server/src/ports`
and published CLI/MCP contracts. `job-search-mcp` is spawned over stdio as a trusted host, never inside
an agent sandbox and never as a child of an agent.

- `server/src/app.ts`: `createApp(store, audit, workspace, mailVault, agentApi, applicationPipeline)`
  builds the context, global middleware and registers the route modules in matching order.
  `http/app-context.ts` creates services, stores and shared helpers (`AppContext`); `http/routes/*.ts`
  hold the routes per area (agent setup, orchestrations, runs, run detail, search, applications,
  profile/CV); `http/middleware.ts` has request logging and the problem+json error handler;
  `http/app-support.ts` has schemas and view helpers. `index.ts` wires real dependencies, recovers
  agent runs and attaches the WebSocket realtime gateway. Tests inject `MemoryConfigStore` and use
  `supertest`.
- `server/src/adapters`: demo vs. MCP job source, local application assistant (submodule CLI),
  submodule CV normalization.
- `server/src/services`: matching, encrypted config/identity store, CRM and application tracking,
  mail vault/IMAP/EML, CV import with layout/OCR and AI structuring, style profile, `nspell` language
  check, DOCX/PDF export, retention.
- `server/src/agents`: Agent Control Center. Provider adapters (Codex exec/app server, OpenCode and
  Claude Code via WSL/Bubblewrap, OpenRouter HTTP, fake, experimental ACP), process supervisor,
  encrypted run/event/artifact stores with recovery and migrations, state machine, security
  policy/approvals, domain-tool bridge, and the multi-agent orchestration
  (`application-workflows.ts`, `application-orchestration-service.ts`, `orchestration-runner.ts`).
- Workflow `evidence-application-package`: Evidence -> Author -> (ATS || Recruiter/Style) ->
  Finalizer as separate node runs bound to input digests, budgets, retry rules and the
  ApplicationCase revision. The Finalizer yields normalized `final_html`.
- `contracts/v1/*.schema.json` + `contracts/fixtures/v1/` define the cross-repository boundaries
  (`server/src/contracts.test.ts`). Changing a shape means a versioned schema and fixture update.
- `web/src/app`: mostly one component (`app.ts`/`app.html`) plus `api.service.ts` and `models.ts`,
  which mirrors server DTOs and must stay in sync. E2E uses the mocked API in
  `web/e2e/support/agent-api.fixture.ts`.
- External portals stay blocked (`ALLOW_EXTERNAL_PORTALS=0`) until the user confirms portal access in
  the UI. Agents get no shell, write, web, MCP or subagent tools; only the opt-in Codex App Server gets
  run-bound, allowlisted root domain tools. Provider CLI versions are pinned exactly
  (`docs/release-matrix.md`, `contracts/v1/agent-provider-support.json`).
