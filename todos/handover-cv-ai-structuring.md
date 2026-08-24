# Übergabe: CV-Import und KI-Strukturierung

Stand: 2026-08-17. Branch `feat/claim-revocation-and-profile-snapshots` in **beiden**
Repos (Parent `59e0170`, Submodul `cb84598`), gepusht, Arbeitsverzeichnisse sauber.
`main` ist unberührt.

---

## 0. Die wichtigste Regel für diesen Fall

**Erst Sichtbarkeit herstellen, dann ändern.**

In der Vorsitzung wurden fünf Ursachenvermutungen aufgestellt und teils gebaut —
alle fünf waren falsch. Jede einzelne war plausibel. Der Grund für das wiederholte
Scheitern war nicht mangelnde Sorgfalt, sondern die Reihenfolge: gebaut wurde vor
gemessen. Die Diagnose wurde viermal als nächster Schritt benannt und viermal
übersprungen.

Wenn du diese Datei liest und versucht bist, direkt eine Ursache zu beheben:
**nicht tun.** Baue zuerst Abschnitt 3.

---

## 1. Was fertig ist und funktioniert

### CV-Extraktion (das ursprüngliche Anliegen) — erledigt

Der Lebenslauf des Nutzers ist zweispaltig mit Datumsspalte. `pdftotext` liest
spaltenweise, dadurch lief das Datum den Aufzählungen eine Station voraus; der
zeilenbasierte Parser paarte alles falsch.

Ergebnis vorher → nachher, an der echten Datei gemessen:

| | vorher | nachher |
|---|---|---|
| Name | „Geburtsdaten" | PETER STUIBER |
| Stationen | 1 | 12 |
| Firmen | 0 | 10 |
| Details | 20 vermischt | 44 zugeordnet |
| Zertifikate | 1 Klumpen + 2 Geister | 4 einzeln |

Umgesetzt in `integrations/bewerbungs-schreib-assistent/scripts/cv_import_contract.py`:
`-layout` mit Seitenumbrüchen, Spaltenerkennung über fast-leere Rinnen,
FIFO-Datumszuordnung, Umbruch-Reparatur (nur PDF, nur Prosa-Abschnitte),
`Firma - Rolle`-Trennung, Abschnitts-Reset an der Spaltengrenze.
101 Vertragstests grün.

### Weitere erledigte Punkte der Sitzung

- Claim-Verwaltung: `revoke-claims`, Profil-Snapshots, Endpunkte, UI
- Stream-Statuslüge behoben (500 im Log bei gesendetem 200)
- Fehlerklassen-Diagnose für unerwartete Serverfehler (`JOB_MATCH_ERROR_STACKS=1`)
- Job-ID-Normalisierung samt Migration (87 URL-IDs)
- Drei Codex-App-Server-Fixes (Enum-Schreibweisen, Notification-Toleranz, Fähigkeitsprüfung)
- Inkognito-Vorschau mit Download
- Stilprofil-Vorlage und blinde UI

---

## 2a. GEFUNDEN: die Ursache (2026-08-17, gemessen)

**`--permission-mode plan` ist die Ursache.** Hypothese 5 war richtig und wurde
mit einem zu kleinen Probelauf fälschlich verworfen.

Gemessen an der echten Nutzlast (28 742 Bytes Prompt aus dem echten Import,
derselbe bwrap-Sandbox-Start wie in der App, Prompt über stdin):

| Variante | Antwort | `{` enthalten | Ergebnis |
|---|---|---|---|
| App-Argumente, `--tools Read` | 44 873 Bytes | ja | JSON — nach einem Tool-Umweg |
| App-Argumente, `--tools ''` | **401 Bytes** | **nein** | **Absage, wie in der App** |
| Trivialer Prompt (Abschnitt 4) | klein | ja | funktioniert — beweist nichts |

Im Plan-Modus **verweigert die CLI die Aufgabe.** Wortlaut der Absage: sie sei im
Plan-Modus, der dem Zuschneiden von Code-Änderungen diene, und das JSON direkt zu
liefern würde den Plan-Modus umgehen statt etwas zu planen. Kein JSON, keine
Klammer, ~400 Bytes Prosa.

