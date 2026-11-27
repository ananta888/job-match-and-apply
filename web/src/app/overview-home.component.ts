import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** Kompakte Stelle für den Treffer-Feed der Startseite. */
export interface OverviewMatch {
  id: string;
  title: string;
  company: string;
  location: string;
  workModel: string;              // remote | hybrid | onsite | unknown
  source: string;
  score: number;                  // 0–100
  reasons: string[];              // erfüllte Muss-/Wunschkriterien
  salary?: string;
  saved: boolean;
}

/** Zustand, aus dem die Startseite den einen nächsten Schritt ableitet. */
export interface OverviewState {
  greetingName?: string;          // leer bei Inkognito
  cvConfirmed: boolean;
  pendingDecisions: number;       // offene Agenten-Rückfragen und Freigaben
  topCandidate?: { title: string; company: string; score: number };
  hoursSinceLastSearch?: number;
  pipeline: { neu: number; zuBewerben: number; inArbeit: number; freigegeben: number; antworten: number };
  status: { mcpConnected: boolean; portalsOpen: boolean; aiProviderReady: boolean };
  profile: { name: string; query: string; regions: string[]; mustHave: string[] };
  topMatches?: OverviewMatch[];
}

export type OverviewAction = 'import-cv' | 'review-decisions' | 'start-application' | 'search' | 'open-crm' | 'edit-profile'
  | 'open-jobs' | 'open-applications' | 'open-sources' | 'open-data';

interface NextStep { kicker: string; title: string; reason: string; cta: string; action: OverviewAction }
type Tone = 'ok' | 'warn' | 'info';
type MatchFilter = 'alle' | 'top';

@Component({
  selector: 'app-overview-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview-home.component.html',
  host: { class: 'tw block font-sans text-ink' }
})
export class OverviewHomeComponent {
  readonly state = input.required<OverviewState>();
  readonly act = output<OverviewAction>();
  /** Bewerbung für eine konkrete Stelle aus dem Feed starten. */
  readonly startMatch = output<string>();
  /** Stelle merken bzw. Merken aufheben. */
  readonly toggleSave = output<string>();

  protected readonly filter = signal<MatchFilter>('alle');
  /** Text für die aria-live-Region */
  protected readonly announcement = signal('');

