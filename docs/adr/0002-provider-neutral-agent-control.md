# ADR 0002: Providerneutrale lokale Agentensteuerung

- Status: angenommen und implementiert
- Datum: 2026-08-14

## Kontext

Die Plattform soll Codex CLI, OpenCode und Claude Code über Angular bedienen, ohne
Providerdetails, Berechtigungen, Portalzugriff und autoritative Fachänderungen zu vermischen.
Providerprotokolle, Versionen und interaktive Fähigkeiten ändern sich unabhängig voneinander.

## Entscheidung

Die Root-Anwendung besitzt einen versionierten `AgentRunnerPort`, ein kanonisches Eventmodell,
serverseitige Provider-Manifeste und eine zentrale Policy Engine. Angular sieht weder Executables
noch freie argv oder Environmentwerte. Provideradapter normalisieren ausschließlich strukturierte
Protokolle; unbekannte Versionen werden fail-closed blockiert.

Codex Exec bleibt der stabile JSONL-Transport. Der Codex App Server ist ein experimenteller,
server-owned Opt-in über `CODEX_APP_SERVER_EXPERIMENTAL=1` oder das bestätigte persistente
Agentenprofil. Er läuft stdio-only mit temporärem
`CODEX_HOME`, `SandboxPolicy.networkAccess:false` und kann rungebundene Root-Domain-Tools als
Dynamic Tools erhalten. Ein fehlgeschlagener Offline- oder Tool-Healthcheck darf nicht auf einen
schwächeren Transport zurückfallen.

OpenCode `1.14.41` und Claude Code `2.1.232` sind ausschließlich read-only in WSL/Bubblewrap
freigegeben. Bubblewrap schützt Dateisystem und Prozessgrenzen; die Provider-Control-Plane bleibt
für den Modellaufruf erreichbar. Modellaufrufbare Shell-, Schreib-, Web-, MCP- und
Subagent-Fähigkeiten werden durch exakte servereigene Providerpolicies entfernt. Diese beiden
Adapter besitzen keine Root-Tool- oder interaktive Approval-Brücke.

Fachzugriff erfolgt über eine eingeschränkte, rungebundene Domain-Fassade. Eine interne Capability
bindet Provider, Run, Tool und ApplicationCases. Vorschläge dürfen keine externe oder autoritative
Änderung behaupten; lokale Domaincommands erfordern serverseitige Validierung, Revision,
Idempotenz und gegebenenfalls eine einmalige kontextgebundene Nutzerfreigabe. Der direkte
`agent:mcp`-Start bleibt ohne injizierte Ports auf Health und Katalog beschränkt.

Der Job-Search-MCP ist keine Agentenfähigkeit. Er läuft separat als direkter Trusted-Host-stdio-
Prozess, niemals in einer Agentensandbox. Bei geführter Jobsuche startet der Root-Server ihn vor
dem Agenten und übergibt nur normalisierte Daten.

Die Bewerbungsfachlichkeit wird als versionierte Fünf-Node-Orchestrierung umgesetzt: Evidence,
Author, ATS, Recruiter/Style und Finalizer laufen in getrennten Child-Runs. Servereigene Evidence-
und Konfliktgates sowie das bewusste `user_input`-Vor-Gate trennen den Finalizerlauf von seiner
nachgelagerten fachlichen Prüfung. Die erzeugte `package_proposal` durchläuft danach
Artefakt-Review, Adoption, Pipeline-Revision, exakte Fallfreigabe, `used` und Export; ein
`review_complete`-Vor-Gate des Finalizers existiert im aktuellen Workflow nicht.

## Folgen

- Neue Provider oder Versionen benötigen Manifest, secret-freie Fixture, Mapper-Replay,
  argv-/Promptprüfung, Sandbox-/Netzwerknachweis, Canary-, Cancel-, Limit- und Recovery-Tests.
- Featureflags sind server-owned. Ein Config-Profil darf Sandbox- oder Approval-Defaults nicht
  stillschweigend verbreitern.
- Run-, Event-, Artefakt-, Orchestrierungs-, Idempotenz-, Retention- und Observability-Daten liegen
  lokal; sensible Inhalte gehören nicht in Git oder normale Supportausgaben.
- Der Approval-Lifecycle wird append-only und hashbasiert persistiert, ohne Rohparameter,
  Akteursnamen oder Bearer-Tokens. Offene oder erteilte, noch nicht verbrauchte Freigaben sind
  nicht restartfähig: Ein Neustart protokolliert ihren Widerruf. Aktive Orchestrierungs-Rohinputs
  sind ebenfalls nicht restartfähig; ein Neustart orphaned aktive Runs beziehungsweise
  Orchestrierungen, statt Prozesse zu adoptieren.
- Das persistente Idempotenzregister ermöglicht Neustart-Replay eines abgeschlossenen Runs, aber
  keine harte Exactly-once-Garantie über mehrere Serverprozesse.
- Retention respektiert Legal Holds und erhält bei verwendeten Artefakten Provenance-Metadaten.
  Das lokale Journal ist nicht extern signiert.
- Pause ist für die produktiven Providerverträge nicht verfügbar; Cancel bleibt der sichere
  Abbruchpfad.
