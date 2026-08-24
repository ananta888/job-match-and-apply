# Threat Model: Agent Control Center

## Schutzgüter und Vertrauensgrenzen

Geschützt werden reale Identität, Kandidatenprofil und Claims, Bewerbungsdokumente, Mails und
Portal-Sessions, Provider-Authentifizierung, Workspace und Git-Historie, autoritative CRM-Zustände,
Pipeline-Nachweise, Approval-/Capability-Schlüssel sowie Auditdaten.

Angular, Stellenanzeigen, E-Mails, importierte Dokumente und Agentenausgaben sind untrusted. Die
Express-API validiert jede Eingabe. Providerprozesse bleiben auch innerhalb einer Sandbox
untrusted. Betriebssystem und lokales Benutzerkonto bilden die äußerste Grenze; wer private Daten
und lokale Schlüssel lesen kann, kann die Inhalte entschlüsseln.

Der Job-Search-MCP bildet eine absichtliche Ausnahme von der Agentenisolation: Er läuft als
direkter nativer oder WSL-stdio-Prozess mit `executionIsolation: trusted-host`, niemals in Codex-,
OpenCode-, Claude-, Bubblewrap-, Container- oder Netzwerk-Sandboxes. Er besitzt Browser-, Session-
und Portalverantwortung. Projektkonfigurationen, die ihn als Agentenkind oder über einen Wrapper
starten würden, blockieren den Agentenlauf vor dem Spawn.

Codex Exec `0.147.0` verwendet feste servereigene Argumente mit `--ignore-user-config
--strict-config`, `web_search="disabled"` und `sandbox_workspace_write.network_access=false`.
Der opt-in Codex App Server verwendet dieselben Overrides, erhält ein temporäres `CODEX_HOME` mit
höchstens `auth.json` und setzt zusätzlich in seiner SandboxPolicy `networkAccess:false`.
OpenCode `1.14.41` und Claude Code `2.1.232` laufen ausschließlich read-only in WSL/Bubblewrap.
Bubblewrap isoliert Dateisystem, PID, IPC und UTS und bindet nur die jeweilige Authdatei read-only
ein. Ihre Provider-Control-Plane bleibt online; modellaufrufbare Shell-, Schreib-, Web-, MCP- und
Subagent-Werkzeuge sind durch eine feste servereigene Policy entfernt.

## Wesentliche Bedrohungen, Kontrollen und Restlücken

| Bedrohung | Derzeitige Kontrolle | Restlücke |
|---|---|---|
| Shell-/Argument-Injection | feste Provider, feste argv, `shell:false`, Prompts über stdin; Browser kann Executable, argv und Environment nicht setzen | Providerprozess und Betriebssystem können stdin-Inhalte während der Laufzeit grundsätzlich beobachten |
| Pfadausbruch | kanonische Rootprüfung, Symlink-/Junction-Tests, sichere Artefakt- und Restore-Ziele | lokale Prozesse mit Zugriff auf Workspace und Benutzerkonto bleiben außerhalb der App-Grenze |
| Indirekte Prompt Injection | Herkunftslabels, getrennte Instruktions-/Datenblöcke, Scope- und Capability-Prüfung bei jedem Root-Tool-Aufruf | jeder injizierte Fachport muss untrusted Inhalte weiterhin als Daten behandeln |
| Credential-Exfiltration | minimales Kindprozess-Environment, isolierte Config-Homes, read-only Authdateien, Redaction und Secret-/PII-Scan | Scan ist signaturbasiert; Redaction ist kein Vollständigkeitsnachweis |
| Confused Deputy | signierte, ablaufende, widerrufbare Run-/Provider-/Tool-/Case-Capability; Client kann Tokens nicht liefern | Korrektheit der vom Composition Root injizierten schmalen Ports bleibt Trust Boundary |
| Approval-Replay | HMAC-Queue mit Ablauf, Parameterhash, Zielbindung, Nonce und einmaligem Verbrauch; append-only, hashbasiertes Lifecycle-Journal ohne Token/Rohparameter | offene oder erteilte, noch nicht verbrauchte Authority wird nach Neustart widerrufen und muss neu angefordert werden |
| Unkontrollierter Netzwerkzugriff | API lehnt `network:true` ab; Codex `0.147.0` erhält feste Offline-Overrides, der App Server zusätzlich `networkAccess:false`; OpenCode/Claude entfernen modellaufrufbare Netzwerk- und Shelltools | Provider-Control-Planes benötigen den Modelltransport; OpenCode/Claude besitzen keinen getrennten Network Namespace |
| Vermischung von Portal- und Agentensandbox | direkter Trusted-Host-Launch, wrapperfreier Vertrag, Projektconfig-Prüfung, isolierte Provider-Homes | gleichzeitige lokale Änderungen nach der Prüfung bleiben eine Host-Trust-Grenze |
| Unkontrollierte externe Aktion | Root-Katalog enthält keinen Versand, Submit, Portal-Login, freie Shell-, Datei- oder Netztools | fehlerhafte Domainport-Implementierung bleibt serverseitige Trust Boundary |
| Prozessflucht/Ressourcenerschöpfung | validierter Prozessbaum-Cancel, Grace Period, deep-first Force-Cleanup, Wall-/Idle-/Output-/Parallelitätslimits, Bubblewrap | Memory-/Kindprozess-Probes sind im normalen Produktstart nicht plattformspezifisch konfiguriert |
| Doppelte Runstarts | payloadfreies persistentes Idempotenzregister und prozesslokale Promise-Koaleszierung | kein koordiniertes Mehrprozess-Claim-Protokoll; keine harte Multi-Prozess-Exactly-once-Garantie |
| Manipulierte Runhistorie | append-only Sequenz, atomare Snapshots, verschlüsselte klassifizierte Felder, Recovery aus Eventlog | keine Hash-Chain, keine allgemeine Schema-Migrationsstrecke |
| Cross-Case-Datenleck | Context Builder und Root-Capability erlauben nur explizite Cases/Firma; sensitive Reads bleiben maskiert | Portimplementierungen müssen minimierte Ergebnisse und korrekte SourceReferences liefern |
| Manipuliertes Agentenartefakt | SHA-256-Prüfung bei jedem Lesen, rungebundener Zugriff, revisionsgebundene Reviews | lokaler Hostzugriff auf Daten und Schlüssel liegt außerhalb der App-Grenze |
| Ungeprüfte Übernahme/Inkognito-Commit | Adopt akzeptiert nur ein freigegebenes Pipelinepaket, führt die lokale Pipeline erneut aus und erzeugt eine Vorschlagsrevision; `use`/Export prüfen signierten Proof, Fallrevision und SHA | fachliche Portatomizität bleibt serverseitige Trust Boundary |
| Halluzinierte Kandidatenfakten | fünf getrennte Rollenläufe, Evidence-Gate, nur belegte Claims, erneute deterministische Finalisierung | Agentenreviews bleiben probabilistisch; exakte menschliche Revisionsfreigabe bleibt nötig |
| Unkontrollierte Löschung | digestgebundene Retention-Vorschau, Legal Holds und append-only Journal; verwendete Provenance bleibt erhalten | Journal ist lokal und nicht extern signiert oder manipulationssicher verankert |

