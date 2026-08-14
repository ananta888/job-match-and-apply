# Threat Model: Agent Control Center

## Schutzgüter

- reale Identität, Kandidatenprofil, Claims und Bewerbungsdokumente
- Mailkonten, Mailinhalte, Portal-Sessions und Provider-Authentifizierung
- Workspace-Dateien, Submodule und lokale Git-Historie
- autoritative Bewerbungs-, Firmen-, Nachrichten- und Dokumentzustände
- Approval-Tokens, Run-Vault-Schlüssel und Audit-Historie

## Vertrauensgrenzen

Angular, Stellenanzeigen, E-Mails, importierte Dokumente und Agentenausgaben sind nicht
vertrauenswürdig. Die Express-API validiert jede Eingabe. Providerprozesse bleiben auch innerhalb
einer angeforderten Sandbox nicht vertrauenswürdig. Codex erzwingt sein Sandboxargument;
OpenCode und Claude werden im WSL-Pfad zusätzlich fail-closed über Bubblewrap mit getrenntem
Netzwerknamespace und nur bei Bedarf schreibbarem Workspace gestartet. Beide bleiben unabhängig
davon wegen fehlender Versionsfreigabe blockiert. Eine gleichwertige Isolation für alle optionalen
Runtimeziele ist nicht nachgewiesen. Portal- und
Bewerbungs-Submodule bleiben selbstständige Policy-Grenzen. Insbesondere läuft der Job-Search-MCP
als explizit vertrauenswürdiger direkter Host-/WSL-stdio-Prozess und nicht in der Agenten-
Bubblewrap-/Container-/Netzwerksandbox; Wrapper- und Shell-Umwege werden abgelehnt.
Vor jedem Providerstart werden die wirksamen Projektkonfigurationen für Codex, OpenCode, Claude
und MCP gelesen. Verweist eine davon auf `job-search-mcp`, wird der Agentenlauf vor dem Spawn mit
`trusted_host_job_mcp_must_not_run_in_agent_sandbox` blockiert. Der Portal-MCP muss in diesem Fall
separat über den Root-Adapter als `trusted-host` laufen. Beliebige projektverwaltete MCP-/Plugin-
Deklarationen werden ebenfalls abgelehnt. `codex exec` startet ab der exakt freigegebenen Version
0.147 zusätzlich mit `--ignore-user-config`; der experimentelle App Server fällt auf Exec zurück,
solange er Userkonfiguration nicht gleichwertig ignorieren kann. Bubblewrap-Prozesse erhalten ein
leeres temporäres HOME/XDG-Konfigurationsverzeichnis.

Betriebssystem und das lokale
Benutzerkonto bilden die äußerste Grenze; wer
gleichzeitig Daten und lokale Schlüssel lesen kann, kann lokale Inhalte entschlüsseln.

## Wesentliche Bedrohungen, Kontrollen und Lücken

