# Job Match & Apply

Lokale Angular-Oberfläche, die den [Job Search MCP](https://github.com/ananta888/job-search-mcp/)
mit dem [Bewerbungs-Schreib-Assistenten](https://github.com/ananta888/bewerbungs-schreib-assistent)
über stabile Adapter verbindet. Beide Upstreams liegen als Git-Submodules unter `integrations/`
und behalten ihre eigene Historie.

## Enthalten

- konfigurierbares Suchprofil: Region, Radius, Arbeitsmodell, Vertragsart, Muss-/Wunschbegriffe
  und Ausschlüsse
- nachvollziehbares lokales Matching und Demo-Daten für einen sofort ausführbaren MVP
- generierte Inkognito-Identitäten mit zentralen Platzhaltern und `.invalid`-E-Mail-Adressen
- generischer stdio-MCP-Client für Suche, Status und sichtbaren StepStone-Login
- Quellenansicht für StepStone, Arbeitnow, Remotive, WWR und Profilimporte
- faktenkonservativer Bewerbungsentwurf hinter einer eigenen Assistenten-Schnittstelle
- serverseitige Inkognito-Sperre für Finalisierung sowie Profil-, Claim-, Stil- und Review-Gates

- lokale, versionierte Suchlaeufe, Bewerbungsfaelle, Wiedervorlagen und bewusst aktivierte Suchplaene
- nutzerkontrollierte Profilimporte als unbestaetigte Vorschlaege sowie DOCX-/PDF-Export
- freigabepflichtige Bewerbungspakete und ausschliesslich seiteneffektfreie Submission-Dry-Runs
- Firmenakten mit getrennten Bewerbungen je Stelle, Antwort-/Termin-Inbox und nachvollziehbarer Dokumenthistorie
- expliziter IMAP-Abruf, manueller EML-Import und optionaler lokaler Nur-Empfang-SMTP-Dienst
- lokales, providerneutrales Agent Control Center für Codex CLI, OpenCode, Claude CLI und weitere JSONL-Adapter

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

Für `job-search-mcp` wird Python 3.12 benötigt. Das Setup verwendet zuerst eine native
Windows-Installation und fällt andernfalls kontrolliert auf Ubuntu/WSL2 zurück:

```powershell
npm.cmd run setup:integrations
```

Das Setup schreibt den erkannten, lokalen Startvertrag nach
`.local-data/job-search-mcp-launch.json`; die API übernimmt daraus nur validierte `command`-,
`args`-, `env`-, `runtimeTarget`- und gegebenenfalls `distribution`-Werte sowie die feste Grenze
`executionIsolation: trusted-host`. Schema-, Realpfad- und Venv-Prüfung sind fail-closed; die API aktiviert den
echten MCP aber nicht selbst. Der Job-Suche-MCP läuft bewusst nicht in einer Agenten- oder
Netzwerk-Sandbox, weil er den sichtbaren StepStone-Login und freigegebene Portalzugriffe besitzt;
die Root-Anwendung ruft ihn über den MCP-Vertrag auf, während Agenten ausschließlich die daraus
normalisierten, als nicht vertrauenswürdig markierten Suchergebnisse erhalten. Anschließend in
**Quellen & MCP** den Modus `stdio-MCP` wählen und speichern. Externe Portale
bleiben mit `ALLOW_EXTERNAL_PORTALS=0` gesperrt. Für StepStone muss der Wert bewusst auf `1`
gesetzt werden; **Sichtbaren Login öffnen** startet dann den vorhandenen Camoufox-Ablauf. Captchas,
2FA und Portalrichtlinien werden nicht umgangen.

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
npm.cmd run security:scan
npm.cmd run mail:server
npm.cmd run agent:mcp
```

Der SMTP-Dienst benötigt `LOCAL_MAIL_SECRET` (mindestens 16 Zeichen), bindet standardmäßig nur an
`127.0.0.1:2525` und versendet keine Nachrichten. Details stehen im Betriebsleitfaden.

Details zu Grenzen und Erweiterungen: [docs/architecture.md](docs/architecture.md).

Installation, Backup, Restore, Upgrade und Deinstallation: [docs/operations.md](docs/operations.md).
Die Integrationsgrenzen sind in [docs/contracts.md](docs/contracts.md) beschrieben.

Entwicklungs-Todos, Skill-Routing und Agentenrollen sind in
[docs/application-agent-system.md](docs/application-agent-system.md) getrennt beschrieben.

Architektur, Sicherheitsgrenzen und Providerstrategie des Agent Control Centers beschreibt
[docs/agent-control-center.md](docs/agent-control-center.md).

Die Seite **Agenten** enthält den vollständigen lokalen Bedienpfad: Providerdiagnose, sichere
Run-Erstellung, Queue, Live-/Replay-Timeline, Rückfragen, Freigaben, Abbruch und redigierten Export.
`fake` ist der konto- und netzwerkfreie Referenzprovider. Reale CLIs werden ausschließlich dann
freigeschaltet, wenn Binary, Version, Runtime und Capability-Vertrag nachweisbar passen.
