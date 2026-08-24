# Lokaler Betrieb

## Windows und WSL2

Fuer die Angular-/Node-Anwendung werden Node.js 22 und npm benoetigt. Der Job-Search-MCP
benoetigt Python 3.12. `setup:integrations` bevorzugt die explizite Ubuntu-WSL2-Distribution und
richtet dort `.venv-wsl` ein. Nur mit `-RuntimeTarget windows` beziehungsweise
`JOB_MCP_RUNTIME_TARGET=windows` wird eine native Windows-3.12-Installation gewaehlt; `auto`
erlaubt den dokumentierten Fallback. Die WSL-Venv bleibt ueber das lokale Submodule-Git-Exclude
unversioniert, ohne die getrackte Upstream-`.gitignore` zu aendern. Der resultierende
Startvertrag liegt privat unter `.local-data/job-search-mcp-launch.json`. Er wird validiert und bei
einer noch frischen Demo-Konfiguration beim nächsten Laden automatisch als effektiver
`stdio`-Start übernommen. Ein fehlender oder ungültiger Vertrag lässt den Offline-Demo-Adapter
aktiv beziehungsweise liefert einen fail-closed Runtimefehler; es gibt keinen unsicheren Start.
Der Vertrag ist durch `contracts/v1/job-search-mcp-launch.schema.json` versioniert. API und
`npm run diagnose` verwenden denselben Parser und dieselbe Realpfad-/Venv-Prüfung. Mit
`GET /api/sources/runtime` kann die Oberfläche `launchValidated` und `state` auswerten; `mode=stdio`
allein ist ausdrücklich kein Verbindungsnachweis. `connected` bleibt bis zu einem erfolgreichen
MCP-Aufruf über `/api/sources` false.

Startkommando, Argumente, Runtime-/Distributionsbindung, Pipelinepfade und MCP-Environment sind
serverseitig. `PUT /api/config` darf nur die übrige Benutzerkonfiguration sowie die Auswahl
`demo`/`stdio` ändern und muss für alle vorhandenen Environment-Schlüssel leere, aus
`GET /api/config` stammende Platzhalter zurücksenden. Neue Werte oder geänderte Startpfade werden
abgelehnt. `ALLOW_EXTERNAL_PORTALS` kann ausschließlich über die gesonderte bestätigte
Portalzugriffsroute geändert werden; der private Startvertrag entsteht durch
`setup:integrations` außerhalb des Browsers.

Der Job-Search-MCP läuft ausdrücklich als `trusted-host`-stdio-Dienst und **nicht** in der
Agenten-, Bubblewrap-, Container- oder Netzwerksandbox. Er besitzt die Portalverantwortung und
benötigt daher den sichtbaren Browser, StepStone-Login und den bewusst freigegebenen
Portalzugriff. Die Agenten-CLIs bleiben davon getrennte Prozesse und erreichen die Jobsuche nur
über den schmalen MCP-Vertrag. Bekannte Sandbox- und Shell-Wrapper werden im MCP-Startvertrag
fail-closed abgelehnt.

Im WSL-Vertrag ist das MCP-Executable das einzige Kommando nach `wsl.exe -d <Distribution> --`.
Es gibt weder Shell- noch `env`-Wrapper. Die Windows/WSL-Umgebungsbruecke ist auf
`ALLOW_EXTERNAL_PORTALS:JOB_MCP_STATE_DIR` begrenzt. Dadurch kann die gesondert bestaetigte
Portalzugriffsroute spaeter genau `ALLOW_EXTERNAL_PORTALS` umschalten, waehrend der Setup- und
Diagnose-Smoke immer `0` voraussetzt. Der Smoke validiert zuerst WSL-/Executable-Realpfad,
Venv-Grenze und wrapperfreie argv, prueft die beiden Variablen in WSL und fuehrt dann nur
MCP-Handshake, `tools/list` und `capabilities` aus. Suche, Login, Credentials und Browsertools
werden dabei nicht aufgerufen.

Eine gegebenenfalls im Submodul vorhandene `.opencode/opencode.json` ist kein unterstützter
Root-Startpfad. Sie wird von Setup, API und Diagnose weder geladen noch komponiert; nur der private,
versionierte Root-Startvertrag darf den Job-Search-MCP aktivieren.

