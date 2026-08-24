# Agent Control Center

## Implementierter Stand

Das Agent Control Center ist die lokale Steuerungs- und Beobachtungsschicht für austauschbare
Agentenprozesse. Angular spricht ausschließlich mit der Express-API auf Loopback. Nur der Server
wählt Executables, exakte Provider-Versionen und feste Argumenttemplates aus; Prozesse starten mit
`shell:false`. Browserrequests können weder einen Executable-Pfad noch freie Argumente oder
Environmentwerte einschleusen.

```text
Angular Agent Center
  ├── REST: Runs, Orchestrierungen, Input, Approval, Review, Adoption
  └── SSE:  globale und rungebundene kanonische Events
          │
          ▼
Agent Control Center (Express)
  ├── Policy, Approval und Run-Capability-Authority
  ├── Run-, Event-, Artefakt- und Orchestrierungsstores
  ├── Context Builder und fünfstufige Bewerbungsorchestrierung
  ├── AgentRunnerPort
  │    ├── Codex Exec
  │    ├── Codex App Server mit Dynamic Tools
  │    ├── OpenCode 1.14.41 in WSL/Bubblewrap
  │    └── Claude Code 2.1.232 in WSL/Bubblewrap
  └── servereigene Root-Domain-Ports
       ├── Jobs, Bewerbungsfälle und Firmen
       ├── Mail-/Status-/Dokumentvorschläge
       ├── Bewerbungs-Evidence-Pipeline
       └── job-search-mcp als separater Trusted Host
```

Der Portal-MCP ist absichtlich kein Agentenkind. Der Root-Server startet ihn direkt nativ oder über
WSL-stdio mit `executionIsolation: trusted-host`. Er läuft niemals in Codex-, OpenCode-, Claude-,
Bubblewrap-, Container- oder Netzwerk-Sandboxes. Agenten erhalten nur normalisierte Daten oder
rungebundene, minimierte Root-Werkzeuge.

## Runvertrag und sichere Defaults

Ein Run bindet Providerinstallation, Capabilityvertrag, Prompttemplate und -witness, Workspace,
Sandbox, fachlichen Scope, Datenquellen, Budgets und Prozesslimits. Neue Runs sind standardmäßig
read-only. Die REST-API lehnt `network:true` ab. Events besitzen monotone Sequenzen; der Browser
kann per `Last-Event-ID`, Cursor und ergänzendem REST-Polling fortsetzen. Prompt und klassifizierte
Eventfelder liegen AES-256-GCM-verschlüsselt im lokalen Run Store.

Provider- und Projektkonfiguration wird vor jedem Spawn geprüft. Ein Verweis auf
`job-search-mcp` oder eine projektverwaltete MCP-/Plugin-Deklaration blockiert den Agentenlauf.
`dangerously-bypass-approvals`, `yolo`, freie Shellbefehle und frei wählbare Netz- oder Dateitools
sind kein Bestandteil des Vertrags.

Ein `Idempotency-Key` wird als Hash plus Requestfingerprint und opaker Runverweis unter
`.local-data/agent-idempotency/` gespeichert. Damit kann ein abgeschlossener Run nach einem
Serverneustart wiedergefunden werden. Gleichzeitige Requests werden zusätzlich innerhalb eines
Express-Prozesses koalesziert. Der Dateistore bietet jedoch keine prozessübergreifende Transaktion;
über mehrere Serverprozesse besteht keine harte Exactly-once-Garantie.

Cancel unterbricht zunächst provider- und domainseitige Freigaben, wartet eine kurze Grace Period
und beendet anschließend den validierten Prozessbaum tiefenorientiert. Beim Neustart rekonstruiert
der Run Store fehlende oder beschädigte Snapshots aus dem append-only Eventlog und markiert
nichtterminale Runs als `orphaned`. Ein Recovery-Workflow erzeugt bei Bedarf einen neuen Run; er
adoptiert niemals einen alten PID oder Providerprozess.

## Providerverträge

### Codex

