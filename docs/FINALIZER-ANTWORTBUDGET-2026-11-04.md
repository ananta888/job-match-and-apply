# Finalizer: gemeinsames Reasoning-/Antwortbudget

Belegter Lauf vom 04.11.2026, 00:46 Uhr: Die vier Vorstufen liefen erfolgreich. Der Abschluss meldete 29.832 Eingabe- und exakt 10.000 Ausgabetokens; der Adapter meldete openrouter_output_truncated. Ein fertiges HTML-Dokument wurde nicht übernommen.

Das bisherige Antwortlimit wurde als Dokumentreserve dimensioniert, obwohl Reasoning und sichtbare Ausgabe dasselbe max_tokens-Limit teilen. Quelle: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-tokens-and-max-output-tokens. Der konkrete Denkanteil des alten Laufs ist mangels damaliger Nutzungsdetails nicht nachträglich belegbar.

Korrektur:
- Abschlusslimit einschließlich Reasoning: off 10.000, low 12.500, medium 20.000, high/default 50.000 Tokens. Die Reserve bei high orientiert sich an 10.000 Dokumenttokens und der dokumentierten ungefähren 80%-Zuordnung; sie garantiert kein bestimmtes Modellverhalten. Der HTTP-Adapter akzeptiert begrenzte Werte bis 65.536.
- Abschlussknoten mit 128.000 Tokens inklusive Eingabe/Korrektur; Kosten- und Zeitgrenzen unverändert. Frühere Vorstufen bleiben unverändert.
- Abschluss-Prompt nennt den zuvor fehlenden Pflichtmarker body[data-result=final-agent-html], verlangt eine einzelne kompakte HTML-Fassung und widerspricht nicht länger der Regel, Evidence-Annotationen ausschließlich in den Vorstufen zu belassen.
- Abgeschnittene Antworten werden weiterhin verworfen. openrouter_output_truncated bleibt als konkreter Laufgrund erhalten und wird in der Oberfläche erklärt.
- Diagnose enthält nur numerische Reasoning-Tokens (falls geliefert), Antwortlänge und normierten Abschlussgrund; keine Denktexte.
- Gezielter Retry verwendet die gespeicherten ursprünglichen Eingaben, dasselbe Modell/Reasoning und die fertigen Vorstufen. Die neue Software wendet dabei die korrigierte Budget-/Promptregel an.

Regressionen prüfen die 50.000 Tokens auch im tatsächlichen HTTP-Anfragerumpf, Marker/Prompt-Konsistenz, Abbruchkategorie, fehlende Nutzungsdaten und den unveränderten Schutz gegen abgeschnittene Dokumente.

Verifikation: 797 Backend- und 76 Angular-Tests bestanden, zwei bestehende Tests übersprungen; Server-/Angular-Build erfolgreich (bekannte Bundle-Warnung bleibt). Sicherheitsprüfung erfolgreich. Unabhängiges Review ohne kritische oder wichtige Befunde. Ein echter Abschluss ist mit diesen Tests allein nicht belegt.

## Echter High-Vergleich und begrenzte schnelle Alternative
Der anschließende echte High-Test mit gleicher Datenbasis erreichte 50.000 Ausgabetokens. Anbieterdiagnose: reasoningTokens=50.000, answerCharacters=0, finishReason=length; Laufzeit etwa 103 Sekunden. Es entstand kein HTML. Ein höheres Gesamtlimit ist daher für diesen Fall keine belegte Lösung.

Der schnelle Wiederholungsweg verändert ausdrücklich nur das Finalizer-Reasoning in einer neuen, eingefrorenen Run-Konfiguration. Anbieter, Modell, Rohdaten und vier geprüfte Vorstufen bleiben unverändert. Der Ursprung bleibt High; das gespeicherte Providerprofil wird nicht geändert. Die API verweigert diese Ausnahme für andere Anbieter oder Knoten. Die normale Wiederholung ohne Override bleibt unverändert. UI-Beschriftung: „Nur Abschluss schnell wiederholen · Reasoning Aus“.

Schneller Retry: 799 Backend-Tests (zwei übersprungen), 77 Angular-Tests, Builds und Sicherheitsprüfung bestanden; unabhängiges Review ohne wichtige Befunde.
