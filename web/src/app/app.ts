import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { forkJoin, type Subscription } from 'rxjs';
import type { AgentApproval, AgentArtifactContent, AgentArtifactRecord, AgentConfigProfile, AgentConfigProfileView, AgentOrchestrationConfirmationInput, AgentOrchestrationConflict, AgentOrchestrationConflictStrategy, AgentOrchestrationCreateRequest, AgentOrchestrationGate, AgentOrchestrationRecord, AgentProvider, AgentProviderConfigProfile, AgentProviderInstallation, AgentQueueBlockReason, AgentQueueSnapshot, AgentRecoveryDecision, AgentRecoveryLease, AgentRecoveryRun, AgentRun, AgentRunEvent, AgentRunPreflight, AgentRunRequest, AgentRunStatus, AgentRuntimeTarget, AgentWorkflow, AgentWorkspaceMode, AppConfig, ApplicationCase, ApplicationDraft, ApplicationExportResult, ApplicationNextActionsProposalProjection, ApplicationProfileSetupStatus, ApplicationStyleDocumentType, ApplicationStyleExampleDocumentType, ApplicationStyleProfileView, ArtifactRevision, CandidateMatchAnalysis, CandidateProfileSummary, CompanyCrm, CorrelatedMail, DataInventory, EditableApplicationStyleProfile, EmployerResponseTriageProposalProjection, IdentityProfile, JobDecision, JobMatch, JobSourceCapabilities, LanguageCheckResult, MailAccount, McpRuntimeStatus, ProfileImportPreview, SearchSchedule, Section, SourceCapability, SourceStatus } from './models';

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

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  section: Section = 'overview';
  config?: AppConfig;
  sources: SourceStatus[] = [];
  capabilities?: JobSourceCapabilities;
  mcpRuntime?: McpRuntimeStatus;
  matches: JobMatch[] = [];
  searchFailures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }> = [];
  jobDecisions: JobDecision[] = [];
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
    { id: 'identity', label: 'Profil & Identität', icon: 'user' },
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
    this.stopAgentPolling(); this.stopAgentStream();
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
  }

  select(section: Section): void {
    this.section = section; this.notice = ''; this.error = '';
    if (section !== 'agents') { this.stopAgentPolling(); this.stopAgentStream(); this.closeAgentRecoveryDialog(); }
    if (section === 'identity') { this.loadProfileSetup(); this.loadCandidateProfile(); }
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
        this.agentProviders = providers;
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

  runSearch(): void {
    if (!this.config) return;
    this.busy = true; this.error = ''; this.notice = '';
    this.api.search(this.config.searchProfile).subscribe({
      next: ({ matches, partialFailures }) => {
        this.matches = matches; this.selectedMatch = matches[0]; this.busy = false; this.section = 'search';
        this.searchFailures = partialFailures;
        this.notice = `${matches.length} Stellen bewertet${partialFailures.length ? `; ${partialFailures.length} Quelle(n) mit Teilausfall` : ''}.`;
        this.refreshView();
      },
      error: (error) => this.fail(error)
    });
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
