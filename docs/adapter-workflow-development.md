# Provider-, MCP-Tool- und Workflow-Entwicklung

Erweiterungen beginnen mit einem versionierten, geschlossenen Vertrag und synthetischen Fixtures.
Browserwerte dürfen niemals Executables, Shellstrings, freie Argumentlisten, Workspacepfade,
Credentials oder Approval-/Capability-Tokens bestimmen.

## Provideradapter

1. Ein Manifest legt exakte unterstützte Versionen, feste argv-Templates, Eventformat,
   Sandboxing, Netzwerkfähigkeit und Authentifizierungsgrenze fest.
2. Discovery ist read-only. Unbekannte Versionen und unbekannte strukturierte Events werden
   blockiert, bis passende positive und negative Conformance-Fixtures vorliegen.
3. Prozesse starten mit `shell:false`, minimalem Environment, kanonischem Workspace und
   begrenzten Streams, Laufzeit, Speicher- und Kindprozesszahlen.
4. Provider-Capabilities werden auf die engere kanonische Policy abgebildet. Eine nicht
   nachweisbar erzwingbare Policy blockiert den Run.
5. Das Conformance-Kit benötigt keine echte Authentifizierung und kein Netzwerk. Erst danach darf
   die Supportmatrix eine konkrete Version als `supported` ausweisen.

ACP folgt demselben Pfad als experimenteller JSON-RPC-stdio-Transport: Mapper, secret-freie
Fixture und fail-closed Clientfähigkeiten zuerst; erst ein späterer Versionspin darf eine reale
CLI als `supported` ausweisen.

OpenCode und Claude erhalten aktuell ausschließlich serverseitig normalisierten Promptkontext.
Eine Root-Tool-Brücke erfordert je Provider einen neuen versionsgenauen Injektionsvertrag. Native
Codex-App-Server-Runs können nach expliziter Profilaktivierung servereigene Dynamic Tools erhalten.

## Root-MCP-Werkzeuge

Ein neues Werkzeug benötigt gleichzeitig:

- einen geschlossenen Descriptor mit Kategorie `read`, `propose`, `confirm` oder `execute`;
- eine deny-by-default Policyregel und eine workflowabhängige Allowlist;
- Run-/Provider-/Fall-Capabilityprüfung mit kurzer TTL;
- minimierte Ausgabe, stabile IDs/Versionen und SourceReferences;
- Approval-, Revision- und Idempotenzbindung für jeden lokalen Schreibcommand;
- Negativtests für fremden Scope, zusätzliche Felder, Replay, Ablauf und Client-Authority-Bypass.

Shell, freier Dateizugriff, Mailversand, Bewerbungssubmit, Portal-Login und Credentials sind keine
zulässigen Root-Tools. Der Job-Search-Proxy darf nur den vorhandenen Root-Adapter aufrufen. Dieser
startet `job-search-mcp` direkt als Trusted-Host-stdio-Prozess – niemals als Agentenkind,
Bubblewrap-, Container- oder sonstiger Agenten-Sandbox-Prozess.

## Workflows

Ein Workflow deklariert Version, Scope, Rollen, Inputs, Outputs, Abhängigkeiten, Gates, Budgets,
Retryklassen und Fehlerstrategie. Nur tatsächlich getrennte Runs mit getrenntem Kontext dürfen
`declaredIndependentAgent:true` tragen. Outputs bleiben Vorschläge und erhalten Run-, Inputdigest-
und Artefaktprovenienz.

Fan-in entscheidet nicht durch Mehrheitsfiktion: ATS und Recruiter/Style bleiben getrennte
Rollenläufe und werden als komplementäre Rohreviews vollständig an den Finalizer übergeben.

Im aktuellen `evidence-application-package@1.1.0` läuft der Finalizer ohne Browser-Gate. Sein
Output-Ref `final_html` verlangt ein vollständiges HTML5-Dokument und verbietet JSON, Skripte,
Formulare, Navigation und externe Ressourcen. Neue Workflowänderungen an Gates oder Outputformat
benötigen eine neue Workflowversion; alte `package_proposal`-Artefakte bleiben nur als
Kompatibilitätsformat lesbar.

Für Bewerbungsdokumente gilt zusätzlich die lokale Skill-Pipeline: Stellenanalyse, Match-Matrix,
offene Fragen, Evidence, Author, ATS, Recruiter/Style und Finalizer. Erst der anschließende
Artefakt-Review, Adoption, serverseitige PipelineProof, fachliche Revisionsreview sowie getrennte
Fallfreigabe-, Used- und Export-Gates machen eine exakte Revision verwendbar. Inkognito bleibt
Vorschau.

## Prüfschritte

Mindestens ausführen:

```powershell
npm.cmd run test
npm.cmd run build
npm.cmd run security:scan
npm.cmd run diagnose
```

Provider-, Contract- und Securitytests laufen zusätzlich auf Windows und Ubuntu. Beispiele nutzen
nur `example.invalid`, synthetische IDs und leere Testcredentials. Reale Provider-, Portal- oder
Mailkonten sind kein Bestandteil von Unit-, Contract- oder E2E-Tests.
