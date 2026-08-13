# Todo-, Skill-, MCP- und Agentensystem

## Getrennte Ebenen

| Ebene | Eigentümer | Artefakte |
|---|---|---|
| Entwicklung des Integrationsprojekts | `job-match-and-apply` | `AGENTS.md`, `todos/`, Tests, Ports und Adapter |
| Portalzugriff und Browsersitzungen | `job-search-mcp` | MCP-Tools, Portalprofile, Credentials und eigene Todos |
| Bewerbungsfachlichkeit | `bewerbungs-schreib-assistent` | Claims, Evidence Policy, ATS-/Stilregeln und Prüfskripte |
| Konkreter Bewerbungsdurchlauf | lokal und nicht versioniert | `.application-work/` |

Root-Todos dürfen keine Jobtreffer oder Bewerbungsentwürfe enthalten. Submodule-Todos werden nicht
dupliziert; eine Änderung wird zuerst im zuständigen Submodule umgesetzt und danach über dessen
Commit-Zeiger integriert.

## Ablauf

```text
SearchProfile ──> JobSourcePort ──> searchPreferenceScore
                                       │ nur Priorisierung
                                       ▼
                                  ausgewählter Job
                                       │
CandidateProfile ──> Evidence Policy ──┼──> Match-Matrix mit Claim-IDs
                                       ▼
 Author ──> Evidence Review ──> ATS Review ──> Recruiter/Style ──> Finalizer
                                       │
                                       ▼
        validate_profiles + validate_iteration + audit_claims + check_style
```

Ein Suchprofil beschreibt Wünsche. Nur das Kandidatenprofil kann Tatsachen belegen. Der
`searchPreferenceScore` wird deshalb weder in die Match-Matrix noch in ATS-Berichte übernommen.

## Inkognito

Inkognito ersetzt Kontaktdaten ausschließlich für Vorschau und UI-Tests. Die API blockiert eine
Finalisierung mit Inkognito-Identität. Für ein finales Dokument sind eine reale Identität, private
Profile, ein annotierter Entwurf und ein valides Review-Manifest erforderlich. Erst nach
erfolgreichem Claim- und Stil-Audit entfernt der Adapter die internen Evidence-Annotationen.
Die klassische Sprachprüfung bleibt ein offengelegtes externes Gate: Sie benötigt einen lokal
konfigurierten LanguageTool-Server oder Hunspell und darf Bewerbungsinhalte nicht ohne ausdrückliche
Freigabe an einen entfernten Dienst senden.

## Review-Rollen

Die Rollenverträge werden nicht im Hauptprojekt neu erfunden. Maßgeblich sind `SKILL.md` und
`references/iteration-loop.md` des Bewerbungs-Submodules. Separate Agentenkontexte erhalten nur
Rohartefakte und ihre rollenspezifischen Kriterien. Wenn keine getrennten Kontexte verfügbar sind,
muss das Manifest `sequential_single_agent` ausweisen.