```powershell
git clone --recurse-submodules <repository-url>
npm.cmd install
npm.cmd --prefix server install
npm.cmd run setup:integrations
npm.cmd run job-mcp:smoke
npm.cmd test
npm.cmd run build
npm.cmd run diagnose
```

Der Setup-Lauf installiert auch das Camoufox-Browserpaket. Dieser Download verwendet die
Camoufox-Paketquellen, fuehrt aber keine Jobportal-Anfrage aus. Fuer einen CI-/Diagnoselauf ohne
Browserdownload kann bewusst `-SkipBrowserFetch` gesetzt werden; ein sichtbarer StepStone-Login
ist dann erst nach einem spaeteren Browser-Fetch betriebsbereit.

Der Demo-Modus verwendet nur synthetische Offline-Daten. Ein validierter privater Launch aktiviert
den effektiven `stdio`-Modus, aber niemals das Portalnetz. Externe Portale bleiben ohne
`ALLOW_EXTERNAL_PORTALS=1` gesperrt. Die Reihenfolge für StepStone ist: Setup und Offline-Smoke,
den automatisch übernommenen Runtime-Status in **Quellen & MCP** kontrollieren, Portalzugriff über
den eigenen Bestätigungsdialog freigeben und erst dann **Sichtbaren Login öffnen**. Login, Captcha und 2FA
erfordern sichtbare Interaktion. Das System umgeht keine Portalrichtlinie oder Schutzmassnahme.

Ausfuehrliche Setup-, Diagnose- und Fehlerhinweise stehen in
[Job-Search-MCP als Trusted Host](setup-job-search-mcp.md).

## Maileingang

In **Firmen & Antworten** kann ein IMAP-Konto verschlüsselt gespeichert werden. Es ist zunächst
deaktiviert und wird nur über **Jetzt abrufen** synchronisiert. Die Anwendung versendet keine
E-Mails und führt keinen periodischen Hintergrundabruf aus.

Einzelne Antworten können als `.eml` importiert werden. Alternativ startet folgender Befehl einen
lokalen SMTP-Empfänger:

```powershell
$env:LOCAL_MAIL_SECRET='mindestens-16-zeichen'
npm.cmd run mail:server
```

Standardwerte sind `127.0.0.1:2525` und Benutzer `job-agent`. Der Dienst nimmt nur authentifizierte
Nachrichten bis 20 MiB an und legt sie in `.local-data/mail-drop/` ab. **SMTP-Ablage einlesen**
übernimmt sie verschlüsselt und idempotent in die CRM-Inbox. Die ursprünglichen EML-Dateien bleiben
für eine bewusste Kontrolle erhalten. Eine Netzwerkbindung ist nur mit
`ALLOW_NETWORK_MAIL_SERVER=1` möglich; der Dienst ist ohne zusätzliche TLS-Absicherung
ausschließlich für localhost gedacht.

## Agent Control Center

Die Anwendung erkennt Agenten-CLIs auf Windows und optional in Ubuntu/WSL2, installiert oder
aktualisiert sie jedoch nie ungefragt. Der Status erscheint in der Agentenansicht und in
`npm.cmd run diagnose`. REST-API und Angular zeigen die erkannten Installationen nach Windows- oder
WSL-Runtime und Distribution an. Vor dem Start wird eine Installation explizit ausgewählt; der
Server akzeptiert nur eine dazu passende, unterstützte Runtime und verlangt bei WSL die
Distribution. Ein frei eingegebener Executable-Pfad bleibt ausgeschlossen. OpenCode ist nur in
Version `1.14.41`, Claude Code nur in Version `2.1.232 (Claude Code)` und jeweils ausschließlich
als WSL-Runtime freigegeben. Andere Versionen und Runtimeziele bleiben fail-closed blockiert.