Das deckt sich exakt mit den Zählern des instrumentierten App-Laufs
(`11:24:36Z`, claude-cli): `message_events 1`, `message_blocks_with_text 1`,
`output_bytes 303`, `open_braces 0`. Genau eine Antwort, ~300 Bytes, keine
Klammer. Weg 3.

**Die Absage ist deterministisch,** nicht sporadisch. Der Lauf mit `--tools Read`
in der Tabelle oben ist *nicht* die App-Konfiguration: für diesen Workflow
ersetzt `generic-jsonl-adapter.ts:135` `--tools Read` bereits durch `--tools ''`.
Die maßgebliche Zeile ist deshalb die mittlere. Was „nie reproduzierbar" wirken
ließ, war der zweite Fehlermodus (unten), nicht Zufall in der Absage.

### 2a.1 Der zweite Fehlermodus: `crash` = Kontingent erschöpft

Die beiden Läufe, die der Nutzer am 17.08. auslöste (`10:13` claude-cli, `11:01`
opencode), scheiterten **nicht** an der Validierung, sondern mit
`crash` / `stage: agent`. Beim Nachmessen trat derselbe Fall auf:

```
EXIT=1 · Antwort 62 Bytes · "You've hit your session limit · resets 6:10pm (Europe/Berlin)"
```

Die CLI beendet sich bei erschöpftem Kontingent mit Code 1. Der Adapter macht
daraus `crash` (`generic-jsonl-adapter.ts:397`, jedes Nicht-Null-Exit), was den
eigentlichen Grund verschluckt. Beide Provider hängen am selben Konto, deshalb
traf es beide. Kein Codefehler — aber eine irreführende Meldung.

**Direkt daran anschließend:** Nebenbefund 1 in Abschnitt 5 (`rate_limit_event`
ist dem Adapter unbekannt) ist damit kein Schönheitsfehler mehr, sondern die
Reparatur dieser Meldung. Die CLI schickt das Ereignis als **erstes** in jedem
Lauf; gemappt könnte die App „Kontingent erschöpft" sagen statt `crash`.

### Zurückgezogen: „Zero-Tools-Zusage wird nicht durchgesetzt"

Ich hatte ein `tool_use: Read` im Rohstrom als fehlenden Wächter gedeutet. Das
war falsch: dieses `tool_use` stammt aus *meinem* Probelauf, in dem ich `Read`
selbst gewährt hatte. Die App gewährt es nicht (siehe Rewrite oben), und im
App-Lauf kommt entsprechend keine Tool-Ereignisart vor. Kein Befund.

### Offen: der „isolierte" Workspace liegt im Repo

`prepareCvAiWorkspace` legt ihn unter `<repo>/.application-work/cv-ai-structuring`
an. Im Lauf **ohne jedes Tool** nannte das Modell von sich aus
`server/src/services/cv-ai-structuring.ts` und die damals *ungetrackte* Datei
`cv-ai-prompt-dump.mts` — Wissen, das nicht aus dem Prompt stammen kann und auch
nicht aus einem Tool-Aufruf. Naheliegend: die CLI reicht von sich aus
Projektkontext (Dateiliste, `git status`) des umgebenden Repos mit. Zusammen mit
`--ro-bind / /` gehört die Isolationszusage dieses Workflows geprüft.
Mechanismus unbewiesen, Beobachtung reproduzierbar.

### Was daraus folgt

Der Rückbau von `extractProviderJsonObject` (Abschnitt 6) ist damit wieder gut
vertretbar: die Absage enthält gar kein Objekt, das Herausschälen hilft ihr
nicht. Es war nie die Ursache und ist auch keine Rettung.

**Gebaut** (`abfc36a`): `--permission-mode acceptEdits` statt `plan`, mitsamt
Konformitätsprüfung, cv-ai-Attestierung und beiden Fixtures. `acceptEdits`
lockert hier nichts — das `init`-Ereignis meldet `tools: []`, es gibt kein
Werkzeug, dessen Änderungen akzeptiert werden könnten.

**Noch nicht verifiziert:** Der Lauf mit `acceptEdits` gegen die echte Nutzlast
wurde vom Kontingentlimit abgeschnitten. Nach dem Reset einmal auslösen und die
Zähler prüfen — bei Erfolg erscheint gar kein `provider_output_shape`-Eintrag.

---

## 2. Der offene Fehler (historisch — siehe 2a)

