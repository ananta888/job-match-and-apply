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
 Evidence Review ──> Author ──┬──> ATS Review ────────────┐
                              └──> Recruiter/Style Review ─┴──> Finalizer
                                                                 │
                                                                 ▼
                 validate_profiles + validate_iteration + audit_claims
                              + check_style + local language check
```

Ein Suchprofil beschreibt Wünsche. Nur das Kandidatenprofil kann Tatsachen belegen. Der
`searchPreferenceScore` wird deshalb weder in die Match-Matrix noch in ATS-Berichte übernommen.

## Inkognito

Inkognito ersetzt Kontaktdaten ausschließlich für Vorschau und UI-Tests. Die API blockiert eine
Finalisierung mit Inkognito-Identität. Für ein finales Dokument sind eine reale Identität, private
Profile, ein annotierter Entwurf und ein valides Review-Manifest erforderlich. Erst nach
erfolgreichem Claim-, Stil- und Sprach-Audit entfernt der Adapter die internen Evidence-
Annotationen. Standardbackend ist die lokale `nspell`-Prüfung mit gebündelten deutschen und
englischen Wörterbüchern. Ein lokaler LanguageTool-Server oder Hunspell kann explizit konfiguriert
werden; Bewerbungsinhalte werden nicht automatisch an einen entfernten Dienst gesendet.

## Lokale Profile

Die Root-App legt Kandidaten- und Stilprofil ausschließlich unter `.local-data/profiles/` an. Das
bestätigte Onboarding kopiert nur die Beispielvorlagen des Submodules, überschreibt keine
vorhandenen Profile und erfindet keine Fakten. Stiländerungen sind an die geladene Revision und den
vollständigen SHA-256 gebunden und müssen den Profilvalidator des Bewerbungs-Submodules bestehen.

## Review-Rollen

Die Rollenverträge werden nicht im Hauptprojekt neu erfunden. Maßgeblich sind `SKILL.md` und
`references/iteration-loop.md` des Bewerbungs-Submodules. Der lokal verdrahtete Root-Workflow
`evidence-application-package@1.0.0` erzeugt für Evidence, Author, ATS, Recruiter/Style und
Finalizer jeweils einen eigenen Node-Run. Jeder Run erhält nur deklarierte Rohartefakte und
rollenspezifische Kriterien; ATS und Recruiter/Style prüfen den Author-Entwurf getrennt. Der
Finalizer besitzt im aktuellen Workflow vor seinem Lauf ausschließlich das bewusste
`user_input`-Gate; ein vorgezogenes `review_complete` existiert nicht. Er erzeugt lediglich eine
strikt validierte `package_proposal`. Erst Artefakt-Review, Adoption mit erneuter
Submodule-Validierung, die daraus erzeugte fachliche Vorschlagsrevision, deren Review sowie exakte
Revisions- und Hashgates erlauben Fallfreigabe, `used` und Export.