Neue Runs verwenden `read-only` und `network: disabled`; Requests mit `network:true` lehnt die API
vollständig ab. Workspace-Schreibrechte sind nur bei Providern auswählbar, deren Manifest diesen
Modus anbietet. Bei OpenCode und Claude bezeichnet `network: disabled` die modellseitige
Toolgrenze: Bubblewrap isoliert Dateisystem, PID und IPC, lässt aber die Provider-Control-Plane für
den Modellaufruf erreichbar. Die feste Read-only-Policy entfernt Shell-, Schreib-, Web-, MCP- und
Subagent-Werkzeuge. Das ist ausdrücklich keine Netzwerk-Namespace-Sperre des gesamten
Providerprozesses.

Kontextgebundene Root-Freigaben sind für den nativen Codex App Server verdrahtet, der
bedarfsabhängig ohne Featureflag ausgewählt wird. Der
interaktive Fake demonstriert Approve/Deny und Rückfragen ohne Seiteneffekt; seine Freigaben laufen
ebenfalls durch die zentrale Policy und einmalige parametergebundene Approval-Tokens. Providerzugänge
werden über deren lokalen Login eingerichtet. API-Schlüssel, Tokens und
Portalkennwörter dürfen nicht in Prompt, Angular-Konfiguration oder Repository-`.env` kopiert
werden.

Das persistente Approval-Lifecycle-Journal unter `.local-data/agent-approvals/` ist append-only
und `fsync`-gesichert. Es enthält keine Rohparameter, Akteursnamen oder Bearer-Tokens; Bindung,
Parameter und Akteur werden nur gehasht abgelegt. Nach einem Serverneustart wird diese Historie
gelesen, offene sowie erteilte, noch nicht verbrauchte Freigaben werden jedoch widerrufen und
müssen neu angefordert werden.

Bei einem hängenden Lauf wird zuerst **Abbrechen** verwendet. Der Server versucht, den bekannten
Prozessbaum nach einer Grace Period zu beenden. Nach einem Serverneustart werden persistierte
nichtterminale Runs als `orphaned` markiert. Eine operatorgebundene, ablaufende Recovery-Lease
erlaubt Cleanup oder einen neuen Ersatz-Run; eine automatische Prozessadoption findet nie statt.
Der globale Emergency Stop liegt nur im Arbeitsspeicher, verhindert neue Läufe und
fordert den Abbruch aktiver Runs an. Er ist noch nicht mit einer allgemeinen Domain-/MCP-Policy
für externe Aktionen verbunden. Die Store-Recovery repariert zwei bekannte Vorabversionsfälle:
ein unverschlüsseltes camelCase-`userPrompt` und einen Run-Snapshot, dessen `failure` wegen einer
historisch falschen Event-AAD nicht lesbar ist. Eine allgemeine Schema-Migrationsstrecke ist das
nicht.

Sind Speicher- oder Kindprozesslimits aktiv, misst der Supervisor den Prozessbaum in festen,
zeitbegrenzten Intervallen. Linux/macOS verwenden `ps`; Windows verwendet einen festen
`powershell.exe -EncodedCommand` ohne Profil, Shell-Interpolation, WMI/CIM oder Compiler. Das
Toolhelp32-Snapshot öffnet Speicherinformationen nur für die serverseitig gebundene Root-PID und
deren Nachkommen. Kann die Windows-Prozesstabelle nicht innerhalb von fünf Sekunden gelesen
werden, wird der Run mit `resource_probe_error` beendet und der Baum über den separaten
speicherfreien Snapshot beziehungsweise `taskkill /T /F` bereinigt. Das Limit wird nie still
deaktiviert. Die Windows-Messung bleibt eine Stichprobe und ersetzt kein Kernel-Job-Object; für
bereits vor einem Snapshot verwaiste Prozesse und PID-Reuse gilt daher die in der Release-Matrix
dokumentierte Restgrenze.

Backups des Agentensystems müssen Run-Vault, Schlüssel, Eventindex und referenzierte
Arbeitsartefakte gemeinsam umfassen. Der vorhandene Helper erzeugt atomare Bundles, validiert
Hashes und Schlüsselmaterial, führt schreibfreie Dry-runs aus und restauriert nur in eine exakt
freigegebene Zielwurzel mit atomarem Swap/Rollback. Eine UI-/CLI-Betriebsstrecke dafür fehlt.
Support- und Standard-Runexporte sind redigiert; interne
Speicherdateien können personenbezogene Daten enthalten und müssen entsprechend geschützt werden.

