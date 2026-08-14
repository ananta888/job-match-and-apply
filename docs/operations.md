# Lokaler Betrieb

## Windows und WSL2

Fuer die Angular-/Node-Anwendung werden Node.js 22 und npm benoetigt. Der Job-Search-MCP
benoetigt Python 3.12. `setup:integrations` verwendet eine native Windows-3.12-Installation oder
richtet andernfalls in der expliziten Ubuntu-WSL2-Distribution `.venv-wsl` ein. Der resultierende
Startvertrag liegt privat unter `.local-data/job-search-mcp-launch.json`; er wird validiert und in
der Demo-Konfiguration vorausgefuellt, schaltet `stdio` aber nie automatisch ein.
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

Eine gegebenenfalls im Submodul vorhandene `.opencode/opencode.json` ist kein unterstützter
Root-Startpfad. Sie wird von Setup, API und Diagnose weder geladen noch komponiert; nur der private,
versionierte Root-Startvertrag darf den Job-Search-MCP aktivieren.

```powershell
git clone --recurse-submodules <repository-url>
npm.cmd install
npm.cmd --prefix server install
npm.cmd run setup:integrations
npm.cmd test
npm.cmd run build
npm.cmd run diagnose
```

Der Demo-Modus verwendet nur synthetische Offline-Daten. Externe Portale bleiben ohne
`ALLOW_EXTERNAL_PORTALS=1` gesperrt. Login, Captcha und 2FA erfordern sichtbare Interaktion.

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
Distribution. Ein frei eingegebener Executable-Pfad bleibt ausgeschlossen. OpenCode und Claude
bleiben außerdem blockiert, solange kein Versionsmuster ausdrücklich freigegeben ist.

Neue Runs verwenden `read-only` und `network: disabled`. Workspace-Schreibrechte sind bewusst
auswählbar; Netzwerkrequests lehnt die API derzeit vollständig ab. Eine zentrale
kontextgebundene Freigabe für produktive CLI-Toolaufrufe ist noch nicht verdrahtet. Der
interaktive Fake demonstriert Approve/Deny und Rückfragen ohne Seiteneffekt; seine Freigaben
laufen durch die zentrale Policy und einmalige parametergebundene Approval-Tokens. Providerzugänge
werden über deren lokalen Login eingerichtet. API-Schlüssel, Tokens und
Portalkennwörter dürfen nicht in Prompt, Angular-Konfiguration oder Repository-`.env` kopiert
werden.

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

Backups des Agentensystems müssen Run-Vault, Schlüssel, Eventindex und referenzierte
Arbeitsartefakte gemeinsam umfassen. Der vorhandene Helper erzeugt atomare Bundles, validiert
Hashes und Schlüsselmaterial, führt schreibfreie Dry-runs aus und restauriert nur in eine exakt
freigegebene Zielwurzel mit atomarem Swap/Rollback. Eine UI-/CLI-Betriebsstrecke dafür fehlt.
Support- und Standard-Runexporte sind redigiert; interne
Speicherdateien können personenbezogene Daten enthalten und müssen entsprechend geschützt werden.

Der Offline-Referenzpfad lässt sich nach `npm.cmd run dev` in **Agenten** mit dem Provider
**Synthetischer Offline-Agent** testen. Er benötigt weder Konto noch Netzwerk. Die API bindet nur
an `127.0.0.1`; Angular verwendet REST-Kommandos, nativen EventSource-Reconnect mit
`Last-Event-ID` und ergänzendes REST-Polling. Ein
`Idempotency-Key` findet persistierte Runs wieder und koalesziert gleichzeitig eintreffende gleiche
Startrequests atomar innerhalb desselben Express-Prozesses. Die Inflight-Map ist jedoch
prozesslokal und der Disk-Store besitzt keine transaktionale Unique-Constraint; über mehrere
Serverprozesse sowie Crash-/Neustart-Grenzen hinweg besteht deshalb keine dauerhafte
Exactly-once-Garantie. Run-Prompts und klassifizierte Eventfelder werden im Disk-Store mit
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
Center generell fail-closed. Codex Exec verwendet auf der freigegebenen 0.147-Linie zusätzlich
`--ignore-user-config`; OpenCode/Claude erhalten in Bubblewrap ein leeres temporäres HOME und
XDG-Konfigurationsverzeichnis. Der experimentelle Codex App Server fällt vor dem ersten Turn auf
Exec zurück, solange er Userkonfiguration nicht nachweisbar ignorieren kann.

Wichtige Diagnoseendpunkte sind `GET /api/agents/providers`, `GET /api/agents/health`,
`GET /api/agent-runs`, `GET /api/agent-runs/:id/events` und
`GET /api/agent-runs/:id/stream`. `POST /api/agents/emergency-stop` benötigt
`{"enabled":true,"confirmed":true}`. Ein Stop wird bewusst mit derselben Route und
`enabled:false` aufgehoben.

Vor einem Start ruft Angular `POST /api/agent-runs/preflight` mit demselben strikt validierten
Run-Entwurf auf. Die Antwort ist `Cache-Control: no-store`, echoet weder Prompt noch IDs, Pfade
oder Inhalte und startet weder Agent noch Job-Search-MCP. Sie nennt serverseitig erkannte Runtime,
effektiven Workspacezugriff, Datenkategorien, Limits, Netzwerkpolicy und die vollständige aktuell
leere Root-MCP-Tool-Allowlist. Beim Workflow `guided-job-analysis` ist ausdrücklich sichtbar,
dass `job-search-mcp` erst beim eigentlichen Start auf dem Trusted Host läuft und der Agent nur
normalisierte Ergebnisse erhält.

Rungebundene Vorschläge liegen unter `GET/POST /api/agent-runs/:id/artifacts`. Metadaten und
UTF-8-Inhalt werden über `.../artifacts/:artifactId` beziehungsweise `.../content` gelesen;
`.../artifacts/diff?left=<id>&right=<id>` liefert einen größen- und zeilenbegrenzten Vergleich.
`POST .../artifacts/:artifactId/review` akzeptiert ausschließlich `approved` oder `rejected`
zusammen mit `expectedRevision` und `confirmed:true`. Es existiert absichtlich kein REST-Endpunkt
zum Markieren als `used`. Inhaltsantworten tragen `Cache-Control: no-store`; Run- und
Supportexporte sowie normale Auditlogs enthalten keine Artefakt-Rohinhalte. Die Dateien unter
`.local-data/agent-artifacts/` sind dennoch personenbezogene lokale Daten und gehören in die
gemeinsame Backup-, Zugriffs- und Löschpolicy.

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
