import { Routes } from '@angular/router';
import type { Section } from './models';

/** URL-Pfad je Arbeitsbereich. Reihenfolge und Namen bleiben deutsch, wie die Oberfläche. */
export const SECTION_PATHS: Record<Section, string> = {
  overview: '',
  search: 'jobs/suche',
  jobs: 'jobs/liste',
  identity: 'profil',
  cv: 'profil/lebenslauf',
  sources: 'einstellungen/quellen',
  applications: 'bewerbung',
  crm: 'bewerbung/firmen',
  agents: 'agenten',
  operations: 'einstellungen/daten'
};

/** Frühere Adressen leiten weiter, damit Lesezeichen gültig bleiben. */
export const LEGACY_REDIRECTS: Record<string, string> = {
  jobsuche: 'jobs/suche',
  'meine-jobs': 'jobs/liste',
  jobs: 'jobs/suche',
  lebenslauf: 'profil/lebenslauf',
  quellen: 'einstellungen/quellen',
  betrieb: 'einstellungen/daten',
  einstellungen: 'einstellungen/quellen',
  firmen: 'bewerbung/firmen'
};

const SECTION_TITLES: Record<Section, string> = {
  overview: 'Übersicht',
  search: 'Jobsuche',
  jobs: 'Meine Jobs',
  identity: 'Profil & Identität',
  cv: 'Lebenslauf-Studio',
  sources: 'Quellen & MCP',
  applications: 'Bewerbungswerkstatt',
  crm: 'Firmen & Antworten',
  agents: 'Agent Center',
  operations: 'Daten & Betrieb'
};

/** Liefert den Bereich zu einer URL (ohne Query und Fragment); unbekannte Pfade fallen auf die Übersicht zurück. */
export function sectionFromUrl(url: string): Section {
  const raw = url.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  const path = LEGACY_REDIRECTS[raw] ?? raw;
  const match = (Object.entries(SECTION_PATHS) as Array<[Section, string]>).find(([, value]) => value === path);
  return match ? match[0] : 'overview';
}

/** Absolute URL eines Bereichs. */
export function sectionUrl(section: Section): string {
  return `/${SECTION_PATHS[section]}`;
}

// Die Bereiche werden noch von der App-Komponente gerendert; die Routen tragen URL und Seitentitel.
// `children: []` ist eine gültige Route ohne eigene Komponente und braucht kein <router-outlet>.
export const routes: Routes = [
  ...(Object.entries(SECTION_PATHS) as Array<[Section, string]>).map(([section, path]) => ({
    path,
    pathMatch: 'full' as const,
    title: `${SECTION_TITLES[section]} · JobMatch & Apply`,
    data: { section },
    children: []
  })),
  ...Object.entries(LEGACY_REDIRECTS).map(([path, redirectTo]) => ({ path, pathMatch: 'full' as const, redirectTo })),
  { path: '**', redirectTo: '' }
];