Der Offline-Referenzpfad lässt sich nach `npm.cmd run dev` in **Agenten** mit dem Provider
**Synthetischer Offline-Agent** testen. Er benötigt weder Konto noch Netzwerk. Die API bindet nur
an `127.0.0.1`; Angular verwendet REST-Kommandos, nativen EventSource-Reconnect mit
`Last-Event-ID` und ergänzendes REST-Polling. Ein `Idempotency-Key` wird ohne Requestinhalt als
Hash/Fingerprint und opaker Ergebnisverweis unter `.local-data/agent-idempotency/` persistiert. Er
findet auch nach einem Neustart einen abgeschlossenen Run wieder; gleichzeitig eintreffende gleiche
Requests werden im selben Express-Prozess koalesziert. Der Dateistore koordiniert jedoch keine
prozessübergreifende Transaktion oder verteiltes Claim-Protokoll. Bei mehreren Serverprozessen besteht daher
weiterhin keine harte Exactly-once-Garantie. Run-Prompts und klassifizierte Eventfelder werden im Disk-Store mit
AES-256-GCM verschlüsselt; `.local-data/keys/agent-run-vault.key` muss gemeinsam mit
`.local-data/agent-runs/` gesichert werden.

Der eingeschränkte Root-MCP startet über:

```powershell
npm.cmd run agent:mcp
```

Der direkte Prozess ist absichtlich fail-closed: Ohne eine vom Server injizierte rungebundene
Domain-Fassade funktionieren nur Health und Toolkatalog. Der MCP enthält keine Shell-, Versand-,
Submit-, Portal-Login- oder beliebigen Netzwerkwerkzeuge.

Produktive Domainwerkzeuge werden ausschließlich über die serverseitige Run-Factory bereitgestellt.
Sie benötigt eine intern erzeugte Run-/Provider-/Tool-/Case-Capability sowie explizit injizierte
schmale Ports. Capability- und Approval-Tokens werden nicht als MCP-Argumente akzeptiert. Eine
Freigabe wird im Server angefordert, einmalig gebunden und vor dem Portaufruf verbraucht; sensitive
Reads verwenden weiterhin die maskierte Ansicht. Ablauf oder Widerruf der Run-Capability sperrt
jeden weiteren Toolaufruf der Sitzung.

Diese Agenten-Isolation gilt nicht für den eigenständigen Job-Search-MCP. Er ist explizit als
`executionIsolation: trusted-host` klassifiziert und wird direkt nativ oder über WSL-stdio
gestartet. Agenten-Wrapper, Shell-Umwege, Bubblewrap, Container und eine Agenten-Netzwerksandbox
sind für diesen Prozess nicht erlaubt. Portalzugriff und Credentials verbleiben in seiner eigenen
Policy-Grenze.

Ein Agentenlauf wird außerdem vor dem Prozessstart blockiert, wenn die wirksame
Codex-/OpenCode-/Claude-/MCP-Projektkonfiguration versucht, `job-search-mcp` als Kindprozess zu starten.
Damit kann insbesondere die optionale `.opencode`-Entwicklerkonfiguration des Submoduls nicht
versehentlich innerhalb von Bubblewrap ausgeführt werden. Der Root-Adapter bleibt der
unterstützte trusted-host-Startpfad. Projektverwaltete MCP-/Plugin-Deklarationen sind im Agent
Center generell fail-closed. Codex Exec verwendet bei der ausschließlich freigegebenen Version
`0.147.0` feste servereigene Argumente mit `--ignore-user-config --strict-config`,
`web_search="disabled"` und `sandbox_workspace_write.network_access=false`. Der experimentelle
Codex App Server verwendet dieselben Overrides und erhält ein temporäres `CODEX_HOME`,
das höchstens die lokale `auth.json`, aber keine Benutzer-MCP-/Plugin-Konfiguration enthält.
OpenCode und Claude erhalten ein temporäres HOME/XDG-Verzeichnis; nur ihre jeweilige
Authentifizierungsdatei wird read-only eingebunden. Bei einem als offline ausgewählten App-Server-
Run ist ein Healthfehler fail-closed und führt nicht zu einem schwächeren Exec-Fallback.

