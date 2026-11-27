import { InjectionToken } from '@angular/core';
import type { App } from './app';

/**
 * Zugriff auf die App-Komponente für ausgelagerte Bereiche (Hinweise, Fehler, Konfiguration).
 * Eigenes Token statt eines direkten Imports, damit kein Laufzeit-Zyklus App ↔ Bereich entsteht.
 */
export const APP_HOST = new InjectionToken<App>('APP_HOST');
