import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { AppConfig, ApplicationDraft, IdentityProfile, JobMatch, Section, SourceStatus } from './models';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  section: Section = 'overview';
  config?: AppConfig;
  sources: SourceStatus[] = [];
  matches: JobMatch[] = [];
  selectedMatch?: JobMatch;
  draft?: ApplicationDraft;
  assistant = { available: false, note: 'Status wird geladen …' };
  loading = true;
  busy = false;
  notice = '';
  error = '';
  documentType: 'cover_letter' | 'email' = 'cover_letter';

  readonly nav: { id: Section; label: string; icon: string }[] = [
    { id: 'overview', label: 'Übersicht', icon: 'grid' },
    { id: 'search', label: 'Jobsuche', icon: 'search' },
    { id: 'identity', label: 'Profil & Identität', icon: 'user' },
    { id: 'sources', label: 'Quellen & MCP', icon: 'nodes' },
    { id: 'applications', label: 'Bewerbung', icon: 'file' }
  ];

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.api.config().subscribe({
      next: (config) => { this.config = config; this.loading = false; this.refreshView(); },
      error: (error) => this.fail(error)
    });
    this.refreshSources();
    this.api.assistantStatus().subscribe({ next: (status) => { this.assistant = status; this.refreshView(); } });
  }

  refreshSources(): void {
    this.api.sources().subscribe({
      next: (sources) => { this.sources = sources; this.refreshView(); },
      error: (error) => { this.sources = []; this.error = this.message(error); this.refreshView(); }
    });
  }

  select(section: Section): void { this.section = section; this.notice = ''; this.error = ''; }
  activeIdentity(): IdentityProfile | undefined {
    return this.config?.identities.find((identity) => identity.id === this.config?.activeIdentityId);
  }

  saveConfig(message = 'Konfiguration lokal gespeichert.'): void {
    if (!this.config) return;
    this.busy = true;
    this.api.saveConfig(this.config).subscribe({
      next: (config) => { this.config = config; this.busy = false; this.notice = message; this.error = ''; this.refreshSources(); this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  createIncognito(): void {
    if (!this.config) return;
    this.busy = true;
    this.api.createIncognito(this.config.searchProfile.regions[0] ?? 'Deutschland').subscribe({
      next: (identity) => {
        this.config?.identities.push(identity);
        if (this.config) this.config.activeIdentityId = identity.id;
        this.busy = false;
        this.notice = 'Neue Scheinidentität mit sicheren Platzhaltern angelegt.';
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  runSearch(): void {
    if (!this.config) return;
    this.busy = true; this.error = ''; this.notice = '';
    this.api.search(this.config.searchProfile).subscribe({
      next: ({ matches }) => {
        this.matches = matches; this.selectedMatch = matches[0]; this.busy = false; this.section = 'search';
        this.notice = `${matches.length} Stellen bewertet.`;
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  chooseMatch(match: JobMatch): void { this.selectedMatch = match; }

  prepareApplication(match = this.selectedMatch): void {
    if (!match || !this.config) return;
    this.selectedMatch = match; this.busy = true;
    this.api.draft(match, this.config.activeIdentityId, this.documentType).subscribe({
      next: (draft) => { this.draft = draft; this.busy = false; this.section = 'applications'; this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  login(source: SourceStatus): void {
    this.busy = true; this.notice = ''; this.error = '';
    this.api.login(source.id).subscribe({
      next: (result) => { this.busy = false; this.notice = result.note || `Login-Status: ${result.status}`; this.refreshSources(); this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  updateList(field: 'regions' | 'mustHave' | 'niceToHave' | 'exclude', value: string): void {
    if (!this.config) return;
    this.config.searchProfile[field] = value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  list(field: 'regions' | 'mustHave' | 'niceToHave' | 'exclude'): string {
    return this.config?.searchProfile[field].join(', ') ?? '';
  }

  toggleSource(sourceId: string, enabled: boolean): void {
    if (!this.config) return;
    const selected = new Set(this.config.searchProfile.sourceIds);
    enabled ? selected.add(sourceId) : selected.delete(sourceId);
    this.config.searchProfile.sourceIds = [...selected];
  }

  updateMcpArgs(value: string): void {
    if (this.config) this.config.mcp.args = value.split(' ').map((item) => item.trim()).filter((item) => item.length > 0);
  }

  sourceSelected(sourceId: string): boolean { return this.config?.searchProfile.sourceIds.includes(sourceId) ?? false; }
  acceptedCount(): number { return this.matches.filter((match) => match.accepted).length; }

  private refreshView(): void { this.changeDetector.markForCheck(); }
  private fail(error: unknown): void { this.busy = false; this.loading = false; this.error = this.message(error); this.refreshView(); }
  private message(error: unknown): string {
    if (typeof error === 'object' && error && 'error' in error) {
      const body = (error as { error?: { error?: string } }).error;
      if (body?.error) return body.error;
    }
    return error instanceof Error ? error.message : 'Die Aktion ist fehlgeschlagen.';
  }
}
