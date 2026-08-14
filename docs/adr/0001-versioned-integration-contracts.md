# ADR 0001: Versionierte Integrationsverträge

- Status: angenommen
- Datum: 2026-08-13

## Kontext

Angular, lokale API und zwei unabhängig versionierte Submodules entwickeln sich getrennt. Direkte
Imports interner Modelle würden Releases koppeln und Portal- sowie Evidence-Verantwortungen in das
Hauptprojekt verschieben.

## Entscheidung

Die innere Anwendung besitzt kleine Ports. Submodules veröffentlichen maschinenlesbare Verträge
mit semantischer Major-/Minor-Version. MCP bleibt der Portaltransport; die Bewerbungspipeline wird
über lokale CLI-/Artefaktverträge integriert. Synthetische Fixtures definieren die gemeinsame
Contract-Suite.

## Verworfene Alternativen

- Gemeinsames Universalmodell: vermischt Suchpräferenzen, Portalrohdaten und Kandidatenevidence.
- Direkte Python-Imports aus Node: koppeln Laufzeiten und interne Modulstrukturen.
- Unversionierte JSON-Antworten: machen inkompatible Änderungen erst zur Laufzeit sichtbar.

## Konsequenzen

Additive Felder sind günstig; Breaking Changes benötigen Migration und neues Major. Submodule
werden zuerst separat veröffentlicht und danach gepinnt. Contract-Tests kommen zusätzlich zu den
jeweiligen Unit- und Integrationstests hinzu.
