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