Wichtige Diagnoseendpunkte sind `GET /api/agents/providers`, `GET /api/agents/health`,
`GET /api/agent-runs`, `GET /api/agent-runs/:id/events` und
`GET /api/agent-runs/:id/stream`. `POST /api/agents/emergency-stop` benötigt
`{"enabled":true,"confirmed":true}`. Ein Stop wird bewusst mit derselben Route und
`enabled:false` aufgehoben.

Vor einem Start ruft Angular `POST /api/agent-runs/preflight` mit demselben strikt validierten
Run-Entwurf auf. Die Antwort ist `Cache-Control: no-store`, echoet weder Prompt noch IDs, Pfade
oder Inhalte und startet weder Agent noch Job-Search-MCP. Sie nennt serverseitig erkannte Runtime,
effektiven Workspacezugriff, Datenkategorien, Limits, Netzwerkpolicy und die vollständige
provider- und workflowabhängige Root-MCP-Tool-Allowlist. Sie ist für OpenCode, Claude, Fake und
den stabilen Codex-Exec-Transport leer; beim aktivierten nativen Codex App Server enthält sie nur die benötigten
Domainwerkzeuge. Beim Workflow `guided-job-analysis` ist ausdrücklich sichtbar,
dass `job-search-mcp` erst beim eigentlichen Start auf dem Trusted Host läuft und der Agent nur
normalisierte Ergebnisse erhält.

Rungebundene Vorschläge liegen unter `GET/POST /api/agent-runs/:id/artifacts`. Metadaten und
UTF-8-Inhalt werden über `.../artifacts/:artifactId` beziehungsweise `.../content` gelesen;
`.../artifacts/diff?left=<id>&right=<id>` liefert einen größen- und zeilenbegrenzten Vergleich.
`POST .../artifacts/:artifactId/review` akzeptiert ausschließlich `approved` oder `rejected`
zusammen mit `expectedRevision` und `confirmed:true`. Die bestätigte Route `.../adopt` kann nur ein
freigegebenes Legacy-`application-pipeline-package` aus Workflow 1.0 übernehmen. Dabei führt der Server die lokale
Evidence- und Sprachpipeline erneut aus, prüft Fall-, Stellen-, Firmen-, Identitäts-, Revisions-
und Hash-Provenance und erzeugt eine neue fachliche Revision im Zustand `proposed`. Nur dieser
servereigene Übernahmeport darf anschließend das Agentenartefakt als `used` markieren; einen freien
Lifecycle-Schalter gibt es nicht. Inhaltsantworten tragen `Cache-Control: no-store`; Run- und
Supportexporte sowie normale Auditlogs enthalten keine Artefakt-Rohinhalte. Die Dateien unter
`.local-data/agent-artifacts/` sind dennoch personenbezogene lokale Daten und gehören in die
gemeinsame Backup-, Zugriffs- und Löschpolicy.

### Multi-Agent-Orchestrierung

`POST /api/agent-orchestrations` startet einen versionierten Workflow, nicht nur einen einzelnen
UI-Run. Der Workflow `evidence-application-package` führt fünf getrennte Node-Runs aus:
Evidence → Author → ATS und Recruiter/Style → Finalizer. Scope, Input-Digests, Rollenprompt,
Abhängigkeiten, Budgets, Retryregeln und Artefakte werden serverseitig gebunden. Evidence-Gates
kommen ausschließlich aus dem lokalen Kandidatenprofil. Im aktuellen
`evidence-application-package@1.1.0` läuft der Finalizer ohne Browser-Gate und erhält ATS- sowie
Recruiter/Style-Review automatisch. Er erzeugt direkt `final_html`; JSON-Paket, Fortsetzen-Dialog
und Fan-in-Freigabe gehören nicht zum aktuellen Lauf. Nach Erfolg liefert die hashgebundene
`result.html`-Route eine CSP-geschützte Seite, die Angular automatisch sandboxed anzeigt. Ein
Abbruch ist weiter an `expectedRevision` gebunden; Anzeige löst keinen Export oder Versand aus.

