# Agent Control Center

## Zielbild und aktueller Stand

Das Agent Control Center soll die lokale Steuerungs- und Beobachtungsschicht für austauschbare
Agentenprozesse werden. Angular spricht bereits ausschließlich mit der lokalen Express-API. Nur
der Server wählt Providerprogramme und feste Argumenttemplates aus; Prozesse werden mit
`shell: false` gestartet. Für serverseitig gehostete Runs existiert eine explizite Factory, die
RunCapabilityAuthority, RestrictedAgentMcpFacade, Policy, einmalige Approvals und injizierte
schmale Domain-/Submodule-Ports zu einer rungebundenen MCP-Sitzung zusammensetzt. Der direkt
gestartete MCP-Server besitzt absichtlich weder Run-Scope noch Ports und bietet deshalb weiterhin
nur Health und Toolkatalog.

Das folgende Diagramm beschreibt das Zielbild. REST/SSE, Run Store, Context Builder, CLI-Adapter
und die explizit erzeugte rungebundene MCP-Kette sind vorhanden. Die vollständige automatische
Workflow-/DAG-Orchestrierung jedes Angular-Starts bleibt dagegen unvollständig.

```text
Angular Agent Center
  | REST: Commands, Inputs, Approvals
  | SSE:  kanonische, resumierbare Events
  v
Agent Control Center (Express)
  |-- Policy Engine + Approval Broker
  |-- Run Store + Artifact/Provenance Store
  |-- Context Builder + Workflow Orchestrator
  `-- AgentRunnerPort
       |-- CodexExecAdapter       (stabiler JSONL-Pfad)
       |-- CodexAppServerAdapter  (experimentelles Feature Flag)
       |-- OpenCodeAdapter
       |-- ClaudeCliAdapter
       `-- GenericJsonlAdapter
             |
             | runbezogene MCP-Capabilities
             v
       Root-Domain-Fassade
          |-- Jobs und Firmen (read/propose)
          |-- Mail und Termine (read/propose/confirm)
          |-- job-search-mcp (Portalverantwortung)
          `-- Bewerbungs-Pipeline (Evidence-Verantwortung)
