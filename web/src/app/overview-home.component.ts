import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

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
}

export type OverviewAction = 'import-cv' | 'review-decisions' | 'start-application' | 'search' | 'open-crm' | 'edit-profile'
  | 'open-jobs' | 'open-applications' | 'open-sources';

interface NextStep { kicker: string; title: string; reason: string; cta: string; action: OverviewAction }

@Component({
  selector: 'app-overview-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview-home.component.html',
  styleUrl: './overview-home.component.scss'
})
export class OverviewHomeComponent {
  readonly state = input.required<OverviewState>();
  readonly act = output<OverviewAction>();

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
    if ((s.hoursSinceLastSearch ?? Infinity) >= 24) return { kicker: 'Aktualisieren', title: 'Neue Stellen prüfen', reason: 'Deine letzte Suche ist mehr als einen Tag her.', cta: 'Jetzt suchen', action: 'search' };
    return { kicker: 'Alles erledigt', title: 'Keine offenen Aufgaben', reason: 'Antworten von Firmen findest du in den Firmenakten.', cta: 'Firmenakten öffnen', action: 'open-crm' };
  });

  readonly profileLine = computed(() => {
    const profile = this.state().profile;
    return [profile.query, ...profile.regions].filter((part) => part.trim()).join(' · ');
  });

  /** Links bleiben echte Links (neuer Tab, Kontextmenü); ein normaler Klick navigiert in der App. */
  openStage(event: MouseEvent, action: OverviewAction): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.act.emit(action);
  }

  readonly stages = computed(() => {
    const p = this.state().pipeline;
    return [
      { key: 'neu', label: 'Neu', count: p.neu, href: '/meine-jobs', action: 'open-jobs' as const },
      { key: 'zuBewerben', label: 'Zu bewerben', count: p.zuBewerben, href: '/meine-jobs', action: 'open-jobs' as const },
      { key: 'inArbeit', label: 'In Arbeit', count: p.inArbeit, href: '/bewerbung', action: 'open-applications' as const },
      { key: 'freigegeben', label: 'Freigegeben', count: p.freigegeben, href: '/bewerbung', action: 'open-applications' as const },
      { key: 'antworten', label: 'Antworten', count: p.antworten, href: '/firmen', action: 'open-crm' as const },
    ];
  });
}