**Symptom:** „Mit KI strukturieren" mit Claude CLI scheitert **immer**, nie
sporadisch, mit `provider_output_not_strict_json` / `stage: validation` /
nicht wiederholbar.

**Ort:** `server/src/services/cv-ai-structuring.ts`, Validierungsblock
(Suche nach `provider_output_not_strict_json`).

Nach den bisherigen Änderungen führen nur noch drei Wege zu diesem Code:
1. kein einziges `agent_message_completed` (`!output`)
2. Antwort > 512 KiB (`MAX_PROVIDER_OUTPUT_BYTES`)
3. zusammengesetzte Antwort enthält kein parsbares `{…}`

### Bereits widerlegte Hypothesen — nicht erneut verfolgen

| # | Vermutung | Wie widerlegt |
|---|---|---|
| 1 | Markdown-Zäune / Vorspann um das JSON | Toleranz eingebaut, Fehler blieb |
| 2 | Nur das letzte Fragment nötig (`at(-1)`) | falsch gedacht, ersetzt durch `join('')`, Fehler blieb |
| 3 | Antwort kommt nur im `result`-Ereignis | Probelauf: `assistant`-Textblock existiert |
| 4 | Lange Antwort kommt als Deltas | Probelauf: **ein** vollständiger Block, 14 346 Zeichen |
| 5 | App-Argumente / `--permission-mode plan` schuld | ~~Probelauf mit exakt diesen Argumenten: funktioniert~~ — **Widerlegung war falsch**, siehe 2a. Der Probelauf benutzte einen trivialen Prompt; im Plan-Modus verweigert die CLI erst die *echte* Aufgabe. |

**Einziger verbliebener Unterschied** zwischen funktionierendem Probelauf und
scheiterndem App-Lauf: die echte Nutzlast — Zeilenmanifest des Lebenslaufs plus
Ausgabeschema im Prompt, und eine entsprechend große erwartete Antwort.

### Beweismaterial

Echte Ereignisströme von Claude CLI 2.1.233 liegen im Scratchpad der Vorsitzung
(`probe.jsonl` kurz, `probe2.jsonl` lang, `probe3.jsonl` mit App-Argumenten).
Falls weg: mit dem Muster aus Abschnitt 4 neu erzeugen.

Beobachtet bei langer Antwort: 88 `system`-Ereignisse und ein **zweites
`assistant`-Ereignis ohne Textblock** — der einzige Strukturunterschied zwischen
kurz und lang. Wert, verfolgt zu werden.

---

## 3. Erste Aufgabe: Diagnose (vor allem anderen) — gebaut, wartet auf einen Lauf

Ziel: Ein einziger Fehlversuch soll beantworten, welcher der drei Wege es ist.

Umgesetzt in `ff710ec`. Zwei Abweichungen von der ursprünglichen Skizze, beide
bewusst:

- **Aufzeichnen statt Aufheben.** Die Skizze wollte die Löschung im Fehlerfall
  aussetzen. Stattdessen wird die Form der Antwort *vor* dem Purge festgehalten;
  der Purge läuft unverändert weiter. Das beantwortet dieselbe Frage, ohne
  Prompt und Lebenslauftext zur Diagnose auf der Platte zu behalten.
- **Der Löscher heißt anders.** Im Fehlerpfad räumt nicht `deleteForImport` ab,
  sondern `purgeRawRun` im `catch` von `refresh` (und im `failed`-Zweig davor).
  `deleteForImport` ist die Kaskade vor dem Löschen des Imports.

Aufgezeichnet wird bei `provider_output_not_strict_json`, als Zähler:

| `errorClass` | `eventSequence` |
|---|---|
| `events_total` | alle Ereignisse des Laufs |
| `message_events` | `agent_message_completed`, auch ohne Textblock |
| `message_blocks_with_text` | davon die mit nicht-leerem Text |
| `output_bytes` | Byte-Länge der zusammengesetzten Ausgabe |
| `open_braces` | Anzahl `{` — `0` heißt: keine einzige |
| `kind.<ereignisart>` | je vorkommende Ereignisart deren Anzahl |