```

## Derzeit wirksame sichere Voreinstellungen

- Browserrequests können weder Executable, Arbeitsverzeichnis noch freie Argumentarrays setzen.
  Provider und Argumenttemplates sind serverseitig festgelegt.
- Neue Runs verwenden standardmäßig `read-only`; Netzwerkrequests werden von der REST-API derzeit
  vollständig abgelehnt, weil kein aktivierter Adapter begrenzten Netzwerkzugriff nachweisbar
  erzwingt.
- Codex erhält den Prompt über stdin. OpenCode und Claude verwenden nach ihrem aktuellen
  CLI-Vertrag einen begrenzten Einzelparameter; der Prompt ist bei diesen beiden Providern daher
  in der lokalen Prozessliste sichtbar. Er wird nie als Shellfragment ausgewertet.
- Workspace-Schreibrechte sind in Angular bewusst auswählbar. Der normale CLI-Start bleibt mit
  `approvalMode: deny` toolfrei. Nur eine explizit serverseitig erzeugte MCP-Sitzung kann die
  rungebundene Policy-/Approval-Kette und die injizierten Ports verwenden.
- `dangerously-bypass-approvals`, `yolo` und vergleichbare globale Umgehungen sind nicht Teil des
  Produktvertrags.
- Stellenanzeigen und Mails werden im Prompt als `dataOnly` markiert. Die rungebundene MCP-Kette
  prüft zusätzlich Tool-, Case-, Provider- und Approval-Scope bei jedem Aufruf neu.
- Die bestehenden Domain-Endpunkte blockieren Inkognito-Finalisierung und `used`; der Agentenpfad
  besitzt derzeit keine Versand- oder Portalwerkzeuge.

## Kanonischer Runvertrag

Ein Run speichert Provider, erkannte Capabilities, Prompttemplate und Version, angeforderten
Workspace-/Sandbox-Scope, Netzwerkpolicy, fachliche Referenzen, Budgets und Status. Events besitzen
eine monoton steigende Sequenz. Provider-JSONL wird in normalisierte Events übersetzt; unbekannte
Typen werden als Warnung erhalten. Ein rotierendes Roh-stdout-/stderr-Archiv ist noch nicht
implementiert.

Nur das Erstellen eines Runs unterstützt derzeit einen `Idempotency-Key`. Bereits persistierte
Runs werden darüber wiedergefunden; gleichzeitig eintreffende Requests mit demselben Schlüssel
teilen innerhalb eines Express-Prozesses dasselbe Enqueue-Promise. Abweichende Requestinhalte zum
gleichen Schlüssel werden abgelehnt. Diese Koaleszierung ist nur prozesslokal: Der Store besitzt
keine transaktionale Unique-Constraint, daher gibt es über mehrere Serverprozesse oder einen
Crash-/Neustart-Rand hinweg keine dauerhafte Exactly-once-Garantie. `expectedRevision` ist bei
Steuerkommandos optional. Der Eventstream akzeptiert `Last-Event-ID` beziehungsweise `after`. Die
Angular-Anwendung ergänzt ausgefallene Streams per REST-Polling; der native EventSource-Client
verbindet sich außerdem automatisch neu und sendet dabei `Last-Event-ID`.

Eine HMAC-basierte Freigabequeue bindet Freigaben an Run, Tool, Parameter, Ziel und Ablaufzeit.
Die REST-Approvalroute des interaktiven Offlinepfads durchläuft Policy, erzeugt ein einmaliges
Token und verbraucht es vor der Providerentscheidung. Die rungebundene MCP-Factory verwendet
dieselbe serverseitige Semantik. Capability- und Approval-Tokens sind nie MCP-Clientargumente;
ein Client kann eine Freigabe weder behaupten noch selbst einschleusen.

## Providerstrategie

`codex exec --ignore-user-config --json` bleibt der stabile Codex-Transport. Nur die exakt
freigegebene 0.147-Linie besitzt den dafür verifizierten CLI-Schalter. Projektkonfigurationen
werden vor jedem Spawn auf agentverwaltete MCP-/Plugin-Deklarationen geprüft. Der experimentelle
App-Server-Pfad wird mit `CODEX_APP_SERVER_EXPERIMENTAL=1` angefordert, bleibt produktiv aber im
Exec-Fallback, solange Userconfig-Isolation nicht nachgewiesen ist. Sein geprüfter Protokollpfad startet
`codex app-server --listen stdio://`, führt den versionierten `initialize`-/`initialized`-
Healthcheck aus und bildet Thread, Turn, Resume, Steering, Interrupt und einmalige Command-/
File-Approvals auf den Agent-Runner-Vertrag ab. Es wird weder ein TCP-/WebSocket-Listener noch die
unsandboxed `process/*`-API geöffnet.

Nur die im Manifest und in der Fixture freigegebenen CLI-Versionen dürfen den experimentellen
Pfad verwenden. Eine unbekannte Version oder ein Fehler vor dem ersten Turn fällt mit einem
sichtbaren `codex_app_server_fallback`-Ereignis auf `codex exec --ignore-user-config --json` zurück. Sobald ein
App-Server-Turn angenommen wurde, führen unbekannte Ereignisse, Items, Request-IDs oder
Thread-/Turn-Bindungen dagegen fail-closed zum Runfehler; in diesem Zustand findet kein Replay
über den Exec-Fallback statt.

OpenCode ist für `opencode run --format json` vorbereitet; `--auto` ist nicht Teil der
Konfiguration. Claude ist für Print Mode mit `stream-json`, `plan`-Berechtigungsmodus und
deaktivierter lokaler Sessionpersistenz vorbereitet. Bubblewrap leert HOME/XDG-Konfiguration,
damit kein benutzerweit registrierter MCP als Agentenkind startet. Ein explizites Turn- oder Kostenlimit wird
noch nicht als Claude-CLI-Argument gesetzt. `bypassPermissions` und
`dangerously-skip-permissions` sind ausgeschlossen. Für OpenCode und Claude sind aktuell keine
getesteten Versionsmuster freigegeben, weshalb gefundene Installationen fail-closed als
`untested` blockiert bleiben. Es gibt keinen Fallback auf das Parsen einer farbigen Terminaloberfläche.

## Fachliche Grenzen

