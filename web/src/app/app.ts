import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from './api.service';
import { forkJoin, type Subscription } from 'rxjs';
import type { AgentApproval, AgentArtifactContent, AgentArtifactRecord, AgentConfigProfile, AgentConfigProfileView, AgentOrchestrationConfirmationInput, AgentOrchestrationConflict, AgentOrchestrationConflictStrategy, AgentOrchestrationCreateRequest, AgentOrchestrationGate, AgentOrchestrationRecord, AgentProvider, AgentProviderConfigProfile, AgentProviderInstallation, AgentQueueBlockReason, AgentQueueSnapshot, AgentRecoveryDecision, AgentRecoveryLease, AgentRecoveryRun, AgentRun, AgentRunEvent, AgentRunPreflight, AgentRunRequest, AgentRunStatus, AgentRuntimeTarget, AgentWorkflow, AgentWorkspaceMode, AppConfig, ApplicationCase, ApplicationDraft, ApplicationExportResult, ApplicationNextActionsProposalProjection, ApplicationProfileSetupStatus, ApplicationStyleDocumentType, ApplicationStyleExampleDocumentType, ApplicationStyleProfileView, ArtifactRevision, CandidateMatchAnalysis, CandidateProfileSummary, CompanyCrm, CorrelatedMail, CvAiProviderSelection, CvAiStructuringOptions, CvAiStructuringPublicRun, CvAiStructuringSelection, CvAiStructuringSuggestion, CvAdoptionLedgerEntry, CvFact, CvFactCategory, CvFactDecision, CvFactOperation, CvImportRecord, CvImportSummary, CvProfileSnapshotSummary, CvRecognitionVersionList, CvRecognitionVersionSummary, CvTheme, CvLayoutFingerprint, CvLayoutSection, CvThemeOriginalLayout, CvLayoutPalette, JobInventoryView, JobInventoryCategory, SearchRunSummary, AtsCheckReport, JobSearchMcpRuntimeCandidate, DataInventory, EditableApplicationStyleProfile, EmployerResponseTriageProposalProjection, IdentityProfile, JobDecision, JobMatch, JobSourceCapabilities, LanguageCheckResult, MailAccount, McpRuntimeStatus, ProfileImportPreview, ProviderModelCatalog, SearchSchedule, Section, SourceCapability, SourceStatus } from './models';

type AgentEventLevelFilter = 'all' | 'debug' | 'info' | 'warning' | 'error';
type AgentTimelineView = 'readable' | 'diagnostic';

interface AgentTimelineEntry {
  key: string;
  sequence: number;
  sequenceEnd: number;
  timestamp: string;
  type: string;
  level: NonNullable<AgentRunEvent['level']>;
  text: string;
  diagnostic: string;
  groupedCount: number;
  correlationId?: string;
}

interface AgentApprovalInboxItem {
  run: AgentRun;
  approval: AgentApproval;
  actionable: boolean;
  reason?: string;
}

interface CvFactGroup {
  recordId: string;
  category: CvFactCategory;
  facts: CvFact[];
  title: string;
  period?: string;
}

interface AgentRunComparisonSection {
  id: 'lineage' | 'versions' | 'policy' | 'context' | 'usage' | 'result';
  label: string;
  rows: Array<{ label: string; parent: string; current: string; changed: boolean }>;
}

interface AgentRecoveryDialogState {
  runId: string;
  decision: AgentRecoveryDecision;
  expectedRevision: number;
  leaseId: string;
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
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly sanitizer = inject(DomSanitizer);
  section: Section = 'overview';
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
  agentProviders: AgentProvider[] = [];
  agentConfigProfile?: AgentConfigProfileView;
  agentConfigProfileDraft?: AgentConfigProfile;
  agentConfigProfileConfirmed = false;
  agentCodexAppServerOptInConfirmed = false;
  agentConfigCostAmount = '';
  agentConfigCostCurrency = 'EUR';
  agentConfigProfileBusy = false;
  agentConfigProfileError = '';
  agentModelCatalogs: Record<string, ProviderModelCatalog> = {};
  agentModelCatalogBusy: Record<string, boolean> = {};
  agentModelCatalogError: Record<string, string> = {};
  agentWorkflows: AgentWorkflow[] = [];
  agentRuns: AgentRun[] = [];
  agentQueue?: AgentQueueSnapshot;
  agentRecoveryRuns: AgentRecoveryRun[] = [];
  agentOperationalError = '';
  selectedAgentRun?: AgentRun;
  agentEvents: AgentRunEvent[] = [];
  agentArtifacts: AgentArtifactRecord[] = [];
  agentArtifactContent?: AgentArtifactContent;
  employerResponseTriageProposal?: EmployerResponseTriageProposalProjection;
  applicationNextActionsProposal?: ApplicationNextActionsProposalProjection;
  agentArtifactReviewConfirmed: Record<string, boolean> = {};
  agentArtifactAdoptionConfirmed: Record<string, boolean> = {};
  adoptedDocumentRevisionId?: string;
  agentOrchestrations: AgentOrchestrationRecord[] = [];
  selectedAgentOrchestration?: AgentOrchestrationRecord;
  agentOrchestrationForm: {
    workflowId?: AgentWorkflow['id']; providerId: string; prompt: string; runtimeTarget: AgentRuntimeTarget; wslDistribution?: string;
    applicationCaseId?: string; mailId?: string; userInputConfirmed: boolean;
  } = { workflowId: 'evidence-application-package', providerId: '', prompt: '', runtimeTarget: 'windows', userInputConfirmed: false };
  agentOrchestrationBusy = false;
  agentOrchestrationUserInputConfirmed = false;
  agentOrchestrationCancelConfirmed = false;
  agentOrchestrationConflictStrategies: Record<string, AgentOrchestrationConflictStrategy | undefined> = {};
  agentOrchestrationConflictArtifactIds: Record<string, string | undefined> = {};
  agentOrchestrationConflictConfirmed: Record<string, boolean> = {};
  agentOrchestrationError = '';
  agentEventsAfter = 0;
  readonly agentEventRenderChunk = 100;
  agentEventRenderLimit = this.agentEventRenderChunk;
  agentEventSearch = '';
  agentEventTypeFilter = 'all';
  agentEventLevelFilter: AgentEventLevelFilter = 'all';
  agentTimelineView: AgentTimelineView = 'readable';
  agentTimelinePaused = false;
  agentPausedEvents: AgentRunEvent[] = [];
  prefersReducedMotion = false;
  agentAutoScroll = false;
  agentTimelineNearBottom = true;
  agentBusy = false;
  agentInput = '';
  agentInputSensitive = false;
  agentRecoveryDialog?: AgentRecoveryDialogState;
  agentRecoveryConfirmed = false;
  agentRecoveryInput = '';
  agentPreflight?: AgentRunPreflight;
  agentPreflightLoading = false;
  agentPreflightError = '';
  agentRunForm: AgentRunRequest = { providerId: '', prompt: '', runtimeTarget: 'windows', workspaceMode: 'read_only', network: false, budget: { wallTimeMinutes: 30, maxOutputMiB: 10 } };
  agentStatusFilter: AgentRunStatus | 'all' = 'all';
  agentProviderFilter = 'all';
  agentExportPreview?: Record<string, unknown>;
  private agentPollHandle?: ReturnType<typeof setInterval>;
  private cvAiPollHandle?: ReturnType<typeof setInterval>;
  private cvAiPollInFlight = false;
  private agentPollInFlight = false;
  private agentOrchestrationPollInFlight = false;
  private agentOperationsPollInFlight = false;
  private agentEventSubscription?: Subscription;
  private agentPreflightTimer?: ReturnType<typeof setTimeout>;
  private agentPreflightRevision = 0;
  private agentPreflightFingerprint?: string;
  private readonly agentRecoveryLeases = new Map<string, AgentRecoveryLease>();
  private readonly agentEventIndex = new Map<number, AgentRunEvent>();
  private agentTimelineCache?: { source: AgentRunEvent[]; search: string; type: string; level: AgentEventLevelFilter; entries: AgentTimelineEntry[] };
  private agentEventTypesCache?: { source: AgentRunEvent[]; types: string[] };
  private agentMotionMedia?: MediaQueryList;
  private agentRecoveryReturnFocus?: HTMLElement;
  private portalPermissionReturnFocus?: HTMLElement;
  private readonly agentMotionListener = (event: MediaQueryListEvent): void => {
    this.prefersReducedMotion = event.matches;
    if (event.matches) this.agentAutoScroll = false;
    this.refreshView();
  };

