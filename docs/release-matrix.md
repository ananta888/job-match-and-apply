# Release-Matrix

Stand: 2026-08-14. Diese Matrix beschreibt den derzeit im Repository gebundenen lokalen
Einzelbenutzerbetrieb. Sie ist weder eine Sicherheitszertifizierung noch die Behauptung eines
externen Bewerbungs-, Mailversand- oder Hochverfügbarkeitsdienstes. Maschinenlesbare
Providerfreigaben stehen in
[`agent-provider-support.json`](../contracts/v1/agent-provider-support.json); Vertragsdetails in
den [Integrationsverträgen](contracts.md).

## Provider und Laufzeitgrenzen

| Provider/Transport | Freigabe | Runtime | Effektive Grenze | Domainwerkzeuge und Freigaben | Aktivierung und enger Rollback |
|---|---|---|---|---|---|
| `fake` / `fake-interactive` | synthetischer Referenzpfad; kein externer CLI-Supporteintrag | lokaler Node-Prozess | konto- und netzwerkfreie Fixtures; keine realen Daten | `fake` prompt-only; `fake-interactive` demonstriert Rückfrage und zentrale Approvalpolicy ohne realen Seiteneffekt | standardmäßig nutzbar; Provider im lokalen Profil deaktivieren |
| Codex Exec | `supported`, **exakt Codex `0.147.0`**, Adapter `1.0.0` | Windows, WSL, Linux, macOS | feste argv mit `--ignore-user-config --strict-config`, `web_search="disabled"` und `sandbox_workspace_write.network_access=false`; Prompt über stdin; Codex-Sandbox read-only oder Workspace-Write | prompt-only, keine Root-Dynamic-Tools; keine produktive interaktive Toolfreigabe | andere Versionen werden blockiert; im Profil deaktivieren oder auf read-only/deny begrenzen |
| nativer Codex App Server | `experimental`, **exakt Codex `0.147.0`**, Adapter `0.1.0` | Windows, WSL, Linux, macOS | dieselben festen Offline-Overrides, runlokales `CODEX_HOME` mit höchstens `auth.json` und zusätzlich `SandboxPolicy.networkAccess:false`; Health/Isolation fail-closed | einzig unterstützter Pfad für workflow-, run- und fallgebundene Root-Dynamic-Tools und die zentrale Approvalkette | kein Featureflag; bedarfsabhängig bevorzugt, weicht auf Codex Exec aus, wenn ein Lauf den servereigenen Zero-Tools-Vertrag verlangt oder die Version nicht freigegeben ist; Health/Isolation weiterhin fail-closed |
| OpenCode | `supported`, **exakt `1.14.41`**, Adapter `1.1.0` | ausschließlich WSL mit Bubblewrap | read-only; temporäres HOME/XDG; Provider-Control-Plane bleibt für den Modellaufruf erreichbar | prompt-only; keine Root-Tools, keine interaktive Approval-, Pause- oder Resume-Brücke | andere Versionen/Runtimes werden blockiert; im Profil deaktivieren oder wieder exakt `1.14.41` bereitstellen |
| Claude Code | `supported`, **exakt `2.1.232 (Claude Code)`**, Adapter `1.1.0` | ausschließlich WSL mit Bubblewrap | read-only, Safe Mode, Permission Mode `plan`, Built-in `Read`; Provider-Control-Plane bleibt erreichbar | prompt-only; leerer MCP-Vertrag, keine Root-Tools, keine interaktive Approval-, Pause- oder Resume-Brücke | andere Versionen/Runtimes werden blockiert; im Profil deaktivieren oder wieder exakt `2.1.232` bereitstellen |

Bei OpenCode und Claude bedeutet die UI-Angabe `network: disabled`, dass modellaufrufbare Web-,
Shell-, Schreib-, MCP- und Subagent-Werkzeuge serverseitig entfernt sind. Bubblewrap stellt keine
vollständige Netzwerk-Namespace-Sperre des Providerprozesses her. Der native Codex App Server darf
Root-Dynamic-Tools erst nach explizitem Feature-Opt-in und nur entsprechend der vollständigen
serverseitigen Preflight-Allowlist erhalten.

## Feature- und Datenflussmatrix