Die produktive Factory exponiert ausschließlich den festen Read-/Propose-/Confirm-/lokalen
Execute-Katalog. Sie erhält Run-ID, Provider, erlaubte Tools und ApplicationCases sowie alle
schmalen Ports vom Server. Die intern ausgegebene Capability läuft ab, ist widerrufbar und wird
bei jedem Toolaufruf erneut geprüft. Sensitive Reads bleiben selbst nach einer Freigabe maskiert;
Ergebnisse führen normalisierte SourceReferences und Auditereignisse. Shell, Versand, Submit,
Portal-Login, beliebiges Netzwerk und frei wählbare Dateien sind nicht Teil des Katalogs.
Portalzugriff verbleibt im `job-search-mcp`; Claims, Match-Matrix, Review und finale Dokumente
verbleiben in der Evidence-Pipeline des `bewerbungs-schreib-assistent`. Der Job-Search-MCP ist
dabei bewusst ein separat vertrauenswürdiger Hostprozess (`executionIsolation: trusted-host`) und
wird direkt nativ oder über WSL-stdio gestartet. Er läuft weder in der Agenten-Bubblewrap-/
Container-Sandbox noch unter deren Netzwerkpolicy; bekannte Wrapper- und Shell-Umwege werden
fail-closed abgelehnt. Diese Ausnahme überträgt sich nicht auf Agenten-CLIs.

Mehrere Bewerbungen bei derselben Firma bleiben eigene ApplicationCases. Der Context Builder
begrenzt fallbezogene Runs auf den explizit gewählten Fall. Nur der ausdrücklich ausgewählte
Workflow `application-next-actions` erweitert diesen Scope serverseitig auf die Fälle derselben
Firma und deren Trackingereignisse; jeder Fall und jede Dokumentrevision bleibt dabei getrennt.
Runvergleich und die vollständige Darstellung der Artefakte in Angular sind noch nicht implementiert. Die REST-Strecke speichert
Vorschläge content-addressed, listet und liest sie rungebunden, erzeugt begrenzte Textdiffs und
bindet Approve/Reject an Lifecycle und Revision. Die vollständige Provenance wird aus dem
serverseitig beim Run erfassten Provider-/Template-/Case-/Job-/Firmenkontext erzeugt. `used` ist
bewusst kein REST-Kommando; diese Transition ist ausschließlich über einen injizierten
fachlichen Validierungs- und Übernahmeport möglich und für Inkognito gesperrt.

## Betrieb und Wiederherstellung

Der Process Supervisor beendet bekannte Prozessbäume und klassifiziert Cancel, Timeout,
Idle-Timeout und Outputlimit. Beim API-Neustart rekonstruiert der Store den Zustand aus dem
Eventlog und markiert nichtterminale Runs als `orphaned`; laufende Betriebssystemprozesse werden
weder gesucht noch adoptiert. Die Angular-Oberfläche reserviert eine zeitlich begrenzte,
operatorgebundene Recovery-Lease. Cleanup schließt den alten Run nachvollziehbar ab; Resume
erzeugt immer einen neuen Queue-Run und adoptiert weder PID noch Providerprozess.

Der Backup-Helper erzeugt atomar veröffentlichte, versionierte Bundles, prüft Datei- und
Manifesthashes und stellt nach schreibfreiem Dry-run nur in eine exakt freigegebene Zielwurzel
wieder her. Bestehende Ziele werden nur nach expliziter Overwrite-Entscheidung atomar ausgetauscht;
fehlendes Schlüsselmaterial blockiert die Wiederherstellung. Eine Betriebsoberfläche dafür ist
noch nicht verdrahtet. Die Run-Store-Recovery migriert bekannte
Vorabversionsfälle: ein unverschlüsselt gespeichertes camelCase-Feld `userPrompt` wird geschützt
und ein Snapshot mit historisch falscher Event-AAD für `failure` wird aus dem autoritativen
Terminalevent repariert. Das ist keine allgemeine Run-Store-Schema-Migrationsstrecke. Backups
müssen Konfiguration, Workspace, Agent-Run-Vault, Schlüssel und Artefakte konsistent enthalten.
Supportexporte verwenden redigierte Views. Prompts, Antworten, Mails, reale
Identitäten, Tokens und Credentials gehören weder in Git noch in normale Diagnoseausgaben.

## Implementierte Oberflächen

- Angular: Providerkarten, explizite Windows-/WSL-Installations- und Distributionsauswahl,
  Run-Erstellung, Queue/History, Detailansicht, Timeline, Usage, Approval-/Eingabebereich für den
  interaktiven Fake, Abbruch, Replay-Vorlage und redigierter Export
