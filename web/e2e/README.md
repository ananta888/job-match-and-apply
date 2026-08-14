# Agent Center browser E2E

This suite is intentionally offline. Every `/api/*` request is intercepted before navigation and
answered from deterministic fixtures under `e2e/support/`. The fixtures use only reserved
`example.invalid` addresses, synthetic identities, synthetic paths and fixed timestamps. Every
non-local HTTP(S) request is aborted and fails the test.

Covered browser contracts:

- redacted MCP configuration, read-only runtime diagnostics from `/api/sources/runtime` and the dedicated confirmed portal-access gate
- fail-closed portal enablement for invalid trusted-host launch diagnostics
- server-owned `/api/agent-runs/preflight` request parity and explicit provider, runtime, workspace,
  data scope, Root-MCP allowlist, network boundary, workflow, effective limits and scheduling state
- explicit trusted-host/offline boundary in the `guided-job-analysis` preflight, with no agent start,
  source search, external request, prompt, path or secret disclosure during inspection
- controlled run creation and explicit Windows/WSL runtime transport
- CAS-bound local Agent configuration, Codex App Server double opt-in, provider refresh and hard cost-budget projection
- suggestion-only multi-agent orchestration with the current `user_input` pre-gate, explicit inbox-mail binding and proposed pipeline packages
- ATS/style fan-in conflicts with complete variant witnesses, explicit domain resolution and stale-CAS rejection without retry
- typed employer-response and company-next-action proposals with source references, confidence and no send/calendar/status execution controls
- REST plus SSE event rendering
- a 450-event timeline with incremental rendering, search, type filters, presentation pause and lossless buffering
- redacted clipboard output and grouped agent-message deltas
- plain and masked user follow-up input with its transport warning
- global actionable, expired and stale approvals with revision-bound decisions
- explicitly unavailable edit-and-approve when the strict API does not accept edited parameters
- explicit cancellation
- queue diagnostics with global, provider, workspace and owner limits, priority aging and block reasons
- orphan recovery with browser-held operator leases, revision checks and separate cleanup/new-process confirmation dialogs
- active-run and timeline restoration after a page reload
- parent/child replay lineage, structured comparison and proposal-only artifact handling
- keyboard skip navigation, current-page semantics, visible focus, native modal focus containment/return and Axe WCAG 2.2 A/AA checks
- reviewed desktop, tablet and mobile full-page screenshot baselines

Timeline pause freezes only presentation; REST/SSE ingestion continues and is asserted losslessly.
Provider-level pause/resume remains deliberately separate: the productive endpoints currently fail
closed because no enabled provider offers a proven safe pause/resume bridge, so the UI does not
present them as available controls.

Agent output remains proposal-only by default. The only tested domain promotion path accepts an
approved, real-identity, current-case-bound `application-pipeline-package`, reruns the deterministic
pipeline and creates a proposed document revision. Typed mail and next-action proposals deliberately
have no send, calendar, status-change or generic promotion control.

Run `npm run e2e:update` only for an intentional visual change and inspect every updated PNG before
committing it. Playwright traces, videos, failure screenshots and HTML reports stay ignored.

## Accessibility acceptance record

Target: WCAG 2.2 AA for the locally operated Angular workspace.

On 2026-08-14 the complete offline Chromium suite was reviewed at desktop, tablet and mobile
widths. The keyboard path covers the skip link, main-region focus, semantic current-page navigation,
form controls, start confirmation, native modal focus containment and trigger return, and the
case-bound language workflow. Focus remains visibly marked;
reduced-motion mode disables automatic timeline motion. All interactive controls in the Angular
unit contract have an accessible label or name, live status and alert regions announce asynchronous
state, and Axe reports no WCAG 2.0 A/AA, 2.1 AA or 2.2 AA violations for the covered Agent Center and
application-pipeline regions. Every updated baseline PNG was inspected after the passing run.
