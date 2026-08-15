# Lebenslauf-Studio

Das Lebenslauf-Studio ist der lokale, evidence-basierte Weg von einem vorhandenen Lebenslauf zu
einer stellenbezogenen HTML-Revision. Es ist in Angular über **Lebenslauf** erreichbar.

## Unterstützte Eingaben

- PDF (`.pdf`), sofern Text extrahierbar und das Dokument weder verschlüsselt noch aktiv ist
- Word Open XML (`.docx`); das alte binäre `.doc`-Format wird bewusst nicht akzeptiert
- LibreOffice/OpenDocument Text (`.odt`)
- UTF-8-HTML (`.html`, `.htm`)

Die maximale Quelldatei ist 10 MiB groß. Die Verarbeitung erfolgt lokal und passiv. Externe
HTML-/Office-Verweise werden nicht geladen. Makros, Skripte, OLE/ActiveX, verschlüsselte Container,
Pfadtraversal und ZIP-Bombs werden abgewiesen. PDF-Prüfung und Textextraktion sind passiv und
best-effort; erkennbare aktive oder verschlüsselte PDFs werden abgewiesen. Bei sehr wenig PDF-Text
weist die Oberfläche auf einen möglichen Scan beziehungsweise fehlendes OCR hin. Bei mehr als 100
Seiten wird die Auswertung begrenzt und als solche ausgewiesen.

Die ursprünglichen Uploadbytes werden nach der Extraktion nicht gespeichert. Der normalisierte
Import einschließlich Fakten, Provenienz und späterer HTML-Revision liegt AES-256-GCM-verschlüsselt
unter `.local-data/cv-imports`; der separate Schlüssel wird mit restriktiven Dateirechten angelegt.

## Optionale KI-Strukturierung

Jeder Lebenslauf erhält beim lokalen Import zunächst einen deterministischen Erkennungsstand. Er
bleibt als jederzeit auswählbarer Fallback erhalten. Die optionale KI-Strukturierung liest dagegen
die unveränderte ursprüngliche Textextraktion samt Zeilenmanifest und erzeugt daraus einen neuen,
vollständigen Erkennungsstand. Sie ergänzt oder repariert also nicht schrittweise eine womöglich
fehlerhafte aktive Faktenliste. Nach erfolgreicher Prüfung des KI-Vertrags wird der neue Stand
automatisch aktiv; ältere Stände bleiben mit Anzahl, Typ, Zeitpunkt und Faktenzahlen sichtbar und
können vor der Profilübernahme direkt ausgewählt werden. Ein Standwechsel bestätigt keine Fakten.

Vor jedem Start bestätigt der Nutzer genau eine zusammengefasste Offenlegung. Sie umfasst beide
Sachverhalte: Der vollständige extrahierte Lebenslauftext wird an den ausgewählten Provider
übermittelt, und dessen Control-Plane kann dafür Netzwerk verwenden. Dieses Provider-Netzwerk ist
vom deaktivierten Modell-Werkzeugnetz getrennt und wird nicht als Offline-Verarbeitung bezeichnet.

Der Agentenlauf selbst läuft in einem isolierten, nur lesbaren Arbeitsbereich mit
`approvalMode=deny`. Seine Allowlist für fachliche Root-MCP-Werkzeuge ist leer; zusätzlich werden
die eingebauten Datei-, Shell-, Such- und sonstigen Providerwerkzeuge durch einen versionsgenauen,
serverseitigen Zero-Tool-Vertrag deaktiviert. Meldet die Runtime dennoch ein Werkzeug oder fehlt die
Sandbox-Attestation, wird der Lauf verworfen. Provider ohne diesen Zero-Tool-Vertrag erscheinen als
nicht verfügbar. Insbesondere erhält der Lauf keinen Zugriff auf Job-Suche, CRM, Mail oder
Bewerbungspipeline. Der Job-Search-MCP wird ihm nicht bereitgestellt und bleibt außerhalb jeder
Agentensandbox.