- REST: Provider/Health/Workflows, side-effect-freier Run-Preflight, Create/List/Get, Events, Cancel, Input, Approval,
  rungebundene Artefakt-Metadaten/Inhalte/Textdiffs/Reviews, Resume-/Pause-Capability-Fehler,
  Retention-Vorschau/-Anwendung und Emergency Stop
- Streaming: SSE je Run mit monotoner Sequenz, Cursor, Heartbeat und Puffergrenze; Angular nutzt
  den nativen EventSource-Reconnect, ein globaler autorisierter Stream fehlt
- Persistenz: append-only JSONL-Ereignisse, atomare Snapshots, Recovery, Retention,
  AES-256-GCM-Klassifizierung und lokaler Schlüssel außerhalb von Git
- MCP: stdio-only, feste Domain-Tool-Allowlist und explizite serverseitige Run-Factory mit
  Capability-, Case-, Policy-, Approval-, Audit- und SourceReference-Bindung; der direkte
  CLI-Einstieg bleibt ohne injizierte Ports absichtlich auf Health und Katalog beschränkt

`fake` bildet den einfachen Offlinepfad ab; `fake-interactive` demonstriert Eingabe und eine
Policy-/HMAC-gebundene Freigabe ohne Seiteneffekt. Codex nutzt bei kompatibler lokaler
Installation `codex exec --ignore-user-config --json` mit stdin-Prompt. API und Angular stellen gefundene Windows- und
WSL-Installationen getrennt dar; vor dem Start wird die Runtime einschließlich WSL-Distribution
explizit gewählt und serverseitig gegen eine unterstützte Installation validiert. OpenCode und
Claude bleiben blockiert, solange für die erkannte Version kein Versionsmuster freigegeben ist.
Codex App Server ist experimentell hinter dem Feature Flag implementiert; Pause bleibt mangels
belastbarer Providersemantik deaktiviert. Codex erzwingt den ausgewählten CLI-Sandboxmodus;
OpenCode und Claude besitzen einen WSL-Bubblewrap-Vertrag, bleiben aber bis zur
Versionskonformität blockiert. Für weitere optionale Providerziele ist keine gleichwertige
OS-/Container-Isolation nachgewiesen.

## Abnahmestand

- Vorhanden: Unit-, Property-, Contract-, Load-, Recovery-, Process-Limit- und Canary-Tests für
  Zustandsmaschine, Pfade, Provider-Mapping, Policy, Redaction, Approval-/Capability-Tokens,
  fremde Case-IDs, Client-Bypass, Eventreplay und synthetische Kindprozesse.
- Vorhanden: Angular-Unit- und Playwright-E2E-Abnahme für Start, Streaming, Rückfrage, Approval,
  Cancel, Reload/Replay, Tastaturbedienung, Axe/WCAG sowie stabile Desktop-, Tablet- und
  Mobile-Baselines. Der Preflight zeigt ausschließlich serverbelegte Daten-/Toolscopes und Limits.
- Teilweise: Nach Erreichen des Outputlimits werden keine weiteren Provider-Chunks an die
  Callback-/Eventqueue weitergereicht; optionale Speicher-/Kindprozess-Probes sind implementiert,
  aber im normalen Produktstart nicht plattformspezifisch konfiguriert.
- Ausstehend: vollständige Disk-full-/Key-loss-/Rollback-Abnahme, remote belegte Windows- und
  Ubuntu-CI-Matrix, veröffentlichte Submodule-Commits sowie Versionsfreigaben für OpenCode und
  Claude. Die vollständige Release-Abnahme bleibt daher offen.

## Referenzen

- Offizielle OpenAI-Dokumentation: <https://learn.chatgpt.com/docs/non-interactive-mode>
- Offizielle Codex-App-Server-Dokumentation: <https://learn.chatgpt.com/docs/app-server>
- Codex Developer Commands: <https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- OpenCode CLI: <https://dev.opencode.ai/docs/cli/>
- Claude Code CLI: <https://code.claude.com/docs/en/cli-usage>
- Root-Policy: [../AGENTS.md](../AGENTS.md)
- Bewerbungs-Agentensystem: [application-agent-system.md](application-agent-system.md)
