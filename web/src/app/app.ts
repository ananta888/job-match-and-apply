import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, forwardRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router } from '@angular/router';
import { sectionFromUrl, sectionUrl } from './app.routes';
import { ApiService } from './api.service';
import { AgentCenterComponent } from './agent-center.component';
import { AgentCenterStore } from './agent-center.store';
import { CvStudioComponent } from './cv-studio.component';
import { CvStudioStore } from './cv-studio.store';
import { OverviewHomeComponent, type OverviewAction, type OverviewState } from './overview-home.component';
import { APP_HOST } from './app-host';
import { CvFactsEditorComponent } from './cv-facts-editor.component.js';
import { type Subscription } from 'rxjs';
import type { AgentOrchestrationRecord, AgentRunRequest, AppConfig, ApplicationCase, ApplicationDraft, ApplicationExportResult, ApplicationProfileSetupStatus, ApplicationStyleDocumentType, ApplicationStyleExampleDocumentType, ApplicationStyleProfileView, ArtifactRevision, CandidateMatchAnalysis, CandidateProfileSummary, CompanyCrm, CorrelatedMail, JobInventoryView, JobInventoryCategory, SearchRunSummary, JobSearchMcpRuntimeCandidate, JobSearchMcpRuntimeTarget, DataInventory, EditableApplicationStyleProfile, IdentityProfile, JobDecision, JobMatch, JobSourceCapabilities, LanguageCheckResult, MailAccount, McpRuntimeStatus, ProfileImportPreview, SearchSchedule, Section, SourceCapability, SourceStatus } from './models';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, CvFactsEditorComponent, AgentCenterComponent, CvStudioComponent, OverviewHomeComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  providers: [{ provide: APP_HOST, useExisting: forwardRef(() => App) }]
})
export class App implements OnInit, OnDestroy {
  /** Zustand und Logik des Agent Centers; auch von Lebenslauf und Bewerbung genutzt. */
  readonly agents = inject(AgentCenterStore);
  /** Zustand und Logik des Lebenslauf-Studios; auch von Profil und Bewerbung genutzt. */
  readonly cv = inject(CvStudioStore);
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  // Optional, damit Unit-Tests ohne Router-Provider weiterlaufen.
  private readonly router = inject(Router, { optional: true });
  private routerSubscription?: Subscription;
  section: Section = 'overview';

