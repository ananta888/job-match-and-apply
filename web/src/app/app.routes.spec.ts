import { LEGACY_REDIRECTS, routes, sectionFromUrl, sectionUrl, SECTION_PATHS } from './app.routes';
import type { Section } from './models';

describe('Bereichs-Routing', () => {
  it('bildet jeden Bereich auf eine eindeutige URL ab und wieder zurück', () => {
    const sections = Object.keys(SECTION_PATHS) as Section[];
    expect(new Set(sections.map(sectionUrl)).size).toBe(sections.length);
    for (const section of sections) expect(sectionFromUrl(sectionUrl(section))).toBe(section);
  });

  it('ignoriert Query, Fragment und Schrägstriche und fällt bei Unbekanntem auf die Übersicht zurück', () => {
    expect(sectionFromUrl('/agenten?run=1#log')).toBe('agents');
    expect(sectionFromUrl('/profil/lebenslauf/')).toBe('cv');
    expect(sectionFromUrl('/')).toBe('overview');
    expect(sectionFromUrl('/gibt-es-nicht')).toBe('overview');
  });

  it('setzt einen Seitentitel pro Bereich und leitet Unbekanntes um', () => {
    const titled = routes.filter((route) => route.title);
    expect(titled).toHaveLength(Object.keys(SECTION_PATHS).length);
    expect(titled.find((route) => route.path === 'agenten')?.title).toBe('Agent Center · JobMatch & Apply');
    expect(routes.at(-1)).toEqual({ path: '**', redirectTo: '' });
  });

  it('gruppiert die Bereiche unter Jobs, Profil, Bewerbung und Einstellungen und leitet alte Adressen weiter', () => {
    expect(sectionUrl('search')).toBe('/jobs/suche');
    expect(sectionUrl('jobs')).toBe('/jobs/liste');
    expect(sectionUrl('cv')).toBe('/profil/lebenslauf');
    expect(sectionUrl('crm')).toBe('/bewerbung/firmen');
    expect(sectionUrl('sources')).toBe('/einstellungen/quellen');
    for (const [legacy, target] of Object.entries(LEGACY_REDIRECTS)) {
      expect(routes.find((route) => route.path === legacy)).toMatchObject({ redirectTo: target, pathMatch: 'full' });
      expect(sectionFromUrl(`/${legacy}`)).toBe(sectionFromUrl(`/${target}`));
    }
  });
});
