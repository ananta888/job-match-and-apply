# Architektur

```text
Angular UI
   │ HTTP/SSE auf Loopback
   ▼
Lokale Express API
   ├── SearchProfile + Identity + Matching
   ├── Bewerbungs-CRM + Mail-Vault
   ├── Agent Control Center
   │    ├── Run-/Event-/Artifact-Stores
   │    ├── Root-Domain-Tool-Factory
   │    └── Multi-Agent-Orchestrator
   ├── JobSourcePort
   │    ├── DemoJobSourceAdapter
   │    └── McpJobSourceAdapter ──stdio/trusted-host──> job-search-mcp
   └── ApplicationAssistantPort
        └── LocalApplicationAssistantAdapter ──CLI/Artefakte──> bewerbungs-schreib-assistent
```

Beide Upstreams bleiben unabhängig versionierte Git-Submodules. Das Root-Projekt importiert keine
internen Pythonmodelle, sondern verwendet schmale Ports und versionierte CLI-/MCP-Verträge.

## Portal- und Agentengrenze

Die Angular-App kennt weder Portal-Credentials noch Browserzustände. Sie spricht ausschließlich
mit der lokalen API auf `127.0.0.1`. Der Root-MCP-Adapter startet `job-search-mcp` direkt über
stdio und ruft dessen öffentliche Status-, Such- und Login-Werkzeuge auf.

Dieser Portalprozess ist eine eigene `trusted-host`-Grenze und läuft ausdrücklich außerhalb jeder
Agenten-, Bubblewrap-, Container- und Netzwerk-Sandbox. Der private Launchvertrag erlaubt nur den
kanonischen nativen Venv-Start oder den wrapperfreien WSL-Aufruf. Shell-, Sandbox- und
Containerwrapper werden abgelehnt. Ein gültiger privater Launch aktiviert bei frischer
Konfiguration den effektiven `stdio`-Modus; `ALLOW_EXTERNAL_PORTALS` bleibt trotzdem `0`, bis der
Nutzer den separaten Portalzugriff bestätigt.

Vor jedem Agentenstart werden Projektkonfigurationen auf `job-search-mcp` sowie agentverwaltete
MCP-/Plugin-Deklarationen geprüft. Ein Treffer blockiert den Run, damit der Portalprozess nie zum
Kind eines Agenten wird. Codex Exec `0.147.0` verwendet feste servereigene Argumente mit
`--ignore-user-config --strict-config`, `web_search="disabled"` und
`sandbox_workspace_write.network_access=false`. Der opt-in Codex App Server verwendet dieselben
Overrides, erhält ein runlokales `CODEX_HOME` mit höchstens `auth.json` und setzt für read-only und
Workspace-Write zusätzlich `SandboxPolicy.networkAccess:false`. Ein Offline-Health- oder
Root-Tool-Fehler ist fail-closed.

OpenCode `1.14.41` und Claude Code `2.1.232` laufen ausschließlich in WSL/Bubblewrap read-only.
Bubblewrap isoliert Dateisystem, PID, IPC und UTS und bindet nur die jeweilige Authdatei read-only
in ein temporäres HOME. Die Provider-Control-Plane bleibt für den Modellaufruf erreichbar; die
servereigene Providerpolicy entfernt dagegen modellaufrufbare Shell-, Schreib-, Web-, MCP- und
Subagent-Werkzeuge. Das ist eine Capability- und keine vollständige Prozess-Netzwerkgrenze.

## Agenten- und Domainfluss

Normale Runs erhalten serverseitig zusammengesetzten Fachkontext. Der native Codex App Server kann
zusätzlich eine workflowabhängige Auswahl der Root-Domain-Tools als Dynamic Tools erhalten.
Capability, Toolscope und erlaubte ApplicationCase-IDs sind intern an den Run gebunden; der Client
erhält weder Capability- noch Approval-Token. OpenCode, Claude, Fake und der stabile Codex-Exec-
Transport arbeiten ohne diese Root-Tool-Brücke mit begrenztem Promptkontext.