### Profile und lokale Sprachprüfung

`GET /api/application-pipeline/setup` zeigt, ob die privaten Kandidaten- und Stilprofile vorhanden
sind. Die bestätigte Setup-Route kopiert nur die leeren Beispiele des Submodules nach
`.local-data/profiles/`, überschreibt nichts und erfindet keine Kandidatenfakten. Das Stilprofil
wird über `GET/PUT /api/application-pipeline/style-profile` mit `expectedRevision`,
`expectedSha256` und `confirmed:true` bearbeitet und vor atomarer Veröffentlichung durch den
Submodule-Validator geprüft.

Die Sprachprüfung verwendet standardmäßig gebündelte deutsche und englische Wörterbücher über
`nspell`; Dokumenttext verlässt dabei den Rechner nicht. `LANGUAGE_CHECK_BACKEND=languagetool`
oder `hunspell` wählt die bestehenden lokalen Submodule-Backends. Ein nicht verfügbares Backend
bleibt in der finalen Evidence-Pipeline ein blockierender Nachweisfehler.

### Retention, Observability und Agentenprofile

Die lokale Composition legt Retention-Journal, Idempotenzregister, Agenten-Konfigurationsprofil
und strukturierte Observability ausschließlich unter `.local-data/` an. Retention arbeitet als
Preview mit Digest und anschließend bestätigter Kaskade über terminale Runs, Eventlogs, vorhandene
optional konfigurierte Rohlogs und Agentenartefakte. Der Supervisor unterstützt Rohlogrotation,
die normalen Provideradapter aktivieren sie derzeit jedoch nicht. Aktive Legal Holds auf Run,
Artefakt oder Bewerbungsfall blockieren die Löschung;
bei bereits verwendeten Artefakten bleibt die Provenance-Metadatei erhalten, während Rohinhalt
gelöscht werden kann. Das Journal speichert Referenzen nur gehasht, ist append-only und wird
`fsync`-gesichert; es ist jedoch keine extern signierte oder manipulationssichere Audit-Chain.

`GET/PUT /api/agents/config-profile` verwaltet ein versionsgebundenes, secret-freies Profil mit
Compare-and-swap über `expectedUpdatedAt`, Last-known-good-Kopie und sicherem Reset. Das Feld
`codexAppServerExperimental` ist mit Schema 3 entfallen und wird beim Laden aus Version-2-Profilen
still entfernt; die Codex-Transportwahl folgt jetzt den Anforderungen des Laufs. Einzelne Runwerte
stammen weiterhin aus dem validierten Runrequest. Der produktiv verdrahtete
Angular-CAS-Editor zeigt aktives Profil beziehungsweise Last-known-good-Quelle, Provider-Runtime,
Sandbox, Offline-/Approvalmodus, Budgetgrenzen und Featureflags. Er bietet keine Secret-, Pfad-,
Command- oder argv-Felder an, verlangt für den Codex App Server ein gesondertes Opt-in und erneuert
nach erfolgreichem Speichern Providererkennung und Preflight. Reservierte Realtime-/Rohlogflags
sind in der Oberfläche nur lesbar. Das lokale Observability-Log enthält nur allowlistete Codes,
Zeitmessungen und gehashte Korrelations-/Run-IDs, niemals Prompts, Mails oder freie Details; eine
Angular-Logansicht ist dafür noch nicht vorhanden.

## Backup und Restore

Die Anwendung muss für ein konsistentes Vollbackup beendet sein. Der Agent-Backup-Helper erzeugt
ein atomar veröffentlichtes Bundle aus `manifest.json` und `files/`. Manifestversion 1.1 enthält
pro Datei Pfad, Klassifizierung, Größe und SHA-256 sowie einen Hash über das Manifest selbst.
Quelländerungen während des Lesens, symlinked Backup-Einträge, Pfad-Traversal, doppelte Einträge
und unbekannte Contractversionen werden abgelehnt. Das öffentliche Format ist in
`contracts/v1/agent-backup-manifest.schema.json` beschrieben.