In dieser ersten Version ist dafür ausschließlich Claude Code `2.1.232` in der geprüften
WSL-/Bubblewrap-Konfiguration freigegeben. OpenCode und Codex bleiben für die CV-KI-Strukturierung
so lange blockiert, bis auch ihr leerer Runtime-Werkzeugsatz versionsgenau attestiert ist. Der
deterministische Import und die manuelle Faktenprüfung funktionieren unabhängig davon lokal.

KI-Ergebnisse werden nur angenommen, wenn sie dem strikten, versionsgebundenen Vertrag entsprechen.
Jeder nicht leere Feldvorschlag muss dabei exakt auf eine Textstelle der importierten Quelle mit
Zeilen- und Zeichenposition sowie Quellzitat verweisen. Eine vom Provider angegebene Konfidenz ist
nur eine Entscheidungshilfe und ausdrücklich kein Kandidatenbeleg. Unbelegte Ergänzungen werden
abgewiesen; unbekannte Werte müssen als offene Frage zurückkommen.

Auch der automatisch aktivierte KI-Stand enthält ausschließlich `pending`/`unverified` Fakten. Die
Oberfläche gruppiert sie als verständliche Stationen wie Zeitraum, Arbeitgeber und Rolle, statt
eine KI-Vorschlagsliste zum einzelnen Durchklicken zu verlangen. Der Nutzer kann Fehler korrigieren
oder Fakten verwerfen und bestätigt anschließend den gesamten aktiven Stand mit einer einzigen,
ausdrücklichen Aktion. Diese Bestätigung ist noch keine Übernahme in das CandidateProfile und keine
Freigabe für eine Bewerbung. Die separate Profilübernahme übernimmt nur bestätigte Fakten; offene
oder verworfene Fakten bleiben ausgeschlossen. Eine automatische Adoption findet nicht statt.
Ältere Imports ohne das private Zeilenmanifest besitzen nicht die erforderliche Quellbindung und
müssen deshalb neu importiert werden, bevor die KI-Strukturierung gestartet werden kann.

Die temporäre Laufakte wird lokal verschlüsselt gespeichert; nach 24 Stunden stößt ein Start- und
Intervall-Worker ihre Bereinigung an. Metadaten werden erst gelöscht, nachdem die zugrunde liegende
rohe Agentenlaufakte nachweislich bereinigt wurde. Ein anomal noch laufender oder nicht bereinigbarer
Prozess bleibt verschlüsselt und sichtbar für weitere Bereinigungsversuche, statt ungetrackt
zurückzubleiben; daraus folgt keine harte 24-Stunden-Löschgarantie. Normale Agentenlisten, Streams,
Exporte, Artefakt- und
Steuerungsrouten blenden diese privaten Läufe vollständig aus. In der öffentlichen API erscheint
weder das private Importartefakt noch dessen Zeilenmanifest. Die automatisierten Tests verwenden
synthetische Fixtures und Fake-Provider. Sie senden keinen Lebenslauf an einen echten Provider.

## Sechs Schritte

1. **Import:** PDF, DOCX, ODT oder HTML auswählen; Extraktion und deterministischen Fallback lokal
   erzeugen.
2. **Erkennung:** den Fallback verwenden oder mit einer Gesamtzustimmung einen vollständigen
   KI-Erkennungsstand aus der ursprünglichen Extraktion erzeugen; den gewünschten Stand auswählen.
3. **Faktenfreigabe:** Stationen übersichtlich prüfen, nötige Werte korrigieren oder verwerfen und
   den aktiven Stand einmal insgesamt bestätigen.
4. **Darstellung:** das versionierte private Stilprofil und optional eine geschlossene ATS-Vorlage,
   Schrift, Akzentfarbe, Abstand und Abschnittsreihenfolge wählen. Freies HTML/CSS ist kein Eingabefeld.
