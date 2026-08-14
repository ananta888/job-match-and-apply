# Integrationsverträge

## Verantwortungen

| Vertrag | Anbieter | Verbraucher | Transport |
|---|---|---|---|
| Job Search `1.x` | `job-search-mcp` | lokale Express-API | MCP über stdio |
| Application Pipeline `1.x` | `bewerbungs-schreib-assistent` | lokale Express-API | lokale CLI und Artefakte |
| Workspace API `1.x` | lokale Express-API | Angular | HTTP/JSON auf Loopback |
| Agent Runner `1.x` | lokale CLI-Adapter | Agent Control Center | strukturierte Events über Prozess-/Providerprotokoll |
| Agent Control API `1.x` | lokale Express-API | Angular | REST-Kommandos und resumierbare SSE-Events |
| Agent Artifact `1.x` | Agent Control Center | lokale Express-API und fachlicher Übernahmeport | content-addressed Blob plus revisionsgebundene Metadaten |
| Agent Domain Tools `1.x` | lokale Express-API | erlaubte Agenten | rungebundene MCP-/Command-Fassade |

Major-Versionen definieren die Kompatibilitätsgrenze. Minor-Erweiterungen müssen additiv sein;
Verbraucher ignorieren unbekannte Felder. Ein unbekanntes Major deaktiviert nur den betroffenen
Adapter und darf weder auf einen unsicheren Fallback wechseln noch externe Seiteneffekte auslösen.

Die maschinenlesbare Supportmatrix liegt in
`contracts/v1/agent-provider-support.json`. Unbekannte CLI-Versionen werden blockiert. Eine
Freigabe benötigt eine synthetische, secret-freie Fixture, Mapper-Replay, feste argv-/Prompt-
Prüfung, den Nachweis der effektiven Sandbox-/Netzwerkpolicy, unveränderte Approval-Defaults,
Canary- sowie Cancel-/Limit-/Recovery-Tests und ein enges Versionsmuster. Experimentelle Pfade
sind serverseitig standardmäßig aus und werden in API und UI sichtbar markiert. Reguläre
Entfernungen haben mindestens 90 Tage Ankündigungsfrist; nur dringende Sicherheitsabschaltungen
dürfen sofort erfolgen. Kein Providerupdate darf Sandbox- oder Approval-Rechte ohne neuen
Vertrags-Major und explizite Migration verbreitern.

## Job Search `1.0`

`capabilities` liefert Contract-Version, Werkzeuge, sichere Fehlerkategorien und pro Quelle:

- stabile ID und Anzeigename
- Aktivierung und Policy-Status
- Zugriffsart und Loginbedarf
- unterstützte Filter und Pagination

`mehrportal_suche` liefert normalisierte Treffer und isolierte Quellenergebnisse. Der Root-Adapter
ergänzt für ältere `1.x`-Antworten lokale Abrufzeit und `SourceReference`; Quelldaten und lokal
abgeleitete Werte bleiben unterscheidbar.

## Application Pipeline `1.0`

Die Stufen `validate_profiles`, `analyze_job`, `build_match_matrix`, `draft`, `review`, `audit` und
`finalize` liefern maschinenlesbare Zustände und Artefaktreferenzen. Die Evidence Policy des
Submodules bleibt autoritativ. Nur `verified` und `user_confirmed` dürfen in finale Dokumente
gelangen; offene Findings der Schwere `critical` oder `high` blockieren die Finalisierung.

## Agent Runner und Agent Control API `1.0`

Der Runner veröffentlicht Provider-ID, Version, Supportstatus und Capabilities für Streaming,
Resume, Eingabe, Freigaben, Tools, Usage und Sandbox. `start`, `sendInput`, `resolveApproval`,
`cancel` und `resume` liefern ausschließlich kanonische Run-/Eventtypen. Unbekannte additive
Events dürfen alte Verbraucher nicht brechen; ein unbekanntes Major blockiert den Adapter.

Schreibkommandos sind idempotent und revisionsgebunden. Der Eventstream besitzt monotone
Sequenzen und Resume über `Last-Event-ID`. Approval-Tokens sind einmalig sowie an Run, Tool, Ziel,
Parameterhash und Ablaufzeit gebunden. Ein Agentenergebnis ist kein Domain-Commit: Erst ein
validierter `confirm`- oder `execute`-Command darf autoritativen Zustand ändern.

Der geschlossene Preflight-Vertrag liegt in
`contracts/v1/agent-run-preflight.schema.json`. `POST /api/agent-runs/preflight` akzeptiert einen
strict Run-Entwurf, persistiert und echoet den Prompt nicht und führt weder Provider- noch
Portalwerkzeuge aus. Die Antwort unterscheidet deklarierte Datenkategorien von erst beim Start
verfügbaren Quellen, veröffentlicht die effektiven Prozesslimits und weist die Root-MCP-Allowlist
vollständig aus. Solange die rungebundene Domain-MCP-Kette nicht in normale Runs injiziert wird,
ist diese Allowlist leer. Ein dort genannter `job-search-mcp` ist immer
`executionIsolation: trusted-host`, für den Agenten nicht direkt erreichbar und wird nur vom Root
vor dem Agentenstart aufgerufen.

## Agent Artifact `1.0`