Vor jeder Wiederherstellung validiert der Helper Manifest und sämtliche Dateien. Ein Dry-run führt
dieselbe Prüfung und eine Migration des Manifestmodells aus, schreibt aber nichts. Version 1.0 kann
deterministisch nach 1.1 migriert werden; unbekannte Versionen werden nicht verändert. Fehlendes
deklariertes Schlüsselmaterial macht das Backup ausdrücklich nicht wiederherstellbar. Ein verlorener
Schlüssel kann nicht aus verschlüsselten Daten rekonstruiert werden.

Ein Restore benötigt die exakte, explizit freigegebene Zielwurzel. Dateisystemwurzeln, Symlinks,
Überlappungen mit dem Backup und Ziele außerhalb dieser Freigabe sind gesperrt. Bestehende Ziele
werden standardmäßig nicht überschrieben. Nur mit einer gesonderten Overwrite-Entscheidung wird
zuerst in ein Geschwisterverzeichnis restauriert und vollständig hashvalidiert, dann das komplette
Zielverzeichnis atomar ausgetauscht; ein fehlgeschlagener Austausch rollt auf das alte Verzeichnis
zurück. Die aufrufende Betriebsoberfläche für diesen Helper ist noch nicht verdrahtet.

Ein Vollbackup umfasst gemeinsam `.local-data/` und optional `.application-work/`. `config.json`
und `config.json.key`, `mail-vault.json` und `mail-vault.key` sowie Agent-Run-Vault und zugehöriger
Schlüssel dürfen nicht getrennt werden. Das Bundle ist wie personenbezogene Daten zu schützen.
Nach einem Restore wird `npm.cmd run diagnose` ausgeführt.

## Upgrade und Rollback

Vor dem Upgrade: Backup erstellen, Arbeitsbaum pruefen und Submodule-Pins notieren. Danach den
gewuenschten Root-Commit auschecken, `git submodule update --init --recursive`, Abhaengigkeiten
installieren sowie Tests und Diagnose ausfuehren. Beim Rollback werden Root-Commit und seine
gepinnten Submodule-Commits ausgecheckt und das gemeinsam erstellte Datenbackup wiederhergestellt.
Unbekannte lokale Schema-Versionen werden nicht automatisch ueberschrieben.

## Vollstaendige lokale Deinstallation

Nach bewusstem Export koennen `.local-data/`, `.application-work/`, virtuelle Python-Umgebungen
und `node_modules/` entfernt werden. Portal-Sitzungen liegen gegebenenfalls separat im
`JOB_MCP_STATE_DIR` und muessen dort ebenfalls geloescht werden. Erst danach wird der Repository-
Ordner entfernt. Diese Schritte sind unwiederbringlich und muessen manuell mit geprueften,
konkreten Pfaden erfolgen.

## Release-Checkliste

- Root- und Submodule-Tests, Typpruefung, Formatierung und Builds sind gruen.
- Contract- und Schema-Versionen sind kompatibel; Breaking Changes verwenden einen neuen Major.
- Root zeigt auf veroeffentlichte, unveraenderliche Submodule-Commits.
- Security-/PII-Scan, Inkognito-Negativtests und Datenschutzreview sind abgeschlossen. Der
  aktuelle Scan prüft relevante getrackte und untracked Quelldateien sowie bekannte Signaturen
  und Runtime-Canaries in den ignorierten Laufzeitverzeichnissen. Er bleibt signaturbasiert,
  überspringt unter anderem Binärdateien, Symlinks und übergroße Quelldateien und ersetzt deshalb
  kein manuelles Datenschutzreview.
- Backup, Upgrade, Rollback und bekannte Einschraenkungen sind fuer das Release dokumentiert.
- Ein frischer Checkout reproduziert den synthetischen Kernpfad ohne Credentials und Netzwerk.

Die konkreten Pins, Provider- und Featuregrenzen sowie Rollback- und Offline-Kommandos stehen in
der [Release-Matrix](release-matrix.md). Bei einem Sicherheits- oder Datenschutzvorfall gilt das
[Incident- und Datenschutz-Runbook](incident-privacy-runbook.md).
