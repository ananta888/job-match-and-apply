import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, forwardRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { sectionFromUrl, sectionUrl } from './app.routes';
import { ApiService } from './api.service';
import { AgentCenterComponent } from './agent-center.component';
import { AgentCenterStore } from './agent-center.store';
import { APP_HOST } from './app-host';
import { CvFactsEditorComponent } from './cv-facts-editor.component.js';
import { cvFactGroupIsRaw, groupCvFactRecords } from './cv-facts-view.js';
import { forkJoin, type Subscription } from 'rxjs';
import type { AgentArtifactRecord, AgentOrchestrationRecord, AgentProviderConfigProfile, AgentRunRequest, AppConfig, ApplicationCase, ApplicationSourceCvCandidate, ApplicationDraft, ApplicationExportResult, ApplicationProfileSetupStatus, ApplicationStyleDocumentType, ApplicationStyleExampleDocumentType, ApplicationStyleProfileView, ArtifactRevision, CandidateMatchAnalysis, CandidateProfileSummary, CompanyCrm, CorrelatedMail, CvAiProviderSelection, CvAiStructuringOptions, CvAiStructuringPublicRun, CvAiStructuringSelection, CvAiStructuringSuggestion, CvAdoptionLedgerEntry, CvFact, CvFactCategory, CvFactDecision, CvFactOperation, CvImportRecord, CvImportSummary, CvIncognitoPreview, CvProfileSnapshotSummary, CvRecognitionVersionList, CvRecognitionVersionSummary, CvTheme, CvLayoutFingerprint, CvThemeOriginalLayout, JobInventoryView, JobInventoryCategory, SearchRunSummary, AtsCheckReport, JobSearchMcpRuntimeCandidate, DataInventory, EditableApplicationStyleProfile, IdentityProfile, JobDecision, JobMatch, JobSourceCapabilities, LanguageCheckResult, MailAccount, McpRuntimeStatus, ProfileImportPreview, ProviderModelCatalog, SearchSchedule, Section, SourceCapability, SourceStatus } from './models';

interface CvFactGroup {
  recordId: string;
  category: CvFactCategory;
  facts: CvFact[];
  title: string;
  period?: string;
}

type CvStudioStep = 1 | 2 | 3 | 4 | 5 | 6;
type CvFactDraft = Pick<CvFact, 'category' | 'recordId' | 'field' | 'value'>;
interface CvNewFactDraft {
  category: CvFactCategory;
  target: 'existing_record' | 'new_record';
  recordId: string;
  newRecordKey: string;
  field: string;
  value: string;
  explicitlyConfirmed: boolean;
}

interface CvAiSuggestionGroup {
  key: string;
  category: string;
  recordId: string | null;
  title: string;
  period?: string;
  suggestions: CvAiStructuringSuggestion[];
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, CvFactsEditorComponent, AgentCenterComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  providers: [{ provide: APP_HOST, useExisting: forwardRef(() => App) }]
})
export class App implements OnInit, OnDestroy {
  /** Zustand und Logik des Agent Centers; auch von Lebenslauf und Bewerbung genutzt. */
  readonly agents = inject(AgentCenterStore);
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly sanitizer = inject(DomSanitizer);
  // Optional, damit Unit-Tests ohne Router-Provider weiterlaufen.
  private readonly router = inject(Router, { optional: true });
  private routerSubscription?: Subscription;
  section: Section = 'overview';