`operation` ist `provider_output_shape`, `component` ist `cv_ai_structuring`.
Ereignisarten werden in das Alphabet der Senke gezwungen (Kleinschreibung,
`[^a-z0-9_.:-]` → `-`); ein trotzdem abgelehnter Eintrag wird geschluckt, damit
die Diagnose nicht den Fehler ersetzt, den sie erklären soll. Anmerkung zur
Vorsitzung: ein ungültiger `errorClass` wird **nicht** still verworfen, sondern
`AgentLocalObservability.record` wirft `observability_error_class_invalid`.

**Offen: Schritt 3.** Nutzer muss den Fehler einmal auslösen. Danach:

```bash
node -e "for (const l of require('fs').readFileSync('.local-data/agent-observability/events.jsonl','utf8').trim().split('\n').slice(-400)) { const r = JSON.parse(l); if (r.operation === 'provider_output_shape') console.log(r.timestamp, r.errorClass, r.eventSequence); }"
```

Auswertung: `message_events` gleich `0` → Weg 1. `output_bytes` über 524 288 →
Weg 2. Beide unauffällig und `open_braces` gleich `0` → Weg 3, und die Antwort
enthielt tatsächlich nie eine Klammer. `open_braces` größer `0` bei Weg 3
bedeutet: Klammern vorhanden, aber unbalanciert oder kein Objekt — dann ist die
Ausgabe abgeschnitten, und die Spur führt zu einem Limit im Adapter, nicht zum
Parser.

---

## 4. Probelauf-Rezept — **nur mit echtem Prompt aussagekräftig**

**Warnung:** Mit einem trivialen Prompt beweist dieses Rezept nichts. Genau daran
ist die Widerlegung von Hypothese 5 gescheitert. Der Plan-Modus verweigert erst
die echte Aufgabe. Nutze den echten Prompt: er lässt sich aus einem Import
rekonstruieren, indem `loadAiSource` und `buildCvAiStructuringPrompt`
zusammengesetzt werden (Wegwerf-Skript, absichtlich nicht im Repo, weil es
Personendaten unverschlüsselt auf die Platte schreibt).

Ein Start ohne Shell und mit Argument-Array ist Pflicht: Git Bash schreibt jedes
Argument und jeden Umgebungswert um, der wie ein POSIX-Pfad aussieht — `/tmp`
wurde dreimal zu `C:/Program Files/Git/...`. Und der echte App-Start ist nicht
das Rezept unten, sondern
`wsl.exe -d Ubuntu -- bwrap … --chdir <workspace> -- <cli> <args>`
(Plan in `server/src/agents/provider-sandbox.ts:185-215`).



```bash
wsl -e bash -lc 'claude --safe-mode -p --output-format stream-json --verbose \
  --permission-mode plan --tools Read --disallowedTools "mcp__*" \
  --strict-mcp-config --mcp-config "{\"mcpServers\":{}}" \
  --disable-slash-commands --no-session-persistence < /mnt/c/pfad/zum/prompt.txt'
```

Entspricht exakt den App-Argumenten aus `CLAUDE_CLI_MANIFEST`
(`server/src/agents/provider-adapters.ts`). Prompt über **stdin**, nicht als Argument.

---

## 4b. Die beiden anderen Provider (17.08., gemessen und behoben)

### opencode: war nie funktionsfähig

Der injizierte `OPENCODE_CONFIG_CONTENT` enthielt `$schema`. opencode 1.14.41
validiert streng und lehnt den Schlüssel ab:

```
Error: Configuration is invalid at OPENCODE_CONFIG_CONTENT
↳ Unrecognized key:
```

Exit 1, bevor ein Token ausgegeben wird → `crash`. Alle sieben Schlüssel einzeln
durchprobiert; `$schema` ist der einzige abgelehnte. Ohne ihn antwortet derselbe
Start korrekt (`EXIT=0`). Behoben in `7ce13ca`. In einer Konfigurations*datei*
ist `$schema` erlaubt — nur im per Umgebung injizierten Inhalt nicht.

### Codex: Auswahl folgt jetzt dem Bedarf

Beide Codex-Installationen waren gleichzeitig blockiert, aus zwei unabhängigen
Gründen. WSL: das Profil nagelt `codex-exec` auf Windows fest. Windows: der
experimentelle App-Server-Transport beantwortete die Fähigkeitsabfrage, und
seine Zusagen enthalten weder `serverOwnedNoToolsMode` noch `externalSandbox` —
genau die beiden, die dieser Workflow verlangt.