| Bereich | Freigabestand | Verbindliche Grenze | Rollback/Deaktivierung |
|---|---|---|---|
| Agenten-Konfigurationsprofil | lokal produktiv verdrahtet: `GET/PUT /api/agents/config-profile`, atomarer CAS über `expectedUpdatedAt`, Last-known-good-Kopie | Angular zeigt Provider, Runtime, Sandbox, Offline-/Approvalmodus, Budget und Features; keine Secret-, Pfad-, Command- oder argv-Felder; CAS-Konflikte werden nicht automatisch wiederholt | bestätigter Reset auf Safe Default oder einzelne Provider/Features im CAS-Editor deaktivieren |
| Codex App Server | experimenteller Transport, bedarfsabhängige Auswahl ohne Flag | kein Opt-in mehr; Läufe mit Zero-Tools-Vertrag und nicht freigegebene Versionen gehen an Codex Exec | Auswahl folgt der Anforderung des Laufs; bereits laufende Prozesse bewusst abbrechen |
| Multi-Agent-Orchestrierung | lokale, suggestion-only Workflows; Safe Default `multiAgentExperimental=true` | servereigener Scope, Digests, Budgets, Gates und Child-Runs; keine automatische externe Aktion | Feature im Profil auf `false`; neue Orchestrierungen werden blockiert, bestehende bewusst abbrechen |
| Evidence-Pipeline | fünf getrennte Runs: Evidence → Author → ATS/Recruiter-Style → Finalizer | vor dem Finalizer nur das browserauflösbare Gate `user_input`; kein `review_complete`-Vor-Gate; abweichende Fan-in-Varianten benötigen eine revisions- und Variantendigest-gebundene Entscheidung | Orchestrierung revisionsgebunden abbrechen; kein teilweises Ergebnis als fachliche Revision behandeln |
| `package_proposal` | strikt typisiertes `application-pipeline-package`, weiterhin `proposed` | Reihenfolge: Artefakt-Review → bestätigte Adoption → erneute lokale Pipeline → fachliche Vorschlagsrevision → Revisionsreview → exakte Fallfreigabe → `used` oder Export | vor Adoption ablehnen; danach die Vorschlagsrevision nicht freigeben/verwenden/exportieren |
| Approval-Lifecycle | append-only und `fsync`-gesichert unter `.local-data/agent-approvals/` | Rohparameter, Akteursnamen und Bearer-Tokens werden nicht persistiert; Bindung, Parameter und Akteur nur als Hash; offene oder erteilte, nicht verbrauchte Freigaben werden nach Neustart widerrufen | Emergency Stop oder Prozessneustart widerruft Authority; Freigabe bei Bedarf neu anfordern |
| Job-Search-MCP | realer Adapter ausschließlich direkter `trusted-host`-stdio-Start, nativ oder WSL | niemals Agentenkind und niemals Codex-/OpenCode-/Claude-/Bubblewrap-/Container-/Netzwerksandbox; Agent erhält nur normalisierte untrusted Daten oder eine minimierte Root-Fassade | Portalzugriff separat deaktivieren oder Quelle auf Demo zurückstellen; nicht in eine Agentensandbox verschieben |
| Portalzugriff/StepStone | getrenntes, bestätigtes Server-Gate | `stdio` und valider Launch aktivieren kein Portalnetz; sichtbarer Login, Captcha und 2FA bleiben Nutzerinteraktion | `ALLOW_EXTERNAL_PORTALS` über die eigene bestätigte Portalaktion deaktivieren; Provider-/Agentenprofil ist davon unabhängig |
| Realtime und Rohlogs | SSE plus REST ist der produktive Browserpfad; WebSocket-/Rohlogflags sind reserviert beziehungsweise read-only in Angular | keine Browseraktivierung sensibler Rohlogs; normales Observability-Log bleibt allowlistet und hashbasiert | Flags aus lassen; SSE/REST weiterverwenden |
| Windows-Prozessressourcen | sampled Memory-/Kindprozessgrenzen über festen Toolhelp32-Helper | Root-PID ist servergebunden; kein WMI/CIM, Compiler oder Client-argv; bei Probe-Timeout `resource_probe_error` plus Prozessbaum-Cleanup statt stiller Degradierung | keine adversarial-harte Job-Object-Grenze für bereits vor dem Snapshot verwaiste Nachkommen/PID-Reuse; Provider auf dem betroffenen Host deaktivieren oder auf einen Host mit funktionierender Probe wechseln |
| Externe Bewerbung/Mail | nicht implementiert | kein Mailversand und kein Bewerbungssubmit; nur Vorschläge, lokale Zustände, Export und seiteneffektfreier Submission-Dry-Run | Vorschlag ablehnen oder nicht exportieren |
| Backup/Restore | Helper und Verträge vorhanden | vollständige lokale Datenwurzel und Schlüssel gemeinsam sichern; noch keine Angular-/allgemeine CLI-Betriebsstrecke | auf passenden Root-/Submodule-Stand und ein gemeinsam erstelltes Backup zurückrollen |

## Gebundene Submodule-Pins

Die folgenden Werte sind Gitlink-Commits des aktuellen Root-Index. Branchbezeichnungen sind
absichtlich nicht Teil des Vertrags; nur der Commit ist reproduzierbar.

| Submodule | Pfad | Gitlink-Pin | Root-Vertrag | Rollback |
|---|---|---|---|---|
| `bewerbungs-schreib-assistent` | `integrations/bewerbungs-schreib-assistent` | `3101c66f41654942f4538317c14872de6d62ac53` | Application Pipeline `1.x` über lokale CLI/Artefakte; Candidate Evidence bleibt autoritativ | Root-Commit mit vorherigem Gitlink auschecken; keine Dateien aus dem Submodule ins Root kopieren |
| `job-search-mcp` | `integrations/job-search-mcp` | `cee3e3c754b632e895f02a0f07cb9151e61597b1` | Job Search MCP `1.x` über direkten Trusted-Host-stdio-Vertrag | Root-Commit mit vorherigem Gitlink auschecken; privaten Launchvertrag danach erneut validieren |

