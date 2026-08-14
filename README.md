# Job Match & Apply

Lokale Angular-Oberfläche, die den [Job Search MCP](https://github.com/ananta888/job-search-mcp/)
mit dem [Bewerbungs-Schreib-Assistenten](https://github.com/ananta888/bewerbungs-schreib-assistent)
über stabile Adapter verbindet. Beide Upstreams liegen als Git-Submodules unter `integrations/`
und behalten ihre eigene Historie.

## Enthalten

- konfigurierbares Suchprofil: Region, Radius, Arbeitsmodell, Vertragsart, Muss-/Wunschbegriffe
  und Ausschlüsse
- nachvollziehbares lokales Matching und synthetische Demo-Daten für einen sofort ausführbaren
  Offline-Pfad
- generierte Inkognito-Identitäten mit zentralen Platzhaltern und `.invalid`-E-Mail-Adressen
- generischer stdio-MCP-Client für Suche, Status und sichtbaren StepStone-Login
- Quellenansicht für StepStone, Arbeitnow, Remotive, WWR und Profilimporte
- faktenkonservativer Bewerbungsentwurf hinter einer eigenen Assistenten-Schnittstelle
- serverseitige Inkognito-Sperre für Finalisierung sowie Profil-, Claim-, Stil- und Review-Gates
- lokale, versionierte Suchläufe, Bewerbungsfälle, Wiedervorlagen und bewusst aktivierte Suchpläne
- lokale Kandidaten- und Stilprofile, revisionsgebundene Stilbearbeitung und standardmäßig lokale
  Rechtschreibprüfung mit `nspell`
- nutzerkontrollierte Profilimporte als unbestätigte Vorschläge sowie DOCX-/PDF-Export
- freigabepflichtige Bewerbungspakete und ausschließlich seiteneffektfreie Submission-Dry-Runs
- Firmenakten mit getrennten Bewerbungen je Stelle, Antwort-/Termin-Inbox und nachvollziehbarer
  Dokumenthistorie
- expliziter IMAP-Abruf, manueller EML-Import und optionaler lokaler Nur-Empfang-SMTP-Dienst
- lokales Agent Control Center für Codex CLI sowie die exakt geprüften WSL-Versionen OpenCode
  `1.14.41` und Claude Code `2.1.232`
- lokal verdrahtete Fünf-Rollen-Orchestrierung für Evidence, Author, ATS, Recruiter/Style und Finalizer;
  der Finalizer hat vor seinem Lauf ausschließlich das bewusste `user_input`-Gate und sein
  Ergebnis bleibt bis zur nachgelagerten Review- und Revisionskette ein Vorschlag

## Start

Voraussetzungen: Node.js 22+ und npm.

```powershell
npm.cmd install
npm.cmd --prefix server install
npm.cmd run dev
```

Danach: <http://localhost:4200>. Der Demo-Modus benötigt weder echte Accounts noch externe
Portalzugriffe.

## Echte Upstream-Integrationen

Für `job-search-mcp` wird Python 3.12 benötigt. Das Setup bevorzugt die vorhandene
Ubuntu/WSL2-Runtime; native Windows-Ausführung muss bewusst gewählt werden:

```powershell
npm.cmd run setup:integrations
```

Das Setup schreibt den erkannten, lokalen Startvertrag nach
`.local-data/job-search-mcp-launch.json`; die API übernimmt daraus nur validierte `command`-,
`args`-, `env`-, `runtimeTarget`- und gegebenenfalls `distribution`-Werte sowie die feste Grenze
`executionIsolation: trusted-host`. Schema-, Realpfad- und Venv-Prüfung sind fail-closed. Sobald
dieser private Vertrag gültig ist und noch die frische Demo-Konfiguration vorliegt, übernimmt die
API ihn beim nächsten Laden automatisch als effektiven `stdio`-Modus. Der Job-Suche-MCP läuft
bewusst niemals in einer Agenten-, Bubblewrap-, Container- oder Netzwerk-Sandbox: Er besitzt den
sichtbaren StepStone-Login und die Portalverantwortung. Die Root-Anwendung ruft ihn über den
MCP-Vertrag auf; Agenten erhalten nur normalisierte, als nicht vertrauenswürdig behandelte Daten
oder – ausschließlich beim explizit aktivierten nativen Codex App Server – eng allowlistete,
rungebundene Dynamic Tools. OpenCode `1.14.41`, Claude Code `2.1.232`, Fake und Codex Exec arbeiten
prompt-only. Externe Portale bleiben unabhängig vom aktiven `stdio`-Modus
mit `ALLOW_EXTERNAL_PORTALS=0` gesperrt. Sie werden ausschließlich über die bestätigte
Portalzugriffsaktion in **Quellen & MCP** freigegeben. **Sichtbaren Login öffnen** startet danach
den Camoufox-Ablauf; Captchas, 2FA und Portalrichtlinien werden nicht umgangen.

Das Setup endet mit einem echten Offline-stdio-Smoke (`tools/list` und `capabilities`) und prüft
dabei StepStone, Realpfade, die enge WSL-Environment-Brücke und den wrapperfreien Trusted-Host-
Start. Es ruft keine Suche und keinen Login auf. Der Smoke ist mit `npm.cmd run job-mcp:smoke`
wiederholbar; Details stehen unter [Job-Search-MCP als Trusted Host](docs/setup-job-search-mcp.md).

Beim frischen Klonen können die Submodules direkt mitgeladen werden:

```powershell
git clone --recurse-submodules <repository-url>
```

Zur gemeinsamen Weiterentwicklung wird innerhalb des jeweiligen Submodules auf einem eigenen
Branch committed und gepusht. Danach übernimmt das Hauptprojekt den neuen Submodule-Commit.

## Befehle

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run diagnose
npm.cmd run job-mcp:smoke
npm.cmd run security:scan
npm.cmd run mail:server
npm.cmd run agent:mcp
```

Der SMTP-Dienst benötigt `LOCAL_MAIL_SECRET` (mindestens 16 Zeichen), bindet standardmäßig nur an
`127.0.0.1:2525` und versendet keine Nachrichten. Details stehen im Betriebsleitfaden.

Details zu Grenzen und Erweiterungen: [docs/architecture.md](docs/architecture.md).

Installation, Backup, Restore, Upgrade und Deinstallation: [docs/operations.md](docs/operations.md).
Die Integrationsgrenzen sind in [docs/contracts.md](docs/contracts.md) beschrieben.

Releasepins, Featuregrenzen, Rollback und reproduzierbare Offline-Prüfschritte stehen in der
[Release-Matrix](docs/release-matrix.md). Für Störungen und Datenschutzfälle gilt das
[Incident- und Datenschutz-Runbook](docs/incident-privacy-runbook.md). Neue Provider, Root-Tools
und Workflows folgen dem Leitfaden
[Provider-, MCP-Tool- und Workflow-Entwicklung](docs/adapter-workflow-development.md).

Entwicklungs-Todos, Skill-Routing und Agentenrollen sind in
[docs/application-agent-system.md](docs/application-agent-system.md) getrennt beschrieben.

Architektur, Sicherheitsgrenzen und Providerstrategie des Agent Control Centers beschreibt
[docs/agent-control-center.md](docs/agent-control-center.md).

Die Seite **Agenten** enthält den vollständigen lokalen Bedienpfad: Providerdiagnose, sichere
Run-Erstellung, Queue, Live-/Replay-Timeline, Rückfragen, Freigaben, Abbruch und redigierten Export.
Sie steuert außerdem die versionierten Multi-Agent-Workflows, zeigt deren Rollen, Budgets und Gates
und kann ein vom Finalizer erzeugtes `application-pipeline-package` nach menschlichem
Artefakt-Review über die lokale Evidence-Pipeline als neue fachliche Vorschlagsrevision übernehmen.
Danach folgen Pipeline-Review, exakte Fallfreigabe, `used` und Export, jeweils an dieselbe
Revisions-ID und denselben SHA-256 gebunden. `fake` ist der konto- und netzwerkfreie
Referenzprovider. Reale CLIs werden ausschließlich dann freigeschaltet, wenn Binary, exakte
Version, Runtime und Capability-Vertrag nachweisbar passen.

Der Codex App Server bleibt experimentell und ist standardmäßig aus. Er wird serverseitig über
das explizite Operator-Featureflag `CODEX_APP_SERVER_EXPERIMENTAL=1` oder über
`features.codexAppServerExperimental` im bestätigten persistenten Agentenprofil aktiviert. Der
Angular-CAS-Editor zeigt aktives Profil und Last-known-good-Quelle, erlaubt keine Secret-, Pfad-,
Command- oder argv-Felder und verlangt für dieses Opt-in eine zusätzliche Bestätigung. Nach dem
Speichern werden Providererkennung und Preflight erneuert. Bei Auswahl erzwingt der Server über die
Codex-`SandboxPolicy` stets `networkAccess:false`; ein fehlgeschlagener Offline-Healthcheck oder
eine nicht verfügbare Root-Tool-Brücke beendet den Run fail-closed. OpenCode und Claude laufen nur
read-only in WSL/Bubblewrap. Ihre Provider-Control-Plane darf das Modell erreichen, während die
servereigene Toolpolicy Shell-, Schreib-, Web-, MCP- und Subagent-Zugriffe verweigert. Diese Grenze
ist keine allgemeine Host-Netzwerkisolation.

Der Approval-Lifecycle wird lokal append-only und ohne Rohparameter, Akteur oder Bearer-Token
persistiert; Bindungen, Parameter und Akteure erscheinen nur als Hash. Nach einem Serverneustart
werden zuvor offene oder bereits erteilte, noch nicht verbrauchte Freigaben im Journal widerrufen
und müssen neu angefordert werden.