Codex `0.147.0` ist die einzige freigegebene Version. `codex exec` läuft mit festen Argumenten für
`--ignore-user-config --strict-config`, `web_search="disabled"` und
`sandbox_workspace_write.network_access=false` als stabiler JSONL-Transport. Der Prompt wird über
stdin übertragen. Die CLI-Sandbox unterstützt read-only und bewusst
ausgewähltes Workspace-Write; Userprofile und projektverwaltete MCP-/Plugin-Konfigurationen sind im
Agent Center gesperrt.

Der Codex App Server ist ein experimenteller, servereigener stdio-Transport für dieselbe exakt
freigegebene native Codex-Linie. Er wird nicht per Flag geschaltet: bevorzugt wird der App Server, bedarfsabhängig weicht die
Auswahl auf Codex Exec aus. Läufe mit servereigenem Zero-Tools-Vertrag gehen immer an Codex Exec,
weil der App Server dynamische Tools anbietet und diese Zusage nicht tragen kann. Er verwendet ein runlokales `CODEX_HOME`, in das höchstens
`auth.json`, aber keine Benutzerkonfiguration kopiert wird. `turn/start` erhält immer eine konkrete
Codex-`SandboxPolicy`:

```json
{ "type": "readOnly", "networkAccess": false }
```

Bei Workspace-Write kommen ausschließlich die validierte Workspacewurzel und ebenfalls
`networkAccess:false` hinzu. Ein für offline ausgewählter App-Server-Run schlägt bei Health-,
Isolation- oder Dynamic-Tool-Problemen fail-closed fehl; er fällt nicht auf einen Transport mit
schwächerer Netzwerkzusage zurück. Nach einem angenommenen Turn führen unbekannte Protokollteile,
Request-IDs oder Thread-/Turn-Bindungen ebenfalls zum Runfehler und niemals zu einem Replay über
Codex Exec.

Nur der App-Server-Vertrag kann die serverseitigen Root-Domain-Tools als Codex Dynamic Tools
exponieren. Die Freigabe ist provider-, workflow-, run- und fallgebunden. Ist ein vom Workflow
benötigtes Tool nicht verfügbar, startet der Run nicht.

### OpenCode und Claude Code

OpenCode ist ausschließlich als WSL-Version `1.14.41`, Claude Code ausschließlich als WSL-Version
`2.1.232 (Claude Code)` freigegeben. Unbekannte Versionen, native Windows-Ziele und fehlendes
Bubblewrap werden blockiert. Beide erhalten den Prompt über stdin und unterstützen in diesem
Vertrag nur read-only, keine interaktive Approval-Brücke, Pause oder Resume.

Bubblewrap bindet die Distribution und den Workspace read-only, verwendet flüchtige Verzeichnisse
für HOME, Konfiguration und Cache und isoliert PID, IPC und UTS. Nur die jeweilige
Authentifizierungsdatei wird read-only in das temporäre HOME eingebunden. Die Provider-Control-
Plane darf für den Modellaufruf das Netzwerk erreichen. Modellaufrufbare Netz-, Shell-, Schreib-,
MCP- und Subagent-Werkzeuge sind dagegen durch eine servereigene exakte Providerpolicy entfernt:

- OpenCode: servereigener Agent `job-match-read-only`, Default `deny`; nur `read`, `glob`, `grep`
  und `list` sind erlaubt, Plugins und MCPs sind leer.
- Claude: `--safe-mode`, Permission Mode `plan`, nur das Built-in-Tool `Read`, strikter leerer
  MCP-Vertrag, deaktivierte Slash Commands und keine Sessionpersistenz.

Diese Kontrolle ist eine Tool-/Capability-Grenze und keine Netzwerk-Namespace-Isolation des
gesamten Providerprozesses. OpenCode und Claude erhalten aktuell keine Root-Domain-Tools; ihre
Workflows arbeiten mit dem vom Server aufgebauten, begrenzten Promptkontext.

## Root-Domain-Tools

Die produktive Factory setzt für einen konkreten Run eine `RunCapabilityAuthority`, die
`RestrictedAgentMcpFacade`, Policy, Approvalqueue, Audit und schmale Domainports zusammen. Die
interne Capability ist signiert, kurzlebig und widerrufbar und wird bei jedem Aufruf gegen Run,
Provider, Tool und erlaubte ApplicationCase-IDs geprüft. Capability- und Approval-Tokens sind nie
Teil des MCP-Clientvertrags.