Der Root-Katalog enthält nur minimierte Reads, Analysen, Vorschläge und bestätigte lokale
Domaincommands. Portal-Login, Mailversand, Bewerbungssubmission, freie Shell-/Dateioperationen und
beliebiger Netzwerkzugriff sind ausgeschlossen. Bei `guided-job-analysis` führt der Root-Server
die Trusted-Host-Suche vor dem Agentenstart aus und übergibt nur normalisierte Treffer mit
SourceReferences.

## Bewerbungsorchestrierung und Evidence

Der Workflow `evidence-application-package` führt fünf getrennte Node-Runs aus:

```text
Evidence → Author → ┬→ ATS ─────────────┐
                    └→ Recruiter/Style ─┴→ Finalizer
```

Jede Rolle erhält nur ihre deklarierten Rohinputs und rollenspezifischen Kriterien. Der Server
bindet Input-Digests, Abhängigkeiten, Budget, Retryregeln, ApplicationCase-Revision und
Identitätsmodus. Das Evidence-Gate akzeptiert nur `verified` oder `user_confirmed` Claims mit
Evidence-Referenzen. Abweichende ATS-/Style-Varianten müssen vor dem Fan-in über den gebundenen
Konfliktvertrag aufgelöst sein. Das einzige browserauflösbare Gate vor dem Finalizer ist im
aktuellen Workflow die bewusste Bestätigung `user_input`; ein `review_complete`-Gate vor seinem
Lauf existiert nicht.

Das Finalizer-Ergebnis ist ein geschlossenes `application-pipeline-package` mit annotiertem Inhalt
und Iterationsmanifest. Es bleibt als `package_proposal` ein Vorschlag. Erst menschliches
Artefakt-Review und die bestätigte Adopt-Aktion dürfen es über den servereigenen Port erneut durch
die lokale Evidence-, Stil- und Sprachpipeline führen und eine neue fachliche Dokumentrevision
erzeugen. Diese Revision durchläuft danach ihr eigenes Review, die exakte Fallfreigabe sowie
`used` beziehungsweise Export.

## Dokumentrevisionen und Freigabe

Agentenartefakte sind content-addressed und speichern serverseitige Provenance zu Run, Provider,
Adapter, Template, Workflow, Fallrevision, Job, Firma und Identitätsmodus. Eine fachliche
Dokumentrevision besitzt zusätzlich einen signierten Pipeline-Nachweis über Profil-, Stil-,
Iterations-, Claim- und Sprachprüfung.

Die Freigabekette bindet jede Stufe an exakte Bytes:

1. Menschliches Review bestätigt Revisions-ID, vollständigen SHA-256 und Zahl der Sprachhinweise.
2. Der Bewerbungsfall wird nur mit derselben Revisions-ID und demselben SHA-256 genehmigt.
3. `used`, Package, Submission-Dry-Run und Export prüfen erneut Fall, Job, Identität,
   Pipeline-Nachweis, Revision und Hash.

Es gibt REST-Aktionen für Review, Adoption, fachliches `use` und Export, aber keinen freien
Lifecycle-Schalter. Inkognito-Revisionen dürfen Review/Vorschau erreichen, jedoch nicht
Fallgenehmigung, Adoption als reale Revision, `used` oder Export.

## Bewerbungs-CRM und Maileingang

Das CRM gruppiert Bewerbungsfälle über einen normalisierten Firmenschlüssel, hält Stellen und
Historien aber getrennt. IMAP, EML und der lokale SMTP-Drop liefern dasselbe Nachrichtenmodell.
Eine regelbasierte Korrelation bleibt ein Vorschlag; bei Unsicherheit stellt erst die ausdrückliche
Nutzerbestätigung die Zuordnung her. Nachrichten und Mailzugänge liegen AES-256-GCM-verschlüsselt
im lokalen Mail-Vault.

Weitere erlaubte Antwortquellen implementieren `EmployerResponseSourcePort`. Dieser Port
normalisiert ausschließlich eingehende Ereignisse und besitzt keine Versandmethode. Korrelation,
Nutzerbestätigung und Firmenansicht bleiben dadurch von der Quelle unabhängig.

## Profile und Datenschutzgrenzen

- `.local-data/` enthält lokale Konfiguration, Kandidaten-/Stilprofile, Runs und private Stores und
  wird nicht versioniert. Identitäten in `config.json` sind AES-256-GCM-verschlüsselt; der lokale
  Schlüssel bleibt ebenfalls außerhalb von Git. Ein OS-Keyring ist noch nicht integriert.