5. **Zielstelle:** einen vorhandenen CV-Bewerbungsfall und damit exakt eine Stelle auswählen.
6. **Prüfung/HTML:** den Workflow Evidence → Author → ATS + Recruiter/Style → Finalizer ausführen,
   sein Artefakt menschlich prüfen und übernehmen und erst dann die freigegebene Revision rendern.

Importierte, KI-strukturierte oder bearbeitete Inhalte sind zunächst `pending`. Die
Gesamtbestätigung setzt nur die noch offenen Fakten des aktiven Erkennungsstands auf `confirmed`;
sie adoptiert nichts. Erst die getrennte Profilübernahme kann diese bestätigten Fakten über den
versionierten Vertrag des Bewerbungs-Schreib-Assistenten als `user_confirmed` in das
CandidateProfile übernehmen. Verworfenes und noch offenes Material gelangt weder in das Profil noch
in einen Agentenlauf. Bearbeiten ersetzt einen importierten Fakt durch einen neuen, erneut zu
bestätigenden Nutzerfakt; die ursprüngliche Provenienz bleibt verworfen nachvollziehbar.

Ein vom Extraktor festgestellter Widerspruch blockiert die Übernahme in Version 1 bewusst. Die
Quelle muss korrigiert und als neuer Import eingelesen werden. Nach erfolgreicher Profilübernahme
ist ein Import unveränderlich; spätere Profilkorrekturen erfolgen als neuer Import oder als eigene,
versionierte CandidateProfile-Änderung.

## Agenten- und Freigabegrenzen

Der Lebenslauf-Workflow verwendet die bestehende fünfstufige Bewerbungs-Pipeline. Der Finalizer darf
nur belegte CandidateProfile-Claims verwenden. Sein Ergebnis bleibt ein Vorschlag. HTML wird erst
erzeugt, wenn exakt dieselbe CV-Dokumentrevision

- einen gültigen PipelineProof besitzt,
- von einem `used`-Agentenartefakt des versionierten Finalizer-Workflows stammt,
- menschlich geprüft und freigegeben wurde,
- an denselben Bewerbungsfall und dieselbe Stelle gebunden ist und
- mit Revisions-ID und SHA-256 im Fall freigegeben wurde.

Die optionale Formatvorlage wird danach serverseitig auf die freigegebene Revision angewendet und
ihr Hash im CV-Importnachweis gespeichert. Das Ergebnis ist eigenständiges, escaped HTML mit CSP,
ohne Skripte oder externe Ressourcen. Die Angular-Vorschau läuft in einem sandboxed `iframe`.
Inkognito-Agentenläufe bleiben als nicht verwendbare Vorschlagsartefakte im Agent Center prüfbar;
sie können weder als fachliche Dokumentrevision übernommen noch als HTML erzeugt oder heruntergeladen
werden. Damit wird eine Scheinidentität niemals versehentlich zu einer verwendbaren Bewerbung.

Der Job-Search-MCP bleibt davon getrennt: Er läuft ausschließlich als validierter Trusted-Host-
stdio-Prozess und niemals innerhalb einer Agenten-, Container- oder Bubblewrap-Sandbox.

## Lokaler Test

```powershell
npm.cmd run dev
```

Die Plattform läuft standardmäßig auf `http://127.0.0.1:4201`; Port 4200 ist nicht Teil dieses
Projekts. Für einen vollständigen Test werden ein eingerichtetes Candidate-/Stilprofil, ein
CV-Bewerbungsfall und ein verfügbarer, unterstützter Agentenprovider benötigt. Import und
Faktenprüfung lassen sich mit der synthetischen Fixture
`integrations/bewerbungs-schreib-assistent/tests/fixtures/synthetic-cv.html` vollständig lokal und
ohne Portalzugriff testen. Die optionale KI-Strukturierung über einen echten Provider ist damit
nicht getestet; dafür sind die beiden Offenlegungen bewusst zu bestätigen.

Ein Import kann nur mit exakter Revision, exaktem SHA-256 und der typisierten Bestätigung
`DELETE cv-import <UUID>` gelöscht werden.