Der feste Katalog umfasst nur:

- minimierte Jobsuche sowie maskierte Bewerbungs- und Mailreads;
- Evidence-Analyse und lokale Vorschläge für Mailkorrelation, Status und Dokumentrevision;
- bestätigte, revisions- und idempotenzgebundene lokale Domaincommands.

Shell, Mailversand, Bewerbungs-Submit, Portal-Login, beliebige Netzwerkzugriffe und freie
Dateioperationen sind ausgeschlossen. `npm.cmd run agent:mcp` startet absichtlich nur Health und
Katalog: Erst die serverseitige Run-Factory kann Ports und eine Capability injizieren.

## Lokale Multi-Agent-Orchestrierung

Angular kann vier versionierte Workflows starten und deren Nodes, Runs, Budgets, Gates und
Vorschlagsartefakte verfolgen. `evidence-application-package` besteht aus fünf getrennten
Node-Runs und Rollenkontexten:

```text
Evidence → Author → ┬→ ATS ─────────────┐
                    └→ Recruiter/Style ─┴→ Finalizer
```

Der Server löst Inputs aus dem aktuellen Suchprofil, Job, Kandidatenprofil, Bewerbungsfall und den
vorherigen Rohartefakten auf und speichert ihre Digests. Nur `verified` und `user_confirmed` Claims
mit Evidence-Referenzen erfüllen das servereigene Evidence-Gate. ATS und Recruiter/Style prüfen
weiterhin getrennt; beide Rohreviews werden automatisch an den Finalizer übergeben. Im
`evidence-application-package@1.1.0` gibt es weder ein browserauflösbares `user_input`-Gate noch
eine manuelle Fan-in-Entscheidung. Cancel bleibt revisionsgebunden.

Der Finalizer liefert ausschließlich ein vollständiges HTML5-Dokument als `final_html`, kein
JSON-Paket. Der Server normalisiert es auf eine CSP-geschützte Seite ohne aktive oder externe
Inhalte. Nach dem fünften erfolgreichen Node zeigt das Agent Center die exakt hashgebundene Route
automatisch in einem sandboxed `iframe`. Die Anzeige selbst genehmigt, exportiert oder versendet
nichts; solche späteren Aktionen bleiben eigene fachliche Wege.

## Artefakte und fachliche Übernahme

Agentenartefakte besitzen unveränderliche, SHA-256-adressierte Inhalte und getrennte
Lifecycle-Metadaten. Run, Provider-/Adapterversion, Template, Workflow, ApplicationCase-Revision,
Job, Firmenschlüssel und Identitätsmodus stammen aus serverseitigem Kontext. Angular kann
Metadaten, UTF-8-Inhalt und begrenzte Textdiffs anzeigen sowie eine exakte Artefaktrevision
freigeben oder ablehnen.

Der getrennte Legacy-Adoptionspfad für bestehende Workflow-1.0-Artefakte akzeptiert nur ein
freigegebenes `application-pipeline-package` mit realer Identität und kann es über die bestätigte
Adopt-Aktion weitergegeben werden. Der servereigene Port führt die vollständige lokale
Bewerbungs-Pipeline erneut aus und erstellt eine neue fachliche Dokumentrevision im Zustand
`proposed`. Danach folgen getrennt:

1. Review der fachlichen Revision mit vollständigem SHA-256 und bestätigter Zahl der
   Sprachhinweise;
2. Fallfreigabe mit derselben Revisions-ID und demselben Hash;
3. `used` beziehungsweise Export ausschließlich für diese gebundene Revision.

Inkognito darf Vorschau und Review erreichen. Adoption als reale Revision, Fallfreigabe, `used`
und Export sind gesperrt. Ein freier Lifecycle-Schalter oder automatischer Submission-Pfad
existiert nicht.

## Betriebsspeicher und Oberflächen

Die produktive Composition verwendet unter `.local-data/`:

- append-only Run-Events und atomare Snapshots;
- content-addressed Agentenartefakte und optionale Rohlogs;
- ein payloadfreies Idempotenzregister;
- ein append-only, `fsync`-gesichertes Approval-Lifecycle-Journal mit Hashes statt Rohparametern,
  Akteursnamen oder Bearer-Tokens;