- Das Profil-Onboarding kopiert nur leere Beispiele des Bewerbungs-Submodules und überschreibt
  keine vorhandenen Dateien. Kandidatenfakten müssen vom Nutzer belegt und freigegeben werden.
- Stilprofiländerungen verwenden Revision plus SHA-256 als Compare-and-swap und werden vor
  atomarer Veröffentlichung durch den Submodule-Validator geprüft.
- Die Sprachprüfung verwendet standardmäßig lokale `nspell`-Wörterbücher für Deutsch und Englisch.
  LanguageTool und Hunspell sind optionale lokale Backends; ein entfernter Dienst wird nicht
  automatisch verwendet.
- Der Upstream-MCP speichert Portal-Credentials in seinem eigenen privaten State-Verzeichnis.
- Inkognito-Profile verwenden `.invalid`-E-Mail-Adressen und auffällige Platzhalter. Eine
  Scheinidentität ersetzt Kontaktdaten, niemals Qualifikationen oder berufliche Fakten.
- LinkedIn ist als Profil-/Export-Adapter modelliert; unerlaubtes Crawling ist nicht implementiert.

## Persistenz, Retention und Recovery

Persistente Zustände liegen versioniert unter `.local-data/`; Bewerbungsarbeitsartefakte unter der
ignorierten `.application-work/`. Run-Events sind append-only, Snapshots atomar und klassifizierte
Felder verschlüsselt. Ein payloadfreies Idempotenzregister speichert nur Hashes und opake
Ergebnisverweise. Das lokale Observability-Log besitzt eine feste Feldallowlist und hasht Run- und
Korrelations-IDs.

Agenten-Retention erstellt vor der Löschung einen digestgebundenen Kaskadenplan. Legal Holds auf
Run, Artefakt oder Bewerbungsfall schützen referenzierte Daten. Bei verwendeten Artefakten kann
Rohinhalt entfernt werden, während Provenance-Metadaten erhalten bleiben. Retention- und
Exportaktionen werden append-only und `fsync`-gesichert protokolliert; das lokale Journal ist
keine extern signierte Audit-Chain.

Der Approval-Lifecycle besitzt zusätzlich ein append-only, `fsync`-gesichertes JSONL-Journal.
Rohparameter, Akteure und Bearer-Tokens werden nicht persistiert; Bindung, Parameter und Akteur
stehen nur als Hash neben Lifecycle-Metadaten. Beim Neustart werden persistierte Zustände gelesen,
aber offene oder erteilte, noch nicht verbrauchte Authority wird nicht restauriert: Der Server
schreibt stattdessen einen Widerruf und verlangt eine neue Freigabe.

Nach einem Serverneustart rekonstruiert der Run Store fehlende beziehungsweise beschädigte
Snapshots aus dem Eventlog und markiert aktive Runs als `orphaned`. Prozesse werden nicht
automatisch adoptiert. Aktive Multi-Agent-Orchestrierungen können nach einem Neustart nicht aus
ihren prozesslokalen Rohinputs fortgesetzt werden.

Das secret-freie Agenten-Konfigurationsprofil liegt mit Last-known-good-Kopie unter `.local-data/`.
Der Angular-Editor schreibt es bestätigt per Compare-and-swap gegen `updatedAt`, erneuert danach
Providererkennung und Preflight und bietet weder Pfade noch Commands, argv oder Secretfelder an.
Der Codex App Server bleibt darin standardmäßig deaktiviert und erfordert ein gesondertes Opt-in.

## Neue Quelle ergänzen

Eine Quelle implementiert `JobSourcePort` in `server/src/ports/job-source.ts` und liefert das
kanonische `JobPosting`-Modell. Matching und UI bleiben davon unabhängig. Produktive Quellen
benötigen Contract-Test, dokumentierte Nutzungsbedingungen und ein explizites Zugriffs-Gate.

Die Verantwortungsgrenzen zwischen Entwicklungs-Todos, Skills, MCP und Review-Agenten beschreibt
[application-agent-system.md](application-agent-system.md). Betriebsabläufe stehen in
[operations.md](operations.md).
