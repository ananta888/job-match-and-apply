# Architektur

```text
Angular UI
   │ HTTP /api
   ▼
Lokale Express API
   ├── SearchProfile + Identity + Matching (eigener Domain-Kern)
   ├── JobSourcePort
   │    ├── DemoJobSourceAdapter
   │    └── McpJobSourceAdapter ──stdio──> integrations/job-search-mcp (Submodule)
   └── ApplicationAssistantPort
        └── LocalApplicationAssistantAdapter ──> integrations/bewerbungs-schreib-assistent (Submodule)
```

Die Angular-App kennt weder Portal-Credentials noch Browserzustände. Sie spricht ausschließlich
mit der lokalen API auf `127.0.0.1`. Der MCP-Adapter startet den Upstream-Prozess über stdio und
ruft dessen öffentliche Werkzeuge `browser_status`, `mehrportal_suche` und `portal_login` auf.
Dieser Portalprozess ist eine eigene `trusted-host`-Grenze und läuft ausdrücklich außerhalb der
Agenten-Sandbox; bekannte Sandbox-/Containerwrapper und Shell-Umwege werden im Startvertrag
abgelehnt. OpenCode-/Claude-/Codex-Sandboxprofile gelten ausschließlich für deren Agentenprozesse.
Enthält eine von einem sandboxed Provider geladene Projektkonfiguration dennoch einen
`job-search-mcp`-Start oder eine agentverwaltete MCP-/Plugin-Deklaration, blockiert die
Providergrenze den gesamten Agentenlauf vor dem Spawn. Codex Exec ignoriert zusätzlich die
Benutzerkonfiguration; der experimentelle App Server bleibt bis zu einer gleichwertigen Isolation
im Exec-Fallback.

## Bewerbungs-CRM und Maileingang

Das CRM gruppiert Bewerbungsfälle über einen normalisierten Firmenschlüssel, hält Stellen und
Historien aber getrennt. IMAP, EML und der lokale SMTP-Drop liefern dasselbe Nachrichtenmodell.
Eine regelbasierte Korrelation bleibt ein Vorschlag; bei Unsicherheit stellt erst die ausdrückliche
Nutzerbestätigung die Zuordnung her. Nachrichten und Mailzugänge liegen AES-256-GCM-verschlüsselt
im lokalen Mail-Vault.

Dokumentinhalte werden nicht vom CRM erfunden. Der Bewerbungs-Assistent erzeugt faktenkonservative
Vorschläge; das Root-Projekt speichert Hash, Pipelineversion, Firma, Stelle und Lifecycle. Eine als
`used` markierte Revision ist unveränderlich. Inkognito-Revisionen können nie `used` sein.

Weitere erlaubte Antwortquellen (etwa Portal-Inbox oder Kalender-API) implementieren
`EmployerResponseSourcePort`. Dieser Port normalisiert ausschließlich eingehende Ereignisse und
besitzt absichtlich keine Versandmethode; Korrelation, Nutzerbestätigung und Firmenansicht bleiben
dadurch unabhängig von der konkreten Quelle.

## Datenschutzgrenzen

- `.local-data/` enthält Profile und lokale Konfiguration und wird nicht versioniert. Identitäten
  werden in `config.json` mit AES-256-GCM verschlüsselt; der separat erzeugte lokale Schlüssel
  bleibt ebenfalls außerhalb von Git. Wer Zugriff auf beide Dateien und das Benutzerkonto hat,
  kann die Daten entschlüsseln; ein OS-Keyring bleibt die bevorzugte spätere Härtung.
- Der Upstream-MCP speichert Credentials verschlüsselt in seinem eigenen State-Verzeichnis.
- Inkognito-Profile verwenden reservierte `.invalid`-E-Mail-Adressen und auffällige Platzhalter.
- Eine Scheinidentität ersetzt Kontaktdaten, aber niemals Qualifikationen oder berufliche Fakten.
- LinkedIn ist als Profil-/Export-Adapter modelliert; unerlaubtes Crawling ist nicht implementiert.

## Neue Quelle ergänzen

Eine Quelle implementiert `JobSourcePort` in `server/src/ports/job-source.ts`. Sie liefert das
kanonische `JobPosting`-Modell. Matching und UI ändern sich dadurch nicht. Für produktive Quellen
sollten ein Contract-Test, dokumentierte Nutzungsbedingungen und ein explizites Zugriffs-Gate
ergänzt werden.

Die Verantwortungsgrenzen zwischen Entwicklungs-Todos, Skills, MCP und Review-Agenten beschreibt
[application-agent-system.md](application-agent-system.md).

## Daten- und Kontrollfluss

Jobs bleiben Quellendaten: Normalisierung, Deduplizierung und der lokale Suchpraeferenz-Score
veraendern keine Kandidatenclaims. Erst die Bewerbungspipeline verknuepft explizite
Stellenanforderungen mit freigegebenen Claim-IDs. Eine Nicht-Gap-Zuordnung ohne Evidence ist
unzulassig. Inkognito ist auf Vorschau und Tests beschraenkt; Paketfreigabe, Export und Uebergabe
verlangen eine reale Identitaet.

Persistente Arbeitszustaende liegen atomar und versioniert unter `.local-data/`. Temporaere
Import- und Exportartefakte liegen unter `.application-work/` und werden nicht versioniert.
Externe Seiteneffekte sind im aktuellen Submission-Adapter technisch deaktiviert; er erzeugt nur
einen idempotenten Dry-Run-Plan.

## Recovery und Migration

Unbekannte Schema-Major-Versionen werden mit einem verstaendlichen Fehler abgelehnt. Vor einem
Upgrade werden `.local-data/config.json`, `.local-data/config.key` und
`.local-data/workspace.json` gemeinsam gesichert. Ohne Schluessel koennen Identitaeten nicht
entschluesselt werden. Weitere Betriebsablaeufe stehen in [operations.md](operations.md).
