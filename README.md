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

Für `job-search-mcp` wird Python 3.12 benötigt:

```powershell
npm.cmd run setup:integrations
```

Anschließend in **Quellen & MCP** den Modus `stdio-MCP` wählen und speichern. Externe Portale
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
```

Details zu Grenzen und Erweiterungen: [docs/architecture.md](docs/architecture.md).

Entwicklungs-Todos, Skill-Routing und Agentenrollen sind in
[docs/application-agent-system.md](docs/application-agent-system.md) getrennt beschrieben.
