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
| Application Orchestration `1.x` | lokale Express-API | Angular und Agent Control Center | REST plus getrennte Child-Runs |
| Application Style Profile `1.x` | Bewerbungs-Submodule/Root-Store | Angular und Pipeline | privates YAML plus CAS-HTTP-Vertrag |

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

Der private Launchvertrag bindet `executionIsolation: trusted-host`, Runtimeziel, Distribution,
direkte argv und ein minimales Environment. Ein gültiger Vertrag wird bei frischer
Demo-Konfiguration als effektiver `stdio`-Modus übernommen. Portalzugriff ist davon unabhängig und
bleibt `ALLOW_EXTERNAL_PORTALS=0`, bis die eigene bestätigte Route ihn freigibt.

## Application Pipeline `1.0`

Die Stufen `validate_profiles`, `analyze_job`, `build_match_matrix`, `draft`, `review`, `audit` und
`finalize` liefern maschinenlesbare Zustände und Artefaktreferenzen. Die Evidence Policy des
Submodules bleibt autoritativ. Nur `verified` und `user_confirmed` dürfen in finale Dokumente
gelangen; offene Findings der Schwere `critical` oder `high` blockieren die Finalisierung.

Kandidaten- und Stilprofil liegen ausschließlich unter `.local-data/profiles/`. Der öffentliche
Stilprofilvertrag verwendet Revision und SHA-256 als Compare-and-swap. Standard-Sprachbackend ist
lokales `nspell` mit gebündelten deutschen und englischen Wörterbüchern; optionale LanguageTool-
und Hunspell-Aufrufe bleiben lokale, explizit konfigurierte Backends.

## Agent Runner und Agent Control API `1.0`

Der Runner veröffentlicht Provider-ID, Version, Supportstatus und Capabilities für Streaming,
Resume, Eingabe, Freigaben, Tools, Usage und Sandbox. `start`, `sendInput`, `resolveApproval`,
`cancel` und `resume` liefern ausschließlich kanonische Run-/Eventtypen. Unbekannte additive
Events dürfen alte Verbraucher nicht brechen; ein unbekanntes Major blockiert den Adapter.

Jedes Schreibkommando besitzt seinen eigenen Bestätigungs- und Konfliktvertrag. Run-Create kann
einen persistenten `Idempotency-Key` verwenden; Reviews, Orchestrierungs-Continue/Cancel,
Stilprofiländerungen und lokale Domaincommands verwenden die jeweils deklarierte erwartete
Revision beziehungsweise den erwarteten Hash. Der Eventstream besitzt monotone Sequenzen und
Resume über `Last-Event-ID`. Approval-Tokens sind einmalig sowie an Run, Tool, Ziel,
Parameterhash und Ablaufzeit gebunden. Ein Agentenergebnis ist kein Domain-Commit: Erst ein
validierter `confirm`- oder `execute`-Command darf autoritativen Zustand ändern.

Der Approval-Lifecycle wird append-only und `fsync`-gesichert persistiert. Der Vertrag speichert
keine Rohparameter, Akteure oder Bearer-Tokens; Bindung, Parameter und Akteur werden nur gehasht
abgelegt. Bei einem Neustart rekonstruiert der Server ausschließlich die Historie und widerruft
offene sowie erteilte, noch nicht verbrauchte Freigaben. Aus dem Journal wird niemals Authority
oder ein Token wiederhergestellt.

Der geschlossene Preflight-Vertrag liegt in
`contracts/v1/agent-run-preflight.schema.json`. `POST /api/agent-runs/preflight` akzeptiert einen
strict Run-Entwurf, persistiert und echoet den Prompt nicht und führt weder Provider- noch
Portalwerkzeuge aus. Die Antwort unterscheidet deklarierte Datenkategorien von erst beim Start
verfügbaren Quellen, veröffentlicht die effektiven Prozesslimits und weist die Root-MCP-Allowlist
vollständig aus. Sie ist provider- und workflowabhängig: Nur der aktivierte native Codex App Server
kann die benötigten Root-Werkzeuge als Dynamic Tools erhalten. OpenCode, Claude, Fake und der
stabile Codex-Exec-Transport erhalten keine solche Toolbrücke. `job-search-mcp` selbst ist niemals
ein Agententool: Es bleibt `executionIsolation: trusted-host` und wird nur vom Root vor oder hinter
der minimierten Fassade aufgerufen.

## Agent Artifact `1.0`

Vorschläge werden als unveränderliche, per SHA-256 adressierte Inhalte und getrennte
revisionsgebundene Metadaten gespeichert. Der Server setzt Run, Provider- und Adapterversion,
Template, optionalen Workflow sowie ApplicationCase-Revision, Job und Firmenschlüssel aus dem
beim Run erfassten Fachkontext; der Browser kann diese Provenance nicht behaupten. Relative
Anzeigepfade sind segmentweise validiert und werden nicht als frei wählbare Schreibziele benutzt.

