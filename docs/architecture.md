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

## Datenschutzgrenzen

- `.local-data/` enthält Profile und lokale Konfiguration und wird nicht versioniert.
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
