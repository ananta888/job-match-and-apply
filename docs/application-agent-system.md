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
`evidence-application-package@1.1.0` erzeugt für Evidence, Author, ATS, Recruiter/Style und
Finalizer jeweils einen eigenen Node-Run. Jeder Run erhält nur deklarierte Rohartefakte und
rollenspezifische Kriterien; ATS und Recruiter/Style prüfen den Author-Entwurf getrennt. Der
Finalizer erhält beide Reviews automatisch als komplementäre Eingaben; weder ein `user_input`-Gate
noch eine manuelle Fan-in-Entscheidung unterbricht den Lauf. Er muss direkt ein vollständiges
HTML5-Dokument als `final_html` liefern. Der Server entfernt aktive Inhalte und externe Ressourcen,
speichert die normalisierte HTML-Datei unveränderlich und zeigt sie sofort über eine
SHA-256-gebundene Sandbox-Route an. Die Anzeige selbst genehmigt oder versendet nichts.
