# Job-Search-MCP als Trusted Host

## Ziel und Sicherheitsgrenze

Der echte `job-search-mcp` besitzt Browser-, Sitzungs- und Portalverantwortung. Er wird deshalb
vom Root-Server als separater, vertrauenswuerdiger stdio-Prozess gestartet und niemals als
Kindprozess einer Codex-, OpenCode-, Claude-, Bubblewrap-, Container- oder Netzwerk-Sandbox.
Agenten erhalten nur normalisierte Root-Daten beziehungsweise schmale Root-Werkzeuge; sie starten
den Portal-MCP nicht selbst.

Der private Startvertrag ist `.local-data/job-search-mcp-launch.json`. Er ist ignoriert, enthaelt
lokale absolute Pfade und wird atomar ohne UTF-8-BOM geschrieben. Das oeffentliche Schema liegt in
`contracts/v1/job-search-mcp-launch.schema.json`.

## Voraussetzungen

- Windows mit WSL2 und einer Distribution `Ubuntu`
- Python 3.12 in dieser Distribution
- Node.js 22, npm und installierte Root-/Server-Abhaengigkeiten
- initialisierte Git-Submodules

Die Distribution kann ueber `-Distribution <Name>` oder `JOB_MCP_WSL_DISTRIBUTION` gewaehlt
werden. Namen werden strikt validiert und nie an eine Shell uebergeben.

## Reproduzierbares Setup

```powershell
npm.cmd install
npm.cmd --prefix server install
powershell -ExecutionPolicy Bypass -File scripts/setup-integrations.ps1 `
  -RuntimeTarget wsl -Distribution Ubuntu
```

Der npm-Kurzbefehl verwendet dieselben sicheren Standardwerte:

```powershell
npm.cmd run setup:integrations
```

Das Setup:

1. initialisiert nur die gepinnten Submodules;
2. erzeugt oder prueft `integrations/job-search-mcp/.venv-wsl` mit Python 3.12;
3. installiert das gepinnte Submodule editierbar in genau diese Venv;
4. laedt das Camoufox-Browserpaket, ohne ein Jobportal aufzurufen;
5. erzeugt den privaten WSL-Startvertrag mit `ALLOW_EXTERNAL_PORTALS=0`;
6. validiert `wsl.exe`, die Pfadabbildung, Venv- und Executable-Realpfade;
7. prueft die enge WSL-Umgebungsbruecke;
8. startet den MCP kurz direkt ueber stdio und ruft nur `tools/list` und `capabilities` auf;
9. verlangt eine kompatible StepStone-Capability mit Loginunterstuetzung.

Der WSL-argv hat exakt diese Form:

```text
C:\Windows\System32\wsl.exe -d Ubuntu -- /.../.venv-wsl/bin/job-search-mcp
```

`bash`, `sh`, `env`, Bubblewrap, Container und andere Wrapper sind nicht Teil des Startpfads und
werden vom Vertragsparser abgelehnt. `WSLENV` ist fest auf
`ALLOW_EXTERNAL_PORTALS:JOB_MCP_STATE_DIR` begrenzt; andere Server- oder Provider-Secrets werden
nicht vererbt.

## Offline-Verifikation

Der positive Protokoll-Smoke kann jederzeit wiederholt werden:

```powershell
npm.cmd run job-mcp:smoke
npm.cmd run diagnose
```

Er bricht ab, wenn Portalzugriff im privaten Vertrag nicht `0` ist. Ein Erfolg weist nach:

- realer MCP-Handshake ueber stdio;
- Werkzeugkatalog des gepinnten Submodules;
- kompatibler `job-search-mcp`-Vertrag Major 1;
- StepStone aktiviert und `supports_login=true`;
- direkte Trusted-Host-argv ohne Sandboxwrapper;
- kanonisches Executable innerhalb `.venv-wsl`;
- keine aufgerufene Suche, kein Login und keine Portalnavigation.

## StepStone bewusst aktivieren

Ein gültiger privater Launch wird bei einer frischen Demo-Konfiguration beim nächsten Laden
automatisch als effektiver `stdio`-Modus übernommen. Das aktiviert ausdrücklich noch kein
Portalnetz. In Angular unter **Quellen & MCP**:

1. den validierten `stdio`-Runtime-Status kontrollieren;
2. den separaten Dialog **Portalzugriff freigeben** bestätigen;
3. erst danach **Sichtbaren Login öffnen** verwenden;
4. Captcha und 2FA selbst im sichtbaren Fenster abschließen.

Nur der dedizierte Serverendpunkt darf `ALLOW_EXTERNAL_PORTALS` von `0` auf `1` setzen. Normales
Konfigurationsspeichern kann weder Pfade noch Environment-Werte injizieren. Zum erneuten Sperren
wird derselbe bestaetigte Dialog verwendet. Gespeicherte Credentials und Sitzungen verbleiben im
privaten `JOB_MCP_STATE_DIR` und werden nicht an Agenten weitergegeben.

## Alternative Runtime und CI

Ein natives Windows-Setup muss explizit gewaehlt werden:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-integrations.ps1 -RuntimeTarget windows
```

`-RuntimeTarget auto` prueft zuerst WSL und faellt nur bei fehlender WSL-Python-3.12-Runtime auf
natives `python3.12` zurueck. `-SkipBrowserFetch` ist nur fuer Umgebungen gedacht, die den
Protokollvertrag testen, aber noch keinen sichtbaren Login ausfuehren sollen. Der Offline-MCP-Smoke
bleibt in allen Varianten obligatorisch.

## Fehlerdiagnose

- `job_search_mcp_wsl_realpath_invalid`: Nur das kanonische Windows-System-`wsl.exe` ist erlaubt.
- `job_search_mcp_wsl_root_mapping_invalid`: Windows-Pfad konnte nicht eindeutig nach WSL
  abgebildet werden; Distribution und Mount pruefen.
- `job_search_mcp_wsl_venv_realpath_invalid`: `.venv-wsl` ist ein Link oder zeigt nicht auf den
  erwarteten Integrationspfad.
- `job_search_mcp_executable_outside_allowed_venv`: Executable liegt ausserhalb der verwalteten
  Venv oder wurde umgebogen.
- `job_search_mcp_smoke_wsl_environment_bridge_failed`: WSL hat eine der beiden erlaubten
  Variablen nicht exakt uebernommen.
- `job_search_mcp_smoke_requires_portals_disabled`: Offline-Smoke verweigert einen Vertrag mit
  freigeschaltetem Portalnetz; erst wieder sperren.
- `job_search_mcp_smoke_stepstone_capability_missing`: Submodule-/Vertragsdrift; nicht durch
  Aktivieren des Portalnetzes umgehen.

Der Startvertrag kann sicher neu erzeugt werden, indem das Setup erneut ausgefuehrt wird. Es
ueberschreibt keine vorhandenen Kandidaten- oder Stilprofile und veraendert keinen Submodule-Pin.