Vorschläge werden als unveränderliche, per SHA-256 adressierte Inhalte und getrennte
revisionsgebundene Metadaten gespeichert. Der Server setzt Run, Provider- und Adapterversion,
Template, optionalen Workflow sowie ApplicationCase-Revision, Job und Firmenschlüssel aus dem
beim Run erfassten Fachkontext; der Browser kann diese Provenance nicht behaupten. Relative
Anzeigepfade sind segmentweise validiert und werden nicht als frei wählbare Schreibziele benutzt.

Listen, Metadaten, UTF-8-Inhalt und begrenzte Textdiffs sind rungebunden lesbar. `approved` und
`rejected` erfordern Bestätigung und erwartete Revision. `used` besitzt absichtlich keinen
generischen Browser- oder Agentenendpunkt: Nur ein injizierter fachlicher Port kann ein bereits
freigegebenes Artefakt idempotent validieren und übernehmen. Ergebnis-IDs müssen der gespeicherten
Case-/Job-/Firmen-Provenance entsprechen; Inkognito-Artefakte werden vor dem Portaufruf blockiert.
Das öffentliche Metadatenschema liegt in `contracts/v1/agent-artifact.schema.json`.

## Rungebundener Agent Domain Tools Vertrag `1.0`

Die serverseitige Factory erhält Run-ID, Provider-ID, Identity-/Sandboxprofil, erlaubte Toolnamen,
erlaubte ApplicationCase-IDs und konkrete schmale Ports. Daraus gibt die
`RunCapabilityAuthority` intern eine signierte, ablaufende und widerrufbare Capability aus. Das
Bearer-Token wird weder im Toolkatalog noch in MCP-Argumenten oder Ergebnissen veröffentlicht und
wird bei jedem Aufruf erneut gegen Run, Provider, Tool und optionalen ApplicationCase geprüft.

Der MCP-Client übergibt nur die im Toolschema beschriebenen Fachargumente. Approval- oder
Capability-Felder werden abgelehnt. Eine benötigte Freigabe wird über den serverseitigen
Approvalkanal angefordert und als einmaliges, parameter- und zielgebundenes Token intern an genau
einen passenden Aufruf gereicht. Sensitive Reads bleiben auch nach Freigabe auf der maskierten
Portansicht. Ergebnisse führen normalisierte `SourceReference`s; Entscheidungen, Argumenthash,
Scope-Verstöße und Freigabestatus werden ohne Rohinhalt auditiert.

Der feste Katalog enthält ausschließlich minimierte Reads, Vorschläge sowie bestätigte lokale
Domaincommands. Shell, Mailversand, Bewerbungs-Submit, Portal-Login, beliebige Netzwerkzugriffe und
freie Dateioperationen sind kein Bestandteil dieses Vertrags. `npm run agent:mcp` injiziert
absichtlich weder Ports noch Capability und bleibt daher auf Health und Toolkatalog beschränkt.

Der über einen schmalen Port injizierbare Job-Search-MCP besitzt eine getrennte Laufzeitgrenze:
`executionIsolation: trusted-host`. Er wird direkt als nativer oder WSL-stdio-Prozess gestartet,
nie als Agent und nie über Bubblewrap, Container oder die Agenten-Netzwerksandbox. Bekannte
Wrapper- und Shell-Kommandos werden fail-closed abgelehnt. Der private Startvertrag folgt
`contracts/v1/job-search-mcp-launch.schema.json`; `runtimeTarget`, `distribution` und argv werden
gemeinsam gebunden. Vor dem Start werden der native Executable-Realpfad beziehungsweise
`wsl.exe`, WSL-Distribution und der Realpfad unter der integrations-eigenen Venv geprüft. Seine Portal-, Login-, Credential- und
Quellpolicy bleibt vollständig im `job-search-mcp`; die Root-Fassade veröffentlicht davon nur die
fest erlaubten minimierten Ergebnisse.

Der experimentelle Codex-App-Server-Vertrag `1.0` ist stdio-only und opt-in. Sein Manifest liegt
unter `contracts/v1/codex-app-server-manifest.json`, die freigegebene synthetische Ereignisfolge
unter `contracts/fixtures/v1/codex-app-server-events.json`. Vor dem ersten Turn sind nur
versionierter Handshake und Thread-Aufbau fallbackfähig; unbekannte Ereignisse innerhalb eines
angenommenen Turns schlagen den Run fehl, statt ihn über einen zweiten Providerlauf zu wiederholen.
Die Produktionsauswahl bleibt derzeit im `codex exec --ignore-user-config`-Fallback, weil der
App-Server keinen gleichwertigen Schalter zum Ausschluss benutzerweit registrierter MCPs anbietet.

## Fehler

Grenzen verwenden die Kategorien `validation`, `policy`, `authentication`, `rate_limit`,
`retryable_dependency` und `internal`. Fehler enthalten eine Korrelations-ID und sichere Details,
aber niemals Credentials, Cookies, Profile oder vollständige Bewerbungsinhalte.

## Änderung und Veröffentlichung

1. Contract-Fixture und Verbrauchertest im Hauptprojekt ändern.
2. Eigenes Todo und Branch im zuständigen Submodule anlegen.
3. Upstream implementieren, prüfen, committen und veröffentlichen.
4. Root-Adapter gegen den veröffentlichten Commit testen.
5. Submodule-Pointer aktualisieren und Cross-Repository-Tests ausführen.