  @ViewChild('agentTimelineList') private agentTimelineList?: ElementRef<HTMLOListElement>;
  @ViewChild('agentRecoveryDialogElement') private agentRecoveryDialogElement?: ElementRef<HTMLDialogElement>;
  @ViewChild('agentRecoveryConfirm') private agentRecoveryConfirm?: ElementRef<HTMLInputElement>;
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
    this.configureAgentMotionPreference();
    this.load();
  }

  ngOnDestroy(): void {
    this.stopAgentPolling(); this.stopAgentStream(); this.stopCvAiPolling();
    if (this.agentPreflightTimer) clearTimeout(this.agentPreflightTimer);
    this.agentMotionMedia?.removeEventListener?.('change', this.agentMotionListener);
  }

  private configureAgentMotionPreference(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.agentMotionMedia?.removeEventListener?.('change', this.agentMotionListener);
    this.agentMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.prefersReducedMotion = this.agentMotionMedia.matches;
    if (this.prefersReducedMotion) this.agentAutoScroll = false;
    this.agentMotionMedia.addEventListener?.('change', this.agentMotionListener);
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
    this.section = section; this.notice = ''; this.error = '';
    if (section !== 'agents') { this.stopAgentPolling(); this.stopAgentStream(); this.closeAgentRecoveryDialog(); }
    if (section !== 'cv') this.stopCvAiPolling();
    if (section === 'jobs') this.loadJobs();
    if (section === 'identity') { this.loadProfileSetup(); this.loadCandidateProfile(); }
    if (section === 'cv') this.loadCvStudio();
    if (section === 'applications') this.loadApplicationCases();
    if (section === 'crm') this.loadCrm();
    if (section === 'agents') { this.configureAgentMotionPreference(); this.loadAgentCenter(); }
    if (section === 'operations') this.loadOperations();
  }

  loadAgentCenter(): void {
    this.loadAgentConfigProfile();
    this.loadAgentProviders();
    this.api.applicationCases().subscribe({ next: (items) => { this.applicationCases = items; this.refreshView(); } });
    this.api.agentWorkflows().subscribe({ next: (items) => { this.agentWorkflows = items; this.refreshView(); } });
    this.refreshAgentRuns();
    this.refreshAgentOrchestrations();
    this.startAgentPolling();
  }

  loadCvStudio(): void {
    this.loadCvImportInventory();
    this.loadApplicationCases();
    this.loadApplicationStyleProfile();
    this.refreshAgentOrchestrations();
    if (!this.agentProviders.length) this.loadAgentProviders();
    if (!this.agentWorkflows.length) this.api.agentWorkflows().subscribe({
      next: (items) => { this.agentWorkflows = items; this.refreshView(); },
      error: (error) => { this.cvError = this.message(error); this.refreshView(); }
    });
    if (this.cvImport) { this.loadCvRecognitionVersions(); this.loadCvAiStructuringState(); }
  }

  loadAgentConfigProfile(): void {
    this.agentConfigProfileBusy = true;
    this.agentConfigProfileError = '';
    this.api.agentConfigProfile().subscribe({
      next: (view) => {
        this.applyAgentConfigProfile(view);
        this.agentConfigProfileBusy = false;
        this.refreshView();
      },
      error: (error) => {
        this.agentConfigProfileBusy = false;
        this.agentConfigProfileConfirmed = false;
        this.agentCodexAppServerOptInConfirmed = false;
        this.agentConfigProfileError = this.message(error);
        this.refreshView();
      }
    });
  }

  setAgentConfigProviderRuntime(provider: AgentProviderConfigProfile, runtimeTarget: AgentRuntimeTarget): void {
    provider.runtimeTarget = runtimeTarget;
    if (runtimeTarget !== 'wsl') provider.wslDistribution = undefined;
    this.invalidateAgentConfigConfirmation();
  }

  setAgentConfigWslDistribution(provider: AgentProviderConfigProfile, distribution: string | undefined): void {
    provider.wslDistribution = distribution?.trim() || undefined;
    this.invalidateAgentConfigConfirmation();
  }

  modelCatalogKey(provider: Pick<AgentProviderConfigProfile, 'provider' | 'runtimeTarget' | 'wslDistribution'>): string {
    return `${provider.provider}:${provider.runtimeTarget}:${provider.wslDistribution ?? ''}`;
  }

  providerModelCatalog(provider: AgentProviderConfigProfile): ProviderModelCatalog | undefined {
    return this.agentModelCatalogs[this.modelCatalogKey(provider)];
  }

  loadProviderModels(provider: Pick<AgentProviderConfigProfile, 'provider' | 'runtimeTarget' | 'wslDistribution'>): void {
    if (provider.runtimeTarget === 'wsl' && !provider.wslDistribution) {
      this.agentModelCatalogError[this.modelCatalogKey(provider)] = 'Für WSL zuerst die Distribution angeben.';
      return;
    }
    const key = this.modelCatalogKey(provider);
    this.agentModelCatalogBusy[key] = true;
    this.agentModelCatalogError[key] = '';
    this.api.providerModels(provider.provider, provider.runtimeTarget, provider.wslDistribution).subscribe({
      next: (catalog) => { this.agentModelCatalogs[key] = catalog; this.agentModelCatalogBusy[key] = false; },
      error: (error) => { this.agentModelCatalogBusy[key] = false; this.agentModelCatalogError[key] = this.message(error); }
    });
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
    return target ? this.agentModelCatalogs[this.modelCatalogKey(target)] : undefined;
  }

  cvAiModelCatalogKey(): string {
    const target = this.cvAiModelCatalogTarget();
    return target ? this.modelCatalogKey(target) : '';
  }

  loadCvAiModels(): void {
    const target = this.cvAiModelCatalogTarget();
    if (target) this.loadProviderModels(target);
  }

  setAgentConfigProviderModel(provider: AgentProviderConfigProfile, model: string | undefined): void {
    provider.model = model?.trim() || undefined;
    this.invalidateAgentConfigConfirmation();
  }

  setAgentConfigBudget(key: 'maxTotalTokens' | 'maxToolCalls' | 'maxRunDurationMs', value: number | string | null | undefined): void {
    if (!this.agentConfigProfileDraft) return;
    const parsed = value === '' || value === null || value === undefined ? undefined : Number(value);
    this.agentConfigProfileDraft.budgets[key] = parsed;
    this.invalidateAgentConfigConfirmation();
  }

  setAgentConfigCostAmount(value: string | number | null | undefined): void {
    this.agentConfigCostAmount = value === null || value === undefined ? '' : String(value).trim();
    this.invalidateAgentConfigConfirmation();
  }

  setAgentConfigCostCurrency(value: string): void {
    this.agentConfigCostCurrency = value.trim().toUpperCase();
    this.invalidateAgentConfigConfirmation();
  }

  agentConfigCostSummary(): string {
    const amountMicros = this.parseAgentConfigCostMicros();
    if (amountMicros === undefined) return 'Kein hartes Kostenbudget im aktiven Serverprofil ausgewiesen; Kostenobergrenze: unknown.';
    if (!Number.isSafeInteger(amountMicros) || !/^[A-Z]{3}$/.test(this.agentConfigCostCurrency)) return 'Kostenbudget-Eingabe ist noch ungültig und wird nicht gespeichert.';
    return `${this.formatAgentConfigCost(amountMicros)} ${this.agentConfigCostCurrency} · ${amountMicros.toLocaleString('de-DE')} Währungs-Mikroeinheiten · harte serverseitige Obergrenze.`;
  }

  setCodexAppServerEnabled(enabled: boolean): void {
    if (!this.agentConfigProfileDraft) return;
    this.agentConfigProfileDraft.features.codexAppServerExperimental = enabled;
    this.agentCodexAppServerOptInConfirmed = false;
    this.agentConfigProfileConfirmed = false;
  }

  invalidateAgentConfigConfirmation(): void {
    this.agentConfigProfileConfirmed = false;
  }

  agentConfigProfileSaveUnavailableReason(): string {
    const current = this.agentConfigProfile;
    const draft = this.agentConfigProfileDraft;
    if (!current || !draft) return 'Das serverseitige Profil ist noch nicht geladen.';
    if (!this.agentConfigProfileConfirmed) return 'Die CAS-gebundene Profiländerung muss bestätigt werden.';
    if (!current.profile.features.codexAppServerExperimental && draft.features.codexAppServerExperimental && !this.agentCodexAppServerOptInConfirmed) {
      return 'Der experimentelle Codex App Server benötigt eine zweite ausdrückliche Opt-in-Bestätigung.';
    }
    if (!Number.isSafeInteger(draft.budgets.warningAtPercent) || draft.budgets.warningAtPercent < 1 || draft.budgets.warningAtPercent > 100) {
      return 'Die Budgetwarnung muss eine ganze Prozentzahl zwischen 1 und 100 sein.';
    }
    for (const value of [draft.budgets.maxTotalTokens, draft.budgets.maxToolCalls, draft.budgets.maxRunDurationMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return 'Optionale Budgetlimits müssen nichtnegative ganze Zahlen sein.';
    }
    const amountMicros = this.parseAgentConfigCostMicros();
    if (amountMicros !== undefined && (!Number.isSafeInteger(amountMicros) || amountMicros < 0)) {
      return 'Das optionale Kostenbudget muss eine nichtnegative Zahl mit höchstens sechs Nachkommastellen sein.';
    }
    if (amountMicros !== undefined && !/^[A-Z]{3}$/.test(this.agentConfigCostCurrency)) {
      return 'Für das Kostenbudget ist ein dreistelliger ISO-Währungscode erforderlich.';
    }
    if (draft.providers.some((provider) => provider.wslDistribution
      && (provider.runtimeTarget !== 'wsl' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider.wslDistribution)))) {
      return 'Eine optionale WSL-Distribution muss eine pfadfreie Kennung verwenden.';
    }
    return '';
  }

  saveAgentConfigProfile(): void {
    if (this.agentConfigProfileBusy) return;
    const current = this.agentConfigProfile;
    const draft = this.agentConfigProfileDraft;
    const unavailableReason = this.agentConfigProfileSaveUnavailableReason();
    if (!current || !draft || unavailableReason) { this.agentConfigProfileError = unavailableReason; return; }
    this.agentConfigProfileBusy = true;
    this.agentConfigProfileError = '';
    this.api.saveAgentConfigProfile(current, this.agentConfigProfileForSave(draft)).subscribe({
      next: (view) => {
        this.applyAgentConfigProfile(view);
        this.agentConfigProfileBusy = false;
        this.agentPreflight = undefined;
        this.notice = `Agenten-Sicherheitsprofil ${view.profile.profileId} wurde per CAS gespeichert. Provider und Preflight werden neu geprüft.`;
        this.loadAgentProviders(true);
        this.refreshView();
      },
      error: (error) => {
        this.agentConfigProfileBusy = false;
        this.agentConfigProfileConfirmed = false;
        this.agentCodexAppServerOptInConfirmed = false;
        this.agentConfigProfileError = this.message(error);
        this.refreshView();
      }
    });
  }

  agentConfigRuntimeLabel(provider: AgentProviderConfigProfile): string {
    return `${provider.runtimeTarget}${provider.wslDistribution ? ` · ${provider.wslDistribution}` : ''}`;
  }

  private applyAgentConfigProfile(view: AgentConfigProfileView): void {
    this.agentConfigProfile = view;
    this.agentConfigProfileDraft = structuredClone(view.profile);
    this.agentConfigCostAmount = view.profile.budgets.maxCostMicros
      ? this.formatAgentConfigCost(view.profile.budgets.maxCostMicros.amountMicros)
      : '';
    this.agentConfigCostCurrency = view.profile.budgets.maxCostMicros?.currency ?? 'EUR';
    this.agentConfigProfileConfirmed = false;
    this.agentCodexAppServerOptInConfirmed = false;
    this.agentConfigProfileError = '';
  }

  private parseAgentConfigCostMicros(): number | undefined {
    const normalized = this.agentConfigCostAmount.trim().replace(',', '.');
    if (!normalized) return undefined;
    const match = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,6}))?$/.exec(normalized);
    if (!match) return Number.NaN;
    const whole = BigInt(match[1]);
    const fraction = BigInt((match[2] ?? '').padEnd(6, '0') || '0');
    const amountMicros = whole * 1_000_000n + fraction;
    return amountMicros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amountMicros) : Number.NaN;
  }

  private formatAgentConfigCost(amountMicros: number): string {
    const whole = Math.trunc(amountMicros / 1_000_000);
    const fraction = String(amountMicros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole},${fraction}` : String(whole);
  }

  private agentConfigProfileForSave(draft: AgentConfigProfile): AgentConfigProfile {
    const profile = structuredClone(draft);
    const amountMicros = this.parseAgentConfigCostMicros();
    if (amountMicros === undefined) delete profile.budgets.maxCostMicros;
    else profile.budgets.maxCostMicros = { amountMicros, currency: this.agentConfigCostCurrency };
    return profile;
  }

  loadAgentProviders(refresh = false): void {
    this.agentBusy = true;
    this.api.agentProviders(refresh).subscribe({
      next: (providers) => {
        this.agentProviders = providers.filter((item) => this.isRealAgentProvider(item.id));
        this.agentTimelineCache = undefined;
        if (!this.agentRunForm.providerId) this.agentRunForm.providerId = providers.find((item) => item.available)?.id ?? providers[0]?.id ?? '';
        if (!this.agentOrchestrationForm.providerId) this.agentOrchestrationForm.providerId = providers.find((item) => item.available)?.id ?? providers[0]?.id ?? '';
        this.ensureAgentRuntimeSelection();
        this.ensureAgentOrchestrationRuntimeSelection();
        this.agentBusy = false; this.refreshAgentPreflight(); this.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  refreshAgentRuns(): void {
    this.refreshAgentOperationalState();
    if (this.agentPollInFlight) return;
    this.agentPollInFlight = true;
    this.api.agentRuns().subscribe({
      next: (runs) => {
        this.agentRuns = [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        if (this.selectedAgentRun) {
          this.selectedAgentRun = runs.find((item) => item.id === this.selectedAgentRun?.id) ?? this.selectedAgentRun;
        } else if (runs.length) {
          this.selectAgentRun(runs[0]);
        }
        this.agentPollInFlight = false;
        this.refreshSelectedAgentRun();
        this.refreshView();
      },
      error: (error) => { this.agentPollInFlight = false; this.error = this.message(error); this.refreshView(); }
    });
  }

  refreshAgentOrchestrations(): void {
    if (this.agentOrchestrationPollInFlight) return;
    this.agentOrchestrationPollInFlight = true;
    this.api.agentOrchestrations().subscribe({
      next: ({ orchestrations }) => {
        this.agentOrchestrations = [...orchestrations].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        if (this.section === 'cv' && this.cvSelectedApplicationCaseId) {
          const latestCvRun = this.agentOrchestrations.find((item) => item.workflowId === 'evidence-application-package'
            && item.scope.applicationCaseId === this.cvSelectedApplicationCaseId);
          if (latestCvRun) this.cvAgentOrchestrationId = latestCvRun.id;
        }
        if (this.selectedAgentOrchestration) {
          const previousRevision = this.selectedAgentOrchestration.revision;
          const previousConflictFingerprint = this.agentOrchestrationConflictFingerprint(this.selectedAgentOrchestration);
          const current = orchestrations.find((item) => item.id === this.selectedAgentOrchestration?.id);
          if (current) {
            this.selectedAgentOrchestration = current;
            if (current.revision !== previousRevision || this.agentOrchestrationConflictFingerprint(current) !== previousConflictFingerprint) {
              this.agentOrchestrationUserInputConfirmed = false;
              this.agentOrchestrationCancelConfirmed = false;
              this.resetAgentOrchestrationConflictInputs();
            }
          }
        } else if (orchestrations.length) this.selectAgentOrchestration(orchestrations[0], false);
        this.agentOrchestrationPollInFlight = false; this.refreshView();
      },
      error: (error) => {
        this.agentOrchestrationPollInFlight = false; this.agentOrchestrationError = this.message(error); this.refreshView();
      }
    });
  }

  selectAgentOrchestration(orchestration: AgentOrchestrationRecord, refresh = true): void {
    const apply = (current: AgentOrchestrationRecord) => {
      this.selectedAgentOrchestration = current;
      this.agentOrchestrationUserInputConfirmed = false;
      this.agentOrchestrationCancelConfirmed = false;
      this.resetAgentOrchestrationConflictInputs();
      if (current.scope.applicationCaseId) this.loadApplicationArtifacts(current.scope.applicationCaseId);
      this.refreshView();
    };
    if (!refresh) { apply(orchestration); return; }
    this.api.agentOrchestration(orchestration.id).subscribe({ next: apply, error: (error) => { this.agentOrchestrationError = this.message(error); this.refreshView(); } });
  }

  agentOrchestrationProvider(): AgentProvider | undefined {
    return this.agentProviders.find((item) => item.id === this.agentOrchestrationForm.providerId);
  }
  agentOrchestrationInstallations(): AgentProviderInstallation[] { return this.agentProviderInstallations(this.agentOrchestrationProvider()); }
  selectedAgentOrchestrationInstallation(): AgentProviderInstallation | undefined {
    return this.agentOrchestrationInstallations().find((item) => item.runtimeTarget === this.agentOrchestrationForm.runtimeTarget
      && (item.runtimeTarget !== 'wsl' || item.distribution === this.agentOrchestrationForm.wslDistribution));
  }
  selectedAgentOrchestrationInstallationKey(): string {
    const installation = this.selectedAgentOrchestrationInstallation();
    return installation ? this.agentInstallationKey(installation) : '';
  }
  selectAgentOrchestrationProvider(providerId: string): void {
    this.agentOrchestrationForm.providerId = providerId;
    const installation = this.agentOrchestrationInstallations().find((item) => item.support === 'supported') ?? this.agentOrchestrationInstallations()[0];
    if (installation) this.applyAgentOrchestrationInstallation(installation);
  }
  selectAgentOrchestrationInstallation(key: string): void {
    const installation = this.agentOrchestrationInstallations().find((item) => this.agentInstallationKey(item) === key);
    if (installation) this.applyAgentOrchestrationInstallation(installation);
  }
  setAgentOrchestrationWorkflow(workflowId: AgentWorkflow['id'] | undefined): void {
    this.agentOrchestrationForm.workflowId = workflowId;
    this.agentOrchestrationForm.userInputConfirmed = false;
    if (workflowId !== 'employer-response-triage') this.agentOrchestrationForm.mailId = undefined;
    const workflow = this.agentWorkflows.find((item) => item.id === workflowId);
    if (workflow?.requiredScope === 'search_profile') {
      this.agentOrchestrationForm.applicationCaseId = undefined;
    }
  }
  setAgentOrchestrationApplicationCase(caseId: string | undefined): void {
    this.agentOrchestrationForm.applicationCaseId = caseId || undefined;
    this.agentOrchestrationForm.userInputConfirmed = false;
    this.agentOrchestrationForm.mailId = undefined;
    if (caseId) this.loadApplicationArtifacts(caseId);
  }
  setAgentOrchestrationPrompt(prompt: string): void {
    this.agentOrchestrationForm.prompt = prompt;
    this.agentOrchestrationForm.userInputConfirmed = false;
  }
  agentOrchestrationWorkflow(): AgentWorkflow | undefined {
    return this.agentWorkflows.find((item) => item.id === this.agentOrchestrationForm.workflowId);
  }
  createAgentOrchestration(): void {
    const form = this.agentOrchestrationForm;
    const workflow = this.agentOrchestrationWorkflow();
    const installation = this.selectedAgentOrchestrationInstallation();
    const prompt = form.prompt.trim();
    if (!workflow) { this.agentOrchestrationError = 'Bitte einen versionierten Workflow wählen.'; return; }
    if (!installation || installation.support !== 'supported') { this.agentOrchestrationError = 'Bitte eine unterstützte Provider-Laufzeit wählen.'; return; }
    if (prompt.length < 3) { this.agentOrchestrationError = 'Bitte einen konkreten Orchestrierungsauftrag eingeben.'; return; }
    if (workflow.requiredScope !== 'search_profile' && !form.applicationCaseId) { this.agentOrchestrationError = 'Dieser Workflow benötigt einen expliziten Bewerbungsfall.'; return; }
    if (workflow.id === 'employer-response-triage' && !form.mailId) {
      this.agentOrchestrationError = 'Employer-Triage benötigt eine explizit gewählte Inbox-Mail. Öffne sie über die CRM-Aktion; Mailinhalt wird nicht in das Browserformular kopiert.';
      return;
    }
    const request: AgentOrchestrationCreateRequest = {
      workflowId: workflow.id, providerId: form.providerId, prompt, runtimeTarget: installation.runtimeTarget,
      ...(installation.runtimeTarget === 'wsl' && installation.distribution ? { wslDistribution: installation.distribution } : {}),
      ...(form.applicationCaseId ? { applicationCaseId: form.applicationCaseId } : {}),
      ...(form.mailId ? { mailId: form.mailId } : {})
    };
    this.agentOrchestrationBusy = true; this.agentOrchestrationError = '';
    this.api.createAgentOrchestration(request).subscribe({
      next: (created) => {
        this.agentOrchestrationBusy = false;
        this.agentOrchestrations = [created, ...this.agentOrchestrations.filter((item) => item.id !== created.id)];
        this.selectAgentOrchestration(created, false);
        if (this.section === 'cv' && created.workflowId === 'evidence-application-package'
          && created.scope.applicationCaseId === this.cvSelectedApplicationCaseId) this.cvAgentOrchestrationId = created.id;
        this.agentOrchestrationForm.prompt = '';
        this.agentOrchestrationForm.userInputConfirmed = false;
        this.notice = `Multi-Agent-Workflow ${created.id} wurde serverseitig angenommen; alle Ergebnisse bleiben Vorschläge.`;
        this.refreshView();
      },
      error: (error) => { this.agentOrchestrationBusy = false; this.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }

  agentOrchestrationHasGate(gate: AgentOrchestrationGate): boolean {
    return this.selectedAgentOrchestration?.unresolvedGates.some((item) => item.gate === gate) ?? false;
  }
  agentOrchestrationConflictKey(conflict: AgentOrchestrationConflict): string {
    return `${this.selectedAgentOrchestration?.id ?? 'none'}:${conflict.id}`;
  }
  agentOrchestrationConflictStrategy(conflict: AgentOrchestrationConflict): AgentOrchestrationConflictStrategy | undefined {
    return this.agentOrchestrationConflictStrategies[this.agentOrchestrationConflictKey(conflict)];
  }
  agentOrchestrationConflictArtifactId(conflict: AgentOrchestrationConflict): string | undefined {
    return this.agentOrchestrationConflictArtifactIds[this.agentOrchestrationConflictKey(conflict)];
  }
  setAgentOrchestrationConflictStrategy(conflict: AgentOrchestrationConflict, strategy: AgentOrchestrationConflictStrategy): void {
    if (conflict.status !== 'unresolved' || !conflict.requiresDomainResolution) return;
    const key = this.agentOrchestrationConflictKey(conflict);
    this.agentOrchestrationConflictStrategies[key] = strategy;
    if (strategy === 'accept_complementary') this.agentOrchestrationConflictArtifactIds[key] = undefined;
    this.agentOrchestrationConflictConfirmed[key] = false;
  }
  setAgentOrchestrationConflictArtifact(conflict: AgentOrchestrationConflict, artifactId: string | undefined): void {
    if (conflict.status !== 'unresolved' || !conflict.requiresDomainResolution) return;
    const key = this.agentOrchestrationConflictKey(conflict);
    this.agentOrchestrationConflictArtifactIds[key] = artifactId || undefined;
    this.agentOrchestrationConflictConfirmed[key] = false;
  }
  setAgentOrchestrationConflictConfirmation(conflict: AgentOrchestrationConflict, confirmed: boolean): void {
    if (conflict.status !== 'unresolved' || !conflict.requiresDomainResolution) return;
    this.agentOrchestrationConflictConfirmed[this.agentOrchestrationConflictKey(conflict)] = confirmed;
  }
  canResolveAgentOrchestrationConflict(conflict: AgentOrchestrationConflict): boolean {
    const key = this.agentOrchestrationConflictKey(conflict);
    const strategy = this.agentOrchestrationConflictStrategies[key];
    const selectedArtifactId = this.agentOrchestrationConflictArtifactIds[key];
    return conflict.status === 'unresolved' && conflict.requiresDomainResolution
      && this.agentOrchestrationConflictConfirmed[key] === true
      && (strategy === 'accept_complementary'
        || (strategy === 'select_variant' && conflict.variants.some((variant) => variant.artifactId === selectedArtifactId)));
  }
  resolveAgentOrchestrationConflict(conflict: AgentOrchestrationConflict): void {
    const orchestration = this.selectedAgentOrchestration;
    if (!orchestration) return;
    const current = orchestration.conflicts?.find((candidate) => candidate.id === conflict.id);
    if (!current || current.status !== 'unresolved' || !current.requiresDomainResolution) {
      this.agentOrchestrationError = 'Dieser Variantenkonflikt ist nicht mehr offen und kann nicht erneut aufgelöst werden.';
      return;
    }
    const key = this.agentOrchestrationConflictKey(current);
    const strategy = this.agentOrchestrationConflictStrategies[key];
    const selectedArtifactId = this.agentOrchestrationConflictArtifactIds[key];
    if (!strategy) { this.agentOrchestrationError = 'Bitte eine bewusste Konfliktstrategie wählen.'; return; }
    if (strategy === 'select_variant' && !current.variants.some((variant) => variant.artifactId === selectedArtifactId)) {
      this.agentOrchestrationError = 'Bitte genau eine der serverseitig ausgewiesenen Varianten wählen.';
      return;
    }
    if (!this.agentOrchestrationConflictConfirmed[key]) {
      this.agentOrchestrationError = 'Die Entscheidung muss an die aktuelle Orchestrierungsrevision und den vollständigen Varianten-Hash gebunden bestätigt werden.';
      return;
    }
    this.agentOrchestrationBusy = true; this.agentOrchestrationError = '';
    this.api.resolveAgentOrchestrationConflict(orchestration.id, current, orchestration.revision, strategy, selectedArtifactId).subscribe({
      next: (updated) => {
        this.agentOrchestrationBusy = false; this.upsertAgentOrchestration(updated); this.selectAgentOrchestration(updated, false);
        this.notice = 'Der Fan-in-Konflikt wurde revisions- und variantengebunden aufgelöst. Die Finalizer-Ausgabe bleibt ein Vorschlag.';
        this.refreshView();
      },
      error: (error) => {
        this.agentOrchestrationBusy = false;
        if (typeof error === 'object' && error && 'status' in error && (error as { status?: number }).status === 409) {
          this.agentOrchestrationConflictConfirmed = {};
          this.agentOrchestrationUserInputConfirmed = false;
          this.agentOrchestrationCancelConfirmed = false;
        } else this.agentOrchestrationConflictConfirmed[key] = false;
        this.agentOrchestrationError = this.message(error);
        this.refreshView();
      }
    });
  }
  continueAgentOrchestration(): void {
    const orchestration = this.selectedAgentOrchestration; if (!orchestration) return;
    const confirmations: AgentOrchestrationConfirmationInput = {};
    if (this.agentOrchestrationHasGate('review_complete')) {
      this.agentOrchestrationError = 'Ein veraltetes review_complete-Gate kann im neuen Vorschlag-zuerst-Workflow nicht vom Browser aufgelöst werden.';
      return;
    }
    if (this.agentOrchestrationHasGate('user_input')) {
      if (!this.agentOrchestrationUserInputConfirmed) { this.agentOrchestrationError = 'Die offene Nutzereingabe muss ausdrücklich bestätigt werden.'; return; }
      confirmations.userInput = { confirmed: true };
    }
    if (!Object.keys(confirmations).length) { this.agentOrchestrationError = 'Die offenen Gates können nur durch serverseitige Evidence oder einen anderen freigegebenen Vertrag aufgelöst werden.'; return; }
    this.agentOrchestrationBusy = true; this.agentOrchestrationError = '';
    this.api.continueAgentOrchestration(orchestration.id, orchestration.revision, confirmations).subscribe({
      next: (updated) => {
        this.agentOrchestrationBusy = false; this.upsertAgentOrchestration(updated); this.selectAgentOrchestration(updated, false);
        this.notice = 'Nur die offenen Orchestrierungsrollen wurden fortgesetzt; erfolgreiche Rollen werden nicht erneut ausgeführt.'; this.refreshView();
      },
      error: (error) => { this.agentOrchestrationBusy = false; this.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }
  cancelAgentOrchestration(): void {
    const orchestration = this.selectedAgentOrchestration; if (!orchestration) return;
    if (!this.agentOrchestrationCancelConfirmed) { this.agentOrchestrationError = 'Der Abbruch muss für die aktuelle Orchestrierungsrevision bestätigt werden.'; return; }
    this.agentOrchestrationBusy = true; this.agentOrchestrationError = '';
    this.api.cancelAgentOrchestration(orchestration.id, orchestration.revision).subscribe({
      next: (updated) => {
        this.agentOrchestrationBusy = false; this.upsertAgentOrchestration(updated); this.selectAgentOrchestration(updated, false);
        this.notice = 'Orchestrierungsabbruch wurde revisionsgebunden angefordert.'; this.refreshView();
      },
      error: (error) => { this.agentOrchestrationBusy = false; this.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }
  agentOrchestrationStatusLabel(status: AgentOrchestrationRecord['status']): string {
    return ({ queued: 'Eingereiht', running: 'Läuft', waiting_for_gate: 'Gate offen', cancelling: 'Wird abgebrochen', cancelled: 'Abgebrochen', succeeded: 'Erfolgreich', failed: 'Fehlgeschlagen', orphaned: 'Verwaist' } as const)[status];
  }
  agentOrchestrationGateLabel(gate: AgentOrchestrationGate): string {
    return ({ user_input: 'Bestätigte Nutzereingabe am serverdefinierten Gate', approval: 'Serverfreigabe', evidence_complete: 'Serverseitige Evidence vollständig', review_complete: 'Legacy-Review-Gate (nicht mehr im Workflow)' } as const)[gate];
  }
  agentOrchestrationConflictStatusLabel(status: AgentOrchestrationConflict['status']): string {
    return ({ equivalent: 'Inhaltlich äquivalent', unresolved: 'Nutzerentscheidung erforderlich', resolved: 'Explizit aufgelöst' } as const)[status];
  }
  latestAgentOrchestrationNodeRun(node: AgentOrchestrationRecord['nodes'][number]): string | undefined {
    return node.runIds.at(-1);
  }
  openAgentRunFromOrchestration(runId: string): void {
    const cached = this.agentRuns.find((item) => item.id === runId);
    if (cached) { this.selectAgentRun(cached); return; }
    this.api.agentRun(runId).subscribe({
      next: (run) => {
        this.agentRuns = [run, ...this.agentRuns.filter((item) => item.id !== run.id)];
        this.selectAgentRun(run);
        this.notice = 'Zugehöriger Node-Run geöffnet. Review und Adoption bleiben an dessen Artefaktrevision gebunden.';
      },
      error: (error) => { this.agentOrchestrationError = this.message(error); this.refreshView(); }
    });
  }
  private upsertAgentOrchestration(updated: AgentOrchestrationRecord): void {
    this.agentOrchestrations = [updated, ...this.agentOrchestrations.filter((item) => item.id !== updated.id)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  private agentOrchestrationConflictFingerprint(orchestration: AgentOrchestrationRecord): string {
    return JSON.stringify((orchestration.conflicts ?? []).map((conflict) => [
      conflict.id, conflict.status, conflict.variantsSha256, conflict.resolution?.resolvedAgainstRevision
    ]));
  }
  private resetAgentOrchestrationConflictInputs(): void {
    this.agentOrchestrationConflictStrategies = {};
    this.agentOrchestrationConflictArtifactIds = {};
    this.agentOrchestrationConflictConfirmed = {};
  }

  refreshAgentOperationalState(): void {
    if (this.agentOperationsPollInFlight) return;
    this.agentOperationsPollInFlight = true;
    forkJoin({ queue: this.api.agentQueue(), recovery: this.api.agentRecovery() }).subscribe({
      next: ({ queue, recovery }) => {
        this.agentQueue = queue;
        this.agentRecoveryRuns = recovery.runs;
        this.agentOperationalError = '';
        const currentRecoveries = new Map(recovery.runs.map((item) => [item.runId, item]));
        for (const [runId, lease] of this.agentRecoveryLeases) {
          const current = currentRecoveries.get(runId);
          const conflictingServerLease = current?.lease && (current.lease.operatorId !== lease.operatorId
            || current.lease.acquiredAt !== lease.acquiredAt || current.lease.expiresAt !== lease.expiresAt);
          // A response that raced with lease acquisition may still omit the lease. Keep its secret
          // locally, but action checks remain disabled until a later snapshot proves the binding.
          if (!current || conflictingServerLease || this.agentRecoveryLeaseExpired(lease)) this.agentRecoveryLeases.delete(runId);
        }
        if (this.agentRecoveryDialog && this.agentRecoveryActionUnavailableReason(
          currentRecoveries.get(this.agentRecoveryDialog.runId), this.agentRecoveryDialog.decision
        )) this.closeAgentRecoveryDialog();
        this.agentOperationsPollInFlight = false;
        this.refreshView();
      },
      error: (error) => {
        this.agentOperationsPollInFlight = false;
        this.agentOperationalError = this.message(error);
        this.refreshView();
      }
    });
  }

  private buildAgentRunRequest(): AgentRunRequest | undefined {
    const provider = this.selectedAgentProvider();
    const installation = this.selectedAgentInstallation();
    if (!provider || !installation) return undefined;
    return {
      providerId: provider.id,
      prompt: this.agentRunForm.prompt.trim(),
      runtimeTarget: installation.runtimeTarget,
      ...(installation.runtimeTarget === 'wsl' && installation.distribution ? { wslDistribution: installation.distribution } : {}),
      workspaceMode: this.agentRunForm.workspaceMode,
      network: Boolean(this.agentRunForm.network),
      budget: { ...this.agentRunForm.budget },
      ...(this.agentRunForm.workflowId ? { workflowId: this.agentRunForm.workflowId } : {}),
      ...(this.agentRunForm.applicationCaseId ? { applicationCaseId: this.agentRunForm.applicationCaseId } : {}),
      ...(this.agentRunForm.parentRunId ? { parentRunId: this.agentRunForm.parentRunId } : {})
    };
  }
  private agentRunRequestFingerprint(request: AgentRunRequest): string { return JSON.stringify(request); }
  scheduleAgentPreflight(delayMs = 180): void {
    if (this.agentPreflightTimer) clearTimeout(this.agentPreflightTimer);
    this.agentPreflightRevision += 1;
    this.agentPreflight = undefined;
    this.agentPreflightFingerprint = undefined;
    this.agentPreflightError = '';
    const request = this.buildAgentRunRequest();
    if (!request || request.prompt.length < 3) { this.agentPreflightLoading = false; this.refreshView(); return; }
    this.agentPreflightLoading = true;
    this.agentPreflightTimer = setTimeout(() => { this.agentPreflightTimer = undefined; this.refreshAgentPreflight(); }, delayMs);
    this.refreshView();
  }
  refreshAgentPreflight(): void {
    if (this.agentPreflightTimer) { clearTimeout(this.agentPreflightTimer); this.agentPreflightTimer = undefined; }
    const request = this.buildAgentRunRequest();
    if (!request || request.prompt.length < 3) {
      this.agentPreflight = undefined; this.agentPreflightFingerprint = undefined;
      this.agentPreflightLoading = false; this.agentPreflightError = ''; this.refreshView(); return;
    }
    const revision = ++this.agentPreflightRevision;
    const fingerprint = this.agentRunRequestFingerprint(request);
    this.agentPreflightLoading = true; this.agentPreflightError = '';
    this.api.agentRunPreflight(request).subscribe({
      next: (preflight) => {
        const current = this.buildAgentRunRequest();
        if (revision !== this.agentPreflightRevision || !current || fingerprint !== this.agentRunRequestFingerprint(current)) return;
        this.agentPreflight = preflight;
        this.agentPreflightFingerprint = fingerprint;
        this.agentPreflightLoading = false;
        this.refreshView();
      },
      error: (error) => {
        if (revision !== this.agentPreflightRevision) return;
        this.agentPreflight = undefined; this.agentPreflightFingerprint = undefined;
        this.agentPreflightLoading = false; this.agentPreflightError = this.message(error); this.refreshView();
      }
    });
  }
  agentPreflightMatchesCurrentDraft(): boolean {
    const request = this.buildAgentRunRequest();
    return Boolean(request && this.agentPreflight && this.agentPreflightFingerprint === this.agentRunRequestFingerprint(request));
  }
  agentPreflightReadyForCurrentDraft(): boolean { return this.agentPreflightMatchesCurrentDraft() && this.agentPreflight?.ready === true; }
  setAgentPrompt(prompt: string): void { this.agentRunForm.prompt = prompt; this.scheduleAgentPreflight(); }
  setAgentWorkflow(workflowId?: AgentRunRequest['workflowId']): void { this.agentRunForm.workflowId = workflowId; this.scheduleAgentPreflight(); }
  setAgentApplicationCase(applicationCaseId?: string): void { this.agentRunForm.applicationCaseId = applicationCaseId; this.scheduleAgentPreflight(); }
  setAgentWorkspaceMode(workspaceMode: AgentWorkspaceMode): void { this.agentRunForm.workspaceMode = workspaceMode; this.scheduleAgentPreflight(); }
  setAgentWallTime(value: number): void { this.agentRunForm.budget.wallTimeMinutes = Number(value); this.scheduleAgentPreflight(); }
  setAgentOutputLimit(value: number): void { this.agentRunForm.budget.maxOutputMiB = Number(value); this.scheduleAgentPreflight(); }
  clearAgentParentRun(): void { this.agentRunForm.parentRunId = undefined; this.scheduleAgentPreflight(); }

  createAgentRun(): void {
    const provider = this.agentProviders.find((item) => item.id === this.agentRunForm.providerId);
    const installation = this.selectedAgentInstallation();
    const prompt = this.agentRunForm.prompt.trim();
    if (!provider?.available) { this.error = 'Bitte einen verfügbaren Agenten wählen.'; return; }
    if (!installation || installation.support !== 'supported') { this.error = 'Bitte eine unterstützte Provider-Installation und Laufzeit wählen.'; return; }
    if (prompt.length < 3) { this.error = 'Bitte eine konkrete Aufgabe mit mindestens drei Zeichen beschreiben.'; return; }
    const request = this.buildAgentRunRequest();
    if (!request || !this.agentPreflightMatchesCurrentDraft()) {
      this.error = 'Die serverseitige Startprüfung fehlt oder ist für diesen Entwurf veraltet.';
      this.refreshAgentPreflight(); return;
    }
    if (!this.agentPreflight?.ready) {
      this.error = this.agentPreflight?.blockers.map((item) => item.message).join(' ') || 'Die serverseitige Startprüfung blockiert diesen Run.';
      this.refreshView(); return;
    }
    this.agentBusy = true; this.error = '';
    this.api.createAgentRun(request).subscribe({
      next: (run) => {
        this.agentBusy = false;
        this.agentRuns = [run, ...this.agentRuns.filter((item) => item.id !== run.id)];
        this.agentRunForm.prompt = '';
        this.agentRunForm.parentRunId = undefined;
        this.agentRunForm.network = false;
        this.scheduleAgentPreflight();
        this.notice = `Run ${run.id} wurde sicher eingereiht.`;
        this.selectAgentRun(run);
        this.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  selectAgentRun(run: AgentRun): void {
    if (this.selectedAgentRun?.id !== run.id) {
      this.agentEvents = [];
      this.agentEventIndex.clear();
      this.agentTimelineCache = undefined;
      this.agentEventTypesCache = undefined;
      this.agentEventsAfter = 0;
      this.agentEventRenderLimit = this.agentEventRenderChunk;
      this.agentTimelinePaused = false;
      this.agentPausedEvents = [];
      this.agentTimelineNearBottom = true;
      this.agentExportPreview = undefined;
      this.agentArtifacts = [];
      this.agentArtifactContent = undefined;
      this.employerResponseTriageProposal = undefined;
      this.applicationNextActionsProposal = undefined;
      this.agentArtifactReviewConfirmed = {};
      this.agentArtifactAdoptionConfirmed = {};
      this.adoptedDocumentRevisionId = undefined;
      this.agentInput = '';
      this.agentInputSensitive = false;
    }
    this.selectedAgentRun = run;
    this.loadAgentArtifacts(run.id);
    this.startAgentStream(run.id);
    this.refreshSelectedAgentRun();
  }

  refreshSelectedAgentRun(): void {
    const runId = this.selectedAgentRun?.id;
    if (!runId || this.section !== 'agents') return;
    this.api.agentRun(runId).subscribe({
      next: (run) => {
        if (this.selectedAgentRun?.id !== run.id) return;
        this.selectedAgentRun = run;
        this.agentRuns = this.agentRuns.map((item) => item.id === run.id ? run : item);
        this.refreshAgentEvents(run.id);
        this.refreshView();
      },
      error: (error) => { this.error = this.message(error); this.refreshView(); }
    });
  }

  refreshAgentEvents(runId = this.selectedAgentRun?.id): void {
    if (!runId || this.selectedAgentRun?.id !== runId) return;
    const after = this.agentEventsAfter;
    this.api.agentRunEvents(runId, after).subscribe({
      next: (page) => {
        if (this.selectedAgentRun?.id !== runId) return;
        this.mergeAgentEvents(page.events ?? []);
        this.agentEventsAfter = Math.max(page.nextAfter ?? after, ...this.agentEvents.map((item) => item.sequence), 0);
        this.refreshView();
        this.scheduleAgentAutoScroll();
      },
      error: (error) => { this.error = this.message(error); this.refreshView(); }
    });
  }

  loadAgentArtifacts(runId = this.selectedAgentRun?.id): void {
    if (!runId) return;
    this.api.agentArtifacts(runId).subscribe({
      next: ({ artifacts }) => {
        if (this.selectedAgentRun?.id !== runId) return;
        this.agentArtifacts = artifacts;
        this.refreshView();
      },
      error: (error) => { this.error = this.message(error); this.refreshView(); }
    });
  }

  viewAgentArtifact(artifact: AgentArtifactRecord): void {
    const run = this.selectedAgentRun; if (!run) return;
    this.api.agentArtifactContent(run.id, artifact.id).subscribe({
      next: (content) => {
        this.agentArtifactContent = content;
        this.employerResponseTriageProposal = artifact.kind === 'employer-response-triage-proposal'
          ? this.parseEmployerResponseTriageProposal(content.content) : undefined;
        this.applicationNextActionsProposal = artifact.kind === 'application-next-actions-proposal'
          ? this.parseApplicationNextActionsProposal(content.content) : undefined;
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
  }
  closeAgentArtifactContent(): void {
    this.agentArtifactContent = undefined;
    this.employerResponseTriageProposal = undefined;
    this.applicationNextActionsProposal = undefined;
  }

  reviewAgentArtifact(artifact: AgentArtifactRecord, decision: 'approved' | 'rejected'): void {
    const run = this.selectedAgentRun; if (!run) return;
    if (!this.agentArtifactReviewConfirmed[artifact.id]) { this.error = 'Die Agentenartefakt-Revision muss ausdrücklich bestätigt werden.'; return; }
    if (artifact.lifecycle !== 'proposed') { this.error = 'Nur ein unverändertes vorgeschlagenes Agentenartefakt kann geprüft werden.'; return; }
    this.agentBusy = true;
    this.api.reviewAgentArtifact(run.id, artifact.id, decision, artifact.revision).subscribe({
      next: (updated) => {
        this.agentArtifacts = this.agentArtifacts.map((item) => item.id === updated.id ? updated : item);
        this.agentArtifactReviewConfirmed[artifact.id] = false;
        this.agentBusy = false;
        this.notice = decision === 'approved'
          ? 'Agentenartefakt wurde revisionsgebunden freigegeben. Nur passende Pipeline-Pakete können danach über die getrennte Adopt-Prüfung als fachliche Vorschlagsrevision übernommen werden.'
          : 'Agentenartefakt wurde revisionsgebunden abgelehnt.';
        this.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  agentArtifactAdoptionReason(artifact: AgentArtifactRecord): string {
    const run = this.selectedAgentRun;
    const application = run ? this.agentRunApplication(run) : undefined;
    if (!run || !application) return 'Der Run ist keinem aktuell geladenen Bewerbungsfall zugeordnet.';
    if (application.state !== 'review') return 'Die Übernahme ist nur im aktuellen Review-Status des Falls möglich.';
    if (application.identityMode !== 'real') return 'Inkognito-Fälle dürfen keine fachlichen Dokumentrevisionen übernehmen.';
    if (artifact.provenance.identityMode !== 'real') return 'Die Artefaktprovenienz ist nicht an eine reale Identität gebunden.';
    if (artifact.lifecycle !== 'approved') return 'Zuerst muss exakt diese Agentenartefakt-Revision freigegeben werden.';
    if (artifact.contentState === 'deleted') return 'Der geprüfte Artefaktinhalt wurde bereits gelöscht.';
    if (artifact.kind !== 'application-pipeline-package' || artifact.mediaType !== 'application/json') return 'Nur strikt validierte application-pipeline-package-JSON-Artefakte sind übernehmbar.';
    if (artifact.provenance.applicationCaseId !== application.id) return 'Artefakt und aktueller Bewerbungsfall sind nicht identisch gebunden.';
    if (artifact.provenance.applicationCaseRevision !== application.revision) return 'Die Fallrevision hat sich seit der Agentenverarbeitung geändert.';
    if (artifact.provenance.jobId !== application.job.id) return 'Artefakt und aktuelle Stelle sind nicht identisch gebunden.';
    const companyKey = application.job.company.normalize('NFKC').toLocaleLowerCase('de-DE')
      .replace(/\b(gmbh|ag|ug|se|inc|ltd|llc)\b/g, '').replace(/[^a-z0-9äöüß]+/gi, '-').replace(/^-|-$/g, '') || 'unknown-company';
    if (artifact.provenance.companyKey !== companyKey) return 'Artefakt und aktueller Firmenstand sind nicht identisch gebunden.';
    return '';
  }

  adoptAgentArtifact(artifact: AgentArtifactRecord): void {
    const run = this.selectedAgentRun;
    const application = run ? this.agentRunApplication(run) : undefined;
    const reason = this.agentArtifactAdoptionReason(artifact);
    if (!run || !application || reason) { this.error = reason || 'Agentenartefakt kann nicht übernommen werden.'; return; }
    if (!this.agentArtifactAdoptionConfirmed[artifact.id]) { this.error = 'Die erneute Pipeline-Prüfung und Übernahme muss ausdrücklich bestätigt werden.'; return; }
    this.agentBusy = true; this.error = '';
    this.api.adoptAgentArtifact(run.id, artifact.id, artifact.revision).subscribe({
      next: ({ artifact: updated, documentRevisionId }) => {
        this.agentArtifacts = this.agentArtifacts.map((item) => item.id === updated.id ? updated : item);
        this.agentArtifactAdoptionConfirmed[artifact.id] = false;
        this.adoptedDocumentRevisionId = documentRevisionId;
        this.selectApplicationCase(application);
        this.loadApplicationArtifacts(application.id);
        this.agentBusy = false;
        this.notice = `Agentenpaket wurde erneut deterministisch geprüft; fachliche Revision ${documentRevisionId} liegt als Vorschlag zur menschlichen Hash-Prüfung vor.`;
        this.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  cancelAgentRun(): void {
    const run = this.selectedAgentRun; if (!run || !this.isAgentRunActive(run.status)) return;
    this.agentBusy = true;
    this.api.cancelAgentRun(run.id, run.lastEventSequence).subscribe({
      next: (updated) => { this.agentBusy = false; this.selectedAgentRun = updated; this.notice = 'Abbruch wurde angefordert.'; this.refreshAgentRuns(); },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  sendAgentInput(): void {
    const run = this.selectedAgentRun; const input = this.agentInput.trim();
    if (!run || !input) return;
    this.agentBusy = true;
    this.api.sendAgentInput(run.id, input, run.lastEventSequence).subscribe({
      next: (updated) => { this.agentBusy = false; this.selectedAgentRun = updated; this.agentInput = ''; this.agentInputSensitive = false; this.notice = 'Antwort wurde dem Agenten übergeben.'; this.refreshSelectedAgentRun(); },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  decideAgentApproval(approval: AgentApproval, decision: 'approve' | 'deny', run = this.selectedAgentRun): void {
    if (!run) return;
    const unavailableReason = this.agentApprovalUnavailableReason(run, approval);
    if (unavailableReason) { this.error = unavailableReason; this.refreshView(); return; }
    this.agentBusy = true;
    const request = approval.expectedRevision === undefined
      ? this.api.decideAgentApproval(run.id, approval.id, decision)
      : this.api.decideAgentApproval(run.id, approval.id, decision, approval.expectedRevision);
    request.subscribe({
      next: (updated) => {
        this.agentBusy = false;
        this.agentRuns = this.agentRuns.map((item) => item.id === updated.id ? updated : item);
        if (this.selectedAgentRun?.id === updated.id) this.selectedAgentRun = updated;
        this.notice = decision === 'approve' ? 'Aktion wurde ausdrücklich freigegeben.' : 'Aktion wurde abgelehnt.';
        this.refreshAgentRuns();
      },
      error: (error) => { this.agentBusy = false; this.fail(error); }
    });
  }

  previewAgentExport(): void {
    const run = this.selectedAgentRun; if (!run) return;
    this.api.exportAgentRun(run.id).subscribe({
      next: (value) => { this.agentExportPreview = value; this.notice = 'Nachvollziehbarer Run-Export wurde als Vorschau geladen.'; this.refreshView(); },
      error: (error) => this.fail(error)
    });
  }

  loadAgentReplayTemplate(): void {
    const run = this.selectedAgentRun; if (!run) return;
    this.agentRunForm = { ...run.request, parentRunId: run.id, network: false, budget: { ...run.request.budget } };
    this.ensureAgentRuntimeSelection();
    if (!this.agentProviderSupportsWorkspace(this.agentRunForm.workspaceMode)) this.agentRunForm.workspaceMode = 'read_only';
    this.notice = 'Run als neue Vorlage geladen. Netzwerkzugriff bleibt für den Replay standardmäßig aus.';
    this.scheduleAgentPreflight();
    this.refreshView();
  }

  filteredAgentRuns(): AgentRun[] {
    return this.agentRuns.filter((run) =>
      (this.agentStatusFilter === 'all' || run.status === this.agentStatusFilter)
      && (this.agentProviderFilter === 'all' || run.providerId === this.agentProviderFilter));
  }

  selectedAgentProvider(): AgentProvider | undefined { return this.agentProviders.find((item) => item.id === this.agentRunForm.providerId); }
  agentProviderInstallations(provider = this.selectedAgentProvider()): AgentProviderInstallation[] {
    if (!provider) return [];
    if (provider.installations?.length) return provider.installations;
    return [{
      runtimeTarget: 'windows', version: provider.version,
      support: provider.available ? 'supported' : 'unavailable', authStatus: provider.authStatus,
      note: provider.note
    }];
  }
  selectAgentProvider(providerId: string): void {
    this.agentRunForm.providerId = providerId;
    const installations = this.agentProviderInstallations();
    const first = installations.find((item) => item.support === 'supported') ?? installations[0];
    if (first) this.applyAgentInstallation(first);
    this.agentRunForm.network = this.agentRunForm.network && this.agentProviderSupportsNetwork();
    if (!this.agentProviderSupportsWorkspace(this.agentRunForm.workspaceMode)) this.agentRunForm.workspaceMode = 'read_only';
    this.scheduleAgentPreflight();
  }
  selectAgentInstallation(key: string): void {
    const installation = this.agentProviderInstallations().find((item) => this.agentInstallationKey(item) === key);
    if (installation) { this.applyAgentInstallation(installation); this.scheduleAgentPreflight(); }
  }
  selectedAgentInstallation(): AgentProviderInstallation | undefined {
    const installations = this.agentProviderInstallations();
    return installations.find((item) => item.runtimeTarget === this.agentRunForm.runtimeTarget
      && (item.runtimeTarget !== 'wsl' || item.distribution === this.agentRunForm.wslDistribution))
      ?? (this.agentRunForm.runtimeTarget === 'wsl' && !this.agentRunForm.wslDistribution
        ? installations.find((item) => item.runtimeTarget === 'wsl') : undefined);
  }
  agentInstallationKey(installation: AgentProviderInstallation): string {
    return `${installation.runtimeTarget}:${encodeURIComponent(installation.distribution ?? '')}`;
  }
  selectedAgentInstallationKey(): string {
    const installation = this.selectedAgentInstallation();
    return installation ? this.agentInstallationKey(installation) : '';
  }
  agentRuntimeLabel(installation = this.selectedAgentInstallation()): string {
    if (!installation) return 'Keine Laufzeit ausgewählt';
    return installation.runtimeTarget === 'wsl'
      ? `WSL · ${installation.distribution ?? 'Distribution unbekannt'}`
      : ({ windows: 'Windows', linux: 'Linux', darwin: 'macOS' } as const)[installation.runtimeTarget];
  }
  agentInstallationAuthLabel(installation: AgentProviderInstallation): string {
    return ({ authenticated: 'angemeldet', unauthenticated: 'nicht angemeldet', not_required: 'kein Login nötig', unknown: 'Auth unbekannt' } as Record<string, string>)[installation.authStatus ?? 'unknown'];
  }
  agentWorkspaceLabel(): string { return this.agentRunForm.workspaceMode === 'read_only' ? 'Nur lesen' : 'Workspace schreiben'; }
  agentWorkflowLabel(): string { return this.selectedAgentWorkflow()?.title ?? 'Allgemeiner Workspace-Auftrag'; }
  agentProviderSupportsWorkspace(mode: AgentWorkspaceMode, provider = this.selectedAgentProvider()): boolean {
    const capabilities = provider?.capabilities;
    if (capabilities && !Array.isArray(capabilities) && capabilities.workspaceModes?.length) return capabilities.workspaceModes.includes(mode);
    return mode === 'read_only';
  }
  agentPreflightProviderDetail(preflight: AgentRunPreflight): string {
    const installation = preflight.provider.installation;
    if (!installation) return 'Keine Installation im serverseitigen Preflight';
    const auth = ({ authenticated: 'angemeldet', unauthenticated: 'nicht angemeldet', not_required: 'kein Login nötig', unknown: 'Auth unbekannt' } as Record<string, string>)[installation.authStatus ?? 'unknown'];
    const support = ({ supported: 'unterstützt', untested: 'ungetestet', unsupported: 'nicht unterstützt', unavailable: 'nicht verfügbar' } as const)[installation.support];
    return `${installation.version ? `v${installation.version}` : 'Version unbekannt'}${installation.adapterVersion ? ` · Adapter v${installation.adapterVersion}` : ''} · ${auth} · ${support}`;
  }
  agentPreflightRuntimeLabel(preflight: AgentRunPreflight): string {
    return preflight.runtime.runtimeTarget === 'wsl'
      ? `WSL · ${preflight.runtime.distribution ?? 'Distribution fehlt'}`
      : ({ windows: 'Windows', linux: 'Linux', darwin: 'macOS' } as Record<string, string>)[preflight.runtime.runtimeTarget] ?? preflight.runtime.runtimeTarget;
  }
  agentPreflightWorkspaceLabel(preflight: AgentRunPreflight): string {
    return `Serverseitiger Projektbereich · ${preflight.workspace.mode === 'read_only' ? 'Nur lesen' : 'Workspace schreiben'}`;
  }
  agentPreflightScopeLabel(scope: AgentRunPreflight['data']['declaredScope']): string {
    return ({ workspace: 'Workspace', search_profile: 'Suchprofil', application_case: 'Bewerbungsfall', company: 'Unternehmen' } as const)[scope];
  }
  agentPreflightCategoryLabel(category: AgentRunPreflight['data']['categories'][number]): string {
    const kind = ({
      search_preference: 'Suchpräferenz', job: 'Stelle', application_case: 'Bewerbungsfall', candidate_claim: 'Kandidatenclaim',
      mail: 'Mailinhalt', company: 'Unternehmen', tracking_event: 'Trackingereignis'
    } as const)[category.kind];
    const availability = ({ included: 'enthalten', conditional: 'bedingt', unknown_until_start: 'Anzahl erst beim Start', not_wired: 'nicht verdrahtet' } as const)[category.availability];
    return `${kind} · ${availability}${category.maxItems === undefined ? '' : ` · max. ${category.maxItems}`}${category.trust === 'untrusted' ? ' · untrusted' : ''}`;
  }
  agentPreflightToolLabel(preflight: AgentRunPreflight): string {
    return preflight.tools.allowedRootMcpTools.length ? preflight.tools.allowedRootMcpTools.join(', ') : 'Keine Root-MCP-Tools freigegeben';
  }
  agentPreflightToolDetail(preflight: AgentRunPreflight): string {
    const blocked = preflight.tools.prohibitedActions.length ? ` Gesperrte Aktionen: ${preflight.tools.prohibitedActions.join(', ')}.` : '';
    const tooling = preflight.tools.providerTooling === 'server_owned_dynamic_tools'
      ? 'Root-MCP-Tools werden serverseitig dynamisch und rungebunden bereitgestellt; native Provider-Werkzeuge sind nicht namentlich offengelegt.'
      : 'Provider erhält ausschließlich Prompt-Kontext; keine dynamischen Root-MCP-Tools.';
    return `Deny-by-default · Allowlist ${preflight.tools.allowlistComplete ? 'vollständig' : 'unvollständig'} · ${tooling}${blocked}`;
  }
  agentPreflightNetworkDetail(preflight: AgentRunPreflight): string {
    const trustedHost = preflight.network.trustedHostServices.length
      ? ` Trusted Host: ${preflight.network.trustedHostServices.map((item) => `${item.id} vor Agentenstart; Agentzugriff nein`).join(', ')}.` : '';
    return `Effektiv ${preflight.network.effective}; serverseitig ${preflight.network.enforced ? 'erzwungen' : 'nicht nachgewiesen'}.${trustedHost}`;
  }
  agentPreflightLimitsLabel(preflight: AgentRunPreflight): string {
    return `${preflight.limits.requested.wallTimeMinutes} Min · ${preflight.limits.requested.maxOutputMiB} MiB angefordert`;
  }
  agentPreflightLimitsDetail(preflight: AgentRunPreflight): string {
    const effective = preflight.limits.effective;
    return `Effektiv: Laufzeit ${Math.round(effective.wallTimeMs / 60_000)} Min · Idle ${Math.round(effective.idleTimeMs / 60_000)} Min · Ausgabe ${this.agentPreflightByteLabel(effective.totalOutputBytes)} (stdout ${this.agentPreflightByteLabel(effective.stdoutBytes)}, stderr ${this.agentPreflightByteLabel(effective.stderrBytes)}) · Eingabe ${this.agentPreflightByteLabel(effective.maxInputBytes)}.`;
  }
  agentPreflightSchedulingDetail(preflight: AgentRunPreflight): string {
    const scheduling = preflight.scheduling;
    if (!scheduling) return 'Keine Scheduling-Momentaufnahme im Preflight';
    return `Queue ${scheduling.queueDepth} · aktiv ${scheduling.active}/${scheduling.limits.global} · Provider ${scheduling.limits.perProvider} · Workspace ${scheduling.limits.perWorkspace} · Owner ${scheduling.limits.perOwner}`;
  }
  private agentPreflightByteLabel(bytes: number): string {
    if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
    if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
    return `${bytes} Byte`;
  }
  private ensureAgentRuntimeSelection(): void {
    const provider = this.selectedAgentProvider() ?? this.agentProviders.find((item) => item.available) ?? this.agentProviders[0];
    if (!provider) return;
    this.agentRunForm.providerId = provider.id;
    const selected = this.selectedAgentInstallation();
    if (selected?.support === 'supported') return;
    const installations = this.agentProviderInstallations(provider);
    const installation = installations.find((item) => item.support === 'supported') ?? installations[0];
    if (installation) this.applyAgentInstallation(installation);
  }
  private ensureAgentOrchestrationRuntimeSelection(): void {
    const provider = this.agentOrchestrationProvider() ?? this.agentProviders.find((item) => item.available) ?? this.agentProviders[0];
    if (!provider) return;
    this.agentOrchestrationForm.providerId = provider.id;
    const selected = this.selectedAgentOrchestrationInstallation();
    if (selected?.support === 'supported') return;
    const installation = this.agentProviderInstallations(provider).find((item) => item.support === 'supported') ?? this.agentProviderInstallations(provider)[0];
    if (installation) this.applyAgentOrchestrationInstallation(installation);
  }
  private applyAgentInstallation(installation: AgentProviderInstallation): void {
    this.agentRunForm.runtimeTarget = installation.runtimeTarget;
    this.agentRunForm.wslDistribution = installation.runtimeTarget === 'wsl' ? installation.distribution : undefined;
  }
  private applyAgentOrchestrationInstallation(installation: AgentProviderInstallation): void {
    this.agentOrchestrationForm.runtimeTarget = installation.runtimeTarget;
    this.agentOrchestrationForm.wslDistribution = installation.runtimeTarget === 'wsl' ? installation.distribution : undefined;
  }
  selectedAgentWorkflow(): AgentWorkflow | undefined { return this.agentWorkflows.find((item) => item.id === this.agentRunForm.workflowId); }
  agentProviderSupportsNetwork(): boolean { return false; }
  agentProviderName(providerId: string): string { return this.agentProviders.find((item) => item.id === providerId)?.name ?? providerId; }
  /** Synthetic offline test providers are never surfaced in the UI. */
  isRealAgentProvider(providerId: string): boolean { return providerId !== 'fake' && providerId !== 'fake-interactive'; }
  visibleAgentConfigProviders(profile: AgentConfigProfile): AgentProviderConfigProfile[] {
    return profile.providers.filter((provider) => this.isRealAgentProvider(provider.provider));
  }
  agentRunProviderVersion(run: AgentRun): string {
    if (run.providerVersion) return `v${run.providerVersion}`;
    const current = this.agentProviders.find((item) => item.id === run.providerId)?.version;
    return current ? `v${current} (aktuell erkannt; nicht historisch gespeichert)` : 'Nicht im Run gespeichert';
  }
  agentRunWorkflowVersion(run: AgentRun): string {
    if (run.workflowVersion) return `v${run.workflowVersion}`;
    const current = this.agentWorkflows.find((item) => item.id === run.request.workflowId)?.version;
    return current ? `v${current} (aktueller Katalog; nicht historisch gespeichert)` : 'Nicht im Run gespeichert';
  }
  agentRunWorkflowTitle(run: AgentRun): string { return this.agentWorkflows.find((item) => item.id === run.request.workflowId)?.title ?? run.request.workflowId ?? 'Allgemeiner Workspace-Auftrag'; }
  agentRunPolicyVersion(run: AgentRun): string { return run.policyVersion ? `v${run.policyVersion}` : 'Nicht im Runvertrag gespeichert'; }
  agentRunPolicySummary(run: AgentRun): string {
    return `${run.request.workspaceMode === 'read_only' ? 'Nur lesen' : 'Workspace schreiben'} · Netzwerk ${run.request.network ? 'erlaubt' : 'gesperrt'}`;
  }
  agentRunContextSummary(run: AgentRun): string {
    const scope = run.contextSummary?.scope ?? (run.request.applicationCaseId ? `Bewerbungsfall ${run.request.applicationCaseId}` : 'Workspace ohne Bewerbungsfall');
    const sources = run.contextSummary?.sourceCount === undefined ? '' : ` · ${run.contextSummary.sourceCount} Quelle(n)`;
    const witness = run.contextSummary?.redactedHash ? ` · Witness ${run.contextSummary.redactedHash.slice(0, 12)}…` : ' · kein Kontext-Witness im UI-Vertrag';
    return `${scope}${sources}${witness}`;
  }
  agentRunComparison(run = this.selectedAgentRun): AgentRunComparisonSection[] {
    if (!run?.parentRunId) return [];
    const parent = this.agentRuns.find((item) => item.id === run.parentRunId);
    if (!parent) return [{ id: 'lineage', label: 'Abstammung', rows: [{ label: 'Ausgangslauf', parent: run.parentRunId, current: 'Nicht mehr lokal verfügbar', changed: true }] }];
    const row = (label: string, parentValue: string, currentValue: string, changed = parentValue !== currentValue) => ({ label, parent: parentValue, current: currentValue, changed });
    const usage = (value?: number) => value === undefined ? '—' : String(value);
    const resultPresence = (value?: string) => value ? 'Gespeichert' : 'Nicht vorhanden';
    return [
      { id: 'lineage', label: 'Abstammung', rows: [row('Run', parent.id, run.id, true), row('Provider', this.agentProviderName(parent.providerId), this.agentProviderName(run.providerId))] },
      { id: 'versions', label: 'Versionen', rows: [row('Provider-Version', this.agentRunProviderVersion(parent), this.agentRunProviderVersion(run)), row('Workflow-Version', this.agentRunWorkflowVersion(parent), this.agentRunWorkflowVersion(run)), row('Policy-Version', this.agentRunPolicyVersion(parent), this.agentRunPolicyVersion(run))] },
      { id: 'policy', label: 'Policy', rows: [row('Berechtigungen', this.agentRunPolicySummary(parent), this.agentRunPolicySummary(run)), row('Runtime', `${parent.request.runtimeTarget}${parent.request.wslDistribution ? ` · ${parent.request.wslDistribution}` : ''}`, `${run.request.runtimeTarget}${run.request.wslDistribution ? ` · ${run.request.wslDistribution}` : ''}`), row('Budget', `${parent.request.budget.wallTimeMinutes} Min · ${parent.request.budget.maxOutputMiB} MiB`, `${run.request.budget.wallTimeMinutes} Min · ${run.request.budget.maxOutputMiB} MiB`)] },
      { id: 'context', label: 'Kontext', rows: [row('Scope', this.agentRunContextSummary(parent), this.agentRunContextSummary(run)), row('Workflow', parent.request.workflowId ?? 'Allgemein', run.request.workflowId ?? 'Allgemein'), row('Auftrag', 'Gespeicherter Auftrag', parent.request.prompt === run.request.prompt ? 'Identisch' : 'Geändert; Klartext wird nicht dupliziert', parent.request.prompt !== run.request.prompt)] },
      { id: 'usage', label: 'Usage', rows: [row('Input-Tokens', usage(parent.usage?.inputTokens), usage(run.usage?.inputTokens)), row('Output-Tokens', usage(parent.usage?.outputTokens), usage(run.usage?.outputTokens)), row('Toolaufrufe', usage(parent.usage?.toolCalls), usage(run.usage?.toolCalls)), row('Dauer', this.formatDuration(parent.usage?.durationMs), this.formatDuration(run.usage?.durationMs))] },
      { id: 'result', label: 'Ergebnis', rows: [row('Status', this.agentStatusLabel(parent.status), this.agentStatusLabel(run.status)), row('Ausgabe', resultPresence(parent.output), resultPresence(run.output), parent.output !== run.output), row('Fehler', resultPresence(parent.error), resultPresence(run.error), parent.error !== run.error)] }
    ];
  }
  agentRunApplication(run: AgentRun): ApplicationCase | undefined { return this.applicationCases.find((item) => item.id === run.request.applicationCaseId); }
  pendingApprovals(run = this.selectedAgentRun): AgentApproval[] { return (run?.pendingApprovals ?? []).filter((item) => !item.status || item.status === 'pending'); }
  globalAgentApprovals(): AgentApprovalInboxItem[] {
    const priority: Record<string, number> = { destructive: 6, critical: 6, external_write: 5, high: 5, network: 4, sensitive_read: 3, local_write: 2, medium: 2, low: 1, read: 0 };
    return this.agentRuns.flatMap((run) => this.pendingApprovals(run).map((approval) => {
      const reason = this.agentApprovalUnavailableReason(run, approval);
      return { run, approval, actionable: !reason, reason };
    })).sort((left, right) => Number(right.actionable) - Number(left.actionable)
      || (priority[right.approval.risk ?? ''] ?? 0) - (priority[left.approval.risk ?? ''] ?? 0)
      || (left.approval.requestedAt ?? left.run.createdAt).localeCompare(right.approval.requestedAt ?? right.run.createdAt));
  }
  agentApprovalRiskLabel(approval: AgentApproval): string {
    return ({ read: 'Lesen', low: 'Niedrig', local_write: 'Lokales Schreiben', medium: 'Mittel', sensitive_read: 'Sensible Daten', network: 'Netzwerk', high: 'Hoch', external_write: 'Externe Änderung', destructive: 'Destruktiv', critical: 'Kritisch' } as Record<string, string>)[approval.risk ?? ''] ?? 'Risiko nicht bewertet';
  }
  agentApprovalUnavailableReason(run: AgentRun, approval: AgentApproval): string | undefined {
    if (approval.status && approval.status !== 'pending') return 'Diese Freigabe wurde bereits entschieden und kann nicht erneut bestätigt werden.';
    const expiresAt = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return 'Diese Freigabe ist abgelaufen. Der Agent muss eine neue, aktuelle Freigabe anfordern.';
    if (run.status !== 'waiting_for_approval') return 'Der Run wartet nicht mehr auf diese Freigabe; der Dialog ist veraltet.';
    if (approval.expectedRevision !== undefined && run.lastEventSequence !== undefined && approval.expectedRevision !== run.lastEventSequence) {
      return `Der Run ist seit Freigabe #${approval.expectedRevision} bis #${run.lastEventSequence} fortgeschritten. Bitte neu prüfen.`;
    }
    const requiresExactTarget = ['network', 'external_write', 'destructive', 'high', 'critical'].includes(approval.risk ?? '');
    if (requiresExactTarget && !approval.target?.trim()) return 'Für diese risikoreiche Aktion fehlt ein exaktes Ziel; eine Freigabe ist gesperrt.';
    return undefined;
  }
  agentApprovalSupportsEdit(_run: AgentRun, _approval: AgentApproval): boolean { return false; }
  agentApprovalEditReason(): string { return 'Der aktuelle API-Vertrag akzeptiert nur unveränderte Approve-/Deny-Entscheidungen. Für bearbeitete Parameter muss der Agent eine neue Freigabe anfordern.'; }
  availableAgentProvidersCount(): number { return this.agentProviders.filter((item) => item.available).length; }
  activeAgentRunsCount(): number { return this.agentRuns.filter((item) => this.isAgentRunActive(item.status)).length; }
  pendingAgentApprovalsCount(): number { return this.globalAgentApprovals().filter((item) => item.actionable).length; }
  isAgentRunActive(status: AgentRunStatus): boolean { return ['queued', 'starting', 'running', 'waiting_for_input', 'waiting_for_approval', 'cancelling', 'recovering'].includes(status); }
  agentStatusLabel(status: AgentRunStatus): string {
    return ({ queued: 'Warteschlange', starting: 'Startet', running: 'Läuft', waiting_for_input: 'Wartet auf Antwort', waiting_for_approval: 'Freigabe erforderlich', cancelling: 'Wird abgebrochen', cancelled: 'Abgebrochen', succeeded: 'Erfolgreich', failed: 'Fehlgeschlagen', timed_out: 'Zeitlimit', orphaned: 'Verwaist', recovering: 'Wiederherstellung' } as Record<AgentRunStatus, string>)[status];
  }
  agentLimitLabel(value?: number): string { return value === undefined ? 'nicht gesetzt' : String(value); }
  agentPriorityLabel(value: number): string { return value > 0 ? `+${value}` : String(value); }
  agentQueueBlockLabel(reason: AgentQueueBlockReason): string {
    return ({ global_limit: 'Global-Limit', provider_limit: 'Provider-Limit', workspace_limit: 'Workspace-Limit', owner_limit: 'Owner-Limit' } as const)[reason];
  }
  agentRecoveryRunView(recovery: AgentRecoveryRun): AgentRun | undefined {
    return this.agentRuns.find((run) => run.id === recovery.runId);
  }
  agentRecoveryLeaseFor(runId: string): AgentRecoveryLease | undefined { return this.agentRecoveryLeases.get(runId); }
  agentRecoveryLeaseExpired(lease: Pick<AgentRecoveryLease, 'expiresAt'>): boolean {
    const expiresAt = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
  }
  agentRecoveryAcquireUnavailableReason(recovery: AgentRecoveryRun): string | undefined {
    const run = this.agentRecoveryRunView(recovery);
    if (recovery.state !== 'orphaned' || run?.status !== 'orphaned') return 'Der Lauf ist nicht mehr eindeutig verwaist.';
    if (run.lastEventSequence === undefined) return 'Die aktuelle Serverrevision fehlt; eine Lease wird fail-closed verweigert.';
    if (recovery.lease) {
      const localLease = this.agentRecoveryLeaseFor(recovery.runId);
      if (localLease && recovery.lease.operatorId === localLease.operatorId && !this.agentRecoveryLeaseExpired(localLease)) {
        return 'Dieser Browser besitzt bereits die operatorgebundene Lease.';
      }
      return `Aktive Lease von ${recovery.lease.operatorId}; die Lease-ID wird absichtlich nicht an andere Browser ausgegeben.`;
    }
    return undefined;
  }
  agentRecoveryActionUnavailableReason(recovery: AgentRecoveryRun | undefined, decision: AgentRecoveryDecision): string | undefined {
    if (!recovery) return 'Die Recovery-Diagnose ist nicht mehr aktuell.';
    if (!recovery.allowedDecisions.includes(decision)) return 'Diese Recovery-Entscheidung ist serverseitig nicht erlaubt.';
    const run = this.agentRecoveryRunView(recovery);
    if (recovery.state !== 'orphaned' || run?.status !== 'orphaned') return 'Der Lauf ist nicht mehr eindeutig verwaist.';
    if (run.lastEventSequence === undefined) return 'Die aktuelle Serverrevision fehlt; die Entscheidung bleibt gesperrt.';
    const lease = this.agentRecoveryLeaseFor(recovery.runId);
    if (!lease) return recovery.lease
      ? `Die Lease gehört ${recovery.lease.operatorId}; dieser Browser besitzt keine Lease-ID.`
      : 'Vor der Entscheidung muss dieser Browser eine operatorgebundene Lease übernehmen.';
    if (this.agentRecoveryLeaseExpired(lease)) return 'Die lokale Recovery-Lease ist abgelaufen.';
    if (!recovery.lease || recovery.lease.operatorId !== lease.operatorId
      || recovery.lease.acquiredAt !== lease.acquiredAt || recovery.lease.expiresAt !== lease.expiresAt) {
      return 'Die lokale Lease stimmt nicht mehr mit dem Serverzustand überein.';
    }
    return undefined;
  }
  acquireAgentRecoveryLease(recovery: AgentRecoveryRun): void {
    const unavailable = this.agentRecoveryAcquireUnavailableReason(recovery);
    const run = this.agentRecoveryRunView(recovery);
    if (unavailable || run?.lastEventSequence === undefined) {
      this.error = unavailable ?? 'Die Serverrevision fehlt.'; this.refreshView(); return;
    }
    this.agentBusy = true; this.error = '';
    this.api.acquireAgentRecoveryLease(recovery.runId, run.lastEventSequence).subscribe({
      next: (lease) => {
        this.agentBusy = false;
        if (lease.runId !== recovery.runId || !lease.leaseId || this.agentRecoveryLeaseExpired(lease)) {
          this.error = 'Die Recovery-Lease-Antwort ist unvollständig oder bereits abgelaufen.';
          this.refreshAgentOperationalState(); this.refreshView(); return;
        }
        this.agentRecoveryLeases.set(recovery.runId, lease);
        this.notice = `Recovery-Lease für ${recovery.runId} ist an Operator ${lease.operatorId} gebunden.`;
        this.refreshAgentOperationalState(); this.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.error = this.message(error); this.refreshAgentOperationalState(); this.refreshView(); }
    });
  }
  openAgentRecoveryDialog(recovery: AgentRecoveryRun, decision: AgentRecoveryDecision, returnFocus?: HTMLElement): void {
    const unavailable = this.agentRecoveryActionUnavailableReason(recovery, decision);
    const run = this.agentRecoveryRunView(recovery);
    const lease = this.agentRecoveryLeaseFor(recovery.runId);
    if (unavailable || run?.lastEventSequence === undefined || !lease) {
      this.error = unavailable ?? 'Revision oder Lease fehlt.'; this.refreshView(); return;
    }
    this.agentRecoveryDialog = { runId: recovery.runId, decision, expectedRevision: run.lastEventSequence, leaseId: lease.leaseId };
    this.agentRecoveryConfirmed = false;
    this.agentRecoveryInput = '';
    this.agentRecoveryReturnFocus = returnFocus;
    this.error = '';
    this.refreshView();
    setTimeout(() => this.openNativeDialog(this.agentRecoveryDialogElement, this.agentRecoveryConfirm));
  }
  closeAgentRecoveryDialog(): void {
    const returnFocus = this.agentRecoveryReturnFocus;
    this.closeNativeDialog(this.agentRecoveryDialogElement);
    this.agentRecoveryDialog = undefined;
    this.agentRecoveryConfirmed = false;
    this.agentRecoveryInput = '';
    this.agentRecoveryReturnFocus = undefined;
    this.refreshView();
    this.restoreDialogFocus(returnFocus);
  }
  cancelAgentRecoveryDialog(event: Event): void {
    event.preventDefault();
    this.closeAgentRecoveryDialog();
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
  confirmAgentRecovery(): void {
    const dialog = this.agentRecoveryDialog;
    if (!dialog || !this.agentRecoveryConfirmed) return;
    const recovery = this.agentRecoveryRuns.find((item) => item.runId === dialog.runId);
    const unavailable = this.agentRecoveryActionUnavailableReason(recovery, dialog.decision);
    const run = recovery ? this.agentRecoveryRunView(recovery) : undefined;
    if (unavailable || run?.lastEventSequence !== dialog.expectedRevision) {
      this.error = unavailable ?? 'Der Lauf wurde seit Öffnen des Dialogs verändert. Bitte Diagnose und Revision neu prüfen.';
      this.closeAgentRecoveryDialog(); this.refreshAgentOperationalState(); return;
    }
    this.agentBusy = true; this.error = '';
    this.api.resolveAgentRecovery(dialog.runId, {
      expectedRevision: dialog.expectedRevision, leaseId: dialog.leaseId, decision: dialog.decision,
      ...(dialog.decision === 'resume' && this.agentRecoveryInput.trim() ? { replacementInput: this.agentRecoveryInput } : {})
    }).subscribe({
      next: (result) => {
        this.agentBusy = false;
        this.agentRecoveryLeases.delete(dialog.runId);
        const returned = [result.resolved, ...(result.replacement ? [result.replacement] : [])];
        const returnedIds = new Set(returned.map((item) => item.id));
        this.agentRuns = [...returned, ...this.agentRuns.filter((item) => !returnedIds.has(item.id))];
        if (this.selectedAgentRun?.id === result.resolved.id) this.selectedAgentRun = result.resolved;
        this.closeAgentRecoveryDialog();
        this.notice = dialog.decision === 'resume'
          ? `Recovery abgeschlossen: Ein neuer Prozess und neuer Run ${result.replacement?.id ?? 'wurde angefordert'} ersetzt ${dialog.runId}; der alte Prozess wurde nicht adoptiert.`
          : `Verwaister Run ${dialog.runId} wurde nach expliziter Operatorentscheidung bereinigt.`;
        this.refreshAgentRuns(); this.refreshView();
      },
      error: (error) => {
        this.agentBusy = false; this.error = this.message(error);
        this.closeAgentRecoveryDialog(); this.refreshAgentRuns(); this.refreshView();
      }
    });
  }
  agentEventText(event: AgentRunEvent): string {
    if (event.message) return event.message;
    const data = event.data ?? {};
    const preferred = data['text'] ?? data['output'] ?? data['summary'] ?? data['content'];
    return typeof preferred === 'string' ? preferred : Object.keys(data).length ? JSON.stringify(data, null, 2) : event.type;
  }
  agentEventTypeOptions(): string[] {
    if (this.agentEventTypesCache?.source === this.agentEvents) return this.agentEventTypesCache.types;
    const types = [...new Set(this.agentEvents.map((event) => event.type))].sort((left, right) => left.localeCompare(right));
    this.agentEventTypesCache = { source: this.agentEvents, types };
    return types;
  }
  agentEventCategory(type: string): 'agent' | 'tool' | 'approval' | 'input' | 'usage' | 'lifecycle' | 'diagnostic' {
    if (type.includes('agent_message') || type.includes('assistant_message')) return 'agent';
    if (type.startsWith('tool_') || type.includes('tool')) return 'tool';
    if (type.includes('approval')) return 'approval';
    if (type.includes('input')) return 'input';
    if (type.includes('usage')) return 'usage';
    if (type === 'warning' || type === 'error' || type === 'heartbeat') return 'diagnostic';
    return 'lifecycle';
  }
  agentEventCategoryLabel(type: string): string {
    return ({ agent: 'Agentenaussage', tool: 'Toolstatus', approval: 'Freigabe', input: 'Rückfrage', usage: 'Usage', lifecycle: 'Runstatus', diagnostic: 'Diagnose' } as const)[this.agentEventCategory(type)];
  }
  agentTimelineEntries(): AgentTimelineEntry[] {
    const source = this.agentTimelinePaused ? this.agentPausedEvents : this.agentEvents;
    const query = this.agentEventSearch.trim().toLocaleLowerCase('de');
    if (this.agentTimelineCache?.source === source && this.agentTimelineCache.search === query
      && this.agentTimelineCache.type === this.agentEventTypeFilter && this.agentTimelineCache.level === this.agentEventLevelFilter) return this.agentTimelineCache.entries;
    const filtered = source.filter((event) => {
      const level = event.level ?? 'info';
      if (this.agentEventTypeFilter !== 'all' && event.type !== this.agentEventTypeFilter) return false;
      if (this.agentEventLevelFilter !== 'all' && level !== this.agentEventLevelFilter) return false;
      if (!query) return true;
      return `${event.type}\n${this.agentEventText(event)}\n${JSON.stringify(event.data ?? {})}`.toLocaleLowerCase('de').includes(query);
    });
    const grouped: AgentTimelineEntry[] = [];
    for (const event of filtered) {
      const text = this.agentEventText(event);
      const diagnostic = this.redactAgentText(JSON.stringify({ sequence: event.sequence, type: event.type, timestamp: event.timestamp, correlationId: event.correlationId, level: event.level ?? 'info', data: event.data ?? {}, message: event.message }, null, 2));
      const previous = grouped.at(-1);
      const groupable = event.type.endsWith('_delta') && previous?.type === event.type
        && previous.sequenceEnd + 1 === event.sequence && previous.correlationId === event.correlationId;
      if (groupable && previous) {
        previous.sequenceEnd = event.sequence;
        previous.groupedCount += 1;
        previous.text += text;
        previous.diagnostic += `\n${diagnostic}`;
        continue;
      }
      grouped.push({ key: `${event.sequence}:${event.type}`, sequence: event.sequence, sequenceEnd: event.sequence, timestamp: event.timestamp, type: event.type, level: event.level ?? 'info', text, diagnostic, groupedCount: 1, correlationId: event.correlationId });
    }
    this.agentTimelineCache = { source, search: query, type: this.agentEventTypeFilter, level: this.agentEventLevelFilter, entries: grouped };
    return grouped;
  }
  renderedAgentTimelineEntries(): AgentTimelineEntry[] {
    const entries = this.agentTimelineEntries();
    return entries.slice(Math.max(0, entries.length - this.agentEventRenderLimit));
  }
  hiddenAgentTimelineEntriesCount(): number { return Math.max(0, this.agentTimelineEntries().length - this.agentEventRenderLimit); }
  olderAgentTimelineBatchSize(): number { return Math.min(this.agentEventRenderChunk, this.hiddenAgentTimelineEntriesCount()); }
  agentTimelineDisplayText(entry: AgentTimelineEntry): string { return this.agentTimelineView === 'diagnostic' ? entry.diagnostic : entry.text; }
  loadOlderAgentEvents(): void {
    const list = this.agentTimelineList?.nativeElement;
    const previousHeight = list?.scrollHeight ?? 0;
    this.agentEventRenderLimit += this.agentEventRenderChunk;
    this.refreshView();
    if (list && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { list.scrollTop += Math.max(0, list.scrollHeight - previousHeight); });
  }
  toggleAgentTimelinePause(): void {
    if (this.agentTimelinePaused) {
      this.agentTimelinePaused = false;
      this.agentPausedEvents = [];
      this.agentEventRenderLimit = Math.max(this.agentEventRenderLimit, this.agentEventRenderChunk);
      this.notice = 'Timeline-Darstellung läuft weiter; gepufferte Events wurden vollständig übernommen.';
      this.refreshView();
      this.scheduleAgentAutoScroll();
      return;
    }
    this.agentPausedEvents = [...this.agentEvents];
    this.agentTimelinePaused = true;
    this.notice = 'Nur die Darstellung ist pausiert. Eingehende Events werden weiterhin verlustfrei gepuffert.';
    this.refreshView();
  }
  bufferedAgentEventsCount(): number {
    if (!this.agentTimelinePaused) return 0;
    const frozenSequences = new Set(this.agentPausedEvents.map((event) => event.sequence));
    return this.agentEvents.reduce((total, event) => total + (frozenSequences.has(event.sequence) ? 0 : 1), 0);
  }
  onAgentTimelineScroll(event: Event): void {
    const list = event.currentTarget as HTMLOListElement;
    this.agentTimelineNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
  }
  setAgentAutoScroll(enabled: boolean): void {
    this.agentAutoScroll = enabled;
    if (enabled) { this.agentTimelineNearBottom = true; this.scheduleAgentAutoScroll(); }
  }
  agentReducedMotionActive(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : this.prefersReducedMotion;
  }
  jumpToLatestAgentEvent(): void { this.agentTimelineNearBottom = true; this.scheduleAgentAutoScroll(true); }
  redactAgentText(value: string): string {
    let redacted = value;
    const configuredValues = [
      ...(this.config?.identities ?? []).flatMap((identity) => [identity.fullName, identity.email, identity.phone, identity.location, identity.linkedin, ...Object.values(identity.placeholders)]),
      this.config?.assistant.candidateProfilePath, this.config?.assistant.skillPath, this.config?.assistant.styleProfilePath,
      ...this.agentProviders.flatMap((provider) => (provider.installations ?? []).map((installation) => installation.executable))
    ].filter((item): item is string => Boolean(item?.trim()) && item!.trim().length >= 3).sort((left, right) => right.length - left.length);
    for (const sensitive of configuredValues) redacted = redacted.replace(new RegExp(this.escapeRegExp(sensitive), 'gi'), '[KONFIGURATION REDIGIERT]');
    return redacted
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[E-MAIL REDIGIERT]')
      .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [GEHEIMNIS REDIGIERT]')
      .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[GEHEIMNIS REDIGIERT]')
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n\t"'<>|]+/g, '[PFAD REDIGIERT]')
      .replace(/\/(?:home|Users|root|tmp|mnt\/[a-z])\/[^\s"'<>]+/gi, '[PFAD REDIGIERT]')
      .replace(/\b(?:\+?\d[\d ()/.\-]{6,}\d)\b/g, '[TELEFON REDIGIERT]');
  }
  async copyRedactedAgentText(value: string, label: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) { this.error = 'Die Zwischenablage ist in dieser Laufzeit nicht verfügbar.'; this.refreshView(); return; }
    try {
      await navigator.clipboard.writeText(this.redactAgentText(value));
      this.notice = `${label} wurde ausschließlich in lokal redigierter Form kopiert.`;
      this.error = '';
    } catch { this.error = 'Redigiertes Kopieren wurde vom Browser abgelehnt.'; }
    this.refreshView();
  }
  copyAgentTimelineEntry(entry: AgentTimelineEntry): void {
    void this.copyRedactedAgentText(`${entry.type} #${entry.sequence}${entry.sequenceEnd > entry.sequence ? `–${entry.sequenceEnd}` : ''}\n${this.agentTimelineDisplayText(entry)}`, `Event #${entry.sequence}`);
  }
  copyAgentResult(run: AgentRun): void { void this.copyRedactedAgentText(run.error ?? run.output ?? '', 'Run-Ergebnis'); }
  agentArtifactPromotionAvailable(_run: AgentRun): boolean { return false; }
  agentArtifactPromotionReason(): string {
    return 'Proposal-only: Der vorhandene Agent-Run-API-Vertrag bietet keinen validierten Übergabepfad in Domain-Commands oder Dokumentrevisionen. Nutze dafür die fachliche Bewerbungspipeline mit Evidenzprüfung und Review.';
  }
  private escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  private mergeAgentEvents(events: AgentRunEvent[]): void {
    if (this.agentEventIndex.size !== this.agentEvents.length) for (const event of this.agentEvents) this.agentEventIndex.set(event.sequence, event);
    let lastSequence = this.agentEvents.at(-1)?.sequence ?? -1;
    const appended: AgentRunEvent[] = [];
    let rebuild = false;
    for (const event of events) {
      if (!this.agentEventIndex.has(event.sequence) && event.sequence > lastSequence && !rebuild) {
        this.agentEventIndex.set(event.sequence, event); appended.push(event); lastSequence = event.sequence;
      } else {
        this.agentEventIndex.set(event.sequence, event); rebuild = true;
      }
    }
    if (!events.length) return;
    this.agentEvents = rebuild ? [...this.agentEventIndex.values()].sort((left, right) => left.sequence - right.sequence) : [...this.agentEvents, ...appended];
    this.agentTimelineCache = undefined;
    this.agentEventTypesCache = undefined;
  }
  private scheduleAgentAutoScroll(force = false): void {
    if (!this.agentAutoScroll || this.agentTimelinePaused || (!force && !this.agentTimelineNearBottom)) return;
    const scroll = () => {
      const list = this.agentTimelineList?.nativeElement;
      if (!list) return;
      const behavior: ScrollBehavior = this.agentReducedMotionActive() ? 'auto' : 'smooth';
      if (typeof list.scrollTo === 'function') list.scrollTo({ top: list.scrollHeight, behavior });
      else list.scrollTop = list.scrollHeight;
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll); else scroll();
  }
  formatDuration(milliseconds?: number): string {
    if (milliseconds === undefined) return '—';
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }

  private startAgentPolling(): void {
    this.stopAgentPolling();
    this.agentPollHandle = setInterval(() => {
      if (this.section === 'agents') { this.refreshAgentRuns(); this.refreshAgentOrchestrations(); }
    }, 2500);
  }
  private stopAgentPolling(): void {
    if (this.agentPollHandle) clearInterval(this.agentPollHandle);
    this.agentPollHandle = undefined;
  }
  private startAgentStream(runId: string): void {
    this.stopAgentStream();
    this.agentEventSubscription = this.api.agentRunEventStream(runId, this.agentEventsAfter).subscribe({
      next: (event) => {
        if (this.selectedAgentRun?.id !== runId) return;
        this.mergeAgentEvents([event]);
        this.agentEventsAfter = Math.max(this.agentEventsAfter, event.sequence);
        if (event.type === 'run_completed') { this.stopAgentStream(); this.refreshAgentRuns(); }
        this.refreshView();
        this.scheduleAgentAutoScroll();
      },
      error: () => { this.stopAgentStream(); }
    });
  }
  private stopAgentStream(): void {
    this.agentEventSubscription?.unsubscribe();
    this.agentEventSubscription = undefined;
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
  jobCategoryLabel(category: JobInventoryCategory): string { return { inbox: 'Neu', apply: 'Bewerben', watchlist: 'Merken', archive: 'Archiv' }[category]; }
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
    this.busy = true;
    this.api.createApplicationCase(this.selectedMatch, this.config.activeIdentityId, this.documentType).subscribe({
      next: (application) => {
        this.applicationCases.unshift(application);
        this.selectApplicationCase(application);
        this.applicationArtifacts[application.id] = [];
        this.busy = false; this.notice = 'Bewerbungsfall lokal angelegt und an die Werkstatt gebunden.'; this.refreshView();
      },
      error: (error) => this.fail(error)
    });
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
    this.agentRunForm = {
      providerId: this.agentRunForm.providerId,
      prompt: prompts[workflowId],
      runtimeTarget: this.agentRunForm.runtimeTarget,
      ...(this.agentRunForm.runtimeTarget === 'wsl' && this.agentRunForm.wslDistribution
        ? { wslDistribution: this.agentRunForm.wslDistribution }
        : {}),
      workspaceMode: 'read_only', network: false, applicationCaseId: application.id, workflowId,
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    };
    this.select('agents');
    this.scheduleAgentPreflight();
  }
  openInboxMailAgentOrchestration(message: CorrelatedMail): void {
    const caseId = this.mailCorrelationTarget[message.id];
    const application = this.applicationCases.find((candidate) => candidate.id === caseId);
    if (!application) { this.error = 'Bitte zuerst einen Bewerbungsfall für diese Inbox-Mail wählen.'; return; }
    this.agentOrchestrationForm = {
      workflowId: 'employer-response-triage', providerId: this.agentOrchestrationForm.providerId,
      prompt: `Ordne die explizit gewählte Inbox-Mail sicher dem Bewerbungsfall bei ${application.job.company} zu und liefere ausschließlich Antwort- und Terminvorschläge.`,
      runtimeTarget: this.agentOrchestrationForm.runtimeTarget,
      ...(this.agentOrchestrationForm.runtimeTarget === 'wsl' && this.agentOrchestrationForm.wslDistribution
        ? { wslDistribution: this.agentOrchestrationForm.wslDistribution }
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
      .filter((provider) => this.isRealAgentProvider(provider.providerId))
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
    return this.agentProviders.find((provider) => provider.id === providerId)?.name ?? providerId;
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

  cvFactGroups(): CvFactGroup[] {
    const groups = new Map<string, { facts: CvFact[]; index: number }>();
    for (const [index, fact] of (this.cvImport?.facts ?? []).entries()) {
      const key = `${fact.category}:${fact.recordId}`;
      const current = groups.get(key);
      groups.set(key, { facts: [...(current?.facts ?? []), fact], index: current?.index ?? index });
    }
    const records = [...groups.entries()].map(([key, group]) => {
      const recordId = group.facts[0]?.recordId ?? key;
      const category = group.facts[0]?.category ?? 'additional';
      const role = this.cvGroupFactValue(group.facts, ['role', 'position', 'title', 'job_title']);
      const company = this.cvGroupFactValue(group.facts, ['company', 'employer', 'organization']);
      const period = this.cvGroupFactValue(group.facts, ['period', 'date_range', 'duration'])
        ?? this.cvGroupDateRange(group.facts);
      const generic = this.cvGroupFactValue(group.facts, ['name', 'title', 'degree', 'institution', 'description']);
      const title = category === 'employment'
        ? [role, company].filter(Boolean).join(' · ') || recordId
        : generic || recordId;
      return { recordId, category, facts: group.facts, title, ...(period ? { period } : {}), index: group.index };
    });
    const employment = records.filter((record) => record.category === 'employment').sort((left, right) => {
      const leftEnd = this.cvEmploymentDateRank(left.facts, true);
      const rightEnd = this.cvEmploymentDateRank(right.facts, true);
      if (leftEnd !== rightEnd) return rightEnd - leftEnd;
      const leftStart = this.cvEmploymentDateRank(left.facts, false);
      const rightStart = this.cvEmploymentDateRank(right.facts, false);
      return rightStart - leftStart || left.index - right.index;
    });
    return [...employment, ...records.filter((record) => record.category !== 'employment').sort((left, right) => left.index - right.index)]
      .map(({ index: _index, ...record }) => record);
  }

  cvStructuredFactGroups(): CvFactGroup[] {
    return this.cvFactGroups().filter((group) => !this.cvFactGroupIsRaw(group));
  }

  cvRawFactGroups(): CvFactGroup[] {
    return this.cvFactGroups().filter((group) => this.cvFactGroupIsRaw(group));
  }

  private cvFactGroupIsRaw(group: CvFactGroup): boolean {
    if (group.category === 'additional') return true;
    return group.facts.length > 0 && group.facts.every((fact) => {
      const root = fact.field.toLocaleLowerCase('en-US').split('.')[0]!.replace(/\[[0-9]{1,4}\]$/, '');
      return root === 'other' || root === 'additional';
    });
  }

  private cvGroupFactValue(facts: CvFact[], fields: string[]): string | undefined {
    const allowed = new Set(fields);
    for (const decision of ['confirmed', 'pending'] as const) {
      const match = facts.find((fact) => fact.decision === decision
        && allowed.has(fact.field.toLocaleLowerCase('en-US').split('.').at(-1)!.replace(/\[[0-9]{1,4}\]$/, '')));
      if (match?.value.trim()) return match.value.trim();
    }
    return undefined;
  }

  private cvGroupDateRange(facts: CvFact[]): string | undefined {
    const start = this.cvGroupFactValue(facts, ['start_date', 'start']);
    const end = this.cvGroupFactValue(facts, ['end_date', 'end']);
    return start || end ? `${start ?? '?'} – ${end ?? 'heute'}` : undefined;
  }

  private cvEmploymentDateRank(facts: CvFact[], end: boolean): number {
    const value = end
      ? this.cvGroupFactValue(facts, ['end_date', 'end', 'period', 'date_range', 'duration'])
      : this.cvGroupFactValue(facts, ['start_date', 'start', 'period', 'date_range', 'duration']);
    if (!value) return Number.NEGATIVE_INFINITY;
    if (end && /\b(?:present|current|heute|aktuell|gegenwärtig|laufend|now)\b/i.test(value)) return Number.MAX_SAFE_INTEGER;
    const dates = [...value.matchAll(/\b((?:19|20)\d{2})(?:[-/.](0?[1-9]|1[0-2]))?\b/g)]
      .map((match) => Number(match[1]) * 12 + Number(match[2] ?? (end ? 12 : 1)));
    if (!dates.length) return Number.NEGATIVE_INFINITY;
    return end ? dates.at(-1)! : dates[0]!;
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
    const workflow = this.agentWorkflows.find((item) => item.id === 'evidence-application-package');
    if (!workflow) return;
    const providerId = this.agentOrchestrationForm.providerId || this.agentProviders.find((item) => item.available)?.id || '';
    this.cvError = ''; this.agentOrchestrationError = '';
    this.agentOrchestrationForm = {
      workflowId: workflow.id, providerId,
      prompt: `Erstelle einen belegbasierten ATS-sicheren Lebenslauf für den ausgewählten Bewerbungsfall ${application.id}. Verwende ausschließlich bestätigte CandidateProfile-Claims und die serverseitig gespeicherten Stilvorgaben. Alle Ergebnisse bleiben prüfpflichtige Vorschläge.`,
      runtimeTarget: this.agentOrchestrationForm.runtimeTarget,
      ...(this.agentOrchestrationForm.runtimeTarget === 'wsl' && this.agentOrchestrationForm.wslDistribution
        ? { wslDistribution: this.agentOrchestrationForm.wslDistribution } : {}),
      applicationCaseId: application.id, userInputConfirmed: false
    };
    this.createAgentOrchestration();
  }

  cvAgentStartUnavailableReason(): string {
    const application = this.cvSelectedApplicationCase();
    if (!this.cvImport?.adoption) return 'Bestätige den aktiven Lebenslaufstand und übernimm ihn danach ins Kandidatenprofil.';
    if (!application || application.documentType !== 'cv') return 'Wähle einen Bewerbungsfall vom Typ Lebenslauf.';
    if (!this.agentWorkflows.some((item) => item.id === 'evidence-application-package')) {
      return 'Der versionierte Evidence-Agentenworkflow ist serverseitig nicht verfügbar.';
    }
    const provider = this.agentProviders.find((item) => item.id === this.agentOrchestrationForm.providerId);
    if (!provider?.available) return 'Wähle einen verfügbaren Agentenprovider.';
    if (this.selectedAgentOrchestrationInstallation()?.support !== 'supported') return 'Wähle eine versionsgenau freigegebene Provider-Laufzeit.';
    return '';
  }

  cvAgentOrchestration(): AgentOrchestrationRecord | undefined {
    if (this.cvAgentOrchestrationId) return this.agentOrchestrations.find((item) => item.id === this.cvAgentOrchestrationId)
      ?? (this.selectedAgentOrchestration?.id === this.cvAgentOrchestrationId ? this.selectedAgentOrchestration : undefined);
    return undefined;
  }

  openCvAgentOrchestration(): void {
    const orchestration = this.cvAgentOrchestration();
    this.select('agents');
    if (orchestration) this.selectAgentOrchestration(orchestration, false);
  }

  refreshCvAgentStatus(): void {
    this.refreshAgentOrchestrations();
    this.loadApplicationCases();
  }

  cvAgentStatusBusy(): boolean { return this.agentOrchestrationPollInFlight; }

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
    this.api.reviewCvFacts(current, operations).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvNotice = notice; afterSuccess?.(); this.refreshView();
      },
      error: (error) => this.failCv(error)
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

  formatProposalConfidence(value: number): string { return `${Math.round(value * 100)} %`; }

  private parseEmployerResponseTriageProposal(content: string): EmployerResponseTriageProposalProjection | undefined {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const proposal = parsed['proposal'] as Record<string, unknown> | undefined;
      if (parsed['contract'] !== 'employer-response-triage-proposal' || parsed['contractVersion'] !== '1.0'
        || typeof parsed['sha256'] !== 'string' || !proposal || proposal['schemaVersion'] !== 1
        || typeof proposal['confidence'] !== 'number' || proposal['confidence'] < 0 || proposal['confidence'] > 1
        || typeof proposal['selectedMailId'] !== 'string' || !this.isStringArray(proposal['sourceReferences'])
        || !Array.isArray(proposal['caseCandidates'])) return undefined;
      return parsed as unknown as EmployerResponseTriageProposalProjection;
    } catch { return undefined; }
  }

  private parseApplicationNextActionsProposal(content: string): ApplicationNextActionsProposalProjection | undefined {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const proposal = parsed['proposal'] as Record<string, unknown> | undefined;
      if (parsed['contract'] !== 'application-next-actions-proposal' || parsed['contractVersion'] !== '1.0'
        || typeof parsed['sha256'] !== 'string' || !proposal || proposal['schemaVersion'] !== 1
        || typeof proposal['companyKey'] !== 'string' || !Array.isArray(proposal['suggestions']) || !Array.isArray(proposal['conflicts'])) return undefined;
      return parsed as unknown as ApplicationNextActionsProposalProjection;
    } catch { return undefined; }
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private openNativeDialog(dialogRef?: ElementRef<HTMLDialogElement>, initialFocus?: ElementRef<HTMLElement>): void {
    const dialog = dialogRef?.nativeElement;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    initialFocus?.nativeElement.focus();
  }

  private closeNativeDialog(dialogRef?: ElementRef<HTMLDialogElement>): void {
    const dialog = dialogRef?.nativeElement;
    if (!dialog?.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  private restoreDialogFocus(target?: HTMLElement): void {
    if (!target) return;
    setTimeout(() => {
      if (target.isConnected && !target.hasAttribute('disabled')) target.focus();
    });
  }

  private refreshView(): void { this.changeDetector.markForCheck(); }
  private fail(error: unknown): void { this.busy = false; this.loading = false; this.error = this.message(error); this.refreshView(); }
  private message(error: unknown): string {
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