Listen, Metadaten, UTF-8-Inhalt und begrenzte Textdiffs sind rungebunden lesbar. `approved` und
`rejected` erfordern Bestätigung und erwartete Revision. Die bestätigte Agenten-Adopt-Route kann nur
ein freigegebenes Legacy-`application-pipeline-package` aus Workflow 1.0 an den injizierten fachlichen Port übergeben. Er
validiert es idempotent, führt die Pipeline erneut aus und erzeugt eine neue fachliche Revision im
Zustand `proposed`. Ergebnis-IDs müssen der gespeicherten Case-/Job-/Firmen-Provenance entsprechen;
Inkognito-Artefakte werden vor dem Portaufruf blockiert.

Für fachliche Revisionen existieren explizite `use`- und Exportaktionen, aber kein freier
Lifecycle-Schalter. Beide prüfen den signierten Pipeline-Nachweis sowie die exakt am Fall
freigegebene Revisions-ID und SHA-256 erneut. Das öffentliche Agenten-Metadatenschema liegt in
`contracts/v1/agent-artifact.schema.json`.

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

## Application Orchestration `1.0`

Das Schema `contracts/v1/application-agent-orchestration.schema.json` bindet Workflow und Version,
Provider, Scope, Prompt-Hash, Revision, Nodes, Run-IDs, Input-Digests, Budgets, Gates und
Artefaktreferenzen. Eine Orchestrierung kann nur mit ihrer aktuellen Revision fortgesetzt oder
abgebrochen werden. Der Browser kann `evidence_complete` nicht behaupten. Im aktuellen
`evidence-application-package@1.1.0` besitzt der Finalizer kein Browser-Gate; `user_input` und
`review_complete` sind dort keine Vor-Gates.

`evidence-application-package@1.1.0` besteht aus fünf separaten Node-Runs: Evidence, Author, ATS,
Recruiter/Style und Finalizer. ATS und Recruiter/Style erhalten denselben annotierten Rohentwurf in
getrennten Rollenläufen; der Finalizer erhält beide Rohreviews und die Evidence-Matrix automatisch.
Sein geschlossenes Ergebnisformat ist ein vollständiges HTML5-Dokument. Der Server veröffentlicht
die normalisierte, content-addressed Ausgabe als `application-final-html`/`final_html` über eine
Route, die Orchestrierungs-ID und vollständigen SHA-256 verlangt. Die HTML-Anzeige benötigt keine
weitere Nutzerentscheidung und verleiht keine Export-, Versand- oder Submission-Berechtigung.

## Provider-spezifische Verträge

Der experimentelle Codex-App-Server-Vertrag `1.0` ist stdio-only. Er wird bedarfsabhängig gewählt
(`selection: requirement-driven-prefer-app-server-degrade-to-exec`), nicht per Featureflag.
Sein Manifest liegt
unter `contracts/v1/codex-app-server-manifest.json`, die freigegebene synthetische Ereignisfolge
unter `contracts/fixtures/v1/codex-app-server-events.json`. Der Prozess erhält ein temporäres
`CODEX_HOME` mit höchstens `auth.json`. `turn/start` verwendet für beide erlaubten Workspaceprofile
eine `SandboxPolicy` mit `networkAccess:false`. Rungebundene Root-Werkzeuge werden als versionierte
Dynamic Tools übergeben. Ein Offline-Health-, Isolations- oder Toolfehler ist fail-closed; nach
einem angenommenen Turn schlagen unbekannte Ereignisse oder Bindungen den Run fehl, statt ihn über
einen zweiten Providerlauf zu wiederholen.

OpenCode ist exakt als WSL-Version `1.14.41`, Claude Code exakt als WSL-Version
`2.1.232 (Claude Code)` freigegeben. Beide Verträge sind read-only und verlangen Bubblewrap.
Provider-Control-Plane-Netzwerk bleibt verfügbar, während die servereigene Toolpolicy
modellaufrufbare Shell-, Schreib-, Web-, MCP- und Subagent-Fähigkeiten entfernt. OpenCode erlaubt
nur `read`, `glob`, `grep` und `list`; Claude verwendet Safe Mode, Permission Mode `plan`, nur
`Read`, einen strikt leeren MCP-Vertrag, deaktivierte Slash Commands und keine Sessionpersistenz.
Diese Provider besitzen derzeit keine Root-Domain-Tool- oder interaktive Approval-Brücke.

Das Agenten-Konfigurationsprofil wird über `GET/PUT /api/agents/config-profile` ohne Cache und ohne
Secret-, Pfad-, Command- oder argv-Felder veröffentlicht. `PUT` ist bestätigt und verwendet
`expectedUpdatedAt` als atomaren Compare-and-swap; eine Last-known-good-Kopie bleibt erhalten. Der
Angular-Editor ist an diesen Vertrag angebunden, verlangt für das Codex-App-Server-Feature ein
zusätzliches Opt-in und erneuert nach erfolgreichem Speichern Providererkennung und Run-Preflight.

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
