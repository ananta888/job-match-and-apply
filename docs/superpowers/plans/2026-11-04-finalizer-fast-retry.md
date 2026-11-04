# Schneller Finalizer: Implementierungsplan
Ziel/Architektur: vorhandenen gezielten Retry um eine explizite Reasoning-Wahl für den OpenRouter-Finalizer ergänzen; Angular/TypeScript ohne Abhängigkeiten.
Spec: ../specs/2026-11-04-finalizer-fast-retry-design.md
- [x] Regression: High scheitert, expliziter Off-Zweig gelingt, vier Artefakte/Eingaben unverändert, Ursprung weiterhin High.
- [x] API validiert reasoning; Service erlaubt Änderung nur für OpenRouter-Finalizer und friert neue Rollenwahl ein.
- [x] Angular-Button im CV und Bewerbungsbereich mit ausdrücklicher Off-Beschriftung; gemeinsame Retry-Logik.
- [ ] Tests/Build/Review, sichern und lokal veröffentlichen, nur Abschluss des betroffenen Laufes mit Off prüfen.