- ein append-only, `fsync`-gesichertes Retention-/Legal-Hold-Journal;
- ein versionsgebundenes, secret-freies Agenten-Konfigurationsprofil mit Last-known-good-Kopie;
- ein allowlistetes Observability-JSONL mit gehashten Run-/Korrelations-IDs und ohne freie
  Nachrichtenfelder.

Retention erstellt zuerst einen digestgebundenen Impact-Plan. Aktive Legal Holds auf Run,
Artefakt oder Bewerbungsfall blockieren die Kaskade. Bei verwendeten Artefakten kann der Rohinhalt
gelöscht werden, während die Provenance-Metadaten erhalten bleiben. Das Journal ist lokal
append-only, aber keine extern signierte, manipulationssichere Audit-Chain.

Angular bietet Providerdiagnose, Installationsauswahl, Preflight, Runqueue und -detail,
Live-/Replay-Timeline, Usage, Input, Approval, Cancel, Recovery, Artefaktvergleich und -adoption,
Multi-Agent-Monitoring sowie redigierten Export. Das persistente Agenten-Konfigurationsprofil und
der Angular-CAS-Editor sind produktiv verdrahtet: Die Oberfläche zeigt aktives Profil oder
Last-known-good-Quelle, Provider-, Runtime-, Sandbox-, Offline-/Approval-, Budget- und
Featurewerte, nimmt keine Secrets oder freien Pfade/Commands/argv an und erneuert nach dem
Speichern Providererkennung und Preflight. Das Codex-App-Server-Opt-in benötigt eine zusätzliche
Bestätigung. Eine Angular-Ansicht für das ebenfalls implementierte lokale Observability-Log fehlt
weiterhin.

## Ehrliche verbleibende Grenzen

- Der Codex App Server ist ein experimenteller, standardmäßig deaktivierter Protokollpfad.
  Root-Domain-Tools sind nur auf diesem nativen Codex-Pfad verfügbar.
- OpenCode/Claude besitzen bewusst keine Root-Tool- oder Approval-Brücke. Ihre Modell-Control-
  Plane benötigt Netzwerk; nur die modellaufrufbaren Werkzeuge sind offline/read-only begrenzt.
- Der Approval-Lifecycle überlebt als append-only, hashbasierte Historie. Offene oder erteilte,
  noch nicht verbrauchte Authority wird nach einem Serverneustart bewusst widerrufen und niemals
  aus dem Journal wiederhergestellt. Aktive Orchestrierungen speichern ihren redigierten Zustand,
  aber ihre Rohinputs nur prozesslokal; nach einem Neustart werden sie nicht automatisch
  fortgesetzt.
- Mehrprozess-Exactly-once, eine allgemeine Run-Store-Migrationsstrecke und eine extern
  manipulationssichere Audit-Chain sind nicht vorhanden.
- Der Backup-/Restore-Helper ist getestet, aber noch nicht als Angular-/CLI-Betriebsstrecke
  verdrahtet.
- Memory- und Kindprozesslimits verwenden plattformspezifische, zeitbegrenzte Stichproben. Auf
  Windows liest ein fester compilerfreier Toolhelp32-Prozess den Root-Prozess und seine
  Nachkommen. Blockiert der Host diese Abfrage, läuft der Agent nicht unbeschränkt weiter: Er
  endet mit `resource_probe_error` und der Prozessbaum wird beendet. Die Stichprobe ist jedoch
  kein Windows Job Object und daher keine adversarial-harte Lifetime-Grenze gegen bereits vor
  dem Snapshot verwaiste Nachkommen oder PID-Reuse.

Weitere Betriebsdetails stehen in [operations.md](operations.md), die Sicherheitsannahmen in
[agent-threat-model.md](agent-threat-model.md) und die Verträge in [contracts.md](contracts.md).
Die konkrete Freigabegrenze mit Pins und Rollback dokumentiert die
[Release-Matrix](release-matrix.md); Incident-Schritte stehen im
[Incident- und Datenschutz-Runbook](incident-privacy-runbook.md). Für neue Adapter und Workflows
gilt [Provider-, MCP-Tool- und Workflow-Entwicklung](adapter-workflow-development.md).
