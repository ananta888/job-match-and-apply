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
- keyboard skip navigation, focus operation and Axe WCAG 2 A/AA checks
- reviewed desktop, tablet and mobile full-page screenshot baselines

Timeline pause freezes only presentation; REST/SSE ingestion continues and is asserted losslessly.
Provider-level pause/resume remains deliberately separate: the productive endpoints currently fail
closed because no enabled provider offers a proven safe pause/resume bridge, so the UI does not
present them as available controls.

Agent output is proposal-only because the current run API exposes no validated promotion endpoint
to domain commands or document revisions. The disabled control and explanation are part of the
tested safety contract; the suite does not call the generic artifact-writing endpoint with raw agent
output.

Run `npm run e2e:update` only for an intentional visual change and inspect every updated PNG before
committing it. Playwright traces, videos, failure screenshots and HTML reports stay ignored.