  constructor() { this.agents.attach(this); this.cv.attach(this); }
  config?: AppConfig;
  sources: SourceStatus[] = [];
  capabilities?: JobSourceCapabilities;
  mcpRuntime?: McpRuntimeStatus;
  mcpRuntimeCandidates: JobSearchMcpRuntimeCandidate[] = [];
  mcpRuntimeBusy = false;
  matches: JobMatch[] = [];
  lastSearchRunId?: string;
  lastSearchAdopted = false;
  searchFailures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }> = [];
  jobDecisions: JobDecision[] = [];
  jobInventory: JobInventoryView[] = [];
  searchRunSummaries: SearchRunSummary[] = [];
  jobsBusy = false;
  jobsError = '';
  jobsNotice = '';
  jobsFilter: 'all' | 'applied' | 'open' = 'all';
  readonly jobCategories: JobInventoryCategory[] = ['inbox', 'apply', 'watchlist', 'archive'];
  selectedMatch?: JobMatch;
  draft?: ApplicationDraft;
  profileSetup?: ApplicationProfileSetupStatus;
  profileSetupConfirmed = false;
  styleProfileDraft?: EditableApplicationStyleProfile;
  styleVocabularyPreferText = '';
  styleVocabularyAvoidText = '';
  stylePreferredPatternsText = '';
  styleAvoidPatternsText = '';
  styleProfileConfirmed = false;
  styleProfileBusy = false;
  readonly styleDocumentTypes: ApplicationStyleDocumentType[] = ['cv', 'cover_letter', 'email', 'linkedin'];
  readonly styleExampleDocumentTypes: ApplicationStyleExampleDocumentType[] = ['cv', 'cover_letter', 'email', 'linkedin', 'interview'];
  candidateProfile?: CandidateProfileSummary;
  matchAnalysis?: CandidateMatchAnalysis;
  applicationCases: ApplicationCase[] = [];
  selectedApplicationCaseId?: string;
  applicationArtifacts: Record<string, ArtifactRevision[]> = {};
  applicationAgentOrchestrationId?: string;
  private readonly pipelineDraftsByCase: Record<string, { annotatedContent: string; iterationManifest: string }> = {};
  pipelineAnnotatedContent = '';
  pipelineIterationManifest = '';
  languageCheckResult?: LanguageCheckResult;
  languageCheckBusy = false;
  artifactReviewConfirmed: Record<string, boolean> = {};
  artifactExportConfirmed: Record<string, boolean> = {};
  artifactExportFormat: Record<string, 'docx' | 'pdf'> = {};
  applicationExportResult?: ApplicationExportResult;
  companies: CompanyCrm[] = [];
  mailAccounts: MailAccount[] = [];
  mailInbox: CorrelatedMail[] = [];
  /** Zugeordnete Antworten von Firmen, für die Pipeline der Startseite. */
  overviewReplies = 0;
  mailCorrelationTarget: Record<string, string> = {};
  mailAccountForm = { label: '', email: '', host: '', port: 993, secure: true, username: '', secret: '', authType: 'password' as const, enabled: false, mailbox: 'INBOX' };
  importPreview?: ProfileImportPreview;
  assistant = { available: false, note: 'Status wird geladen …' };
  loading = true;
  busy = false;
  notice = '';
  error = '';
  documentType: 'cv' | 'cover_letter' | 'email' = 'cover_letter';
  revealSensitiveIdentity = false;
  portalPermissionIntent?: 'enable' | 'disable';
  portalPermissionConfirmed = false;
  dataInventory?: DataInventory;
  schedules: SearchSchedule[] = [];
  exportPreview?: Record<string, unknown>;
  retentionDays = 180;
  resultSort: 'score' | 'title' | 'company' = 'score';
  comparisonJobIds: string[] = [];
  comparison?: { comparison: Array<{ jobId: string; title: string; company: string; total: number; factors: Record<string, number> }>; disclaimer: string };
  private portalPermissionReturnFocus?: HTMLElement;
  @ViewChild('portalPermissionDialogElement') private portalPermissionDialogElement?: ElementRef<HTMLDialogElement>;
  @ViewChild('portalPermissionConfirm') private portalPermissionConfirm?: ElementRef<HTMLInputElement>;

  readonly nav: { id: Section; label: string; icon: string }[] = [
    { id: 'overview', label: 'Übersicht', icon: 'grid' },
    { id: 'search', label: 'Suche', icon: 'search' },
    { id: 'jobs', label: 'Meine Jobs', icon: 'grid' },
    { id: 'applications', label: 'Bewerbungsfälle', icon: 'file' },
    { id: 'crm', label: 'Firmen & Antworten', icon: 'nodes' },
    { id: 'identity', label: 'Profil & Identität', icon: 'user' },
    { id: 'cv', label: 'Lebenslauf', icon: 'file' },
    { id: 'agents', label: 'Agent Center', icon: 'terminal' },
    { id: 'sources', label: 'Quellen & MCP', icon: 'nodes' },
    { id: 'operations', label: 'Daten & Betrieb', icon: 'nodes' }
  ];

  /** Sechs Hauptbereiche; Gruppen mit mehreren Einträgen zeigen eine Überschrift. */
  readonly navGroups: { label?: string; items: { id: Section; label: string; icon: string }[] }[] = [
    { items: this.navItems(['overview']) },
    { label: 'Jobs', items: this.navItems(['search', 'jobs']) },
    { label: 'Bewerbungen', items: this.navItems(['applications', 'crm']) },
    { label: 'Profil', items: this.navItems(['identity', 'cv']) },
    { items: this.navItems(['agents']) },
    { label: 'Einstellungen', items: this.navItems(['sources', 'operations']) }
  ];

  /** Mobile Leiste unten: die drei häufigsten Ziele plus „Mehr“. */
  readonly mobileNav: { id: Section; label: string; group: Section[] }[] = [
    { id: 'overview', label: 'Übersicht', group: ['overview'] },
    { id: 'search', label: 'Jobs', group: ['search', 'jobs'] },
    { id: 'applications', label: 'Bewerbung', group: ['applications', 'crm'] }
  ];
  mobileMenuOpen = false;
  /** Filterleiste der Jobsuche als Blatt auf Tablet und Handy. */
  filtersOpen = false;
  lastHiddenMatch?: { jobId: string; title: string };
  private lastHiddenTimer?: ReturnType<typeof setTimeout>;

  private navItems(ids: Section[]): { id: Section; label: string; icon: string }[] {
    return ids.map((id) => this.nav.find((item) => item.id === id)!);
  }

  toggleMobileMenu(open = !this.mobileMenuOpen): void { this.mobileMenuOpen = open; }

  ngOnInit(): void {
    this.agents.configureAgentMotionPreference();
    this.bindSectionToRouter();
    this.load();
  }

  ngOnDestroy(): void {
    if (this.lastHiddenTimer) clearTimeout(this.lastHiddenTimer);
    this.routerSubscription?.unsubscribe();
    this.agents.stopAgentPolling(); this.agents.stopAgentStream(); this.cv.stopCvAiPolling();
    if (this.agents.agentPreflightTimer) clearTimeout(this.agents.agentPreflightTimer);
    this.agents.agentMotionMedia?.removeEventListener?.('change', this.agents.agentMotionListener);
  }

  load(): void {
    this.loading = true;
    this.api.config().subscribe({
      next: (config) => { this.config = this.normalizeConfigForUi(config); this.loading = false; this.refreshView(); },
      error: (error) => this.fail(error)
    });
    this.refreshSources();
    this.api.jobDecisions().subscribe({ next: (items) => { this.jobDecisions = items; this.refreshView(); } });
    if (this.section === 'overview') this.loadOverview();
    this.api.assistantStatus().subscribe({ next: (status) => { this.assistant = status; this.refreshView(); } });
    this.loadProfileSetup();
  }

  refreshSources(): void {
    this.api.sources().subscribe({
      next: (sources) => { this.sources = sources; this.refreshView(); },
      error: (error) => { this.sources = []; this.error = this.message(error); this.refreshView(); }
    });
    this.api.capabilities().subscribe({
      next: (capabilities) => { this.capabilities = capabilities; this.refreshView(); },
      error: (error) => { this.error = this.message(error); this.refreshView(); }
    });
    this.api.sourceRuntime().subscribe({
      next: (runtime) => { this.mcpRuntime = runtime; this.refreshView(); },
      error: (error) => {
        const runtime = typeof error === 'object' && error && 'error' in error ? (error as { error?: McpRuntimeStatus }).error : undefined;
        this.mcpRuntime = runtime?.contract === 'job-search-mcp-runtime-status' ? runtime : undefined;
        if (!this.mcpRuntime) this.error = this.message(error);
        this.refreshView();
      }
    });
    this.api.mcpRuntimeCandidates().subscribe({
      next: (result) => { this.mcpRuntimeCandidates = result.candidates; this.refreshView(); },
      error: () => { this.mcpRuntimeCandidates = []; this.refreshView(); }
    });
  }

  selectMcpRuntime(runtimeTarget: JobSearchMcpRuntimeTarget): void {
    if (!this.config || this.mcpRuntimeBusy) return;
    this.mcpRuntimeBusy = true; this.error = ''; this.notice = '';
    this.api.selectMcpRuntime(runtimeTarget, this.config.revision).subscribe({
      next: (config) => {
        this.config = config; this.mcpRuntimeBusy = false;
        this.notice = `Job-Suche-MCP läuft jetzt über die Runtime „${this.mcpRuntimeLabelFor(runtimeTarget)}“.`;
        this.refreshSources(); this.refreshView();
      },
      error: (error) => { this.mcpRuntimeBusy = false; this.error = this.message(error); this.refreshView(); }
    });
  }
  mcpRuntimeLabelFor(target: JobSearchMcpRuntimeTarget): string {
    return ({ windows: 'Nativ (Windows)', wsl: 'WSL (Ubuntu)', darwin: 'Nativ (macOS)' } as const)[target];
  }

  /** Daten der Startseite: nächster Schritt, Pipeline, Suchprofil und Systemstatus. */
  overviewState(): OverviewState {
    const identity = this.activeIdentity();
    const firstName = identity && identity.mode === 'real' && this.revealSensitiveIdentity ? identity.fullName.split(' ')[0] : undefined;
    const open = this.jobInventory.filter((entry) => !entry.status.applied);
    const candidate = open.filter((entry) => entry.category === 'apply')
      .sort((left, right) => (right.match?.score ?? 0) - (left.match?.score ?? 0))[0];
    const lastSearch = this.searchRunSummaries.map((run) => Date.parse(run.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const working: ApplicationCase['state'][] = ['selected', 'analysis', 'questions', 'draft', 'review'];
    const approved: ApplicationCase['state'][] = ['approved', 'exported', 'dry_run', 'submitted'];
    return {
      greetingName: firstName,
      cvConfirmed: this.cv.cvImportInventory.length > 0 || Boolean(this.candidateProfile?.claims?.length),
      pendingDecisions: this.agents.globalAgentApprovals().filter((item) => item.actionable).length,
      topCandidate: candidate ? { title: candidate.job.title, company: candidate.job.company, score: Math.round(candidate.match?.score ?? 0) } : undefined,
      hoursSinceLastSearch: lastSearch ? (Date.now() - lastSearch) / 3_600_000 : undefined,
      pipeline: {
        neu: open.filter((entry) => entry.category === 'inbox').length,
        zuBewerben: open.filter((entry) => entry.category === 'apply').length,
        inArbeit: this.applicationCases.filter((item) => working.includes(item.state)).length,
        freigegeben: this.applicationCases.filter((item) => approved.includes(item.state)).length,
        antworten: this.overviewReplies,
      },
      status: {
        mcpConnected: this.mcpRuntime?.connected === true || this.sources.some((source) => source.kind === 'mcp' && source.connected),
        portalsOpen: this.config?.mcp.env['ALLOW_EXTERNAL_PORTALS'] === '1',
        aiProviderReady: this.agents.agentProviders.some((provider) => provider.available),
      },
      profile: {
        name: this.config?.searchProfile.name ?? '',
        query: this.config?.searchProfile.query ?? '',
        regions: this.config?.searchProfile.regions ?? [],
        mustHave: this.config?.searchProfile.mustHave ?? [],
      },
      topMatches: open.filter((entry) => entry.category === 'inbox' || entry.category === 'apply')
        .filter((entry) => this.jobDecision(entry.job.id) !== 'hidden')
        .sort((left, right) => (right.match?.score ?? 0) - (left.match?.score ?? 0))
        .slice(0, 3)
        .map((entry) => ({
          id: entry.key,
          title: entry.job.title,
          company: entry.job.company,
          location: entry.job.location,
          workModel: entry.job.workModel,
          source: entry.job.sourceId,
          score: Math.round(entry.match?.score ?? 0),
          reasons: [...(entry.match?.matchedMustHave ?? []), ...(entry.match?.matchedNiceToHave ?? [])],
          salary: this.overviewSalary(entry.job.salaryMin, entry.job.salaryMax),
          saved: this.jobDecision(entry.job.id) === 'saved',
        })),
    };
  }

  private overviewSalary(min?: number, max?: number): string | undefined {
    const k = (value: number) => `${Math.round(value / 1000)} T€`;
    if (min && max) return `${Math.round(min / 1000)}–${k(max)}`;
    if (min) return `ab ${k(min)}`;
    if (max) return `bis ${k(max)}`;
    return undefined;
  }

  /** Bewerbung für eine Stelle aus dem Treffer-Feed der Startseite starten. */
  onOverviewStartMatch(key: string): void {
    const entry = this.jobInventory.find((item) => item.key === key);
    if (entry) this.startApplicationFromInventory(entry); else this.select('jobs');
  }

  /** Stelle aus dem Treffer-Feed merken bzw. Merken aufheben. */
  onOverviewToggleSave(key: string): void {
    const entry = this.jobInventory.find((item) => item.key === key);
    if (!entry) return;
    this.setJobDecision(entry.job.id, this.jobDecision(entry.job.id) === 'saved' ? 'neutral' : 'saved');
  }

  onOverviewAction(action: OverviewAction): void {
    switch (action) {
      case 'import-cv': this.select('cv'); break;
      case 'review-decisions': this.select('agents'); break;
      case 'start-application': {
        const candidate = this.jobInventory.filter((entry) => entry.category === 'apply' && !entry.status.applied)
          .sort((left, right) => (right.match?.score ?? 0) - (left.match?.score ?? 0))[0];
        if (candidate) this.startApplicationFromInventory(candidate); else this.select('jobs');
        break;
      }
      case 'search': this.select('search'); this.runSearch(); break;
      case 'open-crm': this.select('crm'); break;
      case 'edit-profile': this.select('search'); break;
      case 'open-jobs': this.select('jobs'); break;
      case 'open-applications': this.select('applications'); break;
      case 'open-sources': this.select('sources'); break;
      case 'open-data': this.select('operations'); break;
    }
  }

  /** Lädt, was die Startseite zeigt; jede Quelle ist optional und blockiert die anderen nicht. */
  private loadOverview(): void {
    this.loadJobs();
    this.cv.loadCvImportInventory();
    this.loadCandidateProfile();
    this.api.applicationCases().subscribe({ next: (items) => { this.applicationCases = items; this.refreshView(); }, error: () => undefined });
    this.api.agentRuns().subscribe({ next: (runs) => { this.agents.agentRuns = runs; this.refreshView(); }, error: () => undefined });
    if (!this.agents.agentProviders.length) this.agents.loadAgentProviders();
    this.api.mailMessages().subscribe({
      next: (items) => { this.overviewReplies = items.filter((item) => Boolean(item.correlation.applicationCaseId)).length; this.refreshView(); },
      error: () => undefined
    });
  }

  select(section: Section): void {
    this.applySection(section);
    const target = sectionUrl(section);
    // Ohne konfigurierte Routen (z. B. Unit-Tests ohne provideRouter) bleibt die Auswahl rein lokal.
    if (this.router?.config.length && sectionFromUrl(this.router.url) !== section) void this.router.navigateByUrl(target);
  }

  /**
   * Wechselt den sichtbaren Bereich aus einem Ablauf heraus (z. B. „Bewerbung →“), ohne dessen
   * Ladeaktionen auszulösen, und hält die URL synchron, damit F5 und Zurück stimmen.
   */
  private showSection(section: Section): void {
    this.section = section;
    if (this.router?.config.length && sectionFromUrl(this.router.url) !== section) void this.router.navigateByUrl(sectionUrl(section));
  }

  /** Synchronisiert den Bereich mit der URL: F5, Lesezeichen und Zurück-Button landen im richtigen Bereich. */
  private bindSectionToRouter(): void {
    if (!this.router) return;
    this.routerSubscription = this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const section = sectionFromUrl(event.urlAfterRedirects);
      if (section !== this.section) { this.applySection(section); this.refreshView(); }
    });
  }

  private applySection(section: Section): void {
    this.section = section; this.notice = ''; this.error = ''; this.mobileMenuOpen = false;
    if (section !== 'agents' && section !== 'cv' && section !== 'applications') this.agents.stopAgentPolling();
    if (section !== 'agents') { this.agents.stopAgentStream(); this.agents.closeAgentRecoveryDialog(); }
    if (section !== 'cv') this.cv.stopCvAiPolling();
    if (section === 'overview') this.loadOverview();
    if (section === 'jobs') this.loadJobs();
    if (section === 'identity') { this.loadProfileSetup(); this.loadCandidateProfile(); this.cv.loadProfileCvOverview(); }
    if (section === 'cv') this.cv.loadCvStudio();
    if (section === 'applications') {
      this.loadApplicationCases();
      this.cv.loadSourceCvCandidates();
      if (!this.agents.agentConfigProfile) this.agents.loadAgentConfigProfile();
      if (!this.agents.agentProviders.length) this.agents.loadAgentProviders();
      if (!this.agents.agentWorkflows.length) this.api.agentWorkflows().subscribe({
        next: (items) => { this.agents.agentWorkflows = items; this.refreshView(); },
        error: (error) => { this.error = this.message(error); this.refreshView(); }
      });
      this.agents.refreshAgentOrchestrations();
      this.agents.startAgentPolling();
    }
    if (section === 'crm') this.loadCrm();
    if (section === 'agents') { this.agents.configureAgentMotionPreference(); this.agents.loadAgentCenter(); }
    if (section === 'operations') this.loadOperations();
  }
  finalizerAnswerDrafts: Record<string, string> = {};
  finalizerAnswersConfirmed = false;
  trapDialogFocus(event: Event, dialog: HTMLDialogElement): void {
    const keyEvent = event as KeyboardEvent;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) { keyEvent.preventDefault(); dialog.focus(); return; }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (keyEvent.shiftKey && (active === first || !dialog.contains(active))) {
      keyEvent.preventDefault(); last.focus();
    } else if (!keyEvent.shiftKey && (active === last || !dialog.contains(active))) {
      keyEvent.preventDefault(); first.focus();
    }
  }
  activeIdentity(): IdentityProfile | undefined {
    return this.config?.identities.find((identity) => identity.id === this.config?.activeIdentityId);
  }
  displayIdentityName(identity?: IdentityProfile): string {
    if (!identity) return 'Profil laden';
    return this.revealSensitiveIdentity || identity.mode === 'incognito' ? identity.fullName : identity.label;
  }

  mcpRuntimeLabel(): string {
    if (!this.mcpRuntime) return 'Runtime wird geprüft';
    if (this.mcpRuntime.connected) return 'MCP verbunden';
    return ({ demo: 'Sicherer Demo-Modus', ready_to_connect: 'Startpfad bereit', invalid: 'Runtime ungültig' } as const)[this.mcpRuntime.state];
  }
  /** Verständlicher Status für die Kopfzeile; die technische Bezeichnung bleibt im Bereich „Quellen & MCP“. */
  headerStatusLabel(): string {
    return ({ loading: 'Status wird geprüft', demo: 'Demo-Modus', ready: 'Jobsuche startklar', connected: 'Jobsuche verbunden', invalid: 'Jobsuche gestört' } as const)[this.mcpRuntimeState()];
  }
  /** Der globale Speichern-Knopf erscheint nur dort, wo die lokale Konfiguration bearbeitet wird. */
  hasSettingsToSave(): boolean {
    return (['search', 'identity', 'sources'] as Section[]).includes(this.section);
  }
  mcpRuntimeState(): 'loading' | 'demo' | 'ready' | 'connected' | 'invalid' {
    if (!this.mcpRuntime) return 'loading';
    if (this.mcpRuntime.connected) return 'connected';
    return this.mcpRuntime.state === 'ready_to_connect' ? 'ready' : this.mcpRuntime.state;
  }
  mcpRuntimeTargetLabel(): string {
    if (!this.mcpRuntime?.runtimeTarget) return 'Kein validierter Startpfad';
    return this.mcpRuntime.runtimeTarget === 'wsl'
      ? `WSL · ${this.mcpRuntime.distribution ?? 'Distribution unbekannt'}` : 'Windows';
  }
  mcpConfiguredEnvironmentKeys(): string[] {
    if (!this.config) return [];
    return [...new Set(this.config.mcp.configuredEnvironmentKeys ?? Object.keys(this.config.mcp.env))].sort();
  }
  portalPermissionUnavailableReason(intent: 'enable' | 'disable'): string | undefined {
    if (!this.config) return 'Konfiguration ist noch nicht geladen.';
    if (intent === 'enable' && !this.mcpRuntime?.connected && this.mcpRuntime?.state !== 'ready_to_connect') {
      return 'Portalzugriff kann erst freigegeben werden, wenn GET /api/sources/runtime einen validierten oder verbundenen trusted-host-Startpfad meldet.';
    }
    return undefined;
  }
  openPortalPermissionDialog(intent: 'enable' | 'disable', returnFocus?: HTMLElement): void {
    const unavailable = this.portalPermissionUnavailableReason(intent);
    if (unavailable) { this.error = unavailable; this.notice = ''; this.refreshView(); return; }
    this.portalPermissionIntent = intent;
    this.portalPermissionConfirmed = false;
    this.portalPermissionReturnFocus = returnFocus;
    this.error = '';
    this.refreshView();
    setTimeout(() => this.openNativeDialog(this.portalPermissionDialogElement, this.portalPermissionConfirm));
  }
  closePortalPermissionDialog(): void {
    const returnFocus = this.portalPermissionReturnFocus;
    this.closeNativeDialog(this.portalPermissionDialogElement);
    this.portalPermissionIntent = undefined;
    this.portalPermissionConfirmed = false;
    this.portalPermissionReturnFocus = undefined;
    this.refreshView();
    this.restoreDialogFocus(returnFocus);
  }
  cancelPortalPermissionDialog(event: Event): void {
    event.preventDefault();
    this.closePortalPermissionDialog();
  }
  confirmPortalPermission(): void {
    const intent = this.portalPermissionIntent;
    if (!intent || !this.portalPermissionConfirmed || !this.config) return;
    const unavailable = this.portalPermissionUnavailableReason(intent);
    if (unavailable) { this.error = unavailable; this.closePortalPermissionDialog(); return; }
    this.busy = true; this.error = '';
    this.api.setMcpPortalAccess(intent === 'enable', this.config.revision).subscribe({
      next: (config) => {
        this.config = this.normalizeConfigForUi(config);
        this.busy = false;
        this.closePortalPermissionDialog();
        this.notice = intent === 'enable'
          ? 'Externer Portalzugriff wurde ausschließlich über ALLOW_EXTERNAL_PORTALS=1 freigegeben.'
          : 'Externer Portalzugriff wurde ausschließlich über ALLOW_EXTERNAL_PORTALS=0 gesperrt.';
        this.refreshSources(); this.refreshView();
      },
      error: (error) => { this.busy = false; this.error = this.message(error); this.closePortalPermissionDialog(); }
    });
  }

  saveConfig(message = 'Konfiguration lokal gespeichert.'): void {
    if (!this.config) return;
    this.busy = true;
    this.api.saveConfig(this.writableConfig()).subscribe({
      next: (config) => { this.config = this.normalizeConfigForUi(config); this.busy = false; this.notice = message; this.error = ''; this.refreshSources(); this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  private normalizeConfigForUi(config: AppConfig): AppConfig {
    const normalized = structuredClone(config);
    const keys = [...new Set(config.mcp.configuredEnvironmentKeys ?? Object.keys(config.mcp.env))].sort();
    normalized.mcp.configuredEnvironmentKeys = keys;
    normalized.mcp.env = Object.fromEntries(keys.map((key) => [key, '']));
    return normalized;
  }
  private writableConfig(): AppConfig {
    if (!this.config) throw new Error('Konfiguration ist noch nicht geladen.');
    const config = structuredClone(this.config);
    const keys = this.mcpConfiguredEnvironmentKeys();
    config.mcp.configuredEnvironmentKeys = keys;
    config.mcp.env = Object.fromEntries(keys.map((key) => [key, '']));
    return config;
  }

  createIncognito(): void {
    if (!this.config) return;
    this.busy = true;
    this.api.createIncognito(this.config.searchProfile.regions[0] ?? 'Deutschland').subscribe({
      next: () => this.api.config().subscribe({
        next: (config) => {
          this.config = this.normalizeConfigForUi(config);
          this.busy = false;
          this.notice = 'Neue Scheinidentität mit sicheren Platzhaltern angelegt.';
          this.refreshView();
        },
        error: (error) => this.fail(error)
      }),
      error: (error) => this.fail(error)
    });
  }

  deleteIdentity(identity: IdentityProfile): void {
    if (!this.config || this.busy) return;
    if (this.config.identities.length <= 1) { this.error = 'Die letzte Identität kann nicht gelöscht werden.'; this.refreshView(); return; }
    if (!confirm(`Identität „${identity.label}“ endgültig löschen?`)) return;
    this.busy = true; this.error = ''; this.notice = '';
    this.api.deleteIdentity(identity.id).subscribe({
      next: () => this.api.config().subscribe({
        next: (config) => { this.config = this.normalizeConfigForUi(config); this.busy = false; this.notice = 'Identität gelöscht.'; this.refreshView(); },
        error: (error) => this.fail(error)
      }),
      error: (error) => this.fail(error)
    });
  }

  runSearch(): void {
    if (!this.config) return;
    this.busy = true; this.error = ''; this.notice = '';
    // Preview only (fold=false): results are adopted into "Meine Jobs" via the
    // explicit deduplicated button below, not silently on every search.
    this.api.search(this.config.searchProfile, false).subscribe({
      next: ({ runId, matches, partialFailures }) => {
        this.matches = matches; this.selectedMatch = matches[0]; this.busy = false; this.showSection('search');
        this.searchFailures = partialFailures; this.lastSearchRunId = runId; this.lastSearchAdopted = false;
        this.notice = `${matches.length} Stellen bewertet${partialFailures.length ? `; ${partialFailures.length} Quelle(n) mit Teilausfall` : ''}. Mit „In ‚Meine Jobs' übernehmen" dubletten-frei speichern.`;
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  adoptSearchResults(): void {
    if (!this.lastSearchRunId || this.busy || !this.matches.length) return;
    this.busy = true; this.error = ''; this.notice = '';
    this.api.adoptSearchRun(this.lastSearchRunId).subscribe({
      next: ({ added, duplicates, total }) => {
        this.busy = false; this.lastSearchAdopted = true;
        this.notice = `${added} neue Stelle(n) in „Meine Jobs" übernommen${duplicates ? `, ${duplicates} bereits vorhanden` : ''} (von ${total}).`;
        this.loadJobs(); this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  // --- Zentrale Jobliste ("Meine Jobs") ---
  loadJobs(): void {
    this.jobsBusy = true; this.jobsError = '';
    this.api.jobInventory().subscribe({
      next: (entries) => { this.jobInventory = entries; this.jobsBusy = false; this.refreshView(); },
      error: (error) => { this.jobsError = this.message(error); this.jobsBusy = false; this.refreshView(); }
    });
    this.api.searchRunsSummary().subscribe({
      next: (runs) => { this.searchRunSummaries = runs; this.refreshView(); },
      error: () => { /* Lauf-Historie ist nicht kritisch für die Liste. */ }
    });
  }

  refreshJobsSearch(): void {
    if (!this.config) return;
    this.jobsBusy = true; this.jobsError = ''; this.jobsNotice = '';
    this.api.search(this.config.searchProfile).subscribe({
      next: ({ matches, partialFailures, newJobCount }) => {
        this.jobsNotice = `${matches.length} Stellen bewertet · ${newJobCount ?? 0} neu in der zentralen Liste${partialFailures.length ? ` · ${partialFailures.length} Quelle(n) mit Teilausfall` : ''}.`;
        this.loadJobs();
      },
      error: (error) => { this.jobsError = this.message(error); this.jobsBusy = false; this.refreshView(); }
    });
  }

  moveJobCategory(entry: JobInventoryView, category: JobInventoryCategory): void {
    if (entry.category === category) return;
    this.api.setJobInventoryCategory(entry.key, category).subscribe({
      next: (updated) => {
        this.jobInventory = this.jobInventory.map((item) => item.key === updated.key ? updated : item);
        this.jobsNotice = `„${updated.job.title}" nach „${this.jobCategoryLabel(category)}" verschoben.`; this.refreshView();
      },
      error: (error) => { this.jobsError = this.message(error); this.refreshView(); }
    });
  }

  toggleJobApplied(entry: JobInventoryView): void {
    const applied = !entry.status.manualApplied;
    this.api.markJobInventoryApplied(entry.key, applied).subscribe({
      next: (updated) => {
        this.jobInventory = this.jobInventory.map((item) => item.key === updated.key ? updated : item);
        this.jobsNotice = applied ? 'Als beworben markiert.' : 'Beworben-Markierung entfernt.'; this.refreshView();
      },
      error: (error) => { this.jobsError = this.message(error); this.refreshView(); }
    });
  }

  deleteJob(entry: JobInventoryView): void {
    if (this.jobsBusy) return;
    if (!confirm(`„${entry.job.title}" (${entry.job.company}) aus der zentralen Liste löschen?`)) return;
    this.jobsBusy = true; this.jobsError = ''; this.jobsNotice = '';
    this.api.deleteJobInventory(entry.key).subscribe({
      next: () => { this.jobInventory = this.jobInventory.filter((item) => item.key !== entry.key); this.jobsBusy = false; this.jobsNotice = 'Job gelöscht.'; this.refreshView(); },
      error: (error) => { this.jobsBusy = false; this.jobsError = this.message(error); this.refreshView(); }
    });
  }

  deleteJobsInCategory(category: JobInventoryCategory): void {
    if (this.jobsBusy) return;
    const targets = this.jobsInCategory(category);
    if (!targets.length) return;
    if (!confirm(`Alle ${targets.length} Jobs in „${this.jobCategoryLabel(category)}" löschen?`)) return;
    this.jobsBusy = true; this.jobsError = ''; this.jobsNotice = '';
    let removed = 0; const failed: string[] = [];
    const runNext = (index: number): void => {
      if (index >= targets.length) {
        this.jobsBusy = false; this.jobsNotice = `${removed} Job(s) gelöscht.`;
        if (failed.length) this.jobsError = `${failed.length} nicht gelöscht.`;
        this.refreshView(); return;
      }
      const target = targets[index]!;
      this.api.deleteJobInventory(target.key).subscribe({
        next: () => { removed += 1; this.jobInventory = this.jobInventory.filter((item) => item.key !== target.key); runNext(index + 1); },
        error: () => { failed.push(target.job.title); runNext(index + 1); }
      });
    };
    runNext(0);
  }

  startApplicationFromInventory(entry: JobInventoryView): void {
    if (!this.config) return;
    const match: JobMatch = {
      job: entry.job, searchPreferenceScore: 0, accepted: false,
      matchedMustHave: [], missingMustHave: [], matchedNiceToHave: [], exclusions: [],
      scoreBreakdown: { mustHave: 0, niceToHave: 0, region: 0, workModel: 0, exclusions: 0 }
    };
    this.selectedMatch = match;
    this.jobsBusy = true;
    this.api.createApplicationCase(match, this.config.activeIdentityId, this.documentType).subscribe({
      next: (application) => {
        this.applicationCases.unshift(application);
        this.applicationArtifacts[application.id] = [];
        this.selectApplicationCase(application);
        this.jobsBusy = false; this.showSection('applications');
        this.notice = `Bewerbungsfall für „${entry.job.title}" angelegt.`; this.refreshView();
      },
      error: (error) => { this.jobsError = this.message(error); this.jobsBusy = false; this.refreshView(); }
    });
  }

  jobsInCategory(category: JobInventoryCategory): JobInventoryView[] {
    return this.jobInventory
      .filter((entry) => entry.category === category)
      .filter((entry) => this.jobsFilter === 'all' || (this.jobsFilter === 'applied' ? entry.status.applied : !entry.status.applied))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }
  jobCategoryCount(category: JobInventoryCategory): number { return this.jobInventory.filter((entry) => entry.category === category).length; }
  jobCategoryLabel(category: JobInventoryCategory): string { return { inbox: 'Neu', apply: 'Zu bewerben', watchlist: 'Merken', archive: 'Archiv' }[category]; }
  appliedJobCount(): number { return this.jobInventory.filter((entry) => entry.status.applied).length; }
  jobDocumentLabel(type: 'cv' | 'cover_letter' | 'application_email'): string {
    return { cv: 'Lebenslauf', cover_letter: 'Anschreiben', application_email: 'E-Mail' }[type];
  }
  jobGeneratedDocuments(entry: JobInventoryView): JobInventoryView['status']['documents'] {
    return entry.status.documents.filter((document) => document.lifecycle !== 'rejected');
  }
  jobWorkModelLabel(model: string): string {
    return { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Vor Ort', unknown: 'k. A.' }[model] ?? model;
  }
  jobEmploymentLabel(type: string): string {
    return { full_time: 'Vollzeit', part_time: 'Teilzeit', contract: 'Vertrag', freelance: 'Freelance', internship: 'Praktikum', unknown: 'k. A.' }[type] ?? type;
  }
  jobSalaryLabel(job: JobInventoryView['job']): string | undefined {
    if (job.salaryMin == null && job.salaryMax == null) return undefined;
    const currency = 'EUR';
    const format = (value: number) => `${Math.round(value).toLocaleString('de-DE')} ${currency}`;
    if (job.salaryMin != null && job.salaryMax != null) return `${format(job.salaryMin)} – ${format(job.salaryMax)}`;
    return format((job.salaryMin ?? job.salaryMax)!);
  }
  jobMatchClass(score: number): 'good' | 'mid' | 'low' {
    return score >= 70 ? 'good' : score >= 45 ? 'mid' : 'low';
  }

  chooseMatch(match: JobMatch): void { this.selectedMatch = match; }
  jobDecision(jobId: string): JobDecision['state'] { return this.jobDecisions.find((item) => item.jobId === jobId)?.state ?? 'neutral'; }
  visibleMatches(): JobMatch[] {
    const visible = this.matches.filter((item) => this.jobDecision(item.job.id) !== 'hidden');
    return [...visible].sort((left, right) => this.resultSort === 'score'
      ? right.searchPreferenceScore - left.searchPreferenceScore
      : this.resultSort === 'title' ? left.job.title.localeCompare(right.job.title, 'de') : left.job.company.localeCompare(right.job.company, 'de'));
  }
  hiddenMatches(): JobMatch[] { return this.matches.filter((item) => this.jobDecision(item.job.id) === 'hidden'); }
  setJobDecision(jobId: string, state: JobDecision['state'], announce = true): void {
    this.api.setJobDecision(jobId, state).subscribe({ next: (decision) => {
      this.jobDecisions = [decision, ...this.jobDecisions.filter((item) => item.jobId !== jobId)];
      if (announce) this.notice = state === 'neutral' ? 'Entscheidung rückgängig gemacht.' : state === 'saved' ? 'Stelle gemerkt.' : 'Stelle ausgeblendet.';
      this.refreshView();
    }, error: (error) => this.fail(error) });
  }
  /** Score-Band nach Spezifikation: ab 80 passend, ab 60 prüfen, darunter neutral (ein niedriger Score ist kein Fehler). */
  scoreBand(score: number): 'high' | 'mid' | 'low' { return score >= 80 ? 'high' : score >= 60 ? 'mid' : 'low'; }
  scoreBandLabel(score: number): string { return ({ high: 'passt gut', mid: 'teilweise passend', low: 'wenig passend' } as const)[this.scoreBand(score)]; }

  /** Anzahl gesetzter Filter für den Filter-Button auf Tablet und Handy. */
  activeFilterCount(): number {
    const profile = this.config?.searchProfile;
    if (!profile) return 0;
    return [profile.query.trim(), profile.regions.length, profile.mustHave.length, profile.niceToHave.length, profile.exclude.length, profile.minSalary]
      .filter((value) => Boolean(value)).length;
  }

  /** Öffnet die Filter als Blatt (Tablet, Handy) und setzt den Fokus hinein; beim Schließen zurück auf den Auslöser. */
  toggleFilters(open = !this.filtersOpen): void {
    this.filtersOpen = open;
    this.refreshView();
    if (typeof document === 'undefined') return;
    setTimeout(() => (document.querySelector<HTMLElement>(open ? '#filters-title' : '.filters-toggle'))?.focus(), 0);
  }

  /** Blendet eine Stelle aus und bietet 6 Sekunden lang „Rückgängig“ an. */
  hideMatch(match: JobMatch): void {
    this.setJobDecision(match.job.id, 'hidden', false);
    if (this.lastHiddenTimer) clearTimeout(this.lastHiddenTimer);
    this.lastHiddenMatch = { jobId: match.job.id, title: match.job.title };
    this.lastHiddenTimer = setTimeout(() => { this.lastHiddenMatch = undefined; this.lastHiddenTimer = undefined; this.refreshView(); }, 6_000);
  }

  undoHide(): void {
    const hidden = this.lastHiddenMatch; if (!hidden) return;
    if (this.lastHiddenTimer) clearTimeout(this.lastHiddenTimer);
    this.lastHiddenMatch = undefined; this.lastHiddenTimer = undefined;
    this.setJobDecision(hidden.jobId, 'neutral');
  }

  toggleComparison(jobId: string, selected: boolean): void {
    const ids = new Set(this.comparisonJobIds); selected ? ids.add(jobId) : ids.delete(jobId);
    this.comparisonJobIds = [...ids].slice(0, 10);
  }
  compareSelectedJobs(): void {
    const selected = this.matches.filter((item) => this.comparisonJobIds.includes(item.job.id));
    if (selected.length < 3) { this.error = 'Für einen Vergleich müssen mindestens drei Stellen ausgewählt sein.'; return; }
    this.api.compareJobs(selected).subscribe({ next: (value) => { this.comparison = value; this.error = ''; this.refreshView(); }, error: (error) => this.fail(error) });
  }

  prepareApplication(match = this.selectedMatch): void {
    if (!match || !this.config) return;
    this.selectedMatch = match; this.busy = true;
    this.api.draft(match, this.config.activeIdentityId, this.documentType).subscribe({
      next: (draft) => { this.draft = draft; this.busy = false; this.showSection('applications'); this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  analyzeApplication(): void {
    if (!this.selectedMatch) return;
    this.busy = true;
    this.api.analyze(this.selectedMatch, this.documentType).subscribe({
      next: (analysis) => { this.matchAnalysis = analysis; this.busy = false; this.refreshView(); }, error: (error) => this.fail(error)
    });
  }

  validateMatchMatrix(): void {
    if (!this.matchAnalysis?.matchMatrix) return;
    this.api.validateMatch(this.matchAnalysis.matchMatrix, this.documentType).subscribe({
      next: (result) => { this.notice = result.valid ? 'Match-Matrix ist evidence-konform.' : ''; this.error = result.errors.join(' '); this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  createApplicationCase(): void {
    if (!this.selectedMatch || !this.config) return;
    const sourceCv = this.cv.sourceCvBindingForCreation();
    this.busy = true;
    this.api.createApplicationCase(this.selectedMatch, this.config.activeIdentityId, this.documentType, {
      ...(this.documentType === 'cv' ? { documentPurpose: 'vacancy_cv' as const } : {}),
      ...(sourceCv ? { sourceCv } : {})
    }).subscribe({
      next: (application) => {
        this.applicationCases.unshift(application);
        this.selectApplicationCase(application);
        this.applicationArtifacts[application.id] = [];
        this.cv.sourceCvSelection = '';
        this.busy = false;
        this.notice = sourceCv
          ? 'Bewerbungsfall lokal angelegt und an den freigegebenen Lebenslauf gebunden.'
          : 'Bewerbungsfall lokal angelegt und an die Werkstatt gebunden.';
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  startApplicationAgentOrchestration(): void {
    const application = this.selectedApplicationCase();
    const unavailable = this.applicationAgentStartUnavailableReason();
    if (unavailable || !application) { this.agents.agentOrchestrationError = unavailable; this.refreshView(); return; }
    const workflow = this.agents.agentWorkflows.find((item) => item.id === 'evidence-application-package');
    if (!workflow) return;
    const providerId = this.agents.agentOrchestrationForm.providerId || this.agents.agentProviders.find((item) => item.available)?.id || '';
    const binding = application.sourceCv
      ? ` Verwende den serverseitig gebundenen Lebenslauf (Fall ${application.sourceCv.caseId}, Revision ${application.sourceCv.revisionId}, SHA-256 ${application.sourceCv.sha256}).`
      : '';
    const promptByType: Record<ApplicationCase['documentType'], string> = {
      cv: `Erstelle einen belegbasierten ATS-sicheren Lebenslauf für den ausgewählten Bewerbungsfall ${application.id}. Verwende ausschließlich bestätigte CandidateProfile-Claims und die serverseitig gespeicherten Stilvorgaben. Der fünfte Agent liefert die direkt sichtbare finale HTML-Fassung.`,
      cover_letter: `Erstelle ein belegbasiertes, ATS-taugliches Anschreiben für den ausgewählten Bewerbungsfall ${application.id}. Baue es logisch auf dem Lebenslauf des Falls auf: gleiche belegte Stationen, konsistente Zeitangaben und keine neuen Fakten.${binding} Der fünfte Agent liefert die direkt sichtbare finale HTML-Fassung.`,
      email: `Erstelle eine kurze, belegbasierte Bewerbungs-E-Mail für den ausgewählten Bewerbungsfall ${application.id}, konsistent mit dem Lebenslauf des Falls.${binding} Der fünfte Agent liefert die direkt sichtbare finale HTML-Fassung.`
    };
    this.agents.agentOrchestrationError = '';
    this.agents.agentOrchestrationForm = {
      workflowId: workflow.id, providerId,
      prompt: promptByType[application.documentType],
      runtimeTarget: this.agents.agentOrchestrationForm.runtimeTarget,
      ...(this.agents.agentOrchestrationForm.runtimeTarget === 'wsl' && this.agents.agentOrchestrationForm.wslDistribution
        ? { wslDistribution: this.agents.agentOrchestrationForm.wslDistribution } : {}),
      applicationCaseId: application.id, userInputConfirmed: false
    };
    this.agents.createAgentOrchestration();
  }

  applicationAgentStartUnavailableReason(): string {
    const application = this.selectedApplicationCase();
    if (!application) return 'Wähle in der Werkstatt einen Bewerbungsfall.';
    if (!this.agents.agentWorkflows.some((item) => item.id === 'evidence-application-package')) {
      return 'Der versionierte Evidence-Agentenworkflow ist serverseitig nicht verfügbar.';
    }
    const provider = this.agents.agentProviders.find((item) => item.id === this.agents.agentOrchestrationForm.providerId);
    if (!provider?.available) return 'Wähle einen verfügbaren Agentenprovider.';
    const installation = this.agents.selectedAgentOrchestrationInstallation();
    const profileBlock = this.agents.agentProfileRuntimeBlockedReason(installation);
    if (profileBlock) return profileBlock;
    if (installation?.support !== 'supported') return 'Wähle eine versionsgenau freigegebene Provider-Laufzeit.';
    return '';
  }

  applicationFinalizerRound(): AgentOrchestrationRecord['finalizerQuestions'] | undefined {
    const orchestration = this.applicationAgentOrchestration();
    if (!orchestration || orchestration.status !== 'failed' || !orchestration.finalizerQuestions) return undefined;
    const node = orchestration.nodes.find((candidate) => candidate.nodeId === orchestration.finalizerQuestions!.nodeId);
    return node?.failureCategory === 'needs_input' ? orchestration.finalizerQuestions : undefined;
  }

  setFinalizerAnswer(questionId: string, value: string): void {
    this.finalizerAnswerDrafts = { ...this.finalizerAnswerDrafts, [questionId]: value };
    this.finalizerAnswersConfirmed = false;
  }

  answerFinalizerQuestions(): void {
    const orchestration = this.applicationAgentOrchestration();
    const round = this.applicationFinalizerRound();
    if (!orchestration || !round || this.cv.applicationRetryBusy || !this.finalizerAnswersConfirmed) return;
    const answers = round.questions.map((question) => ({
      id: question.id,
      question: question.question,
      answer: (this.finalizerAnswerDrafts[question.id] ?? '').trim() || 'Keine Ergänzung',
    }));
    if (answers.some((answer) => answer.answer.length > 1_500)) {
      this.agents.agentOrchestrationError = 'Eine Antwort überschreitet 1.500 Zeichen.';
      this.refreshView(); return;
    }
    this.cv.applicationRetryBusy = true;
    this.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(orchestration.id, round.nodeId, {
      instructions: '', includePreviousVersion: false, answers,
    }).subscribe({
      next: (created) => {
        this.cv.applicationRetryBusy = false;
        this.finalizerAnswerDrafts = {};
        this.finalizerAnswersConfirmed = false;
        this.agents.agentOrchestrations = [created, ...this.agents.agentOrchestrations.filter((item) => item.id !== created.id)];
        this.applicationAgentOrchestrationId = created.id;
        this.notice = 'Die Antworten sind gebunden; der Finalizer läuft mit derselben eingefrorenen Konfiguration weiter.';
        this.refreshView();
      },
      error: (error) => { this.cv.applicationRetryBusy = false; this.agents.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }

  applicationRetryNode(): AgentOrchestrationRecord['nodes'][number] | undefined {
    const orchestration = this.applicationAgentOrchestration();
    if (!orchestration || orchestration.status !== 'failed') return undefined;
    return orchestration.nodes.find((node) => node.status === 'failed' && node.failureCategory !== 'needs_input');
  }

  retryApplicationFailedNode(): void {
    const orchestration = this.applicationAgentOrchestration();
    const node = this.applicationRetryNode();
    if (!orchestration || !node || this.cv.applicationRetryBusy) return;
    this.cv.applicationRetryBusy = true;
    this.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(orchestration.id, node.nodeId).subscribe({
      next: (created) => {
        this.cv.applicationRetryBusy = false;
        this.agents.agentOrchestrations = [created, ...this.agents.agentOrchestrations.filter((item) => item.id !== created.id)];
        this.applicationAgentOrchestrationId = created.id;
        this.notice = `Schritt „${node.role}“ wird mit der eingefrorenen Konfiguration wiederholt.`;
        this.refreshView();
      },
      error: (error) => { this.cv.applicationRetryBusy = false; this.agents.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }

  applicationAgentOrchestration(): AgentOrchestrationRecord | undefined {
    if (this.applicationAgentOrchestrationId) {
      const bound = this.agents.agentOrchestrations.find((item) => item.id === this.applicationAgentOrchestrationId)
        ?? (this.agents.selectedAgentOrchestration?.id === this.applicationAgentOrchestrationId ? this.agents.selectedAgentOrchestration : undefined);
      if (bound) return bound;
    }
    // Returning to the workshop or reloading the page loses the transient id;
    // recover the case's latest evidence chain from the persisted records.
    const caseId = this.selectedApplicationCaseId;
    if (!caseId) return undefined;
    return this.agents.agentOrchestrations
      .filter((item) => item.workflowId === 'evidence-application-package' && item.scope.applicationCaseId === caseId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  openApplicationAgentOrchestration(): void {
    const orchestration = this.applicationAgentOrchestration();
    this.select('agents');
    if (orchestration) this.agents.selectAgentOrchestration(orchestration, false);
  }

  refreshApplicationAgentStatus(): void {
    this.agents.refreshAgentOrchestrations();
  }

  nextApplicationState(application: ApplicationCase): string | undefined {
    const next: Record<string, string> = {
      selected: 'analysis', analysis: 'questions', questions: 'draft', draft: 'review',
      dry_run: 'closed'
    };
    const target = next[application.state];
    return target;
  }

  advanceApplication(application: ApplicationCase): void {
    const target = this.nextApplicationState(application); if (!target) return;
    this.busy = true;
    this.api.transitionApplicationCase(application.id, target).subscribe({
      next: (updated) => {
        this.applicationCases = this.applicationCases.map((item) => item.id === updated.id ? updated : item);
        this.busy = false; this.notice = `Bewerbungsfall ist jetzt im Zustand ${updated.state}.`; this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  loadApplicationCases(): void { this.api.applicationCases().subscribe({ next: (items) => {
    this.applicationCases = items;
    if (this.selectedApplicationCaseId && !items.some((item) => item.id === this.selectedApplicationCaseId)) this.selectedApplicationCaseId = undefined;
    this.refreshView();
  } }); }

  selectedApplicationCase(): ApplicationCase | undefined {
    return this.applicationCases.find((item) => item.id === this.selectedApplicationCaseId);
  }

  deleteApplicationCaseRow(item: ApplicationCase): void {
    if (this.busy) return;
    if (!confirm(`Bewerbungsfall „${item.job.company} · ${item.job.title}“ samt Artefakten und Tracking endgültig löschen?`)) return;
    this.busy = true; this.error = ''; this.notice = '';
    this.api.deleteApplicationCase(item.id).subscribe({
      next: (result) => {
        this.busy = false;
        this.applicationCases = this.applicationCases.filter((entry) => entry.id !== item.id);
        if (this.selectedApplicationCaseId === item.id) this.selectedApplicationCaseId = undefined;
        this.notice = `Bewerbungsfall gelöscht (${result.cascade.artifacts} Artefakt(e), ${result.cascade.trackingEvents} Tracking, ${result.cascade.events} Status).`;
        this.refreshView();
      },
      error: (error) => { this.busy = false; this.fail(error); }
    });
  }

  selectApplicationCase(application: ApplicationCase): void {
    const previousCaseId = this.selectedApplicationCaseId;
    if (previousCaseId && previousCaseId !== application.id) {
      this.pipelineDraftsByCase[previousCaseId] = {
        annotatedContent: this.pipelineAnnotatedContent,
        iterationManifest: this.pipelineIterationManifest
      };
    }
    this.selectedApplicationCaseId = application.id;
    this.languageCheckResult = undefined;
    this.applicationExportResult = undefined;
    this.applicationAgentOrchestrationId = undefined;
    this.agents.agentOrchestrationError = '';
    if (previousCaseId !== application.id) {
      const localDraft = this.pipelineDraftsByCase[application.id];
      this.pipelineAnnotatedContent = localDraft?.annotatedContent ?? (this.draft?.jobId === application.job.id ? this.draft.content : '');
      this.pipelineIterationManifest = localDraft?.iterationManifest ?? '';
    }
    this.loadApplicationArtifacts(application.id);
    this.refreshView();
  }

  setPipelineAnnotatedContent(content: string): void {
    if (content !== this.pipelineAnnotatedContent) this.languageCheckResult = undefined;
    this.pipelineAnnotatedContent = content;
  }

  setPipelineIterationManifest(manifest: string): void { this.pipelineIterationManifest = manifest; }

  loadApplicationArtifacts(caseId: string): void {
    this.api.applicationArtifacts(caseId).subscribe({
      next: (items) => { this.applicationArtifacts[caseId] = items; this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  artifactsFor(application: ApplicationCase): ArtifactRevision[] { return this.applicationArtifacts[application.id] ?? []; }

  runLocalLanguageCheck(): void {
    const content = this.pipelineAnnotatedContent.trim() || this.draft?.content.trim() || '';
    if (!content) { this.error = 'Für die lokale Sprachprüfung fehlt ein Dokumenttext.'; return; }
    this.languageCheckBusy = true; this.error = '';
    this.api.languageCheck(content, 'de-DE').subscribe({
      next: (result) => {
        this.languageCheckResult = result; this.languageCheckBusy = false;
        this.notice = result.available
          ? `Lokale Sprachprüfung abgeschlossen: ${result.issues.length} Hinweis(e).`
          : 'Die lokale Sprachprüfung ist nicht verfügbar; die serverseitige Finalisierung bleibt fail-closed.';
        this.refreshView();
      },
      error: (error) => { this.languageCheckBusy = false; this.fail(error); }
    });
  }

  finalizeSelectedApplicationCase(): void {
    const application = this.selectedApplicationCase();
    const annotatedContent = this.pipelineAnnotatedContent.trim();
    const iterationManifest = this.pipelineIterationManifest.trim();
    if (!application) { this.error = 'Bitte zuerst einen Bewerbungsfall in der Werkstatt öffnen.'; return; }
    if (application.state !== 'review') { this.error = 'Serverseitige Finalisierung ist ausschließlich im Review-Status möglich.'; return; }
    if (application.identityMode !== 'real') { this.error = 'Inkognito-Fälle dürfen nicht finalisiert werden.'; return; }
    if (!annotatedContent || !iterationManifest) { this.error = 'Annotierter Entwurf und Review-Manifest sind beide erforderlich.'; return; }
    this.busy = true; this.error = '';
    this.api.finalizeApplicationCase(application.id, annotatedContent, iterationManifest).subscribe({
      next: ({ draft, revision }) => {
        this.draft = draft;
        this.applicationArtifacts[application.id] = [revision, ...this.artifactsFor(application).filter((item) => item.id !== revision.id)];
        this.busy = false;
        this.notice = `Pipeline-Revision ${revision.id} wurde serverseitig finalisiert und hashgebunden vorgeschlagen.`;
        this.refreshView();
      },
      error: (error) => { this.busy = false; this.fail(error); }
    });
  }

  reviewApplicationRevision(application: ApplicationCase, revision: ArtifactRevision, decision: 'approved' | 'rejected'): void {
    if (!this.artifactReviewConfirmed[revision.id]) { this.error = 'Die exakte Hash-Revision muss vor der Entscheidung bestätigt werden.'; return; }
    const issueCount = revision.pipelineProof?.languageCheck.issueCount;
    if (revision.lifecycle !== 'proposed' || issueCount === undefined) { this.error = 'Nur eine serverseitig nachgewiesene vorgeschlagene Revision kann geprüft werden.'; return; }
    this.busy = true; this.error = '';
    this.api.reviewApplicationArtifact(application.id, revision.id, decision, revision.sha256, issueCount).subscribe({
      next: (updated) => {
        this.applicationArtifacts[application.id] = this.artifactsFor(application).map((item) => item.id === updated.id ? updated : item);
        this.artifactReviewConfirmed[revision.id] = false;
        this.busy = false;
        this.notice = decision === 'approved'
          ? 'Exakt diese Dokumentrevision wurde menschlich und hashgebunden freigegeben.'
          : 'Exakt diese Dokumentrevision wurde abgelehnt.';
        this.refreshView();
      },
      error: (error) => { this.busy = false; this.fail(error); }
    });
  }

  approveApplicationCase(application: ApplicationCase, revision: ArtifactRevision): void {
    if (revision.applicationCaseId !== application.id || revision.lifecycle !== 'approved' || revision.review?.decision !== 'approved') {
      this.error = 'Der Fall kann nur mit einer hashgeprüften, freigegebenen Revision genehmigt werden.'; return;
    }
    this.busy = true;
    this.api.transitionApplicationCase(application.id, 'approved', { revisionId: revision.id, expectedSha256: revision.sha256 }).subscribe({
      next: (updated) => {
        this.applicationCases = this.applicationCases.map((item) => item.id === updated.id ? updated : item);
        this.busy = false; this.notice = `Bewerbungsfall wurde auf Basis der Revision ${revision.id} freigegeben.`; this.refreshView();
      },
      error: (error) => { this.busy = false; this.fail(error); }
    });
  }

  exportApplicationRevision(application: ApplicationCase, revision: ArtifactRevision): void {
    if (!this.artifactExportConfirmed[revision.id]) { this.error = 'Der Export der exakten Revision muss ausdrücklich bestätigt werden.'; return; }
    const unavailableReason = this.applicationArtifactExportUnavailableReason(application, revision);
    if (unavailableReason) { this.error = unavailableReason; return; }
    const format = this.artifactExportFormat[revision.id] ?? 'pdf';
    this.busy = true; this.error = '';
    this.api.exportApplicationArtifact(application.id, revision.id, format).subscribe({
      next: (result) => {
        this.applicationExportResult = result;
        this.artifactExportConfirmed[revision.id] = false;
        this.busy = false;
        this.notice = `${result.fileName} wurde aus der geprüften Revision ${result.artifactRevisionId} erzeugt.`;
        this.downloadApplicationExport(result);
        this.loadApplicationCases(); this.loadApplicationArtifacts(application.id); this.refreshView();
      },
      error: (error) => { this.busy = false; this.fail(error); }
    });
  }

  applicationArtifactExportUnavailableReason(application: ApplicationCase, revision: ArtifactRevision): string {
    if (application.state !== 'approved') return 'Der Bewerbungsfall ist nicht freigegeben.';
    if (application.identityMode !== 'real') return 'Inkognito-Fälle dürfen nicht exportiert werden.';
    if (revision.lifecycle !== 'approved') return 'Die Dokumentrevision ist nicht freigegeben.';
    if (application.approvedArtifactRevisionId !== revision.id || application.approvedArtifactSha256 !== revision.sha256) {
      return 'Nur die beim Fall-Approval exakt gebundene Revisions-ID und ihr SHA-256 dürfen exportiert werden.';
    }
    return '';
  }

  private downloadApplicationExport(result: ApplicationExportResult): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const binary = atob(result.base64); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
    const link = document.createElement('a'); link.href = url; link.download = result.fileName; link.click();
    URL.revokeObjectURL(url);
  }

  openCaseAgentWorkflow(application: ApplicationCase, workflowId: NonNullable<AgentRunRequest['workflowId']>): void {
    const prompts: Record<NonNullable<AgentRunRequest['workflowId']>, string> = {
      'guided-job-analysis': 'Analysiere passende Stellen nachvollziehbar und liefere ausschließlich Vorschläge.',
      'evidence-application-package': `Prüfe die evidenzbasierte Bewerbungsunterlage für ${application.job.title} bei ${application.job.company}.`,
      'employer-response-triage': `Ordne die dem Fall zugewiesenen Unternehmensantworten ein und schlage sichere nächste Schritte für ${application.job.company} vor.`,
      'application-next-actions': `Ermittle firmenweit nachvollziehbare nächste Schritte für alle Bewerbungen bei ${application.job.company}.`
    };
    this.agents.agentRunForm = {
      providerId: this.agents.agentRunForm.providerId,
      prompt: prompts[workflowId],
      runtimeTarget: this.agents.agentRunForm.runtimeTarget,
      ...(this.agents.agentRunForm.runtimeTarget === 'wsl' && this.agents.agentRunForm.wslDistribution
        ? { wslDistribution: this.agents.agentRunForm.wslDistribution }
        : {}),
      workspaceMode: 'read_only', network: false, applicationCaseId: application.id, workflowId,
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    };
    this.select('agents');
    this.agents.scheduleAgentPreflight();
  }
  openInboxMailAgentOrchestration(message: CorrelatedMail): void {
    const caseId = this.mailCorrelationTarget[message.id];
    const application = this.applicationCases.find((candidate) => candidate.id === caseId);
    if (!application) { this.error = 'Bitte zuerst einen Bewerbungsfall für diese Inbox-Mail wählen.'; return; }
    this.agents.agentOrchestrationForm = {
      workflowId: 'employer-response-triage', providerId: this.agents.agentOrchestrationForm.providerId,
      prompt: `Ordne die explizit gewählte Inbox-Mail sicher dem Bewerbungsfall bei ${application.job.company} zu und liefere ausschließlich Antwort- und Terminvorschläge.`,
      runtimeTarget: this.agents.agentOrchestrationForm.runtimeTarget,
      ...(this.agents.agentOrchestrationForm.runtimeTarget === 'wsl' && this.agents.agentOrchestrationForm.wslDistribution
        ? { wslDistribution: this.agents.agentOrchestrationForm.wslDistribution }
        : {}),
      applicationCaseId: application.id, mailId: message.id, userInputConfirmed: false
    };
    this.select('agents');
  }
  loadCrm(): void {
    this.api.crmCompanies().subscribe({ next: (items) => { this.companies = items; this.applicationCases = items.flatMap((item) => item.applications); this.refreshView(); }, error: (error) => this.fail(error) });
    this.api.mailAccounts().subscribe({ next: (items) => { this.mailAccounts = items; this.refreshView(); }, error: (error) => this.fail(error) });
    this.api.mailMessages().subscribe({ next: (items) => { this.mailInbox = items.filter((item) => !item.correlation.applicationCaseId); this.refreshView(); }, error: (error) => this.fail(error) });
  }
  saveMailAccount(): void {
    this.busy = true;
    this.api.saveMailAccount(this.mailAccountForm).subscribe({ next: (account) => {
      this.mailAccounts.unshift(account); this.mailAccountForm.secret = ''; this.busy = false;
      this.notice = 'Mailkonto verschlüsselt und zunächst deaktiviert gespeichert.'; this.refreshView();
    }, error: (error) => this.fail(error) });
  }
  setMailAccountEnabled(account: MailAccount, enabled: boolean): void {
    this.api.setMailAccountEnabled(account.id, enabled).subscribe({ next: (updated) => {
      this.mailAccounts = this.mailAccounts.map((item) => item.id === updated.id ? updated : item);
      this.notice = enabled ? 'Mailabruf bewusst aktiviert.' : 'Mailabruf deaktiviert.'; this.refreshView();
    }, error: (error) => this.fail(error) });
  }
  deleteMailAccount(account: MailAccount): void {
    if (!confirm(`Mailkonto „${account.label}“ und seine importierten Nachrichten wirklich lokal löschen?`)) return;
    this.api.deleteMailAccount(account.id).subscribe({ next: () => { this.notice = 'Mailkonto und zugehörige Vault-Nachrichten gelöscht.'; this.loadCrm(); }, error: (error) => this.fail(error) });
  }
  syncMail(account: MailAccount): void {
    if (!account.enabled) { this.error = 'Das Konto muss vor dem Abruf bewusst aktiviert werden.'; return; }
    this.busy = true; this.api.syncMailAccount(account.id).subscribe({ next: (result) => {
      this.busy = false; this.notice = `${result.added} neue Nachricht(en) aus ${result.fetched} abgerufenen gespeichert.`; this.loadCrm();
    }, error: (error) => this.fail(error) });
  }
  testMail(account: MailAccount): void {
    this.busy = true; this.api.testMailAccount(account.id).subscribe({ next: (result) => { this.busy = false; this.notice = `Verbindung und Postfach ${result.mailbox} erfolgreich geprüft.`; this.refreshView(); }, error: (error) => this.fail(error) });
  }
  importEml(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith('.eml') || file.size > 20 * 1024 * 1024) { this.error = 'Bitte eine .eml-Datei mit höchstens 20 MiB wählen.'; return; }
    const reader = new FileReader(); reader.onload = () => this.api.importEml(file.name, String(reader.result).split(',')[1] ?? '').subscribe({
      next: () => { this.notice = 'EML lokal importiert und automatisch vorgeordnet.'; this.loadCrm(); }, error: (error) => this.fail(error)
    }); reader.readAsDataURL(file);
  }
  importLocalMailDrop(): void {
    this.api.importLocalMailDrop().subscribe({ next: (result) => { this.notice = `${result.added} von ${result.inspected} SMTP-Nachricht(en) neu übernommen.`; this.loadCrm(); }, error: (error) => this.fail(error) });
  }
  confirmCorrelation(messageId: string): void {
    const caseId = this.mailCorrelationTarget[messageId]; if (!caseId) { this.error = 'Bitte zuerst einen Bewerbungsfall wählen.'; return; }
    this.api.confirmMailCorrelation(messageId, caseId).subscribe({ next: () => { this.notice = 'Nachricht verbindlich der Stelle zugeordnet.'; this.loadCrm(); }, error: (error) => this.fail(error) });
  }
  loadOperations(): void {
    this.api.dataInventory().subscribe({ next: (value) => { this.dataInventory = value; this.refreshView(); }, error: (error) => this.fail(error) });
    this.api.schedules().subscribe({ next: (items) => { this.schedules = items; this.refreshView(); }, error: (error) => this.fail(error) });
  }
  createDisabledSchedule(): void {
    if (!this.config) return;
    this.api.createSchedule(this.config.searchProfile).subscribe({ next: (schedule) => { this.schedules.unshift(schedule); this.notice = 'Suchplan wurde sicher deaktiviert angelegt.'; this.refreshView(); }, error: (error) => this.fail(error) });
  }
  deleteSchedule(schedule: SearchSchedule): void {
    if (!confirm(`Suchplan „${schedule.name}“ löschen?`)) return;
    this.api.deleteSearchSchedule(schedule.id).subscribe({
      next: () => { this.schedules = this.schedules.filter((item) => item.id !== schedule.id); this.notice = 'Suchplan gelöscht.'; this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }
  previewPortableExport(): void { this.api.portableExport().subscribe({ next: (value) => { this.exportPreview = value; this.notice = 'Portabler Export ohne Identitäten erstellt.'; this.refreshView(); }, error: (error) => this.fail(error) }); }
  applyRetentionPolicy(): void { this.api.runRetention(this.retentionDays).subscribe({ next: () => { this.notice = 'Bestätigte Aufbewahrungsregel wurde lokal ausgeführt.'; this.loadOperations(); }, error: (error) => this.fail(error) }); }
  loadProfileSetup(): void {
    this.api.applicationPipelineSetup().subscribe({
      next: (status) => {
        this.profileSetup = status;
        if (status.initialized && status.styleProfile === 'present') this.loadApplicationStyleProfile();
        else {
          this.cv.applicationStyleProfile = undefined;
          this.styleProfileDraft = undefined;
          this.cv.styleProfileError = '';
        }
        this.refreshView();
      },
      error: (error) => { this.profileSetup = undefined; this.error = this.message(error); this.refreshView(); }
    });
  }
  initializeApplicationProfiles(): void {
    if (!this.profileSetupConfirmed) { this.error = 'Die lokale Anlage leerer Profilvorlagen muss ausdrücklich bestätigt werden.'; return; }
    this.busy = true; this.error = '';
    this.api.initializeApplicationProfiles().subscribe({
      next: (status) => {
        this.profileSetup = status; this.profileSetupConfirmed = false; this.busy = false;
        this.notice = status.created?.length
          ? `Leere lokale Vorlagen angelegt: ${status.created.join(', ')}. Kandidatenfakten wurden nicht erfunden.`
          : 'Vorhandene Profile wurden nicht überschrieben.';
        this.loadCandidateProfile();
        if (status.initialized && status.styleProfile === 'present') this.loadApplicationStyleProfile();
        this.refreshView();
      },
      error: (error) => { this.busy = false; this.fail(error); }
    });
  }
  loadApplicationStyleProfile(): void {
    this.styleProfileBusy = true;
    this.cv.styleProfileError = '';
    this.api.applicationStyleProfile().subscribe({
      next: (view) => {
        this.applyApplicationStyleProfile(view);
        this.styleProfileBusy = false;
        this.refreshView();
      },
      error: (error) => {
        this.styleProfileBusy = false;
        this.cv.styleProfileError = this.message(error);
        this.refreshView();
      }
    });
  }
  saveApplicationStyleProfile(): void {
    const current = this.cv.applicationStyleProfile;
    const draft = this.styleProfileDraft;
    if (!current || !draft) return;
    if (!this.styleProfileConfirmed) {
      this.cv.styleProfileError = 'Die versionierte Stilprofil-Änderung muss ausdrücklich bestätigt werden.';
      return;
    }
    const profile = this.normalizedApplicationStyleProfile(draft);
    const validationError = this.applicationStyleProfileValidationError(profile);
    if (validationError) { this.cv.styleProfileError = validationError; return; }
    this.styleProfileBusy = true;
    this.cv.styleProfileError = '';
    this.api.saveApplicationStyleProfile(current, profile).subscribe({
      next: (view) => {
        this.applyApplicationStyleProfile(view);
        this.styleProfileBusy = false;
        this.notice = `Stilprofil als Revision ${view.revision} gespeichert. Die lokale Sprachprüfung bleibt nspell-only.`;
        this.refreshView();
      },
      error: (error) => {
        this.styleProfileBusy = false;
        this.cv.styleProfileError = this.message(error);
        this.refreshView();
      }
    });
  }
  addApprovedStyleExample(): void {
    if (!this.styleProfileDraft || this.styleProfileDraft.approvedExamples.length >= 50) return;
    this.styleProfileDraft.approvedExamples.push({
      id: this.nextStyleExampleId('approved-example'), documentType: 'cover_letter', text: ''
    });
  }
  removeApprovedStyleExample(index: number): void { this.styleProfileDraft?.approvedExamples.splice(index, 1); }
  addRejectedStyleExample(): void {
    if (!this.styleProfileDraft || this.styleProfileDraft.rejectedExamples.length >= 50) return;
    this.styleProfileDraft.rejectedExamples.push({
      id: this.nextStyleExampleId('rejected-example'), documentType: 'cover_letter', text: '', reason: ''
    });
  }
  removeRejectedStyleExample(index: number): void { this.styleProfileDraft?.rejectedExamples.splice(index, 1); }
  styleDocumentTypeLabel(kind: ApplicationStyleExampleDocumentType): string {
    return ({ cv: 'Lebenslauf', cover_letter: 'Anschreiben', email: 'E-Mail', linkedin: 'LinkedIn', interview: 'Interview' })[kind];
  }
  private applyApplicationStyleProfile(view: ApplicationStyleProfileView): void {
    this.cv.applicationStyleProfile = view;
    this.styleProfileDraft = structuredClone(view.profile);
    this.styleVocabularyPreferText = view.profile.vocabulary.prefer.join('\n');
    this.styleVocabularyAvoidText = view.profile.vocabulary.avoid.join('\n');
    this.stylePreferredPatternsText = view.profile.preferredPatterns.join('\n');
    this.styleAvoidPatternsText = view.profile.avoidPatterns.join('\n');
    this.styleProfileConfirmed = false;
    this.cv.styleProfileError = '';
  }
  private normalizedApplicationStyleProfile(draft: EditableApplicationStyleProfile): EditableApplicationStyleProfile {
    const normalized = structuredClone(draft);
    const trim = (value: string) => value.trim();
    normalized.language = trim(normalized.language); normalized.locale = trim(normalized.locale);
    normalized.tone = trim(normalized.tone); normalized.formality = trim(normalized.formality);
    normalized.directness = trim(normalized.directness); normalized.sentenceLength = trim(normalized.sentenceLength);
    normalized.technicalDepth = trim(normalized.technicalDepth); normalized.enthusiasm = trim(normalized.enthusiasm);
    normalized.selfPromotion = trim(normalized.selfPromotion); normalized.humor = trim(normalized.humor);
    normalized.vocabulary = {
      prefer: this.styleLines(this.styleVocabularyPreferText), avoid: this.styleLines(this.styleVocabularyAvoidText)
    };
    normalized.preferredPatterns = this.styleLines(this.stylePreferredPatternsText);
    normalized.avoidPatterns = this.styleLines(this.styleAvoidPatternsText);
    for (const kind of this.styleDocumentTypes) {
      normalized.documentStyles[kind].perspective = trim(normalized.documentStyles[kind].perspective);
      normalized.documentStyles[kind].technicalDensity = trim(normalized.documentStyles[kind].technicalDensity);
    }
    normalized.approvedExamples = normalized.approvedExamples.map((item) => ({
      id: trim(item.id), documentType: item.documentType, text: trim(item.text),
      ...(item.sourceRef?.trim() ? { sourceRef: trim(item.sourceRef) } : {}),
      ...(item.notes?.trim() ? { notes: trim(item.notes) } : {})
    }));
    normalized.rejectedExamples = normalized.rejectedExamples.map((item) => ({
      id: trim(item.id), documentType: item.documentType, text: trim(item.text), reason: trim(item.reason)
    }));
    return normalized;
  }
  private applicationStyleProfileValidationError(profile: EditableApplicationStyleProfile): string | undefined {
    const core = [profile.language, profile.locale, profile.tone, profile.formality, profile.directness, profile.sentenceLength,
      profile.technicalDepth, profile.enthusiasm, profile.selfPromotion, profile.humor];
    if (core.some((value) => !value)) return 'Alle Kernfelder des Stilprofils müssen ausgefüllt sein.';
    const lists = [profile.vocabulary.prefer, profile.vocabulary.avoid, profile.preferredPatterns, profile.avoidPatterns];
    if (lists.some((items) => items.length > 100 || items.some((item) => !item || item.length > 2_000))) {
      return 'Wortschatz und Muster sind auf 100 nichtleere Einträge mit je 2.000 Zeichen begrenzt.';
    }
    if (lists.some((items) => new Set(items.map((item) => item.toLocaleLowerCase('de-DE'))).size !== items.length)) {
      return 'Wortschatz und Muster dürfen keine doppelten Einträge enthalten.';
    }
    if (this.styleDocumentTypes.some((kind) => !profile.documentStyles[kind].perspective || !profile.documentStyles[kind].technicalDensity
      || profile.documentStyles[kind].maxSentenceWords < 10 || profile.documentStyles[kind].maxSentenceWords > 100)) {
      return 'Dokumentstile benötigen Perspektive, Technikdichte und 10 bis 100 Wörter pro Satz.';
    }
    const idsValid = (items: Array<{ id: string }>) => items.every((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id))
      && new Set(items.map((item) => item.id)).size === items.length;
    if (!idsValid(profile.approvedExamples) || !idsValid(profile.rejectedExamples)) return 'Beispiel-IDs müssen eindeutiges kebab-case verwenden.';
    if (profile.approvedExamples.length > 50 || profile.rejectedExamples.length > 50
      || profile.approvedExamples.some((item) => item.text.length > 20_000 || (item.sourceRef?.length ?? 0) > 500 || (item.notes?.length ?? 0) > 2_000)
      || profile.rejectedExamples.some((item) => item.text.length > 20_000 || item.reason.length > 2_000)) {
      return 'Beispiellisten oder Beispieltexte überschreiten die geschlossenen Vertragsgrenzen.';
    }
    if (profile.approvedExamples.some((item) => !item.text) || profile.rejectedExamples.some((item) => !item.text || !item.reason)) {
      return 'Beispiele benötigen Text; abgelehnte Beispiele zusätzlich einen Grund.';
    }
    const quality = profile.qualityThresholds;
    if (![quality.maxRepeatedSentenceStarts, quality.maxAvoidPatternMatches].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 100)) {
      return 'Qualitätsgrenzen müssen ganze Zahlen zwischen 0 und 100 sein.';
    }
    if (!Number.isSafeInteger(profile.reviewWorkflow.maxRevisionCycles) || profile.reviewWorkflow.maxRevisionCycles < 1 || profile.reviewWorkflow.maxRevisionCycles > 5) {
      return 'Der Review-Workflow erlaubt ein bis fünf Revisionszyklen.';
    }
    return undefined;
  }
  private styleLines(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
  private nextStyleExampleId(prefix: string): string {
    const ids = new Set([
      ...(this.styleProfileDraft?.approvedExamples.map((item) => item.id) ?? []),
      ...(this.styleProfileDraft?.rejectedExamples.map((item) => item.id) ?? [])
    ]);
    let index = ids.size + 1;
    while (ids.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
  }
  loadCandidateProfile(): void {
    this.api.candidateProfile().subscribe({
      next: (profile) => { this.candidateProfile = profile; this.refreshView(); },
      error: () => { this.candidateProfile = undefined; this.refreshView(); }
    });
  }
  saveClaim(claimId: string, statement: string, status: string): void {
    this.busy = true;
    this.api.patchClaim(claimId, statement, status).subscribe({
      next: () => { this.busy = false; this.notice = 'Claim nach ausdrücklicher Bestätigung gespeichert.'; this.loadCandidateProfile(); },
      error: (error) => this.fail(error)
    });
  }

  importFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { this.error = 'Importdatei ist größer als 10 MiB.'; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      this.api.importProfile(file.name, file.type || 'text/plain', base64, 'user_upload').subscribe({
        next: (preview) => { this.importPreview = preview; this.notice = `${preview.proposals.length} unbestätigte Vorschläge extrahiert.`; this.refreshView(); },
        error: (error) => this.fail(error)
      });
    };
    reader.readAsDataURL(file);
  }

  discardProposal(proposalId: string): void {
    if (!this.importPreview) return;
    this.importPreview.proposals = this.importPreview.proposals.filter((item) => item.id !== proposalId);
    this.notice = 'Importvorschlag lokal verworfen; das Kandidatenprofil wurde nicht verändert.';
  }
  mergeImportProposal(proposal: ProfileImportPreview['proposals'][number]): void {
    if (!proposal.conflict) return;
    const existing = this.candidateProfile?.claims.find((item) => item.id === proposal.conflict!.existingClaimId);
    if (!existing) { this.error = 'Bestehender Konflikt-Claim ist nicht mehr verfügbar.'; return; }
    this.api.patchClaim(existing.id, proposal.statement, existing.status).subscribe({ next: () => {
      this.discardProposal(proposal.id); this.notice = 'Vorschlag nach ausdrücklicher Aktion in den bestehenden Claim zusammengeführt.'; this.loadCandidateProfile();
    }, error: (error) => this.fail(error) });
  }
  acceptImportProposals(): void {
    if (!this.importPreview?.proposals.length) return;
    this.api.acceptImport(this.importPreview).subscribe({ next: () => {
      this.notice = 'Ausgewählte Vorschläge wurden ausdrücklich als unverified Claims übernommen.';
      this.importPreview = undefined; this.loadCandidateProfile();
    }, error: (error) => this.fail(error) });
  }

  login(source: SourceStatus): void {
    this.busy = true; this.notice = ''; this.error = '';
    this.api.login(source.id).subscribe({
      next: (result) => { this.busy = false; this.notice = result.note || `Login-Status: ${result.status}`; this.refreshSources(); this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  logout(source: SourceStatus): void {
    this.busy = true; this.notice = ''; this.error = '';
    this.api.logout(source.id).subscribe({
      next: (result) => { this.busy = false; this.notice = `Sitzung: ${result.status}`; this.refreshSources(); },
      error: (error) => this.fail(error)
    });
  }

  sourceCapability(sourceId: string): SourceCapability | undefined {
    return this.capabilities?.sources.find((source) => source.id === sourceId);
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
    if (enabled && this.sourceCapability(sourceId)?.compatible === false) { this.error = `Quelle ${sourceId} hat eine inkompatible Vertragsversion und bleibt deaktiviert.`; return; }
    const selected = new Set(this.config.searchProfile.sourceIds);
    enabled ? selected.add(sourceId) : selected.delete(sourceId);
    this.config.searchProfile.sourceIds = [...selected];
  }

  selectedSourceCount(): number { return this.sources.filter((source) => this.sourceSelected(source.id)).length; }
  sourceSelected(sourceId: string): boolean { return this.config?.searchProfile.sourceIds.includes(sourceId) ?? false; }
  unsupportedActiveFilters(): string[] {
    if (!this.config || !this.capabilities) return [];
    const supported = new Set(this.capabilities.sources.filter((item) => this.config!.searchProfile.sourceIds.includes(item.id)).flatMap((item) => item.filters));
    const active = [
      this.config.searchProfile.workModels.length ? 'workModels' : '', this.config.searchProfile.employmentTypes.length ? 'employmentTypes' : '',
      this.config.searchProfile.mustHave.length ? 'mustHave (lokal nachgelagert)' : '', this.config.searchProfile.niceToHave.length ? 'niceToHave (lokal nachgelagert)' : '',
      this.config.searchProfile.exclude.length ? 'exclude (lokal nachgelagert)' : '', this.config.searchProfile.minSalary ? 'minSalary' : '', this.config.searchProfile.radiusKm ? 'radiusKm' : ''
    ].filter(Boolean);
    return active.filter((item) => item.includes('lokal') || !supported.has(item));
  }
  acceptedCount(): number { return this.matches.filter((match) => match.accepted).length; }

  openNativeDialog(dialogRef?: ElementRef<HTMLDialogElement>, initialFocus?: ElementRef<HTMLElement>): void {
    const dialog = dialogRef?.nativeElement;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    initialFocus?.nativeElement.focus();
  }

  closeNativeDialog(dialogRef?: ElementRef<HTMLDialogElement>): void {
    const dialog = dialogRef?.nativeElement;
    if (!dialog?.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  restoreDialogFocus(target?: HTMLElement): void {
    if (!target) return;
    setTimeout(() => {
      if (target.isConnected && !target.hasAttribute('disabled')) target.focus();
    });
  }

  refreshView(): void {
    // Ausgelagerte Bereiche lesen ihren Zustand aus Stores; das Signal markiert ihre Ansicht neu.
    this.agents.revision.update((value) => value + 1);
    this.cv.revision.update((value) => value + 1);
    this.changeDetector.markForCheck();
  }
  fail(error: unknown): void { this.busy = false; this.loading = false; this.error = this.message(error); this.refreshView(); }
  message(error: unknown): string {
    if (typeof error === 'object' && error && 'error' in error) {
      const body = (error as { error?: { error?: string; category?: string; correlationId?: string } }).error;
      if (body?.error) {
        const action = body.category === 'validation' ? ' Eingaben prüfen.' : body.category === 'authentication' ? ' Anmeldung bewusst erneuern.' : body.category === 'retryable_dependency' ? ' Lokale Abhängigkeit prüfen und erneut versuchen.' : '';
        return `${body.error}${action}${body.correlationId ? ` Referenz: ${body.correlationId}` : ''}`;
      }
    }
    return error instanceof Error ? error.message : 'Die Aktion ist fehlgeschlagen.';
  }
}