Nach Checkout oder Rollback müssen beide Zeilen von `git submodule status --recursive` ohne
vorangestelltes `+`, `-` oder `U` erscheinen. Ein lokal anderer Submodule-HEAD ist keine
freigegebene automatische Aktualisierung.

## Fresh-checkout und Offline-Prüfung

Ein Git-Clone und das erstmalige Füllen von npm-, Python- und Browserpaket-Caches benötigen ohne
lokalen Mirror Netzwerk. „Offline“ bedeutet hier: Nach einem vollständigen Checkout mit exakt den
Gitlinks und bereits gefüllten Paket-Caches laufen Kernprüfung und synthetischer Pfad ohne
Providerkonto, Portalzugriff oder externe Anfrage. Ein Cache-Miss ist ein Bootstrapfehler und kein
Grund, die Prüfung unbemerkt online fortzusetzen.

Checkout über ein lokales Mirror-/Bundle-Setup oder einmalig mit Netzwerk:

```powershell
git clone --recurse-submodules <repository-url-or-local-mirror> job-match-and-apply
Set-Location job-match-and-apply
git submodule sync --recursive
git submodule update --init --recursive
git submodule status --recursive
```

Mit Node.js 22, Python 3.12 plus PyYAML, einem Chromium-kompatiblen Testbrowser und gefülltem
npm-Cache:

```powershell
$env:ALLOW_EXTERNAL_PORTALS='0'
$env$env:AGENT_REALTIME_WS='0'
npm.cmd ci --offline
npm.cmd --prefix server ci --offline
npm.cmd --prefix web ci --offline
npm.cmd test
npm.cmd run build
npm.cmd run security:scan
npm.cmd run diagnose
```

`npm.cmd run job-mcp:smoke` ist zusätzlich offline bezüglich Jobportalen: Es führt nur MCP-
Handshake, `tools/list` und `capabilities` aus. Es setzt aber einen zuvor eingerichteten, gültigen
privaten Launchvertrag und die Python-/Camoufox-Installation voraus. `setup:integrations` selbst ist
ohne vorbereiteten Python-/Browserpaket-Cache kein Offline-Bootstrap.

## Rollback-Reihenfolge

1. Neue Runs und Orchestrierungen stoppen; Portalzugriff separat deaktivieren.
2. Vor einem Datenrollback ein gemeinsames Offline-Backup von `.local-data/`, optional
   `.application-work/` und allen zugehörigen Schlüsseln erstellen.
3. Den gewünschten vorherigen Root-Commit auschecken und anschließend
   `git submodule sync --recursive` sowie `git submodule update --init --recursive` ausführen.
4. Abhängigkeiten aus dem zum Commit passenden Lockfile installieren und die Offline-Prüfung oben
   wiederholen.
5. Lokale Daten nur aus einem gemeinsam mit diesem Vertragsstand erzeugten Backup restaurieren.
   Unbekannte neuere Schema-Majors nicht durch einen alten Prozess überschreiben lassen.
6. Für einen reinen Feature-Rollback das Agentenprofil per CAS auf Safe Default setzen und danach
   Providererkennung sowie Preflight prüfen; das ersetzt keinen Datenrollback.

## Bekannte Grenzen

- Der Betrieb ist lokal und loopbackgebunden, nicht multi-tenant und nicht hochverfügbar.
- Der Codex App Server und seine Root-Dynamic-Tools bleiben experimentell und standardmäßig aus.
- OpenCode und Claude sind exakt versionsgebundene prompt-only Adapter; ihre Control-Plane benötigt
  Netzwerk und besitzt keinen getrennten Network Namespace.
- Offene Freigabe-Authority und aktive Orchestrierungs-Rohinputs werden nicht über Neustarts
  fortgesetzt. Runs/Orchestrierungen werden verwaist statt Prozesse oder Tokens zu adoptieren.
- Es gibt keine harte Mehrprozess-Exactly-once-Garantie und keine extern verankerte,
  manipulationssichere Audit-Chain.
- Der echte Portalpfad ist nicht offline: Er erfordert ein bewusstes Portal-Gate, sichtbaren Login
  und die Richtlinien des jeweiligen Portals.
- Agenten- und Triageergebnisse sind Vorschläge. Die Anwendung versendet weder Bewerbungen noch
  Mails automatisch.
- Backup-/Restore-Helper, Realtime-WebSocket und Rohlogprofile sind keine vollständig verdrahteten
  Angular-Betriebsstrecken.

Bei Vorfällen gilt das [Incident- und Datenschutz-Runbook](incident-privacy-runbook.md). Änderungen
an Providern, Dynamic Tools oder Workflows folgen
[Provider-, MCP-Tool- und Workflow-Entwicklung](adapter-workflow-development.md).
