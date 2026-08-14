# Incident- und Datenschutz-Runbook

Dieses Runbook gilt für den lokalen Einzelbenutzerbetrieb. Es ersetzt keine rechtliche Beratung,
sondern beschreibt die technischen Sofortmaßnahmen und Nachweise des Projekts. Keine Maßnahme
versendet Nachrichten, meldet Portalkonten an oder löscht Daten automatisch.

## Sofortmaßnahmen

1. In Angular den Agenten-Emergency-Stop aktivieren. Dadurch werden neue Runs und neue
   Seiteneffekte blockiert, offene Freigaben widerrufen und aktive Runs abgebrochen.
2. Den lokalen API-Prozess kontrolliert beenden. Prüfen, dass auf dem konfigurierten Loopback-Port
   kein Listener mehr existiert.
3. Bei einem möglichen Credential-Abfluss Portal- und Provider-Sitzungen außerhalb dieser
   Anwendung widerrufen. Credentials werden nicht über Angular angezeigt oder exportiert.
4. Vor Änderungen ein gemeinsames Offline-Backup von `.local-data/`, `.application-work/` und den
   zugehörigen Schlüsseldateien erzeugen. Backup und Schlüsselmaterial wie personenbezogene Daten
   behandeln.
5. `npm.cmd run security:scan` und `npm.cmd run diagnose` ausführen. Einen konkreten Canary kann
   man zusätzlich über `SECURITY_SCAN_CANARY` prüfen. Canarywerte und private Pfade gehören nicht
   in Tickets oder öffentliche Logs.

## Technische Eingrenzung

Die verantwortliche Schicht wird ohne Rohprompt über die Correlation-ID verfolgt:

- HTTP-Metadaten und lokale Auditereignisse;
- AgentRun, Provider- und Eventsequenz;
- rungebundene Root-MCP-Entscheidung und Approval-Lifecycle;
- Domaincommand, Artefaktrevision und ApplicationCase.

Das allowlistete Observability-Log darf weder Prompts noch komplette Mailtexte, Identitätswerte,
Tokens oder freie Fehlermeldungen enthalten. Für die Untersuchung werden deshalb nur Codes,
Zeitpunkte, gehashte IDs, Provider-/Adapterversionen und Sequenzen verwendet. Rohlogs sind im
Normalprofil deaktiviert.

## Datenschutzprüfung und Löschung

1. Mit der Dateninventar- und Exportfunktion feststellen, welche lokalen Bereiche betroffen sind.
2. Legal Holds für beweisrelevante Runs, Fälle oder Artefakte setzen, bevor eine Löschvorschau
   erzeugt wird.
3. Die Löschvorschau vollständig prüfen. Die Ausführung benötigt exakt deren Digest; ein
   veralteter Plan wird abgelehnt.
4. Verwendete Dokumentmetadaten und Provenance bleiben nachvollziehbar. Temporärer Rohinhalt darf
   nur nach den Retentionregeln entfernt werden.
5. Mail-Drop-Dateien, IMAP-Konten, Portal-State und private Profile separat berücksichtigen. Der
   Job-Search-MCP läuft als Trusted Host und besitzt eine eigene verschlüsselte Credential-Grenze.
6. Nach der bestätigten Kaskade erneut Security-Scan, Dateninventar und Diagnose ausführen und nur
   die redigierten Ergebnisse dokumentieren.

## Wiederanlauf

- Ein Restore beginnt immer mit einem schreibfreien Dry-run und vollständiger Hashprüfung.
- Unbekannte Major-Versionen, fehlendes Schlüsselmaterial, Symlinks oder Pfadabweichungen blockieren
  die Wiederherstellung.
- Der append-only persistierte Approval-Lifecycle enthält nur Lifecycle-Metadaten und Hashes für
  Bindung, Parameter und Akteur, nie Rohparameter, Akteursnamen oder Bearer-Tokens. Offene oder
  erteilte, noch nicht verbrauchte Approvals werden nach Neustart im Journal widerrufen; Authority
  und Tokens werden niemals restauriert.
- Unfertige AgentRuns und Orchestrierungen werden als verwaist markiert. Es gibt keine PID- oder
  Providersitzungs-Adoption; eine Fortsetzung startet einen neuen Prozess.
- Externe Portale bleiben bis zu einer bewussten erneuten Freigabe deaktiviert. Der Job-Search-MCP
  darf auch im Incidentbetrieb niemals in eine Agenten-Sandbox verschoben werden.

## Abschlusskriterien

Der Incident wird erst geschlossen, wenn Ursache, betroffener Datenumfang, verwendete Versionen,
Recovery-/Löschentscheidungen, erneute Gates und verbleibende Grenzen dokumentiert sind. Eine
pauschale Aussage „alles sicher“ ist unzulässig; Provider, Root-Tools, Mail, Jobquelle und
Bewerbungspipeline werden einzeln bewertet.
