# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

All project instructions live in `AGENTS.md`, shared with Codex, OpenCode, Gemini CLI, Cursor and
Copilot. Edit rules there, not here.

@AGENTS.md

## Claude Code specifics

- For application material (CV, cover letter, ATS/recruiter review, claims) use the
  `bewerbung-pipeline` skill; it routes to `integrations/bewerbungs-schreib-assistent/SKILL.md`.
- Do not create `.mcp.json` or `.claude/settings*.json` with MCP servers or plugins; see
  "Agent tool setup" in `AGENTS.md`.