## Bewerbungs- und Revisionsgrenze

Die lokal verdrahtete Kette führt Evidence → Author → ATS und Recruiter/Style → Finalizer als getrennte
Node-Runs aus. Im aktuellen Workflow besitzt der Finalizer weder `user_input` noch
`review_complete` als Vor-Gate; getrennte ATS-/Style-Ergebnisse werden vollständig und automatisch
eingespeist. Das Ergebnis `final_html` wird beim Speichern auf eine kontrollierte semantische
Tagmenge reduziert. Skripte, Eventhandler, Formulare, Navigation und externe Ressourcen werden
entfernt; zusätzlich gelten CSP, `nosniff`, Same-Origin und ein leeres iframe-`sandbox`.

Inkognito darf die deutlich markierte HTML-Vorschau erreichen. Adoption als reale Revision,
Fallfreigabe, `used` und Export sind gesperrt. Review, Fallgenehmigung, `use` und Export prüfen ihre jeweils
servergelieferten Revisions- und Hashbindungen; es gibt keinen freien Lifecycle-Schalter und keinen
automatischen Submission-Pfad.

## Missbrauchsfälle für die Abnahme

1. Eine Stellenanzeige verlangt, Systemregeln zu ignorieren und `.env` hochzuladen.
2. Eine HTML-/EML-Nachricht behauptet, eine Freigabe sei bereits erteilt.
3. Ein Browserrequest versucht `codex --yolo` oder `powershell -Command` als Provider zu setzen.
4. Ein Run referenziert eine ApplicationCase-ID außerhalb seines Scopes.
5. Ein Approval-Token wird mit verändertem Toolziel oder Parameterhash wiederverwendet.
6. Ein Provider erzeugt unendliche Ausgabe, ungültiges JSONL oder einen hartnäckigen Kindprozess.
7. Die API startet mit fehlendem Snapshot, beschädigtem Snapshot oder nichtterminalem Run neu.
8. Ein Inkognito-Run versucht Adoption, Fallfreigabe, `used` oder Export.
9. Eine Retention-Kaskade trifft einen Legal Hold, geteilten Blob oder verwendete Provenance.
10. OpenCode/Claude melden zur Laufzeit breitere Tool-/MCP-Capabilities als die exakte Fixture.

Automatisiert geprüft werden unter anderem Argumentinjection, Pfadgrenzen, Provider-Conformance,
Approval-/Capability-Replay, fremde Case-IDs, Client-Bypass, Secret-Canaries, Parserfehler,
Prozesslimits/-bäume, Event-Recovery, Idempotenz, Retention/Legal Holds, Orchestrierungsgates und
exakte Artefaktübernahme. Weiter offen bleiben echte Multi-Prozess-Idempotenz, API-Restart mitten
in einem Domain-Toolcall, aktive Orchestrierungsfortsetzung nach Neustart, Disk-full/Key-loss und
eine vollständige plattformübergreifende Releaseabnahme. Dieses Dokument ist daher ein Threat
Model und keine Behauptung einer vollständigen Sicherheitszertifizierung.
