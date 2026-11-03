# Career-Parität: GitLab-Referenz → Ubuntu

Verglichen wurde der lokal vorhandene GitLab-Stand 33c7019 einschließlich seiner Career-Patches. Ein erneuter GitLab-Fetch wurde wegen fehlender HTTPS-Anmeldung abgewiesen. Neuere Remote-Änderungen sind deshalb nicht ausgeschlossen.

## Belegte Ursache
Ein bestehender OpenRouter-Lauf erhielt 88.865 Prompt-Zeichen. Der Anbieter meldete 32.551 Eingabe- und 17.843 Ausgabetokens; das Evidence-Gesamtbudget betrug 8.000 Tokens. Der Lauf endete tatsächlich mit budget_exceeded:tokens. Vorstufen verwendeten Anbieterstandard-Reasoning; die HTTP-Anfrage begrenzte die Ausgabe nicht.

## Korrektur
- Kompakte Evidence-Darstellung aus der GitLab-Referenz übernommen. Claim-IDs, Aussagen und Quellen bleiben erhalten. Abweichend von der alten Referenz bleiben individuelle Sicherheitskennzeichnungen bei gemischten Claim-Status/Outputrechten vollständig sowie Datensatzstatus erhalten.
- Am bestehenden Prompt nur im Speicher gemessen: Evidence 82.638 → 41.454 Zeichen, gesamter Prompt 88.865 → 47.681 Zeichen (46,3 % weniger). Keine personenbezogenen Inhalte gespeichert, keine Modellanfrage ausgelöst. Zeichenersparnis ist kein Laufzeitbenchmark.
- OpenRouter-Routing throughput und Temperatur 0,2 übernommen.
- Standard für neue OpenRouter-Ketten: Evidence/Author/ATS/Style Reasoning off, Finalizer high. Optionales Provider-Reasoning und Modell/Reasoning je Rolle werden serverseitig validiert, im Lauf und Wiederholungscheckpoint eingefroren. Angular bietet diese Rollenoptionen in der Providerkonfiguration.
- Die tatsächlichen freigegebenen Claim-/Quellen-IDs werden an die HTTP-Ausgabeprüfung gereicht.
- HTTP-Antwortlimit pro Rolle 6–12k Tokens, verbleibendes Antwortbudget über Korrekturen, Stop bei abgeschnittener Antwort; tatsächlicher Gesamtzeitrahmen über alle Korrekturanfragen.
- Die Orchestrierungsbudgets zählen Eingabe plus Ausgabe: 64k Eingabe-/Korrekturreserve pro Rolle, insgesamt 400k. Bestehende Geld-/Zeitlimits unverändert; Verbrauch bleibt tatsächliche Anbieterangabe.
- Zwei parallele OpenRouter-Rollen möglich; CLI-Standard weiterhin ein Lauf pro Provider.

Bestehende fehlgeschlagene Läufe werden nicht umgeschrieben. Für die kompakten Eingaben ist ein neuer Lauf erforderlich. Ein Retry alter Checkpoints verwendet deren alte Daten und Einstellungen.

## Prüfgrenzen
Tests mit synthetischen Daten und injiziertem HTTP-Transport belegen Ablauf, Verträge und Konfiguration. Ein erfolgreicher echter Fünf-Agenten-Lauf oder eine Geschwindigkeitsmessung am Modell wird damit nicht behauptet. Die lokale Ubuntu-Instanz ist vom React-Lab unter mcp.skillsprinters.de getrennt.

## Verifikation
795 Backend-Tests bestanden, zwei bestehende Tests übersprungen; 75 Angular-Tests bestanden. Repository-Skripttests bestanden. Server- und Angular-Build erfolgreich; die bestehende Bundle-Warnung bleibt (914 kB gegenüber 500-kB-Warnbudget). Sicherheitsprüfung und Git-Diff-Prüfung bestanden. Unabhängiges Review: drei Befunde behoben (Retry-Eingaben, erlaubter editorial-Marker, Antwortreserve bei fehlender Usage), keine weiteren wichtigen Befunde.