`capabilities()` nimmt jetzt `AgentCapabilityRequirements`; der cv-ai-Dienst
fragt mit `serverOwnedNoTools`, Codex antwortet mit dem exec-Vertrag
(`7d2733b`). `FeatureFlaggedCodexAgentAdapter` → `PreferredCodexAgentAdapter`
mit ablesbarem `selection()`. Flag samt Profilfeld entfernt, Profilschema 3 mit
Migration (`e1ed59a`). Vertragsklausel `featureFlags.experimentalDefault: false`
ersetzt durch prüfbare Eindämmungsregeln (`15c32af`).

**Wichtig für künftige Fehlersuche:** fehlende User-Config-Isolation ist
absichtlich *kein* Fallback-Grund. Nur Bedarf und nicht freigegebene Version
führen zu exec; Isolations- und Health-Zweifel brechen ab. Eine erste Fassung
machte daraus eine stille Abschwächung, ein Test hat sie gefangen.

Stand: `codex-exec` (windows), `opencode` und `claude-cli` sind `ready`.
`codex-exec` auf WSL bleibt blockiert, weil ein Profil je Provider genau ein
`runtimeTarget` zulässt — Konfiguration, kein Fehler.

---

## 5. Nebenbefunde, ungelöst

- **`rate_limit_event`** ist in allen Probeläufen das *erste* Ereignis und dem
  Adapter unbekannt (`unknown_claude_event`). Gehört ins Mapping und in die
  Fixture `contracts/fixtures/v1/claude-cli-events.json`. **Priorität gestiegen:**
  siehe 2a.1 — dies ist die Reparatur der irreführenden `crash`-Meldung bei
  erschöpftem Kontingent.
- ~~**`crash` bei `stage: agent`** trat einmal auf, separate Spur.~~ **Erklärt**,
  siehe 2a.1: erschöpftes Kontingent, Exit-Code 1.
- **`agent-artifact-api.test.ts`** ist an der 5000-ms-Grenze getaktet und fällt unter
  Last aus (mehrfach rot/grün beobachtet). Unabhängig von allem hier; verdient
  einen höheren Timeout.

---

## 6. Umstrittene Änderung, bewusst offen gelassen

`extractProviderJsonObject` in `cv-ai-structuring.ts` schält JSON aus
Markdown-Zäunen und Prosa. Das war Hypothese 1 und **nicht** die Ursache.

Es kehrt eine bewusst gesetzte Fail-closed-Zusage um; der Test hieß ursprünglich
„fails closed on Markdown-wrapped output" und musste umbenannt werden.

Der Nutzer wollte es vorerst behalten. Entscheidung 2026-08-17: **behalten**.
OpenCode lieferte in diesem Durchlauf gar kein Objekt; Codex lieferte eines, das
der Vertrag als `invalid_ai_structure` ablehnte. Der Parser ändert also weder die
Ursache noch die Fail-closed-Validierung des Objekts. Rückbau bleibt möglich,
ist aber kein Merge-Blocker.

---

## 7. Was der Nutzer noch tun muss

Der Import in seinem Profil stammt aus der kaputten Extraktion. Die Verbesserungen
greifen nur bei einem **neuen** Import:

1. Server neu starten
2. Lebenslauf erneut hochladen
3. Über die Claim-Verwaltung die alte Übernahme verwerfen und neu übernehmen

Testdatei: `C:\Users\stuib\Documents\bewerbung\lebenslauf_peter_stuiber_NEW.pdf`
(zweispaltig, 2 Seiten, 12 Stationen — gute Referenz für Extraktionsänderungen).

**Achtung:** Diese Datei enthält echte Personendaten und gehört nicht ins Repo.
Für einen Regressionstest wird eine anonymisierte Fixture gebraucht — die fehlt
weiterhin, und damit sichert derzeit kein Test das zweispaltige Verhalten ab.
Das ist die zweitwichtigste offene Aufgabe nach der Diagnose.

---

## 8. Merge nach `main`

Submodul zuerst, sonst zeigt der Parent auf einen Commit, den `main` nicht kennt:

```bash
cd integrations/bewerbungs-schreib-assistent && git checkout main \
  && git merge --ff-only feat/claim-revocation-and-profile-snapshots && git push origin main
cd ../.. && git checkout main \
  && git merge --ff-only feat/claim-revocation-and-profile-snapshots && git push origin main
```
