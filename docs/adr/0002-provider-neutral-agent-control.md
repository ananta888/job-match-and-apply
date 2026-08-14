# ADR 0002: Providerneutrale lokale Agentensteuerung

Status: angenommen

## Kontext

Die Plattform soll Codex CLI, OpenCode, Claude CLI und weitere lokale Agenten über Angular
bedienbar machen. Direkte Terminaleinbettung würde Providerdetails, Berechtigungen und fachliche
Seiteneffekte vermischen. Ausgabeformate und interaktive Protokolle können sich unabhängig ändern.

## Entscheidung

Die Root-Anwendung besitzt einen versionierten `AgentRunnerPort`, ein kanonisches Eventmodell und
eine zentrale Policy Engine als Architekturbaustein. Provideradapter normalisieren strukturierte
Protokolle. Angular sieht weder Executables noch freie Argumente und sendet keine Shellbefehle.

Codex nutzt primär den stabil dokumentierten nichtinteraktiven JSONL-Modus. App-Server-Unterstützung
bleibt experimentell und optional. Weitere Provider müssen dasselbe Conformance-Testkit bestehen.

Domainzugriff soll über eine eingeschränkte MCP-/Command-Fassade erfolgen. Agenten dürfen
Vorschläge erzeugen; externe oder autoritative Änderungen verlangen serverseitige Validierung und
bei Bedarf eine einmalige kontextgebundene Nutzerfreigabe.

## Implementierungsstatus

Port, Eventmodell, CLI-Adapter, Run Store, REST/SSE und Angular-Oberfläche sind vorhanden. Eine
explizite serverseitige Factory setzt RunCapabilityAuthority, eingeschränkte Domain-Fassade,
Policy, einmalige Approvals, Audit und injizierte schmale Ports zu einer produktiv nutzbaren
rungebundenen MCP-Sitzung zusammen. Capability- und Approval-Tokens sind kein Clientvertrag. Der
direkte MCP-Start bleibt ohne injizierten Executor absichtlich auf Health und Katalog beschränkt.
Credential Broker und Orchestrierungs-DAG sind weiterhin nicht durchgängig im normalen Runpfad
zusammengesetzt. API und Angular unterstützen
die explizite Auswahl erkannter Windows- und WSL-Installationen einschließlich Distribution; nur
serverseitig als unterstützt validierte Installationen können gestartet werden. OpenCode und
Claude bleiben mangels freigegebener Versionsmuster blockiert. OpenCode und Claude besitzen im
WSL-Startpfad eine fail-closed Bubblewrap-Isolation, bleiben jedoch mangels Versionsfreigabe
weiterhin blockiert. Pause/Resume ist noch nicht implementiert. Die ADR beschreibt die weiterhin
gültige Zielentscheidung, nicht deren vollständige Fertigstellung.

## Folgen

- Neue Provider benötigen vor einer Freigabe Adapter, Capability-Fixture und Conformance-Bericht.
- Providerfunktionen können transparent degradieren, ohne das Domainmodell zu ändern.
- Run-Persistenz ist Teil von Retention und Recovery; persistente Approval-Recovery und die
  Verdrahtung des getesteten atomaren Backup-/Restore-Helpers in eine Betriebsoberfläche stehen
  noch aus. Die Recovery repariert bekannte
  Vorabversionsfälle für camelCase-`userPrompt` und Event-AAD-`failure`, ersetzt aber keine
  allgemeine Migrationsstrecke.
- Gleichzeitige identische Startrequests werden innerhalb eines Serverprozesses koalesziert. Ohne
  dauerhafte Unique-Constraint besteht über mehrere Prozesse keine Exactly-once-Garantie.
- Eine engere Root-Policy hat stets Vorrang vor Provideroptionen.
- Experimentelle Protokolle sind separat deaktivierbar; der App-Server-Pfad bleibt opt-in.