  constructor() { this.agents.attach(this); }
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
  applicationStyleProfile?: ApplicationStyleProfileView;
  styleProfileDraft?: EditableApplicationStyleProfile;
  styleVocabularyPreferText = '';
  styleVocabularyAvoidText = '';
  stylePreferredPatternsText = '';
  styleAvoidPatternsText = '';
  styleProfileConfirmed = false;
  styleProfileBusy = false;
  styleProfileError = '';
  readonly styleDocumentTypes: ApplicationStyleDocumentType[] = ['cv', 'cover_letter', 'email', 'linkedin'];
  readonly styleExampleDocumentTypes: ApplicationStyleExampleDocumentType[] = ['cv', 'cover_letter', 'email', 'linkedin', 'interview'];
  candidateProfile?: CandidateProfileSummary;
  matchAnalysis?: CandidateMatchAnalysis;
  applicationCases: ApplicationCase[] = [];
  selectedApplicationCaseId?: string;
  applicationArtifacts: Record<string, ArtifactRevision[]> = {};
  sourceCvCandidates: ApplicationSourceCvCandidate[] = [];
  sourceCvSelection = '';
  sourceCvCandidatesBusy = false;
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
  mailCorrelationTarget: Record<string, string> = {};
  mailAccountForm = { label: '', email: '', host: '', port: 993, secure: true, username: '', secret: '', authType: 'password' as const, enabled: false, mailbox: 'INBOX' };
  importPreview?: ProfileImportPreview;
  cvImport?: CvImportRecord;
  cvImportInventory: CvImportSummary[] = [];
  cvImportSelection: Record<string, boolean> = {};
  cvInventoryBusy = false;
  cvRecognitionVersions?: CvRecognitionVersionList;
  cvRecognitionVersionBusy = false;
  cvRecognitionVersionError = '';
  cvRecognitionVersionNotice = '';
  cvRecognitionVersionConfirmed = false;
  cvRecognitionSelectedVersionId = '';
  cvStep: CvStudioStep = 1;
  cvFactDrafts: Record<string, CvFactDraft> = {};
  cvNewFactDraft: CvNewFactDraft = {
    category: 'additional', target: 'new_record', recordId: '', newRecordKey: 'additional-fact',
    field: 'detail', value: '', explicitlyConfirmed: false
  };
  cvDeleteConfirmation = '';
  cvSelectedApplicationCaseId = '';
  cvThemeDraft: CvTheme = {
    template: 'classic', font: 'Arial', accentColor: '#1f2937', spacing: 'comfortable',
    sectionOrder: ['profile', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional']
  };
  cvAdoptionConfirmed = false;
  cvRevocableAdoptions: CvAdoptionLedgerEntry[] = [];
  cvProfileSnapshots: CvProfileSnapshotSummary[] = [];
  cvClaimManagementBusy = false;
  cvClaimManagementError = '';
  cvClaimManagementNotice = '';
  cvRevokeConfirmed = false;
  cvSnapshotConfirmed = false;
  cvSelectedSnapshotId = '';
  cvThemeConfirmed = false;
  cvThemeVariant: 'ats' | 'original' = 'ats';
  cvThemePreviewUrl?: SafeResourceUrl;
  cvThemePreviewVariant?: 'ats' | 'original';
  cvThemePreviewBusy = false;
  cvIncognitoPreview?: CvIncognitoPreview;
  cvIncognitoPreviewUrl?: SafeResourceUrl;
  private cvIncognitoPreviewObjectUrl?: string;
  private cvThemePreviewObjectUrl?: string;
  cvAtsReport?: AtsCheckReport;
  cvAtsBusy = false;
  cvAtsError = '';
  cvAtsSource: 'theme-preview' | 'proposal' = 'theme-preview';
  cvProposalHtmlUrl?: SafeResourceUrl;
  cvAgentOrchestrationId?: string;
  cvBusy = false;
  cvError = '';
  cvNotice = '';
  cvAiOptions?: CvAiStructuringOptions;
  cvAiRuns: CvAiStructuringPublicRun[] = [];
  cvAiRun?: CvAiStructuringPublicRun;
  cvAiInstallationKey = '';
  cvAiModelOverride = '';
  cvAiDisclosureConfirmed = false;
  cvAiApplyConfirmed = false;
  cvAiSuggestionSelections: Record<string, boolean> = {};
  cvAiAlternativeSelections: Record<string, string> = {};
  cvAiRejectedSuggestions: Record<string, boolean> = {};
  cvAiBusy = false;
  cvAiError = '';
  cvAiNotice = '';
  private cvAiAppliedReloadKey = '';
  readonly cvMaxFileBytes = 10 * 1024 * 1024;
  readonly cvFactCategories: CvFactCategory[] = [
    'profile', 'contact', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional'
  ];
  readonly cvSectionCategories: CvTheme['sectionOrder'] = [
    'profile', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional'
  ];
  readonly cvSteps: Array<{ id: CvStudioStep; label: string }> = [
    { id: 1, label: 'Import' }, { id: 2, label: 'Fakten' }, { id: 3, label: 'Schreibstil' },
    { id: 4, label: 'Formatvorlage' }, { id: 5, label: 'Zielstelle' }, { id: 6, label: 'Agentenlauf & HTML' }
  ];
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
  private cvAiPollHandle?: ReturnType<typeof setInterval>;
  private cvAiPollInFlight = false;
  private portalPermissionReturnFocus?: HTMLElement;
  @ViewChild('portalPermissionDialogElement') private portalPermissionDialogElement?: ElementRef<HTMLDialogElement>;
  @ViewChild('portalPermissionConfirm') private portalPermissionConfirm?: ElementRef<HTMLInputElement>;

  readonly nav: { id: Section; label: string; icon: string }[] = [
    { id: 'overview', label: 'Übersicht', icon: 'grid' },
    { id: 'search', label: 'Jobsuche', icon: 'search' },
    { id: 'jobs', label: 'Meine Jobs', icon: 'grid' },
    { id: 'identity', label: 'Profil & Identität', icon: 'user' },
    { id: 'cv', label: 'Lebenslauf', icon: 'file' },
    { id: 'sources', label: 'Quellen & MCP', icon: 'nodes' },
    { id: 'applications', label: 'Bewerbung', icon: 'file' },
    { id: 'crm', label: 'Firmen & Antworten', icon: 'nodes' },
    { id: 'agents', label: 'Agent Center', icon: 'terminal' },
    { id: 'operations', label: 'Daten & Betrieb', icon: 'nodes' }
  ];

  ngOnInit(): void {
    this.agents.configureAgentMotionPreference();
    this.bindSectionToRouter();
    this.load();
  }

  ngOnDestroy(): void {
    this.routerSubscription?.unsubscribe();
    this.agents.stopAgentPolling(); this.agents.stopAgentStream(); this.stopCvAiPolling();
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

  selectMcpRuntime(runtimeTarget: 'windows' | 'wsl'): void {
    if (!this.config || this.mcpRuntimeBusy) return;
    this.mcpRuntimeBusy = true; this.error = ''; this.notice = '';
    this.api.selectMcpRuntime(runtimeTarget, this.config.revision).subscribe({
      next: (config) => {
        this.config = config; this.mcpRuntimeBusy = false;
        this.notice = `Job-Suche-MCP läuft jetzt über die ${runtimeTarget === 'windows' ? 'native Windows' : 'WSL'}-Runtime.`;
        this.refreshSources(); this.refreshView();
      },
      error: (error) => { this.mcpRuntimeBusy = false; this.error = this.message(error); this.refreshView(); }
    });
  }
  mcpRuntimeLabelFor(target: 'windows' | 'wsl'): string { return target === 'windows' ? 'Nativ (Windows)' : 'WSL (Ubuntu)'; }

  select(section: Section): void {
    this.applySection(section);
    const target = sectionUrl(section);
    // Ohne konfigurierte Routen (z. B. Unit-Tests ohne provideRouter) bleibt die Auswahl rein lokal.
    if (this.router?.config.length && sectionFromUrl(this.router.url) !== section) void this.router.navigateByUrl(target);
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
    this.section = section; this.notice = ''; this.error = '';
    if (section !== 'agents' && section !== 'cv' && section !== 'applications') this.agents.stopAgentPolling();
    if (section !== 'agents') { this.agents.stopAgentStream(); this.agents.closeAgentRecoveryDialog(); }
    if (section !== 'cv') this.stopCvAiPolling();
    if (section === 'jobs') this.loadJobs();
    if (section === 'identity') { this.loadProfileSetup(); this.loadCandidateProfile(); this.loadProfileCvOverview(); }
    if (section === 'cv') this.loadCvStudio();
    if (section === 'applications') {
      this.loadApplicationCases();
      this.loadSourceCvCandidates();
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

  loadCvStudio(): void {
    if (!this.agents.agentConfigProfile) this.agents.loadAgentConfigProfile();
    this.loadCvImportInventory();
    this.loadApplicationCases();
    // Lädt das Stilprofil nur, wenn der Setup-Status es als vorhanden meldet (vermeidet einen 404).
    this.loadProfileSetup();
    this.agents.refreshAgentOrchestrations();
    if (!this.agents.agentProviders.length) this.agents.loadAgentProviders();
    if (!this.agents.agentWorkflows.length) this.api.agentWorkflows().subscribe({
      next: (items) => { this.agents.agentWorkflows = items; this.refreshView(); },
      error: (error) => { this.cvError = this.message(error); this.refreshView(); }
    });
    if (this.cvImport) { this.loadCvRecognitionVersions(); this.loadCvAiStructuringState(); }
    this.agents.startAgentPolling();
  }

  private cvAiModelCatalogTarget(): Pick<AgentProviderConfigProfile, 'provider' | 'runtimeTarget' | 'wslDistribution'> | undefined {
    const selected = this.cvAiSelectedInstallation();
    if (!selected) return undefined;
    return {
      provider: selected.providerId, runtimeTarget: selected.installation.runtimeTarget,
      ...(selected.installation.wslDistribution ? { wslDistribution: selected.installation.wslDistribution } : {}),
    };
  }

  cvAiModelCatalog(): ProviderModelCatalog | undefined {
    const target = this.cvAiModelCatalogTarget();
    return target ? this.agents.agentModelCatalogs[this.agents.modelCatalogKey(target)] : undefined;
  }

  cvAiModelCatalogKey(): string {
    const target = this.cvAiModelCatalogTarget();
    return target ? this.agents.modelCatalogKey(target) : '';
  }

  loadCvAiModels(): void {
    const target = this.cvAiModelCatalogTarget();
    if (target) this.agents.loadProviderModels(target);
  }
  finalizerAnswerDrafts: Record<string, string> = {};
  finalizerAnswersConfirmed = false;
  applicationRetryBusy = false;

  /** Saves ONLY the confirmed runtime/distribution change on top of the SAVED revision. */
  alignAgentProfileRuntimeTo(): void {
    const view = this.agents.agentConfigProfile;
    const installation = this.agents.selectedAgentOrchestrationInstallation();
    const providerId = this.agents.agentOrchestrationForm.providerId;
    if (!view || !installation || !this.agents.agentProfileRuntimeFixConfirmed || this.agents.agentConfigProfileBusy) return;
    const saved = structuredClone(view.profile);
    const rule = saved.providers.find((candidate) => candidate.provider === providerId);
    if (!rule) return;
    rule.runtimeTarget = installation.runtimeTarget;
    rule.wslDistribution = installation.runtimeTarget === 'wsl' ? (installation.distribution ?? undefined) : undefined;
    this.agents.agentConfigProfileDraft = saved;
    this.agents.agentConfigProfileConfirmed = true;
    this.agents.agentProfileRuntimeFixConfirmed = false;
    this.agents.saveAgentConfigProfile();
  }
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
        this.matches = matches; this.selectedMatch = matches[0]; this.busy = false; this.section = 'search';
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
        this.jobsBusy = false; this.section = 'applications';
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
  setJobDecision(jobId: string, state: JobDecision['state']): void {
    this.api.setJobDecision(jobId, state).subscribe({ next: (decision) => {
      this.jobDecisions = [decision, ...this.jobDecisions.filter((item) => item.jobId !== jobId)];
      this.notice = state === 'neutral' ? 'Entscheidung rückgängig gemacht.' : state === 'saved' ? 'Stelle gemerkt.' : 'Stelle ausgeblendet.';
      this.refreshView();
    }, error: (error) => this.fail(error) });
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
      next: (draft) => { this.draft = draft; this.busy = false; this.section = 'applications'; this.refreshView(); },
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
    const sourceCv = this.sourceCvBindingForCreation();
    this.busy = true;
    this.api.createApplicationCase(this.selectedMatch, this.config.activeIdentityId, this.documentType, {
      ...(this.documentType === 'cv' ? { documentPurpose: 'vacancy_cv' as const } : {}),
      ...(sourceCv ? { sourceCv } : {})
    }).subscribe({
      next: (application) => {
        this.applicationCases.unshift(application);
        this.selectApplicationCase(application);
        this.applicationArtifacts[application.id] = [];
        this.sourceCvSelection = '';
        this.busy = false;
        this.notice = sourceCv
          ? 'Bewerbungsfall lokal angelegt und an den freigegebenen Lebenslauf gebunden.'
          : 'Bewerbungsfall lokal angelegt und an die Werkstatt gebunden.';
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }

  loadSourceCvCandidates(): void {
    this.sourceCvCandidatesBusy = true;
    this.api.applicationSourceCvCandidates().subscribe({
      next: (items) => { this.sourceCvCandidates = items; this.sourceCvCandidatesBusy = false; this.refreshView(); },
      error: (error) => { this.sourceCvCandidatesBusy = false; this.fail(error); }
    });
  }

  sourceCvCandidateKey(candidate: ApplicationSourceCvCandidate): string {
    return `${candidate.caseId}::${candidate.revisionId}`;
  }

  selectedSourceCvCandidate(): ApplicationSourceCvCandidate | undefined {
    return this.sourceCvCandidates.find((item) => this.sourceCvCandidateKey(item) === this.sourceCvSelection);
  }

  sourceCvBindingForCreation(): { caseId: string; revisionId: string; sha256: string } | undefined {
    if (this.documentType === 'cv') return undefined;
    const candidate = this.selectedSourceCvCandidate();
    return candidate ? { caseId: candidate.caseId, revisionId: candidate.revisionId, sha256: candidate.sha256 } : undefined;
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
    if (!orchestration || !round || this.applicationRetryBusy || !this.finalizerAnswersConfirmed) return;
    const answers = round.questions.map((question) => ({
      id: question.id,
      question: question.question,
      answer: (this.finalizerAnswerDrafts[question.id] ?? '').trim() || 'Keine Ergänzung',
    }));
    if (answers.some((answer) => answer.answer.length > 1_500)) {
      this.agents.agentOrchestrationError = 'Eine Antwort überschreitet 1.500 Zeichen.';
      this.refreshView(); return;
    }
    this.applicationRetryBusy = true;
    this.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(orchestration.id, round.nodeId, {
      instructions: '', includePreviousVersion: false, answers,
    }).subscribe({
      next: (created) => {
        this.applicationRetryBusy = false;
        this.finalizerAnswerDrafts = {};
        this.finalizerAnswersConfirmed = false;
        this.agents.agentOrchestrations = [created, ...this.agents.agentOrchestrations.filter((item) => item.id !== created.id)];
        this.applicationAgentOrchestrationId = created.id;
        this.notice = 'Die Antworten sind gebunden; der Finalizer läuft mit derselben eingefrorenen Konfiguration weiter.';
        this.refreshView();
      },
      error: (error) => { this.applicationRetryBusy = false; this.agents.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }

  canRetryFinalizerQuickly(run: AgentOrchestrationRecord): boolean {
    return run.status === 'failed' && run.providerId === 'openrouter' && run.workflowId === 'evidence-application-package'
      && run.nodes.some(node => node.nodeId === 'finalizer' && node.status === 'failed' && node.failureCategory !== 'needs_input');
  }
  retryFinalizerQuickly(run: AgentOrchestrationRecord): void {
    if (!this.canRetryFinalizerQuickly(run) || this.applicationRetryBusy) return;
    this.applicationRetryBusy = true; this.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(run.id, 'finalizer', undefined, 'off').subscribe({
      next: created => {
        this.applicationRetryBusy = false;
        this.agents.agentOrchestrations = [created, ...this.agents.agentOrchestrations.filter(item => item.id !== created.id)];
        if (created.scope.applicationCaseId === this.cvSelectedApplicationCaseId) this.cvAgentOrchestrationId = created.id;
        if (created.scope.applicationCaseId === this.selectedApplicationCaseId) this.applicationAgentOrchestrationId = created.id;
        this.notice = 'Nur der Abschluss läuft erneut mit Reasoning Aus. Fertige Vorstufen bleiben erhalten; das gespeicherte Profil bleibt unverändert.';
        this.refreshView();
      },
      error: error => { this.applicationRetryBusy = false; this.agents.agentOrchestrationError = this.message(error); this.refreshView(); },
    });
  }

  applicationRetryNode(): AgentOrchestrationRecord['nodes'][number] | undefined {
    const orchestration = this.applicationAgentOrchestration();
    if (!orchestration || orchestration.status !== 'failed') return undefined;
    return orchestration.nodes.find((node) => node.status === 'failed' && node.failureCategory !== 'needs_input');
  }

  /** Targeted per-node retry from the status list (failed or policy-blocked steps). */
  retryOrchestrationNode(orchestration: AgentOrchestrationRecord, nodeId: string): void {
    if (this.applicationRetryBusy) return;
    const node = orchestration.nodes.find((item) => item.nodeId === nodeId);
    if (!node || !['failed', 'policy_blocked'].includes(node.status)) return;
    this.applicationRetryBusy = true;
    this.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(orchestration.id, nodeId).subscribe({
      next: (created) => {
        this.applicationRetryBusy = false;
        this.agents.agentOrchestrations = [created, ...this.agents.agentOrchestrations.filter((item) => item.id !== created.id)];
        if (this.selectedApplicationCaseId && created.scope.applicationCaseId === this.selectedApplicationCaseId) {
          this.applicationAgentOrchestrationId = created.id;
        } else {
          this.agents.selectedAgentOrchestration = created;
        }
        this.notice = `Schritt „${node.role}" wird mit der eingefrorenen Konfiguration wiederholt.`;
        this.refreshView();
      },
      error: (error) => { this.applicationRetryBusy = false; this.agents.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }

  retryApplicationFailedNode(): void {
    const orchestration = this.applicationAgentOrchestration();
    const node = this.applicationRetryNode();
    if (!orchestration || !node || this.applicationRetryBusy) return;
    this.applicationRetryBusy = true;
    this.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(orchestration.id, node.nodeId).subscribe({
      next: (created) => {
        this.applicationRetryBusy = false;
        this.agents.agentOrchestrations = [created, ...this.agents.agentOrchestrations.filter((item) => item.id !== created.id)];
        this.applicationAgentOrchestrationId = created.id;
        this.notice = `Schritt „${node.role}“ wird mit der eingefrorenen Konfiguration wiederholt.`;
        this.refreshView();
      },
      error: (error) => { this.applicationRetryBusy = false; this.agents.agentOrchestrationError = this.message(error); this.refreshView(); }
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
          this.applicationStyleProfile = undefined;
          this.styleProfileDraft = undefined;
          this.styleProfileError = '';
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
    this.styleProfileError = '';
    this.api.applicationStyleProfile().subscribe({
      next: (view) => {
        this.applyApplicationStyleProfile(view);
        this.styleProfileBusy = false;
        this.refreshView();
      },
      error: (error) => {
        this.styleProfileBusy = false;
        this.styleProfileError = this.message(error);
        this.refreshView();
      }
    });
  }
  saveApplicationStyleProfile(): void {
    const current = this.applicationStyleProfile;
    const draft = this.styleProfileDraft;
    if (!current || !draft) return;
    if (!this.styleProfileConfirmed) {
      this.styleProfileError = 'Die versionierte Stilprofil-Änderung muss ausdrücklich bestätigt werden.';
      return;
    }
    const profile = this.normalizedApplicationStyleProfile(draft);
    const validationError = this.applicationStyleProfileValidationError(profile);
    if (validationError) { this.styleProfileError = validationError; return; }
    this.styleProfileBusy = true;
    this.styleProfileError = '';
    this.api.saveApplicationStyleProfile(current, profile).subscribe({
      next: (view) => {
        this.applyApplicationStyleProfile(view);
        this.styleProfileBusy = false;
        this.notice = `Stilprofil als Revision ${view.revision} gespeichert. Die lokale Sprachprüfung bleibt nspell-only.`;
        this.refreshView();
      },
      error: (error) => {
        this.styleProfileBusy = false;
        this.styleProfileError = this.message(error);
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
    this.applicationStyleProfile = view;
    this.styleProfileDraft = structuredClone(view.profile);
    this.styleVocabularyPreferText = view.profile.vocabulary.prefer.join('\n');
    this.styleVocabularyAvoidText = view.profile.vocabulary.avoid.join('\n');
    this.stylePreferredPatternsText = view.profile.preferredPatterns.join('\n');
    this.styleAvoidPatternsText = view.profile.avoidPatterns.join('\n');
    this.styleProfileConfirmed = false;
    this.styleProfileError = '';
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

  loadCvRecognitionVersions(): void {
    const current = this.cvImport;
    if (!current) { this.resetCvRecognitionVersions(); return; }
    this.cvRecognitionVersionBusy = true; this.cvRecognitionVersionError = '';
    this.api.cvRecognitionVersions(current).subscribe({
      next: (list) => {
        this.cvRecognitionVersionBusy = false;
        if (!this.cvImport || !this.cvRecognitionVersionListMatches(list, this.cvImport)) {
          this.cvRecognitionVersions = undefined;
          this.cvRecognitionVersionError = 'Die Erkennungsstände entsprechen nicht dem aktuellen Lebenslaufvertrag. Lade den Import neu.';
          this.refreshView(); return;
        }
        if (this.cvRecognitionVersions?.activeVersionId !== list.activeVersionId) this.cvRecognitionVersionConfirmed = false;
        this.cvRecognitionVersions = list; this.cvRecognitionSelectedVersionId = list.activeVersionId;
        this.refreshView();
      },
      error: (error) => {
        this.cvRecognitionVersionBusy = false; this.cvRecognitionVersions = undefined;
        this.cvRecognitionVersionError = `Erkennungsstände konnten nicht geladen werden: ${this.message(error)}`;
        this.refreshView();
      }
    });
  }

  /**
   * Loads what the candidate profile itself says about this import: which adoptions are still
   * revocable and which profile snapshots exist. The server record can lose its adoption link
   * while the claims stay in the profile, so the profile ledger is the authority here.
   */
  loadCvClaimManagement(): void {
    const current = this.cvImport;
    if (!current) { this.cvRevocableAdoptions = []; this.cvProfileSnapshots = []; return; }
    this.cvClaimManagementBusy = true; this.cvClaimManagementError = '';
    forkJoin({
      revocable: this.api.revocableCvAdoptions(current),
      snapshots: this.api.cvProfileSnapshots(current)
    }).subscribe({
      next: ({ revocable, snapshots }) => {
        this.cvClaimManagementBusy = false;
        if (this.cvImport?.id !== current.id) { this.refreshView(); return; }
        this.cvRevocableAdoptions = revocable.adoptions;
        this.cvProfileSnapshots = snapshots.snapshots;
        if (!this.cvProfileSnapshots.some((item) => item.id === this.cvSelectedSnapshotId)) {
          this.cvSelectedSnapshotId = this.cvProfileSnapshots.find((item) => !item.current)?.id ?? '';
        }
        this.refreshView();
      },
      error: (error) => {
        this.cvClaimManagementBusy = false;
        this.cvRevocableAdoptions = []; this.cvProfileSnapshots = [];
        this.cvClaimManagementError = `Profilstände konnten nicht geladen werden: ${this.message(error)}`;
        this.refreshView();
      }
    });
  }

  /** The adoption of this import's source that a revoke would target. */
  cvRevocableAdoption(): CvAdoptionLedgerEntry | undefined {
    return this.cvRevocableAdoptions.find((item) => item.presentClaimCount > 0)
      ?? this.cvRevocableAdoptions[0];
  }

  /**
   * Records an adoption that already happened without writing the profile again. The server only
   * accepts this when *every* confirmed claim is already present; a partial overlap stays a
   * collision, so this can never paper over a half-finished adoption.
   */
  markCvAlreadyAdopted(): void {
    const current = this.cvImport;
    if (!current || this.cvBusy || this.cvClaimManagementBusy) return;
    this.cvClaimManagementBusy = true; this.cvBusy = true;
    this.cvClaimManagementError = ''; this.cvClaimManagementNotice = ''; this.cvError = '';
    this.api.adoptCvFacts(current).subscribe({
      next: (record) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false; this.cvAdoptionConfirmed = false;
        this.applyCvImport(record, true);
        this.cvClaimManagementNotice = record.adoption?.alreadyAdopted
          ? `Die ${record.adoption.adoptedClaimIds.length} Claims lagen bereits im Kandidatenprofil und wurden ohne erneute Schreiboperation verbucht.`
          : `${record.adoption?.adoptedClaimIds.length ?? 0} bestätigte Claims wurden in das Kandidatenprofil übernommen.`;
        this.loadCandidateProfile(); this.loadCvClaimManagement(); this.refreshView();
      },
      error: (error) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false;
        this.cvClaimManagementError = (error as { status?: number })?.status === 409
          ? 'Nur ein Teil der bestätigten Claims liegt bereits im Kandidatenprofil. Verwirf die bisherige Übernahme und übernimm neu.'
          : this.message(error);
        this.refreshView();
      }
    });
  }

  /** Discards the recorded adoption and immediately re-adopts the currently confirmed facts. */
  revokeAndReadoptCvAdoption(): void {
    const current = this.cvImport; const target = this.cvRevocableAdoption();
    if (!current || !target || !this.cvRevokeConfirmed || this.cvBusy || this.cvClaimManagementBusy) return;
    this.cvClaimManagementBusy = true; this.cvBusy = true;
    this.cvClaimManagementError = ''; this.cvClaimManagementNotice = ''; this.cvError = '';
    this.api.revokeCvAdoption(current, target.transactionId).subscribe({
      next: (revoked) => {
        this.applyCvImport(revoked, true); this.cvRevokeConfirmed = false;
        this.api.adoptCvFacts(revoked).subscribe({
          next: (record) => {
            this.cvClaimManagementBusy = false; this.cvBusy = false; this.cvAdoptionConfirmed = false;
            this.applyCvImport(record, true);
            this.cvClaimManagementNotice = `Die frühere Übernahme (${target.claimCount} Claims) wurde verworfen; ${record.adoption?.adoptedClaimIds.length ?? 0} Claims des aktiven Erkennungsstands wurden neu übernommen.`;
            this.loadCandidateProfile(); this.loadCvClaimManagement(); this.refreshView();
          },
          error: (error) => {
            this.cvClaimManagementBusy = false; this.cvBusy = false;
            this.cvClaimManagementError = `Die frühere Übernahme wurde verworfen, die neue Übernahme ist aber fehlgeschlagen: ${this.message(error)}`;
            this.loadCandidateProfile(); this.loadCvClaimManagement(); this.refreshView();
          }
        });
      },
      error: (error) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false;
        this.cvClaimManagementError = (error as { status?: number })?.status === 409
          ? 'Die frühere Übernahme ist nicht mehr widerrufbar. Lade den Import neu.'
          : this.message(error);
        this.refreshView();
      }
    });
  }

  /** Rolls the whole candidate profile back to a stored state, including overwritten Profilfelder. */
  restoreCvProfileSnapshot(): void {
    const current = this.cvImport;
    const snapshot = this.cvProfileSnapshots.find((item) => item.id === this.cvSelectedSnapshotId);
    if (!current || !snapshot || snapshot.current || !this.cvSnapshotConfirmed
      || this.cvBusy || this.cvClaimManagementBusy) return;
    this.cvClaimManagementBusy = true; this.cvBusy = true;
    this.cvClaimManagementError = ''; this.cvClaimManagementNotice = ''; this.cvError = '';
    this.api.restoreCvProfileSnapshot(current, snapshot.id).subscribe({
      next: (record) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false; this.cvSnapshotConfirmed = false;
        this.applyCvImport(record, true);
        this.cvClaimManagementNotice = `Das Kandidatenprofil wurde auf den Stand vom ${snapshot.createdAt} zurückgerollt (${snapshot.claimCount} Claims).`;
        this.loadCandidateProfile(); this.loadCvClaimManagement(); this.refreshView();
      },
      error: (error) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false;
        this.cvClaimManagementError = (error as { status?: number })?.status === 409
          ? 'Das Kandidatenprofil hat sich zwischenzeitlich geändert. Lade die Profilstände neu.'
          : this.message(error);
        this.refreshView();
      }
    });
  }

  activateCvRecognitionVersion(versionId: string): void {
    const current = this.cvImport;
    const version = this.cvRecognitionVersions?.versions.find((item) => item.id === versionId);
    if (!current || !version || version.active || this.cvRecognitionVersionBusy || this.cvBusy) return;
    this.cvRecognitionVersionBusy = true; this.cvBusy = true; this.cvRecognitionVersionConfirmed = false;
    this.cvRecognitionVersionError = ''; this.cvRecognitionVersionNotice = '';
    this.api.activateCvRecognitionVersion(current, version.id).subscribe({
      next: (record) => {
        this.cvRecognitionVersionBusy = false; this.cvBusy = false;
        this.applyCvImport(record, true);
        this.cvRecognitionVersionNotice = `${version.label} ist jetzt der aktive Erkennungsstand. Alle Fakten bleiben bis zur Einzelprüfung ungeprüft.`;
        this.focusCvRecognitionVersions(); this.refreshView();
      },
      error: (error) => {
        this.cvRecognitionVersionBusy = false; this.cvBusy = false;
        this.cvRecognitionSelectedVersionId = this.cvRecognitionVersions?.activeVersionId ?? '';
        this.cvRecognitionVersionError = (error as { status?: number })?.status === 409
          ? 'Der Erkennungsstand konnte wegen einer neueren Lebenslaufrevision nicht aktiviert werden. Lade den Import neu und versuche es erneut.'
          : this.message(error);
        this.refreshView();
      }
    });
  }

  confirmCvRecognitionVersion(): void {
    const current = this.cvImport; const active = this.cvRecognitionActiveVersion();
    if (!current || !active || active.factCounts.pending < 1 || !this.cvRecognitionVersionConfirmed
      || this.cvRecognitionVersionBusy || this.cvBusy) return;
    this.cvRecognitionVersionBusy = true; this.cvBusy = true;
    this.cvRecognitionVersionError = ''; this.cvRecognitionVersionNotice = '';
    this.api.confirmCvRecognitionVersion(current, active.id).subscribe({
      next: (record) => {
        this.cvRecognitionVersionBusy = false; this.cvBusy = false; this.cvRecognitionVersionConfirmed = false;
        this.applyCvImport(record, true);
        this.cvRecognitionVersionNotice = 'Der aktive Stand wurde revisionsgebunden bestätigt. Verworfene Fakten bleiben ausgeschlossen; die Profilübernahme erfolgt weiterhin separat.';
        this.focusCvRecognitionVersions(); this.refreshView();
      },
      error: (error) => {
        this.cvRecognitionVersionBusy = false; this.cvBusy = false; this.cvRecognitionVersionConfirmed = false;
        this.cvRecognitionVersionError = (error as { status?: number })?.status === 409
          ? 'Der Stand konnte wegen einer neueren Lebenslaufrevision nicht bestätigt werden. Lade den Import neu.'
          : this.message(error);
        this.refreshView();
      }
    });
  }

  cvRecognitionActiveVersion(): CvRecognitionVersionSummary | undefined {
    const list = this.cvRecognitionVersions;
    return list?.versions.find((version) => version.id === list.activeVersionId && version.active);
  }

  cvRecognitionVersionKindLabel(kind: CvRecognitionVersionSummary['kind']): string {
    return kind === 'ai' ? 'KI-unterstützt' : 'Deterministisch · Fallback';
  }

  cvRecognitionVersionCountLabel(): string {
    const count = this.cvRecognitionVersions?.versions.length ?? 0;
    return `${count} ${count === 1 ? 'Erkennungsstand' : 'Erkennungsstände'}`;
  }

  private cvRecognitionVersionListMatches(list: CvRecognitionVersionList, current: CvImportRecord): boolean {
    if (list.contract !== 'cv-recognition-version-list' || list.contractVersion !== '1.0'
      || list.importId !== current.id || !list.versions.length) return false;
    const ids = new Set<string>();
    for (const version of list.versions) {
      if (!version.id || ids.has(version.id) || !Number.isSafeInteger(version.ordinal) || version.ordinal < 1
        || !['deterministic', 'ai'].includes(version.kind) || !version.label.trim()
        || !Number.isSafeInteger(version.factCounts.total) || version.factCounts.total < 0
        || !Number.isSafeInteger(version.factCounts.pending) || version.factCounts.pending < 0
        || !Number.isSafeInteger(version.factCounts.confirmed) || version.factCounts.confirmed < 0
        || !Number.isSafeInteger(version.factCounts.rejected) || version.factCounts.rejected < 0
        || version.factCounts.pending + version.factCounts.confirmed + version.factCounts.rejected !== version.factCounts.total
        || !Number.isSafeInteger(version.warningCount) || version.warningCount < 0
        || !Number.isFinite(Date.parse(version.createdAt)) || !Number.isFinite(Date.parse(version.updatedAt))) return false;
      ids.add(version.id);
    }
    const active = list.versions.filter((version) => version.active);
    return active.length === 1 && active[0]?.id === list.activeVersionId;
  }

  private resetCvRecognitionVersions(): void {
    this.cvRecognitionVersions = undefined; this.cvRecognitionVersionBusy = false;
    this.cvRecognitionVersionError = ''; this.cvRecognitionVersionNotice = '';
    this.cvRecognitionVersionConfirmed = false;
    this.cvRecognitionSelectedVersionId = '';
  }

  private focusCvRecognitionVersions(): void {
    setTimeout(() => (document.getElementById('cv-recognition-versions-heading') as HTMLElement | null)?.focus(), 0);
  }

  loadCvAiStructuringState(): void {
    const current = this.cvImport;
    if (!current) { this.resetCvAiStructuringState(); return; }
    this.cvAiBusy = true; this.cvAiError = '';
    this.api.cvAiStructuringRuns(current, 20).subscribe({
      next: (runs) => {
        if (!this.cvImport || this.cvImport.id !== current.id || this.cvImport.revision !== current.revision
          || this.cvImport.sha256 !== current.sha256) {
          this.cvAiBusy = false;
          this.cvAiError = 'Die AI-Läufe gehören nicht mehr zur geöffneten Lebenslaufrevision. Lade den Import neu.';
          this.stopCvAiPolling(); this.refreshView();
          return;
        }
        this.cvAiRuns = runs;
        const selected = runs.find((run) => run.id === this.cvAiRun?.id)
          ?? runs.find((run) => this.cvAiRunActive(run)) ?? runs[0];
        if (selected && this.cvAiAppliedRunNeedsImportReload(current, selected)) {
          this.reloadCvImportAfterAiApplied(current, selected);
          return;
        }
        this.api.cvAiStructuringOptions(current).subscribe({
          next: (options) => {
            if (!this.cvImport || options.cvImport.id !== this.cvImport.id
              || options.cvImport.revision !== this.cvImport.revision || options.cvImport.sha256 !== this.cvImport.sha256) {
              this.cvAiBusy = false;
              this.cvAiError = 'Die AI-Optionen gehören nicht zur aktuellen Lebenslaufrevision. Lade den Import neu.';
              this.refreshView();
              return;
            }
            this.cvAiOptions = options; this.cvAiBusy = false;
            this.setCvAiRun(selected);
            const installations = this.cvAiInstallations();
            if (!installations.some((item) => this.cvAiInstallationKeyFor(item.providerId, item.installation) === this.cvAiInstallationKey)) {
              const first = installations.find((item) => item.installation.ready);
              this.cvAiInstallationKey = first ? this.cvAiInstallationKeyFor(first.providerId, first.installation) : '';
            }
            this.refreshView();
          },
          error: (error) => this.failCvAiStructuringStateLoad(error)
        });
      },
      error: (error) => this.failCvAiStructuringStateLoad(error)
    });
  }

  private failCvAiStructuringStateLoad(error: unknown): void {
    this.cvAiBusy = false;
    this.cvAiOptions = undefined;
    this.cvAiError = `Optionale AI-Strukturierung ist derzeit nicht verfügbar: ${this.message(error)}`;
    this.stopCvAiPolling(); this.refreshView();
  }

  private cvAiAppliedRunNeedsImportReload(current: CvImportRecord, run: CvAiStructuringPublicRun): boolean {
    const result = run.status === 'applied' ? run.result : undefined;
    if (!result || result.cvImportRevision < current.revision) return false;
    return result.cvImportRevision > current.revision || result.cvImportSha256 !== current.sha256;
  }

  cvAiInstallations(): Array<{
    providerId: string;
    installation: CvAiStructuringOptions['providers'][number]['installations'][number];
  }> {
    return (this.cvAiOptions?.providers ?? [])
      .filter((provider) => this.agents.isRealAgentProvider(provider.providerId))
      .flatMap((provider) => provider.installations
        .map((installation) => ({ providerId: provider.providerId, installation })));
  }

  cvAiInstallationKeyFor(
    providerId: string,
    installation: CvAiStructuringOptions['providers'][number]['installations'][number]
  ): string {
    return [providerId, installation.runtimeTarget, installation.wslDistribution ?? '', installation.version ?? ''].join('|');
  }

  selectCvAiInstallation(key: string): void {
    this.cvAiInstallationKey = key;
    this.cvAiModelOverride = '';
    this.cvAiDisclosureConfirmed = false;
    this.cvAiApplyConfirmed = false;
    this.cvAiError = '';
  }

  cvAiSelectedInstallation(): ReturnType<App['cvAiInstallations']>[number] | undefined {
    return this.cvAiInstallations().find((item) => this.cvAiInstallationKeyFor(item.providerId, item.installation) === this.cvAiInstallationKey);
  }

  cvAiSelectedProviderLabel(): string {
    const selected = this.cvAiSelectedInstallation();
    return selected ? this.cvAiProviderLabel(selected.providerId) : 'Noch kein Provider gewählt';
  }

  cvAiProviderLabel(providerId: string): string {
    return this.agents.agentProviders.find((provider) => provider.id === providerId)?.name ?? providerId;
  }

  cvAiRuntimeLabel(item = this.cvAiSelectedInstallation()): string {
    if (!item) return 'Keine Installation gewählt';
    const runtime = item.installation.runtimeTarget === 'wsl'
      ? `WSL · ${item.installation.wslDistribution ?? 'Distribution fehlt'}`
      : item.installation.runtimeTarget === 'windows' ? 'Windows'
        : item.installation.runtimeTarget === 'darwin' ? 'macOS' : 'Linux';
    return `${runtime} · ${item.installation.version ?? 'Version unbekannt'}`;
  }

  cvAiBlockerLabel(code: string): string {
    return ({
      provider_disabled_by_profile: 'Provider im lokalen Profil deaktiviert',
      runtime_blocked_by_profile: 'Laufzeit im lokalen Profil nicht freigegeben',
      distribution_blocked_by_profile: 'WSL-Distribution nicht freigegeben',
      installation_not_supported: 'Installation nicht unterstützt',
      installation_unavailable: 'Installation wurde nicht mehr gefunden',
      provider_not_authenticated: 'Provider nicht authentifiziert',
      provider_version_unknown: 'Providerversion unbekannt',
      provider_capabilities_unavailable: 'Providerfähigkeiten konnten nicht sicher geprüft werden',
      structured_output_not_supported: 'Strukturierte Ausgabe nicht unterstützt',
      provider_zero_tools_not_supported: 'Provider besitzt keinen freigegebenen Null-Werkzeug-Modus',
      provider_runtime_attestation_not_supported: 'Provider besitzt keinen freigegebenen Runtime-Nachweis',
      synthetic_provider_test_only: 'Synthetischer Provider ist nur in automatisierten Tests erlaubt',
      read_only_not_supported: 'Read-only-Ausführung nicht unterstützt',
      runtime_not_supported: 'Laufzeit nicht unterstützt',
      capability_provider_mismatch: 'Providerbindung der Fähigkeiten stimmt nicht',
      capability_version_mismatch: 'Versionsbindung der Fähigkeiten stimmt nicht'
    } as Record<string, string>)[code] ?? code;
  }

  cvAiStartUnavailableReason(): string {
    if (!this.cvImport) return 'Importiere zuerst einen Lebenslauf.';
    if (!this.cvAiOptions) return 'Lade zuerst die serverseitigen AI-Optionen.';
    if (this.cvAiRunActive()) {
      return 'Schließe den aktuellen AI-Lauf zuerst durch Auswahl oder Abbruch ab.';
    }
    const selected = this.cvAiSelectedInstallation();
    if (!selected) return 'Wähle einen Provider und eine Installation.';
    if (!selected.installation.ready || !selected.installation.version) {
      return selected.installation.blockers.map((code) => this.cvAiBlockerLabel(code)).join(' · ') || 'Die Installation ist nicht startbereit.';
    }
    if (!this.cvAiDisclosureConfirmed) {
      return 'Bestätige ausdrücklich die Weitergabe des extrahierten Lebenslauftexts und die mögliche Provider-Control-Plane-Netznutzung.';
    }
    return '';
  }

  startCvAiStructuring(): void {
    const current = this.cvImport; const provider = this.cvAiProviderSelection();
    const unavailable = this.cvAiStartUnavailableReason();
    if (!current || !provider || unavailable || this.cvAiBusy) {
      if (unavailable) this.cvAiError = unavailable;
      this.refreshView(); return;
    }
    this.cvAiBusy = true; this.cvAiError = ''; this.cvAiNotice = 'AI-Strukturierung wird revisionsgebunden gestartet …';
    this.api.startCvAiStructuring(current, provider).subscribe({
      next: (run) => {
        this.cvAiBusy = false; this.cvAiRuns = [run, ...this.cvAiRuns.filter((item) => item.id !== run.id)];
        this.setCvAiRun(run); this.clearCvAiDisclosure();
        this.cvAiNotice = 'Der optionale AI-Lauf wurde gestartet. Lokale Fakten bleiben unverändert.';
        this.focusCvAiStatus(); this.refreshView();
      },
      error: (error) => this.failCvAi(error)
    });
  }

  selectCvAiRun(runId: string): void {
    const current = this.cvImport;
    if (!current || this.cvAiBusy) return;
    this.cvAiBusy = true; this.cvAiError = '';
    this.api.cvAiStructuringRun(current.id, runId).subscribe({
      next: (run) => {
        if (this.cvAiAppliedRunNeedsImportReload(current, run)) {
          this.reloadCvImportAfterAiApplied(current, run);
          return;
        }
        this.cvAiBusy = false; this.setCvAiRun(run); this.focusCvAiStatus(); this.refreshView();
      },
      error: (error) => this.failCvAi(error)
    });
  }

  refreshCvAiRun(): void {
    const current = this.cvImport; const run = this.cvAiRun;
    if (!current || !run || this.cvAiPollInFlight) return;
    this.cvAiPollInFlight = true;
    this.api.cvAiStructuringRun(current.id, run.id).subscribe({
      next: (fresh) => {
        this.cvAiPollInFlight = false;
        if (fresh.status === 'applied' && fresh.result) {
          this.reloadCvImportAfterAiApplied(current, fresh);
          return;
        }
        this.setCvAiRun(fresh); this.refreshView();
      },
      error: (error) => { this.cvAiPollInFlight = false; this.stopCvAiPolling(); this.failCvAi(error); }
    });
  }

  private reloadCvImportAfterAiApplied(current: CvImportRecord, run: CvAiStructuringPublicRun): void {
    const result = run.result;
    if (!result) { this.setCvAiRun(run); this.refreshView(); return; }
    const reloadKey = `${run.id}:${result.cvImportRevision}:${result.cvImportSha256}`;
    if (this.cvAiAppliedReloadKey === reloadKey) { this.setCvAiRun(run); this.refreshView(); return; }
    this.cvAiAppliedReloadKey = reloadKey; this.setCvAiRun(run);
    this.cvAiBusy = true; this.cvBusy = true;
    this.api.cvImport(current.id).subscribe({
      next: (record) => {
        if (record.revision !== result.cvImportRevision || record.sha256 !== result.cvImportSha256) {
          this.cvAiBusy = false; this.cvBusy = false; this.cvAiAppliedReloadKey = '';
          this.cvAiError = 'Der neue KI-Erkennungsstand ist noch nicht an die gemeldete Lebenslaufrevision gebunden. Lade den Import erneut.';
          this.refreshView(); return;
        }
        this.cvAiBusy = false; this.cvBusy = false; this.applyCvImport(record, true); this.cvAiRun = run;
        this.cvAiNotice = 'Der neue KI-Erkennungsstand ist aktiv. Prüfe die Struktur und bestätige den gesamten Stand mit einem Klick; einzelne Korrekturen bleiben optional.';
        this.stopCvAiPolling(); this.focusCvRecognitionVersions(); this.refreshView();
      },
      error: (error) => {
        this.cvBusy = false; this.cvAiAppliedReloadKey = ''; this.failCvAi(error);
      }
    });
  }

  cancelCvAiStructuring(): void {
    const current = this.cvImport; const run = this.cvAiRun;
    if (!current || !run || !this.cvAiCanCancel(run) || this.cvAiBusy) return;
    this.cvAiBusy = true; this.cvAiError = '';
    this.api.cancelCvAiStructuring(current.id, run).subscribe({
      next: (fresh) => {
        this.cvAiBusy = false; this.setCvAiRun(fresh);
        this.cvAiNotice = 'Abbruch wurde angefordert. Der deterministische Import bleibt erhalten.';
        this.focusCvAiStatus(); this.refreshView();
      },
      error: (error) => this.failCvAi(error)
    });
  }

  deleteCvAiRun(run: CvAiStructuringPublicRun): void {
    const current = this.cvImport;
    if (!current || this.cvAiBusy) return;
    if (!confirm(`Diesen AI-Lauf (Versuch ${run.attempt}) endgültig löschen?`)) return;
    this.cvAiBusy = true; this.cvAiError = '';
    this.api.deleteCvAiRun(current.id, run).subscribe({
      next: () => {
        this.cvAiBusy = false;
        this.cvAiRuns = this.cvAiRuns.filter((item) => item.id !== run.id);
        if (this.cvAiRun?.id === run.id) this.setCvAiRun(undefined);
        this.cvAiNotice = 'AI-Lauf gelöscht.';
        this.refreshView();
      },
      error: (error) => this.failCvAi(error)
    });
  }

  retryCvAiStructuring(): void {
    const current = this.cvImport; const previous = this.cvAiRun; const provider = this.cvAiProviderSelection();
    const unavailable = this.cvAiStartUnavailableReason();
    if (!current || !previous || !provider || !this.cvAiCanRetry(previous) || unavailable || this.cvAiBusy) {
      if (unavailable) this.cvAiError = unavailable;
      this.refreshView(); return;
    }
    this.cvAiBusy = true; this.cvAiError = '';
    this.api.retryCvAiStructuring(current, previous, provider).subscribe({
      next: (run) => {
        this.cvAiBusy = false; this.cvAiRuns = [run, ...this.cvAiRuns]; this.setCvAiRun(run); this.clearCvAiDisclosure();
        this.cvAiNotice = `Neuer AI-Versuch ${run.attempt} wurde mit aktueller Disclosure gestartet.`;
        this.focusCvAiStatus(); this.refreshView();
      },
      error: (error) => this.failCvAi(error)
    });
  }

  cvAiCanCancel(run = this.cvAiRun): boolean {
    return Boolean(run && ['queued', 'running', 'validating', 'cancel_requested'].includes(run.status));
  }

  cvAiCanRetry(run = this.cvAiRun): boolean {
    return Boolean(run && (run.status === 'cancelled' || (run.status === 'failed' && run.failure?.retryable === true)));
  }

  cvAiRunActive(run = this.cvAiRun): boolean {
    return Boolean(run && (
      ['queued', 'running', 'validating', 'cancel_requested', 'applying'].includes(run.status)
      || (run.status === 'suggestions_ready' && run.mode === 'replace_with_ai_version')
    ));
  }

  cvAiRecognitionVersionActive(run = this.cvAiRun): boolean {
    const recognitionVersionId = run?.result?.recognitionVersionId;
    return Boolean(recognitionVersionId && this.cvRecognitionVersions?.activeVersionId === recognitionVersionId);
  }

  cvAiRunStatusLabel(status: CvAiStructuringPublicRun['status'], run?: CvAiStructuringPublicRun): string {
    return ({
      queued: 'Wartet', running: 'Provider verarbeitet', validating: 'Server prüft Vertrag', suggestions_ready: 'Vorschläge bereit',
      cancel_requested: 'Abbruch läuft', cancelled: 'Abgebrochen', applying: 'KI-Erkennungsstand wird aktiviert',
      applied: this.cvAiRecognitionVersionActive(run) ? 'KI-Erkennungsstand aktiv' : 'KI-Erkennungsstand angelegt',
      failed: 'Fehlgeschlagen', expired: 'Abgelaufen'
    } as const)[status];
  }

  cvAiProgressValue(run = this.cvAiRun): number {
    if (!run) return 0;
    return ({ queued: 1, running: 2, validating: 3, suggestions_ready: 4, cancel_requested: 2,
      cancelled: 5, applying: 4, applied: 5, failed: 5, expired: 5 } as const)[run.status];
  }

  cvAiSuggestionGroups(): CvAiSuggestionGroup[] {
    const groups = new Map<string, CvAiStructuringSuggestion[]>();
    for (const suggestion of this.cvAiRun?.proposal?.suggestions ?? []) {
      const key = `${suggestion.collection}:${suggestion.recordId ?? suggestion.sectionKind ?? suggestion.path.split('.')[0]}`;
      groups.set(key, [...(groups.get(key) ?? []), suggestion]);
    }
    return [...groups.entries()].map(([key, suggestions]) => {
      const first = suggestions[0]!; const recordId = first.recordId;
      const category = first.collection === 'experience' ? 'employment' : first.collection;
      const value = (fields: string[]) => suggestions.find((item) => fields.includes(item.field) && item.value)?.value ?? undefined;
      const employer = value(['employer', 'company']); const role = value(['role', 'position']);
      const start = value(['start_date', 'start']); const end = value(['end_date', 'end']);
      const generic = value(['name', 'institution', 'qualification', 'language', 'value', 'heading']);
      const title = category === 'employment'
        ? [role, employer].filter(Boolean).join(' · ') || recordId || 'Berufliche Station'
        : generic || first.sectionKind || recordId || first.path;
      return { key, category, recordId, title, ...(start || end ? { period: `${start ?? '?'} – ${end ?? 'heute'}` } : {}), suggestions };
    }).sort((left, right) => (left.category === 'employment' ? 0 : 1) - (right.category === 'employment' ? 0 : 1)
      || left.title.localeCompare(right.title, 'de'));
  }

  cvAiSuggestionFieldLabel(field: string): string {
    return ({
      employer: 'Arbeitgeber', company: 'Arbeitgeber', role: 'Rolle', position: 'Rolle',
      start_date: 'Von', start: 'Von', end_date: 'Bis', end: 'Bis', location: 'Ort',
      institution: 'Institution', qualification: 'Abschluss', name: 'Name', language: 'Sprache', level: 'Niveau',
      detail: 'Detail', technology: 'Technologie', value: 'Wert', heading: 'Abschnitt'
    } as Record<string, string>)[field] ?? field;
  }

  cvAiGroupLabel(category: string): string {
    return ({
      employment: 'Berufserfahrung', experience: 'Berufserfahrung', education: 'Ausbildung', projects: 'Projekt', project: 'Projekt',
      skills: 'Kenntnisse', skill: 'Kenntnisse', languages: 'Sprachen', language: 'Sprachen', sections: 'Abschnitt'
    } as Record<string, string>)[category] ?? category;
  }

  cvAiConfidenceLabel(confidence: number): string {
    const level = confidence >= .8 ? 'hoch' : confidence >= .5 ? 'mittel' : 'niedrig';
    return `${level} · ${Math.round(confidence * 100)} % Provider-Konfidenz`;
  }

  cvAiAnchorLabel(anchor: CvAiStructuringSuggestion['sourceAnchor']): string {
    if (!anchor) return 'Keine exakte Quellstelle; Rückfrage erforderlich';
    const lines = anchor.lineStart === anchor.lineEnd ? `Zeile ${anchor.lineStart}` : `Zeilen ${anchor.lineStart}–${anchor.lineEnd}`;
    return `${lines}, Zeichen ${anchor.charStart}–${anchor.charEnd}`;
  }

  setCvAiSuggestionSelected(suggestion: CvAiStructuringSuggestion, selected: boolean): void {
    if (!suggestion.mergeable || (!suggestion.value && !suggestion.alternatives.length)) return;
    this.cvAiSuggestionSelections = { ...this.cvAiSuggestionSelections, [suggestion.id]: selected };
    if (selected) this.cvAiRejectedSuggestions = { ...this.cvAiRejectedSuggestions, [suggestion.id]: false };
    if (!this.cvAiAlternativeSelections[suggestion.id]) {
      this.cvAiAlternativeSelections = {
        ...this.cvAiAlternativeSelections,
        [suggestion.id]: suggestion.value !== null ? '' : suggestion.alternatives[0]?.id ?? ''
      };
    }
    this.cvAiApplyConfirmed = false;
  }

  selectCvAiAlternative(suggestion: CvAiStructuringSuggestion, alternativeId: string): void {
    const valid = alternativeId === '' ? suggestion.value !== null : suggestion.alternatives.some((item) => item.id === alternativeId);
    if (!valid) return;
    this.cvAiAlternativeSelections = { ...this.cvAiAlternativeSelections, [suggestion.id]: alternativeId };
    this.cvAiSuggestionSelections = { ...this.cvAiSuggestionSelections, [suggestion.id]: true };
    this.cvAiRejectedSuggestions = { ...this.cvAiRejectedSuggestions, [suggestion.id]: false };
    this.cvAiApplyConfirmed = false;
  }

  rejectCvAiSuggestion(suggestion: CvAiStructuringSuggestion): void {
    this.cvAiSuggestionSelections = { ...this.cvAiSuggestionSelections, [suggestion.id]: false };
    this.cvAiRejectedSuggestions = { ...this.cvAiRejectedSuggestions, [suggestion.id]: true };
    this.cvAiApplyConfirmed = false;
  }

  restoreCvAiSuggestion(suggestion: CvAiStructuringSuggestion): void {
    this.cvAiRejectedSuggestions = { ...this.cvAiRejectedSuggestions, [suggestion.id]: false };
    this.cvAiApplyConfirmed = false;
  }

  cvAiSelections(): CvAiStructuringSelection[] {
    return (this.cvAiRun?.proposal?.suggestions ?? []).flatMap<CvAiStructuringSelection>((suggestion) => {
      if (!this.cvAiSuggestionSelections[suggestion.id] || this.cvAiRejectedSuggestions[suggestion.id] || !suggestion.mergeable) return [];
      const selected = this.cvAiAlternativeSelections[suggestion.id] ?? '';
      if (selected === '' && suggestion.value !== null) return [{ suggestionId: suggestion.id, alternativeId: null }];
      if (suggestion.alternatives.some((item) => item.id === selected)) return [{ suggestionId: suggestion.id, alternativeId: selected }];
      return [];
    });
  }

  cvAiApplyUnavailableReason(): string {
    if (!this.cvImport || !this.cvAiRun || this.cvAiRun.status !== 'suggestions_ready') return 'Es liegt kein anwendbarer, servervalidierter AI-Vorschlag vor.';
    if (this.cvAiRun.binding.cvImportRevision !== this.cvImport.revision
      || this.cvAiRun.binding.cvImportSha256 !== this.cvImport.sha256) {
      return 'Der AI-Vorschlag gehört zu einer älteren Lebenslaufrevision. Starte mit frischer Zustimmung einen neuen Lauf.';
    }
    if (!this.cvAiSelections().length) return 'Wähle mindestens einen exakt quellgebundenen Vorschlag oder eine Alternative.';
    if (!this.cvAiApplyConfirmed) return 'Bestätige, dass die Auswahl nur als ungeprüfte Fakten gestaged wird.';
    return '';
  }

  applyCvAiSelections(): void {
    const current = this.cvImport; const run = this.cvAiRun; const selections = this.cvAiSelections();
    const unavailable = this.cvAiApplyUnavailableReason();
    if (!current || !run || unavailable || this.cvAiBusy) {
      if (unavailable) this.cvAiError = unavailable;
      this.refreshView(); return;
    }
    this.cvAiBusy = true; this.cvBusy = true; this.cvAiError = '';
    this.api.applyCvAiStructuring(current, run, selections).subscribe({
      next: (applied) => {
        this.cvAiRun = applied; this.cvAiRuns = [applied, ...this.cvAiRuns.filter((item) => item.id !== applied.id)];
        this.api.cvImport(current.id).subscribe({
          next: (record) => {
            this.cvAiBusy = false; this.cvBusy = false; this.applyCvImport(record, true);
            this.cvAiRun = applied; this.cvAiApplyConfirmed = false;
            this.cvAiNotice = `${applied.result?.stagedFactIds.length ?? selections.length} AI-erkannte Fakten wurden ausschließlich als ungeprüft gestaged. Prüfe und korrigiere sie nun in der lokalen Timeline.`;
            this.stopCvAiPolling(); this.focusCvAiStatus(); this.refreshView();
          },
          error: (error) => { this.cvBusy = false; this.failCvAi(error); }
        });
      },
      error: (error) => { this.cvBusy = false; this.failCvAi(error); }
    });
  }

  private cvAiProviderSelection(): CvAiProviderSelection | undefined {
    const selected = this.cvAiSelectedInstallation();
    if (!selected?.installation.version) return undefined;
    return {
      providerId: selected.providerId, runtimeTarget: selected.installation.runtimeTarget,
      ...(selected.installation.wslDistribution ? { wslDistribution: selected.installation.wslDistribution } : {}),
      expectedVersion: selected.installation.version,
      ...(this.cvAiModelOverride.trim() ? { model: this.cvAiModelOverride.trim() } : {}),
    };
  }

  private setCvAiRun(run: CvAiStructuringPublicRun | undefined): void {
    const selectionBindingChanged = this.cvAiRun?.id !== run?.id
      || this.cvAiRun?.proposal?.sha256 !== run?.proposal?.sha256;
    this.cvAiRun = run;
    if (selectionBindingChanged) {
      this.cvAiSuggestionSelections = {}; this.cvAiAlternativeSelections = {};
      this.cvAiRejectedSuggestions = {}; this.cvAiApplyConfirmed = false;
    }
    if (!run) { this.stopCvAiPolling(); return; }
    this.cvAiRuns = [run, ...this.cvAiRuns.filter((item) => item.id !== run.id)];
    const ids = new Set(run.proposal?.suggestions.map((item) => item.id) ?? []);
    this.cvAiSuggestionSelections = Object.fromEntries(Object.entries(this.cvAiSuggestionSelections).filter(([id]) => ids.has(id)));
    this.cvAiAlternativeSelections = Object.fromEntries(Object.entries(this.cvAiAlternativeSelections).filter(([id]) => ids.has(id)));
    this.cvAiRejectedSuggestions = Object.fromEntries(Object.entries(this.cvAiRejectedSuggestions).filter(([id]) => ids.has(id)));
    if (this.cvAiRunActive(run)) this.startCvAiPolling(); else this.stopCvAiPolling();
  }

  private startCvAiPolling(): void {
    if (this.cvAiPollHandle || this.section !== 'cv') return;
    this.cvAiPollHandle = setInterval(() => this.refreshCvAiRun(), 1_500);
  }

  private stopCvAiPolling(): void {
    if (this.cvAiPollHandle) clearInterval(this.cvAiPollHandle);
    this.cvAiPollHandle = undefined; this.cvAiPollInFlight = false;
  }

  private clearCvAiDisclosure(): void {
    this.cvAiDisclosureConfirmed = false;
    this.cvAiApplyConfirmed = false;
  }

  private resetCvAiStructuringState(): void {
    this.stopCvAiPolling(); this.cvAiOptions = undefined; this.cvAiRuns = []; this.cvAiRun = undefined;
    this.cvAiInstallationKey = ''; this.cvAiSuggestionSelections = {}; this.cvAiAlternativeSelections = {};
    this.cvAiRejectedSuggestions = {}; this.cvAiBusy = false; this.cvAiError = ''; this.cvAiNotice = '';
    this.cvAiAppliedReloadKey = '';
    this.clearCvAiDisclosure();
  }

  private focusCvAiStatus(): void {
    setTimeout(() => (document.getElementById('cv-ai-status-heading') as HTMLElement | null)?.focus(), 0);
  }

  private failCvAi(error: unknown): void {
    this.cvAiBusy = false; this.cvAiError = this.message(error); this.cvAiNotice = ''; this.refreshView();
  }

  cvStepAvailable(step: CvStudioStep): boolean {
    if (step === 1) return true;
    if (!this.cvImport) return false;
    if (step === 2) return true;
    if (!this.cvImport.adoption) return false;
    if (step <= 5) return true;
    return Boolean(this.cvSelectedApplicationCaseId);
  }

  selectCvStep(step: CvStudioStep): void {
    if (!this.cvStepAvailable(step)) return;
    this.cvStep = step;
    this.cvError = '';
    this.focusCvStep();
  }

  continueCvStudio(): void {
    const next = (this.cvStep + 1) as CvStudioStep;
    if (next > 6 || !this.cvStepAvailable(next)) {
      this.cvError = this.cvStep === 2
        ? 'Prüfe jeden atomaren Fakt und übernimm die bestätigten Fakten ausdrücklich in das Kandidatenprofil.'
        : this.cvStep === 5 ? 'Wähle zuerst einen Bewerbungsfall als Zielstelle.' : 'Dieser Schritt ist noch nicht verfügbar.';
      this.refreshView();
      return;
    }
    this.selectCvStep(next);
  }

  /** Identity panel: the recognized CV appears automatically from the current import. */
  loadProfileCvImport(importId: string): void {
    if (!importId || importId === this.cvImport?.id) return;
    this.api.cvImport(importId).subscribe({
      next: (record) => { this.applyCvImport(record, true); this.loadCvRecognitionVersions(); this.refreshView(); },
      error: (error) => { this.cvError = this.message(error); this.refreshView(); },
    });
  }

  loadProfileCvOverview(): void {
    if (this.cvImport) { this.loadCvImportInventory(); this.loadCvRecognitionVersions(); return; }
    this.api.cvImports(20).subscribe({
      next: (records) => {
        this.cvImportInventory = records;
        const newest = records[0];
        if (!this.cvImport && newest) {
          this.api.cvImport(newest.id).subscribe({
            next: (record) => { this.applyCvImport(record, true); this.loadCvRecognitionVersions(); this.refreshView(); },
            error: () => this.refreshView(),
          });
        } else this.refreshView();
      },
      error: () => this.refreshView(),
    });
  }

  updateCvFactDraftShared(fact: CvFact, field: 'category' | 'recordId' | 'field' | 'value', value: string): void {
    this.updateCvFactDraft(fact, field, value);
  }

  resetCvFactDraft(fact: CvFact): void {
    delete this.cvFactDrafts[fact.id];
  }

  decideCvFactShared(fact: CvFact, decision: 'confirm' | 'reject'): void {
    this.decideCvFact(fact, decision);
  }

  submitCvFactOperations(operations: CvFactOperation[]): void {
    if (!operations.length) return;
    this.mutateCvFacts(operations, operations.every((operation) => operation.action === 'add')
      ? 'Der ergänzte Fakt wurde als ungeprüfter Nutzerfakt gespeichert und muss noch bestätigt werden.'
      : 'Die Korrektur wurde revisionsgebunden gespeichert und ist erneut zu prüfen.');
  }

  cvFactGroups(): CvFactGroup[] {
    return groupCvFactRecords(this.cvImport?.facts ?? []);
  }

  cvStructuredFactGroups(): CvFactGroup[] {
    return this.cvFactGroups().filter((group) => !cvFactGroupIsRaw(group));
  }

  cvRawFactGroups(): CvFactGroup[] {
    return this.cvFactGroups().filter((group) => cvFactGroupIsRaw(group));
  }

  cvFactFieldLabel(field: string): string {
    const leaf = field.split('.').at(-1) ?? field;
    return this.cvAiSuggestionFieldLabel(leaf.replace(/\[[0-9]{1,4}\]/g, ''));
  }

  cvNewFactRecordLabel(recordId: string): string {
    const group = [...this.cvStructuredFactGroups(), ...this.cvRawFactGroups()].find((item) => item.recordId === recordId);
    return group ? `${group.title}${group.period ? ' · ' + group.period : ''}` : recordId;
  }

  /** Common field keys per category so corrections work without data-model knowledge. */
  readonly cvFieldChoices: Record<CvFactCategory, readonly string[]> = {
    profile: ['name', 'headline', 'summary', 'detail'],
    contact: ['value', 'detail'],
    employment: ['employer', 'role', 'start_date', 'end_date', 'location', 'description', 'detail'],
    project: ['name', 'role', 'technology', 'description', 'detail'],
    education: ['institution', 'qualification', 'start_date', 'end_date', 'detail'],
    skill: ['technology', 'level', 'detail'],
    certification: ['name', 'institution', 'detail'],
    language: ['language', 'level', 'detail'],
    additional: ['detail', 'value', 'heading'],
  };

  cvNewFactFieldOptions(): readonly string[] {
    return this.cvFieldChoices[this.cvNewFactDraft.category] ?? ['detail'];
  }

  cvNewFactFieldSelectValue(): string {
    return this.cvNewFactFieldOptions().includes(this.cvNewFactDraft.field) ? this.cvNewFactDraft.field : '__custom__';
  }

  cvNewFactFieldCustom(): boolean { return this.cvNewFactFieldSelectValue() === '__custom__'; }

  setCvNewFactField(value: string): void {
    if (value === '__custom__') {
      this.cvNewFactDraft = { ...this.cvNewFactDraft, field: '', explicitlyConfirmed: false };
      return;
    }
    this.cvNewFactDraft = { ...this.cvNewFactDraft, field: value, explicitlyConfirmed: false };
  }

  cvFactCategoryLabel(category: CvFactCategory): string {
    return ({
      profile: 'Profil', contact: 'Kontakt', employment: 'Berufserfahrung', project: 'Projekt', education: 'Ausbildung',
      skill: 'Kenntnis', certification: 'Zertifizierung', language: 'Sprache', additional: 'Zusatzfakt'
    } as const)[category];
  }

  cvFactDecisionLabel(decision: CvFactDecision): string {
    return ({ pending: 'Ungeprüft', confirmed: 'Bestätigt', rejected: 'Verworfen' } as const)[decision];
  }

  cvFactCount(decision: CvFactDecision): number {
    return this.cvImport?.facts.filter((fact) => fact.decision === decision).length ?? 0;
  }

  cvFactDraft(fact: CvFact): CvFactDraft {
    return this.cvFactDrafts[fact.id] ?? { category: fact.category, recordId: fact.recordId, field: fact.field, value: fact.value };
  }

  cvFactDraftDirty(fact: CvFact): boolean {
    const draft = this.cvFactDraft(fact);
    return draft.category !== fact.category || draft.recordId !== fact.recordId || draft.field !== fact.field || draft.value !== fact.value;
  }

  updateCvFactDraft(fact: CvFact, field: keyof CvFactDraft, value: string): void {
    const current = this.cvFactDraft(fact);
    this.cvFactDrafts[fact.id] = { ...current, [field]: value } as CvFactDraft;
    this.cvAdoptionConfirmed = false;
  }

  cvNewFactRecordIds(): string[] {
    return [...new Set((this.cvImport?.facts ?? [])
      .filter((fact) => fact.category === this.cvNewFactDraft.category)
      .map((fact) => fact.recordId))].sort((left, right) => left.localeCompare(right, 'de'));
  }

  setCvNewFactCategory(value: string): void {
    if (!this.cvFactCategories.includes(value as CvFactCategory)) return;
    this.cvNewFactDraft = { ...this.cvNewFactDraft, category: value as CvFactCategory, recordId: '', explicitlyConfirmed: false };
  }

  setCvNewFactTarget(value: string): void {
    if (value !== 'existing_record' && value !== 'new_record') return;
    this.cvNewFactDraft = { ...this.cvNewFactDraft, target: value, recordId: '', explicitlyConfirmed: false };
  }

  cvNewFactUnavailableReason(): string {
    const draft = this.cvNewFactDraft;
    if (!this.cvImport) return 'Lade zuerst einen Lebenslaufimport.';
    if (!/^(?=.{1,64}$)[a-z][a-z0-9_.]*(?:\[[0-9]{1,4}\])?$/.test(draft.field.trim())) {
      return 'Das Feld benötigt eine serverkonforme Kennung, zum Beispiel description oder highlights[0].';
    }
    if (!draft.value.trim() || draft.value.trim().length > 5_000) return 'Die Aussage muss 1 bis 5.000 Zeichen enthalten.';
    if (draft.target === 'existing_record') {
      if (!draft.recordId || !this.cvNewFactRecordIds().includes(draft.recordId)) return 'Wähle eine vorhandene Station derselben Kategorie.';
    } else if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.newRecordKey.trim())) {
      return 'Der temporäre Record-Schlüssel muss mit einem Kleinbuchstaben beginnen und darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten.';
    }
    return '';
  }

  addCvFact(): void {
    const unavailable = this.cvNewFactUnavailableReason();
    if (unavailable || this.cvBusy) { if (unavailable) this.cvError = unavailable; this.refreshView(); return; }
    const draft = this.cvNewFactDraft;
    const target = draft.target === 'existing_record'
      ? { recordId: draft.recordId }
      : { newRecordKey: draft.newRecordKey.trim() };
    const operation: CvFactOperation = {
      action: 'add', category: draft.category, ...target, field: draft.field.trim(), value: draft.value.trim(),
      ...(draft.explicitlyConfirmed ? { explicitlyConfirmed: true as const } : {})
    };
    this.mutateCvFacts([operation], draft.explicitlyConfirmed
      ? 'Der selbst ergänzte Fakt wurde atomar und ausdrücklich bestätigt gespeichert; eine Profilübernahme ist weiterhin separat erforderlich.'
      : 'Der selbst ergänzte Fakt wurde atomar als ungeprüft gespeichert und muss noch ausdrücklich bestätigt oder verworfen werden.', () => {
        this.cvNewFactDraft = {
          ...this.cvNewFactDraft, recordId: '', newRecordKey: 'additional-fact', field: 'detail', value: '', explicitlyConfirmed: false
        };
      });
  }

  importCvFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const mimeType = this.cvMimeType(file.name);
    if (!mimeType) {
      this.cvError = 'Erlaubt sind ausschließlich PDF, DOCX, ODT, HTML und HTM.';
      this.refreshView(); return;
    }
    if (file.size < 1 || file.size > this.cvMaxFileBytes) {
      this.cvError = 'Die Lebenslaufdatei muss zwischen 1 Byte und 10 MiB groß sein.';
      this.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = ''; this.cvNotice = 'Datei wird lokal extrahiert und als ungeprüfte Fakten normalisiert …';
    const reader = new FileReader();
    reader.onerror = () => { this.cvBusy = false; this.cvError = 'Die Datei konnte im Browser nicht gelesen werden.'; this.refreshView(); };
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      if (!base64) { this.cvBusy = false; this.cvError = 'Die Datei enthält keine lesbaren Daten.'; this.refreshView(); return; }
      this.api.importCv({ fileName: file.name, mimeType, base64 }).subscribe({
        next: (record) => {
          this.applyCvImport(record);
          this.cvBusy = false; this.cvStep = 2;
          this.cvNotice = `${record.facts.length} atomare Fakten wurden importiert. Sie sind noch nicht als Kandidatenfakten übernommen.`;
          this.focusCvStep(); this.refreshView();
        },
        error: (error) => this.failCv(error)
      });
    };
    reader.readAsDataURL(file);
  }

  loadCvImportInventory(): void {
    this.api.cvImports(20).subscribe({
      next: (records) => { this.cvImportInventory = records; this.refreshView(); },
      error: (error) => { this.cvError = `Gespeicherte Lebenslaufimporte konnten nicht geladen werden: ${this.message(error)}`; this.refreshView(); }
    });
  }

  openCvImport(importId: string): void {
    if (this.cvBusy) return;
    this.cvBusy = true; this.cvError = ''; this.cvNotice = '';
    this.api.cvImport(importId).subscribe({
      next: (record) => {
        this.applyCvImport(record); this.cvBusy = false;
        this.cvNotice = `Import ${record.source.fileName} wurde in Revision ${record.revision} geöffnet.`;
        if (record.proposal) this.loadCvProposalHtml();
        this.focusCvStep(); this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  cvDeleteConfirmationExpected(): string {
    return this.cvImport ? `DELETE cv-import ${this.cvImport.id}` : '';
  }

  deleteCurrentCvImport(): void {
    const current = this.cvImport;
    if (!current || this.cvBusy || this.cvDeleteConfirmation !== this.cvDeleteConfirmationExpected()) return;
    this.cvBusy = true; this.cvError = ''; this.cvNotice = '';
    this.api.deleteCvImport(current).subscribe({
      next: ({ removed }) => {
        this.cvBusy = false; this.cvDeleteConfirmation = '';
        this.cvImportInventory = this.cvImportInventory.filter((item) => item.id !== current.id);
        if (removed === 1) {
          this.cvImport = undefined; this.cvFactDrafts = {}; this.cvProposalHtmlUrl = undefined; this.cvStep = 1;
          this.resetCvAiStructuringState(); this.resetCvRecognitionVersions();
          this.cvNotice = 'Der verschlüsselt gespeicherte Lebenslaufimport wurde gelöscht.';
        } else this.cvError = 'Der Lebenslaufimport war bereits nicht mehr vorhanden.';
        this.focusCvStep(); this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  toggleCvImportSelection(id: string, selected: boolean): void {
    if (selected) this.cvImportSelection[id] = true; else delete this.cvImportSelection[id];
  }

  cvImportAllSelected(): boolean {
    return this.cvImportInventory.length > 0 && this.cvImportInventory.every((item) => this.cvImportSelection[item.id]);
  }

  toggleAllCvImportSelection(selected: boolean): void {
    this.cvImportSelection = {};
    if (selected) for (const item of this.cvImportInventory) this.cvImportSelection[item.id] = true;
  }

  selectedCvImportCount(): number {
    return this.cvImportInventory.filter((item) => this.cvImportSelection[item.id]).length;
  }

  private removeCvImportFromState(id: string): void {
    this.cvImportInventory = this.cvImportInventory.filter((item) => item.id !== id);
    delete this.cvImportSelection[id];
    if (this.cvImport?.id === id) {
      this.cvImport = undefined; this.cvFactDrafts = {}; this.cvProposalHtmlUrl = undefined; this.cvStep = 1;
      this.resetCvAiStructuringState(); this.resetCvRecognitionVersions();
    }
  }

  deleteCvImportRow(record: CvImportSummary): void {
    if (this.cvBusy || this.cvInventoryBusy) return;
    if (!confirm(`Lebenslaufimport „${record.source.fileName}" endgültig löschen? Fakten, Theme und gerenderte Revision werden entfernt.`)) return;
    this.cvInventoryBusy = true; this.cvError = ''; this.cvNotice = '';
    this.api.deleteCvImportById(record.id, record.revision, record.sha256).subscribe({
      next: ({ removed }) => {
        this.cvInventoryBusy = false;
        this.removeCvImportFromState(record.id);
        this.cvNotice = removed === 1 ? `„${record.source.fileName}" wurde gelöscht.` : 'Der Import war bereits nicht mehr vorhanden.';
        this.refreshView();
      },
      error: (error) => { this.cvInventoryBusy = false; this.cvError = this.message(error); this.refreshView(); }
    });
  }

  deleteSelectedCvImports(): void {
    if (this.cvBusy || this.cvInventoryBusy) return;
    const targets = this.cvImportInventory.filter((item) => this.cvImportSelection[item.id]);
    if (!targets.length) return;
    if (!confirm(`${targets.length} Lebenslaufimport(e) endgültig löschen?`)) return;
    this.cvInventoryBusy = true; this.cvError = ''; this.cvNotice = '';
    let removed = 0; const failures: string[] = [];
    const runNext = (index: number): void => {
      if (index >= targets.length) {
        this.cvInventoryBusy = false;
        this.cvNotice = `${removed} Import(e) gelöscht.${failures.length ? ` ${failures.length} fehlgeschlagen.` : ''}`;
        if (failures.length) this.cvError = `Nicht gelöscht: ${failures.join(', ')}`;
        this.refreshView();
        return;
      }
      const target = targets[index]!;
      this.api.deleteCvImportById(target.id, target.revision, target.sha256).subscribe({
        next: () => { removed += 1; this.removeCvImportFromState(target.id); runNext(index + 1); },
        error: () => { failures.push(target.source.fileName); runNext(index + 1); }
      });
    };
    runNext(0);
  }

  reloadCvImport(): void {
    if (!this.cvImport || this.cvBusy) return;
    const importId = this.cvImport.id;
    this.cvBusy = true; this.cvError = '';
    this.api.cvImport(importId).subscribe({
      next: (record) => { this.applyCvImport(record, true); this.cvBusy = false; this.cvNotice = `Importrevision ${record.revision} wurde neu geladen.`; this.refreshView(); },
      error: (error) => this.failCv(error)
    });
  }

  saveCvFact(fact: CvFact): void {
    const current = this.cvImport;
    if (!current || this.cvBusy) return;
    const draft = this.cvFactDraft(fact);
    if (!this.cvFactDraftDirty(fact)) { this.cvError = 'Dieser Fakt enthält keine ungespeicherte Änderung.'; this.refreshView(); return; }
    if (draft.recordId !== fact.recordId) {
      this.cvError = 'Ein Fakt darf nicht in eine andere Station verschoben werden. Ergänze stattdessen dort einen neuen atomaren Fakt.';
      this.refreshView(); return;
    }
    if (!/^(?=.{1,64}$)[a-z][a-z0-9_.]*(?:\[[0-9]{1,4}\])?$/.test(draft.field.trim())
      || !draft.value.trim() || draft.value.trim().length > 5_000) {
      this.cvError = 'Feldkennung oder Aussage liegt außerhalb des geschlossenen Serververtrags.';
      this.refreshView(); return;
    }
    this.mutateCvFacts([{
      factId: fact.id, action: 'edit', category: draft.category, recordId: draft.recordId.trim(),
      field: draft.field.trim(), value: draft.value.trim()
    }], 'Die Änderung wurde als ungeprüfter Fakt gespeichert. Bestätige oder verwirf ihn anschließend ausdrücklich.');
  }

  decideCvFact(fact: CvFact, decision: 'confirm' | 'reject'): void {
    if (this.cvFactDraftDirty(fact)) {
      this.cvError = 'Speichere die Textänderung zuerst. Bearbeitete Fakten werden serverseitig wieder auf „ungeprüft“ gesetzt.';
      this.refreshView(); return;
    }
    this.mutateCvFacts([{ factId: fact.id, action: decision }], decision === 'confirm'
      ? 'Der einzelne Fakt wurde ausdrücklich bestätigt, ist aber noch nicht in das Kandidatenprofil übernommen.'
      : 'Der einzelne Fakt wurde verworfen und wird nicht übernommen.');
  }

  adoptCvFacts(): void {
    const current = this.cvImport;
    if (!current || this.cvBusy || !this.cvAdoptionConfirmed) return;
    if (this.cvFactCount('pending') > 0 || this.cvFactCount('confirmed') < 1) {
      this.cvError = 'Alle Fakten müssen bestätigt oder verworfen sein; mindestens ein bestätigter Fakt ist erforderlich.';
      this.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = '';
    this.api.adoptCvFacts(current).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvAdoptionConfirmed = false;
        this.cvNotice = `${record.adoption?.adoptedClaimIds.length ?? 0} bestätigte Claims wurden revisionsgebunden in das Kandidatenprofil übernommen.`;
        this.cvStep = 3; this.loadCandidateProfile(); this.focusCvStep(); this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  saveCvTheme(): void {
    const current = this.cvImport;
    if (!current || this.cvBusy || !this.cvThemeConfirmed) return;
    const order = this.cvThemeDraft.sectionOrder;
    if (order.length !== this.cvSectionCategories.length || new Set(order).size !== order.length) {
      this.cvError = 'Die Formatvorlage muss jeden ATS-Abschnitt genau einmal in der Lesereihenfolge enthalten.';
      this.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = '';
    this.api.saveCvTheme(current, structuredClone(this.cvThemeDraft)).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvThemeConfirmed = false;
        this.cvNotice = 'Die geschlossene ATS-Formatvorlage wurde revisionsgebunden gespeichert.'; this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  clearCvTheme(): void {
    const current = this.cvImport;
    if (!current || this.cvBusy || !this.cvThemeConfirmed) return;
    this.cvBusy = true; this.cvError = '';
    this.api.saveCvTheme(current, null).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvThemeConfirmed = false;
        this.cvNotice = 'Die optionale Formatvorlage wurde entfernt; der Server verwendet seine ATS-sichere Standardvorlage.'; this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  moveCvThemeSection(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= this.cvThemeDraft.sectionOrder.length) return;
    const order = [...this.cvThemeDraft.sectionOrder];
    [order[index], order[target]] = [order[target]!, order[index]!];
    this.cvThemeDraft = { ...this.cvThemeDraft, sectionOrder: order };
    this.cvThemeConfirmed = false;
    this.refreshCvThemePreview();
  }

  cvLayoutFingerprint(): CvLayoutFingerprint | undefined { return this.cvImport?.layoutFingerprint; }

  cvLayoutSourceFormatLabel(format: CvLayoutFingerprint['sourceFormat']): string {
    return { html: 'HTML', pdf: 'PDF', docx: 'Word (DOCX)', odt: 'OpenDocument (ODT)' }[format];
  }
  cvLayoutConfidenceLabel(confidence: CvLayoutFingerprint['confidence']): string {
    return { high: 'hohe Treue', medium: 'mittlere Treue', low: 'grobe Näherung' }[confidence];
  }
  cvLayoutColumnLabel(column: 'main' | 'side'): string { return column === 'side' ? 'Seitenspalte' : 'Hauptspalte'; }

  /** Switch the presentation between the closed ATS template and the derived original-layout clone. */
  selectCvThemeVariant(variant: 'ats' | 'original'): void {
    if (this.cvThemeVariant === variant && this.cvThemeDraft.mode === variant) { this.refreshCvThemePreview(); return; }
    const fingerprint = this.cvImport?.layoutFingerprint;
    if (variant === 'original') {
      if (!fingerprint) return;
      this.cvThemeDraft = this.buildOriginalThemeFromFingerprint(fingerprint);
    } else {
      this.cvThemeDraft = { ...this.cvThemeDraft, mode: 'ats', original: undefined };
    }
    this.cvThemeVariant = variant;
    this.cvThemeConfirmed = false;
    this.refreshCvThemePreview();
  }

  /** Prefill the closed ATS template with the section order and accent colour detected in the original. */
  prefillAtsFromOriginal(): void {
    const fingerprint = this.cvImport?.layoutFingerprint;
    if (!fingerprint) return;
    this.cvThemeVariant = 'ats';
    this.cvThemeDraft = this.buildAtsThemeFromFingerprint(fingerprint);
    this.cvThemeConfirmed = false;
    this.refreshCvThemePreview();
  }

  onCvThemeChanged(): void { this.cvThemeConfirmed = false; this.refreshCvThemePreview(); }

  private buildAtsThemeFromFingerprint(fingerprint: CvLayoutFingerprint): CvTheme {
    const detected = fingerprint.sections.map((entry) => entry.section);
    const sectionOrder = [...detected, ...this.cvSectionCategories.filter((category) => !detected.includes(category))];
    return {
      mode: 'ats', template: this.cvThemeDraft.template, font: this.cvThemeDraft.font,
      accentColor: this.nearestAtsAccent(fingerprint.palette.accent), spacing: this.cvThemeDraft.spacing, sectionOrder,
    };
  }

  private buildOriginalThemeFromFingerprint(fingerprint: CvLayoutFingerprint): CvTheme {
    const main = fingerprint.sections.filter((entry) => entry.column === 'main').map((entry) => entry.section);
    const side = fingerprint.columns === 2 ? fingerprint.sections.filter((entry) => entry.column === 'side').map((entry) => entry.section) : [];
    const sectionOrder = this.cvThemeDraft.sectionOrder.length === this.cvSectionCategories.length
      ? this.cvThemeDraft.sectionOrder : [...this.cvSectionCategories];
    const original: CvThemeOriginalLayout = {
      columns: fingerprint.columns, palette: structuredClone(fingerprint.palette), fontFamily: fingerprint.fontFamily, main, side,
    };
    return {
      mode: 'original', template: this.cvThemeDraft.template, font: this.cvThemeDraft.font,
      accentColor: this.nearestAtsAccent(fingerprint.palette.accent), spacing: this.cvThemeDraft.spacing, sectionOrder, original,
    };
  }

  private nearestAtsAccent(hex: string): CvTheme['accentColor'] {
    const options: Array<CvTheme['accentColor']> = ['#1f2937', '#1d4ed8', '#047857', '#7c3aed'];
    const toRgb = (value: string) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return options[0];
    const [r, g, b] = toRgb(hex);
    let best = options[0]; let bestDistance = Number.POSITIVE_INFINITY;
    for (const option of options) {
      const [or, og, ob] = toRgb(option);
      const distance = (r! - or!) ** 2 + (g! - og!) ** 2 + (b! - ob!) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = option; }
    }
    return best;
  }

  renderIncognitoCvPreview(artifact: AgentArtifactRecord): void {
    const current = this.cvImport; const application = this.cvSelectedApplicationCase();
    const run = this.agents.selectedAgentRun;
    if (!current || !application || !run || this.cvBusy) return;
    this.cvBusy = true; this.cvError = ''; this.cvIncognitoPreview = undefined;
    this.api.renderIncognitoCvPreview(current, application.id, run.id, artifact.id).subscribe({
      next: (preview) => {
        this.cvBusy = false;
        this.cvIncognitoPreview = preview;
        try {
          this.revokeIncognitoPreview();
          const url = URL.createObjectURL(new Blob([preview.html], { type: 'text/html' }));
          this.cvIncognitoPreviewObjectUrl = url;
          this.cvIncognitoPreviewUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
        } catch { /* Object URLs are unavailable in some environments; the download still works. */ }
        this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  /** The state is part of the file name, so an unconfirmed render stays recognizable on disk. */
  downloadIncognitoCvPreview(): void {
    const preview = this.cvIncognitoPreview;
    if (!preview || typeof document === 'undefined' || typeof URL === 'undefined') return;
    try {
      const url = URL.createObjectURL(new Blob([preview.html], { type: 'text/html' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `lebenslauf-inkognito-${preview.artifactLifecycle}-${preview.htmlSha256.slice(0, 12)}.html`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch { this.cvError = 'Der Download konnte in dieser Umgebung nicht gestartet werden.'; this.refreshView(); }
  }

  private revokeIncognitoPreview(): void {
    if (!this.cvIncognitoPreviewObjectUrl) return;
    try { URL.revokeObjectURL(this.cvIncognitoPreviewObjectUrl); } catch { /* already released */ }
    this.cvIncognitoPreviewObjectUrl = undefined;
  }

  refreshCvThemePreview(): void {
    const current = this.cvImport;
    if (!current || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    this.cvThemePreviewBusy = true;
    this.api.previewCvTheme(current, structuredClone(this.cvThemeDraft)).subscribe({
      next: (result) => {
        try {
          this.revokeThemePreview();
          const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html' }));
          this.cvThemePreviewObjectUrl = url;
          this.cvThemePreviewUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
          this.cvThemePreviewVariant = this.cvThemeVariant;
        } catch { /* Object URLs are unavailable in some environments; the preview stays hidden. */ }
        this.cvThemePreviewBusy = false; this.refreshView();
      },
      error: () => { this.cvThemePreviewBusy = false; this.refreshView(); }
    });
  }

  private revokeThemePreview(): void {
    if (this.cvThemePreviewObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(this.cvThemePreviewObjectUrl);
    }
    this.cvThemePreviewObjectUrl = undefined;
  }

  runCvAtsCheck(source: 'theme-preview' | 'proposal' = this.cvAtsSource): void {
    const current = this.cvImport;
    if (!current) return;
    this.cvAtsSource = source; this.cvAtsBusy = true; this.cvAtsError = '';
    const mustHave = this.config?.searchProfile.mustHave ?? [];
    const niceToHave = this.config?.searchProfile.niceToHave ?? [];
    this.api.atsCheckCv(current, source, mustHave, niceToHave).subscribe({
      next: (report) => { this.cvAtsReport = report; this.cvAtsBusy = false; this.refreshView(); },
      error: (error) => { this.cvAtsError = this.message(error); this.cvAtsBusy = false; this.refreshView(); }
    });
  }
  atsLintStatusLabel(status: 'pass' | 'warn' | 'fail'): string {
    return { pass: 'OK', warn: 'Hinweis', fail: 'Problem' }[status];
  }

  cvSelectedApplicationCase(): ApplicationCase | undefined {
    return this.applicationCases.find((item) => item.id === this.cvSelectedApplicationCaseId);
  }

  cvApplicationCases(): ApplicationCase[] {
    return this.applicationCases.filter((item) => item.documentType === 'cv');
  }

  cvHtmlRenderUnavailableReason(): string {
    const application = this.cvSelectedApplicationCase();
    if (!this.cvImport?.adoption) return 'Die importierten Fakten wurden noch nicht revisionsgebunden übernommen.';
    if (!application) return 'Wähle einen CV-Bewerbungsfall.';
    if (application.documentType !== 'cv') return 'HTML kann nur für einen Bewerbungsfall vom Typ Lebenslauf gerendert werden.';
    if (application.identityMode === 'incognito') {
      return 'Inkognito-Agentenartefakte bleiben nicht verwendbare Vorschläge im Agent Center; HTML-Erzeugung und Download sind gesperrt.';
    }
    if (!['approved', 'exported'].includes(application.state)) return 'Die Agentenrevision muss zuerst geprüft, übernommen und im Bewerbungsfall freigegeben werden.';
    if (!application.approvedArtifactRevisionId || !application.approvedArtifactSha256) return 'Dem Fall fehlt die exakt freigegebene Dokumentrevision mit SHA-256.';
    return '';
  }

  renderApprovedCvHtml(): void {
    const current = this.cvImport;
    const application = this.cvSelectedApplicationCase();
    const unavailable = this.cvHtmlRenderUnavailableReason();
    if (!current?.adoption || !application?.approvedArtifactRevisionId || !application.approvedArtifactSha256 || unavailable || this.cvBusy) {
      this.cvError = unavailable || 'Die exakte freigegebene Dokumentrevision fehlt.';
      this.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = ''; this.cvProposalHtmlUrl = undefined;
    this.api.createCvProposal(
      application.id, current, application.approvedArtifactRevisionId, application.approvedArtifactSha256
    ).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvStep = 6;
        this.cvNotice = 'Die proof-verifizierte, freigegebene CV-Dokumentrevision wurde als HTML gerendert.';
        this.loadCvProposalHtml(); this.focusCvStep(); this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  loadCvProposalHtml(): void {
    const current = this.cvImport;
    const htmlSha256 = current?.proposal?.htmlSha256;
    this.cvProposalHtmlUrl = undefined;
    if (!current || !htmlSha256) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current.id)
      || !/^[a-f0-9]{64}$/.test(htmlSha256)) {
      this.cvError = 'Die proof-gebundene HTML-Referenz verletzt den geschlossenen Serververtrag.';
      this.refreshView(); return;
    }
    const route = this.api.cvProposalHtmlUrl(current.id, htmlSha256);
    if (!/^\/api\/cv-imports\/[0-9a-f-]{36}\/proposal\.html\?sha256=[a-f0-9]{64}&download=false$/i.test(route)) {
      this.cvError = 'Die HTML-Vorschau verweist nicht auf die erlaubte lokale Proof-Route.';
      this.refreshView(); return;
    }
    this.cvProposalHtmlUrl = this.sanitizer.bypassSecurityTrustResourceUrl(route);
    this.refreshView();
  }

  startCvAgentOrchestration(): void {
    const application = this.cvSelectedApplicationCase();
    const unavailable = this.cvAgentStartUnavailableReason();
    if (unavailable || !application) { this.cvError = unavailable; this.refreshView(); return; }
    const workflow = this.agents.agentWorkflows.find((item) => item.id === 'evidence-application-package');
    if (!workflow) return;
    const providerId = this.agents.agentOrchestrationForm.providerId || this.agents.agentProviders.find((item) => item.available)?.id || '';
    this.cvError = ''; this.agents.agentOrchestrationError = '';
    this.agents.agentOrchestrationForm = {
      workflowId: workflow.id, providerId,
      prompt: `Erstelle einen belegbasierten ATS-sicheren Lebenslauf für den ausgewählten Bewerbungsfall ${application.id}. Verwende ausschließlich bestätigte CandidateProfile-Claims und die serverseitig gespeicherten Stilvorgaben. Der fünfte Agent liefert die direkt sichtbare finale HTML-Fassung.`,
      runtimeTarget: this.agents.agentOrchestrationForm.runtimeTarget,
      ...(this.agents.agentOrchestrationForm.runtimeTarget === 'wsl' && this.agents.agentOrchestrationForm.wslDistribution
        ? { wslDistribution: this.agents.agentOrchestrationForm.wslDistribution } : {}),
      applicationCaseId: application.id, userInputConfirmed: false
    };
    this.agents.createAgentOrchestration();
  }

  cvAgentStartUnavailableReason(): string {
    const application = this.cvSelectedApplicationCase();
    if (!this.cvImport?.adoption) return 'Bestätige den aktiven Lebenslaufstand und übernimm ihn danach ins Kandidatenprofil.';
    if (!application || application.documentType !== 'cv') return 'Wähle einen Bewerbungsfall vom Typ Lebenslauf.';
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

  cvAgentOrchestration(): AgentOrchestrationRecord | undefined {
    if (this.cvAgentOrchestrationId) return this.agents.agentOrchestrations.find((item) => item.id === this.cvAgentOrchestrationId)
      ?? (this.agents.selectedAgentOrchestration?.id === this.cvAgentOrchestrationId ? this.agents.selectedAgentOrchestration : undefined);
    return undefined;
  }

  openCvAgentOrchestration(): void {
    const orchestration = this.cvAgentOrchestration();
    this.select('agents');
    if (orchestration) this.agents.selectAgentOrchestration(orchestration, false);
  }

  refreshCvAgentStatus(): void {
    this.agents.refreshAgentOrchestrations();
    this.loadApplicationCases();
  }

  cvAgentStatusBusy(): boolean { return this.agents.agentOrchestrationPollInFlight; }

  downloadApprovedCvHtml(): void {
    const current = this.cvImport;
    const proposal = current?.proposal;
    if (!current || !proposal?.downloadAllowed || this.cvBusy) {
      this.cvError = proposal && !proposal.downloadAllowed
        ? 'Der Server sperrt den Download für diese Identität oder Revision.' : 'Keine downloadfähige HTML-Revision vorhanden.';
      this.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = '';
    this.api.downloadCvProposal(current.id, proposal.htmlSha256).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = 'lebenslauf.html'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
        this.cvBusy = false; this.cvNotice = 'Die exakt freigegebene HTML-Revision wurde heruntergeladen.'; this.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  private mutateCvFacts(operations: Parameters<ApiService['reviewCvFacts']>[1], notice: string, afterSuccess?: () => void): void {
    const current = this.cvImport;
    if (!current || this.cvBusy) return;
    this.cvBusy = true; this.cvError = '';
    // Saving one fact must never silently drop other unsaved field edits.
    const savedIds = new Set(operations.map((operation) => 'factId' in operation ? operation.factId : ''));
    const preservedDrafts = Object.fromEntries(
      Object.entries(this.cvFactDrafts).filter(([factId]) => !savedIds.has(factId)),
    );
    this.api.reviewCvFacts(current, operations).subscribe({
      next: (record) => {
        // A late answer must never overwrite a different, newly selected import.
        if (this.cvImport?.id !== current.id) { this.cvBusy = false; this.refreshView(); return; }
        this.applyCvImport(record, true);
        this.cvFactDrafts = { ...this.cvFactDrafts, ...preservedDrafts };
        this.cvBusy = false; this.cvNotice = notice; afterSuccess?.(); this.refreshView();
      },
      error: (error) => {
        if (this.cvImport?.id !== current.id) { this.cvBusy = false; this.refreshView(); return; }
        this.failCv(error);
      }
    });
  }

  private applyCvImport(record: CvImportRecord, preserveStep = false): void {
    const changedImport = this.cvImport?.id !== record.id;
    if (changedImport) {
      this.resetCvAiStructuringState(); this.resetCvRecognitionVersions();
      this.cvRevocableAdoptions = []; this.cvProfileSnapshots = [];
      this.cvSelectedSnapshotId = ''; this.cvClaimManagementError = ''; this.cvClaimManagementNotice = '';
    }
    this.cvImport = record;
    this.cvFactDrafts = Object.fromEntries(record.facts.map((fact) => [fact.id, {
      category: fact.category, recordId: fact.recordId, field: fact.field, value: fact.value
    }]));
    if (record.theme) this.cvThemeDraft = structuredClone(record.theme);
    this.cvThemeVariant = record.theme?.mode === 'original' ? 'original' : 'ats';
    this.revokeThemePreview(); this.cvThemePreviewUrl = undefined; this.cvThemePreviewVariant = undefined;
    this.cvAtsReport = undefined; this.cvAtsError = '';
    if (record.proposal?.applicationCaseId) this.cvSelectedApplicationCaseId = record.proposal.applicationCaseId;
    if (!preserveStep) this.cvStep = record.proposal ? 6 : record.adoption ? 3 : 2;
    this.cvAdoptionConfirmed = false; this.cvThemeConfirmed = false; this.cvDeleteConfirmation = '';
    this.cvRecognitionVersionConfirmed = false;
    this.cvRevokeConfirmed = false; this.cvSnapshotConfirmed = false;
    this.loadCvImportInventory();
    if (this.section === 'cv') setTimeout(() => {
      this.loadCvRecognitionVersions();
      this.loadCvAiStructuringState();
      this.loadCvClaimManagement();
    }, 0);
  }

  private cvMimeType(fileName: string): CvImportRecord['source']['mimeType'] | undefined {
    const extension = fileName.toLocaleLowerCase('en-US').match(/\.[^.]+$/)?.[0];
    return ({
      '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.odt': 'application/vnd.oasis.opendocument.text'
    } as const)[extension as '.html' | '.htm' | '.pdf' | '.docx' | '.odt'];
  }

  private focusCvStep(): void {
    setTimeout(() => (document.getElementById(`cv-step-heading-${this.cvStep}`) as HTMLElement | null)?.focus(), 0);
  }

  private failCv(error: unknown): void {
    this.cvBusy = false; this.cvError = this.message(error); this.cvNotice = ''; this.refreshView();
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
    // Das ausgelagerte Agent Center liest den Zustand aus dem Store; das Signal markiert seine Ansicht neu.
    this.agents.revision.update((value) => value + 1);
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