| Bedrohung | Derzeitige Kontrolle | Restlücke |
|---|---|---|
| Shell-/Argument-Injection | feste eingebaute Provider, Argumentarrays und `shell: false`; Browser kann weder Executables, MCP-/Pipelinepfade, Startargumente noch Environment setzen | OpenCode-/Claude-Prompts stehen als einzelnes Argument in der lokalen Prozessliste |
| Pfadausbruch | kanonische Rootprüfung und separate getestete WorkspaceRegistry mit Symlink-/Junction-Fällen | die detaillierte Registry ist noch nicht der produktive Adapterpfad |
| Indirekte Prompt Injection | Herkunftslabels, getrennte Instruktions-/Datenblöcke und erneute serverseitige Policy-/Capability-Prüfung jedes rungebundenen MCP-Aufrufs | untrusted Inhalte müssen weiterhin auch in jedem injizierten Port als Daten behandelt werden |
| Credential-Exfiltration | minimales Kindprozess-Environment, getestete Broker-/Redaction-Bausteine sowie Signatur-/Canary-Scan für getrackte und untracked Quellen und ignorierte Laufzeitdaten | Broker und SecretRedactor sind nicht an alle produktiven Event-/Toolgrenzen verdrahtet; der Scan ist signaturbasiert und kein Vollständigkeitsnachweis |
| Confused Deputy | die serverseitige Factory bindet den Executor an eine intern ausgegebene, ablaufende und widerrufbare Run-/Provider-/Tool-/Case-Capability | die Factory muss vom Host mit den korrekten schmalen Ports erzeugt werden; der direkte CLI-MCP bleibt deshalb toolfrei |
| Approval Replay oder Client-Bypass | HMAC-Queue mit Ablauf, Parameterhash, Nonce und einmaligem Verbrauch; MCP-Clients können weder Capability- noch Approval-Token übergeben | Approval-Recovery über einen Serverneustart ist nicht persistent |
| Unkontrollierter Netzwerkzugriff | REST lehnt `network: true` ab; Codex nutzt seine CLI-Sandbox und der WSL-Pfad für OpenCode/Claude erzwingt Bubblewrap `unshare-net` | OpenCode/Claude bleiben ungetestet blockiert; andere optionale Runtimeziele besitzen keine gleichwertig belegte Sperre |
| Vermischung von Portal- und Agentensandbox | `job-search-mcp` ist ausdrücklich `trusted-host` und startet direkt nativ oder über WSL-stdio; jeder Providerpfad prüft Projektkonfiguration vor Spawn, Codex Exec ignoriert Userconfig, Bubblewrap erhält ein leeres Config-HOME | Gleichzeitige Änderungen nach der Prüfung bleiben eine lokale Host-Trust-Grenze; der experimentelle App Server bleibt deshalb im produktiven Pfad im Exec-Fallback |
| Unkontrollierte externe Aktion | der rungebundene Katalog exponiert keine Versand-/Submit-/Portal-/Shell-/Netzwerktools; Execute ist auf bestätigte lokale Domaincommands begrenzt | fehlerhafte Implementierungen injizierter Domainports bleiben eine serverseitige Trust Boundary |
| Prozessflucht oder Ressourcenerschöpfung | Prozessbaum-Cancel, Wall-/Idle-/Output- und Parallelitätslimits; nach Outputlimit werden keine weiteren Chunks an Callbacks weitergereicht; optionale Memory-/Kindprozessprobes; WSL-OpenCode/-Claude werden per Bubblewrap isoliert | Resource-Probe ist im produktiven Composition Root noch nicht konfiguriert; Isolation ist nicht für alle Runtimeziele gleichwertig belegt |
| Doppelte Runstarts | persistierte Idempotency-Suche und atomare Promise-Koaleszierung gleichzeitig eintreffender gleicher Requests innerhalb eines Express-Prozesses | keine dauerhafte Unique-Constraint und keine prozessübergreifende Exactly-once-Garantie |
| Manipulierte Runhistorie | append-only Sequenz, atomare Snapshots und AES-GCM für klassifizierte Felder; Recovery repariert bekannte Vorabversionsfälle für camelCase-`userPrompt` und Event-AAD-`failure` | kein Hash-Chain-Nachweis, keine allgemeine Migrationsstrecke und keine vollständige Restore-Abnahme |
| Cross-Case-Datenleck | Context Builder und MCP-Capability begrenzen auf explizite ApplicationCases; fremde IDs werden vor einem Portaufruf abgelehnt; sensitive Reads bleiben maskiert | Portimplementierungen müssen minimierte Ergebnisse und korrekte SourceReferences liefern |
| Manipuliertes Agentenartefakt oder Review-Replay | SHA-256 wird bei jedem Lesen geprüft; Pfade bleiben relative Metadaten; Zugriff ist rungebunden; Approve/Reject prüfen Lifecycle und erwartete Revision | lokale Prozesse mit Zugriff auf Daten und Schlüssel bleiben außerhalb der App-Grenze vertrauenswürdig |
| Ungeprüfte Übernahme oder Inkognito-Commit | kein generischer `used`-Endpunkt; ausschließlich ein injizierter idempotenter Fachport darf ein freigegebenes Artefakt mit passender Case-/Job-/Firmen-Provenance übernehmen; Inkognito wird vorher blockiert | Korrektheit und Atomizität der fachlichen Portimplementierung bleiben eine serverseitige Trust Boundary |
| Halluzinierte Kandidatenfakten | bestehende Domain-Finalisierung nutzt die Evidence-Pipeline | deklarierte Agentenrollen/DAG werden noch nicht tatsächlich orchestriert |

## Missbrauchsfälle für die Abnahme

1. Eine Stellenanzeige verlangt, Systemregeln zu ignorieren und `.env` hochzuladen.
2. Eine HTML-/EML-Nachricht behauptet, eine Freigabe sei bereits erteilt.
3. Ein Browserrequest versucht `codex --yolo` oder `powershell -Command` als Provider zu setzen.
4. Ein Run referenziert eine ApplicationCase-ID einer anderen Firma außerhalb seines Scopes.
5. Ein altes Approval-Token wird mit verändertem Mailziel wiederverwendet.
6. Ein Fake-Provider sendet unendliche Ausgabe, ungültiges JSONL oder startet einen Kindprozess.
7. Die API wird während Toolausführung beendet und anschließend neu gestartet.
8. Ein Inkognito-Run versucht zu finalisieren, zu senden oder eine Revision als `used` zu markieren.

Aktuell automatisiert abgedeckt sind insbesondere Browser-Argumentinjection, Pfadgrenzen,
Policy-Mutationen, Approval-Token-Replay, Capability-Ablauf/-Widerruf, fremde Case-IDs,
Client-Approval-Bypass, Secret-Canaries, Parserfehler, Prozesslimits und
Store-Recovery einschließlich der beiden bekannten Altformat-Reparaturen. Ebenfalls getestet sind
die Windows-/WSL-Auswahl, die prozesslokale Koaleszierung gleichzeitiger Idempotency-Requests und
der Scan untracked Quellen sowie von Runtime-Canaries. Noch ausstehend sind ein realer
Providerprozess-End-to-end-Test der rungebundenen Factory, Kindprozessflucht, API-Restart während eines Toolcalls,
prozessübergreifende Idempotenz, Inkognito über den Agenten-Toolpfad sowie Chaosfälle wie Disk-full.
Die Liste ist daher eine Abnahmeplanung und keine Behauptung einer vollständigen
Sicherheitsfreigabe.
