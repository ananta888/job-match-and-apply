# Schneller Abschluss nach nachgewiesenem Reasoning-Abbruch
Ziel: denselben belegten Dokumentstand fertigstellen, ohne vier erfolgreiche Rollen erneut zu bezahlen.
Befund: High meldete 50.000 Reasoning-Tokens, null sichtbare Zeichen, finish_reason=length.
Ansätze: weiteres Budget erhöht den belegten Leerlauf; automatischer Fallback verschleiert die wirksame Einstellung. Gewählte Umsetzung innerhalb des beauftragten konfigurierbaren Ablaufs: ausdrückliche schnelle Wiederholung.
Ein neuer Retry-Zweig darf ausschließlich beim fehlgeschlagenen OpenRouter-Finalizer das Reasoning verändern. Der Ursprung bleibt unverändert; die neue Run-Konfiguration friert den Unterschied ein. Daten, Modell, Anbieter, Rechte und Vorstufen bleiben gebunden. Die Oberfläche nennt Reasoning Aus ausdrücklich. Kein globales Profil wird geändert.
