---
name: bewerbung-pipeline
description: Route job-specific CV, cover-letter, application-email, ATS, recruiter, candidate-match, and interview tasks in this repository to the evidence-backed Bewerbungs-Schreib-Assistent submodule. Use whenever application material or candidate claims are created, reviewed, tailored, finalized, or exported.
---

# Bewerbungspipeline

1. Read `integrations/bewerbungs-schreib-assistent/SKILL.md` completely and follow it as the
   authoritative domain workflow.
2. Resolve private profiles from the paths configured by this application. Never use example
   profiles as candidate facts.
3. Keep intermediate artifacts under `.application-work/`; never put them in `todos/`.
4. Treat the UI search score only as `searchPreferenceScore`. Recompute candidate matching from
   claim IDs using the submodule's match classes.
5. Permit incognito identities for previews only. Refuse finalization or submission until a real
   identity and valid candidate profile are selected.
6. When modifying the skill implementation itself, work and commit inside the submodule; update
   the parent submodule pointer afterward.

Do not duplicate the submodule's evidence, ATS, style, or review rules here.