  protected readonly today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    const base = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
    const name = this.state().greetingName;
    return name ? `${base}, ${name}` : base;
  });

  /** Feste Reihenfolge: Grundlagen, wartende Entscheidungen, beste Stelle, frische Suche, sonst Antworten. */
  readonly next = computed<NextStep>(() => {
    const s = this.state();
    if (!s.cvConfirmed) return { kicker: 'Einmalig', title: 'Lebenslauf importieren', reason: 'Belegte Fakten aus deinem Lebenslauf sind die Grundlage jeder Bewerbung.', cta: 'Lebenslauf hochladen', action: 'import-cv' };
    if (s.pendingDecisions > 0) return { kicker: 'Wartet auf dich', title: `${s.pendingDecisions} ${s.pendingDecisions === 1 ? 'Entscheidung' : 'Entscheidungen'} offen`, reason: 'Die Agenten brauchen eine Antwort oder Freigabe, bevor sie weiterarbeiten.', cta: 'Jetzt prüfen', action: 'review-decisions' };
    if (s.topCandidate) return { kicker: 'Beste offene Stelle', title: `${s.topCandidate.title} bei ${s.topCandidate.company}`, reason: `Passt zu ${s.topCandidate.score} % zu deinem Suchprofil und liegt in „Zu bewerben“.`, cta: 'Bewerbung starten', action: 'start-application' };
    if (s.pipeline.neu > 0) return { kicker: 'Neue Treffer', title: `${s.pipeline.neu} neue ${s.pipeline.neu === 1 ? 'Stelle passt' : 'Stellen passen'} zu deinem Profil`, reason: 'Sortiert nach Übereinstimmung. Entscheide in Sekunden: merken, bewerben oder ausblenden.', cta: 'Treffer sichten', action: 'open-jobs' };
    if ((s.hoursSinceLastSearch ?? Infinity) >= 24) return { kicker: 'Aktualisieren', title: 'Neue Stellen prüfen', reason: 'Deine letzte Suche ist mehr als einen Tag her. Deine Daten verlassen dieses Gerät dabei nicht.', cta: 'Jetzt suchen', action: 'search' };
    // Kein Sackgassen-Leerzustand mehr: immer eine sinnvolle nächste Aktion.
    return { kicker: 'Alles erledigt', title: 'Keine offenen Aufgaben', reason: 'Starte eine neue Suche oder sieh nach, ob Firmen geantwortet haben.', cta: 'Neue Suche starten', action: 'search' };
  });

  readonly profileLine = computed(() => {
    const profile = this.state().profile;
    return [profile.query, ...profile.regions].filter((part) => part.trim()).join(' · ');
  });

  readonly statusChips = computed<Array<{ id: string; label: string; tone: Tone }>>(() => {
    const st = this.state().status;
    return [
      { id: 'quellen', label: st.mcpConnected ? 'Quellen verbunden' : 'Demo-Daten aktiv', tone: st.mcpConnected ? 'ok' : 'info' },
      { id: 'lokal', label: 'Daten nur auf diesem Gerät', tone: 'ok' },
      { id: 'portale', label: st.portalsOpen ? 'Portale freigegeben' : 'Portalzugriff gesperrt', tone: st.portalsOpen ? 'ok' : 'warn' },
    ];
  });

  readonly stages = computed(() => {
    const p = this.state().pipeline;
    return [
      { key: 'neu', label: 'Neu', hint: 'Treffer sichten', count: p.neu, href: '/jobs/liste', action: 'open-jobs' as const },
      { key: 'zuBewerben', label: 'Zu bewerben', hint: 'Unterlagen erstellen', count: p.zuBewerben, href: '/jobs/liste', action: 'open-jobs' as const },
      { key: 'inArbeit', label: 'In Arbeit', hint: 'Entwurf prüfen', count: p.inArbeit, href: '/bewerbung', action: 'open-applications' as const },
      { key: 'freigegeben', label: 'Freigegeben', hint: 'Bereit zum Versand', count: p.freigegeben, href: '/bewerbung', action: 'open-applications' as const },
      { key: 'antworten', label: 'Antworten', hint: 'Rückmeldungen lesen', count: p.antworten, href: '/bewerbung/firmen', action: 'open-crm' as const },
    ];
  });

  readonly matches = computed(() => this.state().topMatches ?? []);
  readonly visibleMatches = computed(() =>
    this.filter() === 'top' ? this.matches().filter((m) => m.score >= 80) : this.matches());

  /** Links bleiben echte Links (neuer Tab, Kontextmenü); ein normaler Klick navigiert in der App. */
  openStage(event: MouseEvent, action: OverviewAction): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.act.emit(action);
  }

  setFilter(f: MatchFilter): void {
    this.filter.set(f);
    this.announcement.set(`${this.visibleMatches().length} Treffer angezeigt`);
  }

  onToggleSave(m: OverviewMatch): void {
    this.toggleSave.emit(m.id);
    this.announcement.set(m.saved ? `${m.title} nicht mehr gemerkt` : `${m.title} gemerkt`);
  }

  workModelLabel(model: string): string {
    return ({ remote: 'Remote', hybrid: 'Hybrid', onsite: 'Vor Ort' } as Record<string, string>)[model] ?? '';
  }

  /** Score-Band wie in der Jobsuche: ab 80 passend, ab 60 prüfen. Immer Zahl + Text + Balken, nie nur Farbe. */
  scoreBand(score: number): { label: string; badge: string; bar: string } {
    if (score >= 80) return { label: 'Passt gut', badge: 'bg-ok-soft text-ok', bar: 'bg-ok' };
    if (score >= 60) return { label: 'Teilweise passend', badge: 'bg-brand-50 text-brand-700', bar: 'bg-brand-600' };
    return { label: 'Wenig passend', badge: 'bg-warn-soft text-warn', bar: 'bg-warn' };
  }

  toneClass(tone: Tone): string {
    return {
      ok: 'border-ok/25 bg-ok-soft text-ok',
      warn: 'border-warn/25 bg-warn-soft text-warn',
      info: 'border-brand-200 bg-brand-50 text-brand-700',
    }[tone];
  }
}
