import type { AgentApproval, AgentArtifactContent, AgentArtifactRecord, AgentConfigProfile, AgentConfigProfileView, AgentOrchestrationConfirmationInput, AgentOrchestrationConflict, AgentOrchestrationConflictStrategy, AgentOrchestrationCreateRequest, AgentOrchestrationGate, AgentOrchestrationRecord, AgentProvider, AgentProviderConfigProfile, AgentProviderInstallation, AgentQueueBlockReason, AgentQueueSnapshot, AgentRecoveryDecision, AgentRecoveryLease, AgentRecoveryRun, AgentRun, AgentRunEvent, AgentRunPreflight, AgentRunRequest, AgentRunStatus, AgentRuntimeTarget, AgentWorkflow, AgentWorkspaceMode, ApplicationCase, ApplicationNextActionsProposalProjection, EmployerResponseTriageProposalProjection, ProviderModelCatalog, ProviderCredentialSummary, AgentWslDistribution, AgentWslDistributionsView, VersionApproval, VersionApprovalSnapshot } from './models';
import { ElementRef, Injectable, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { forkJoin, type Subscription } from 'rxjs';
import { ApiService } from './api.service';
import type { App } from './app';

export type AgentEventLevelFilter = 'all' | 'debug' | 'info' | 'warning' | 'error';
export type AgentTimelineView = 'readable' | 'diagnostic';

export interface AgentTimelineEntry {
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

export interface AgentApprovalInboxItem {
  run: AgentRun;
  approval: AgentApproval;
  actionable: boolean;
  reason?: string;
}

export interface AgentRunComparisonSection {
  id: 'lineage' | 'versions' | 'policy' | 'context' | 'usage' | 'result';
  label: string;
  rows: Array<{ label: string; parent: string; current: string; changed: boolean }>;
}

export interface AgentRecoveryDialogState {
  runId: string;
  decision: AgentRecoveryDecision;
  expectedRevision: number;
  leaseId: string;
}/**
 * Zustand und Logik des Agent Centers.
 *
 * Lebt als Root-Service, damit Formulare, laufende Runs und das Polling einen Wechsel des
 * Arbeitsbereichs überstehen. Lebenslauf und Bewerbung nutzen denselben Zustand für
 * Orchestrierungen. Rückmeldungen (Hinweise, Fehler, Neuzeichnen) laufen über die App (`host`).
 */
@Injectable({ providedIn: 'root' })
export class AgentCenterStore {
  readonly api = inject(ApiService);
  readonly sanitizer = inject(DomSanitizer);
  host!: App;
  /** Wird bei jeder Zustandsänderung erhöht; die Agent-Center-Ansicht liest es und zeichnet dann neu. */
  readonly revision = signal(0);

  attach(host: App): void { this.host = host; }

  agentProviders: AgentProvider[] = [];

  agentConfigProfile?: AgentConfigProfileView;

  agentConfigProfileDraft?: AgentConfigProfile;

  agentConfigProfileConfirmed = false;

  agentCodexAppServerOptInConfirmed = false;

  agentConfigCostAmount = '';

  agentConfigCostCurrency = 'EUR';

  agentConfigProfileBusy = false;

  agentConfigProfileError = '';

  agentVersionApprovals: VersionApprovalSnapshot = { schemaVersion: 1, updatedAt: null, approvals: [] };

  agentProviderCredentials: ProviderCredentialSummary[] = [];

  agentWslDistributions?: AgentWslDistributionsView;

  agentRunInstallationKey = '';

  agentOrchestrationInstallationKey = '';

  agentProviderSetupBusy = false;

  agentProviderSetupError = '';

  agentCredentialDraft: { providerId: string; envKey: string; envSecret: string; endpointUrl: string; confirmed: boolean } =
    { providerId: '', envKey: 'OPENAI_API_KEY', envSecret: '', endpointUrl: '', confirmed: false };

  readonly credentialKeyPresets = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'TOGETHER_API_KEY'
  ];

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

  agentPollHandle?: ReturnType<typeof setInterval>;

  agentPollInFlight = false;

  agentOrchestrationPollInFlight = false;

  agentOperationsPollInFlight = false;

  agentEventSubscription?: Subscription;

  agentPreflightTimer?: ReturnType<typeof setTimeout>;

  agentPreflightRevision = 0;

  agentPreflightFingerprint?: string;

  readonly agentRecoveryLeases = new Map<string, AgentRecoveryLease>();

  readonly agentEventIndex = new Map<number, AgentRunEvent>();

  readonly agentOrchestrationResultUrls = new Map<string, SafeResourceUrl>();

  agentTimelineCache?: { source: AgentRunEvent[]; search: string; type: string; level: AgentEventLevelFilter; entries: AgentTimelineEntry[] };

  agentEventTypesCache?: { source: AgentRunEvent[]; types: string[] };

  agentMotionMedia?: MediaQueryList;

  agentRecoveryReturnFocus?: HTMLElement;

  readonly agentMotionListener = (event: MediaQueryListEvent): void => {
    this.prefersReducedMotion = event.matches;
    if (event.matches) this.agentAutoScroll = false;
    this.host.refreshView();
  };

  agentTimelineList?: ElementRef<HTMLOListElement>;

  agentRecoveryDialogElement?: ElementRef<HTMLDialogElement>;

  agentRecoveryConfirm?: ElementRef<HTMLInputElement>;

  configureAgentMotionPreference(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.agentMotionMedia?.removeEventListener?.('change', this.agentMotionListener);
    this.agentMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.prefersReducedMotion = this.agentMotionMedia.matches;
    if (this.prefersReducedMotion) this.agentAutoScroll = false;
    this.agentMotionMedia.addEventListener?.('change', this.agentMotionListener);
  }

  loadAgentCenter(): void {
    this.loadAgentConfigProfile();
    this.loadAgentProviders();
    this.loadAgentProviderSetup();
    this.loadAgentWslDistributions();
    this.api.applicationCases().subscribe({ next: (items) => { this.host.applicationCases = items; this.host.refreshView(); } });
    this.api.agentWorkflows().subscribe({ next: (items) => { this.agentWorkflows = items; this.host.refreshView(); } });
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
        this.host.refreshView();
      },
      error: (error) => {
        this.agentConfigProfileBusy = false;
        this.agentConfigProfileConfirmed = false;
        this.agentCodexAppServerOptInConfirmed = false;
        this.agentConfigProfileError = this.host.message(error);
        this.host.refreshView();
      }
    });
  }

  loadAgentWslDistributions(): void {
    this.api.agentWslDistributions().subscribe({
      next: (view) => { this.agentWslDistributions = view; this.host.refreshView(); },
      error: () => { this.agentWslDistributions = undefined; this.host.refreshView(); }
    });
  }

  agentWslDistributionLabel(distribution: AgentWslDistribution): string {
    const stats = distribution.installations
      ? ` · ${distribution.installations} Installation(en), ${distribution.supported} unterstützt`
      : ' · keine Agenten-Installation gefunden';
    return `${distribution.name}${distribution.enumerated ? '' : ' (aus Discovery)'}${stats}`;
  }

  loadAgentProviderSetup(): void {
    this.agentProviderSetupError = '';
    this.api.versionApprovals().subscribe({
      next: (snapshot) => { this.agentVersionApprovals = snapshot; this.host.refreshView(); },
      error: (error) => { this.agentProviderSetupError = this.host.message(error); this.host.refreshView(); }
    });
    this.api.providerCredentials().subscribe({
      next: (items) => { this.agentProviderCredentials = items; this.host.refreshView(); },
      error: (error) => { this.agentProviderSetupError = this.host.message(error); this.host.refreshView(); }
    });
  }

  versionApprovalKey(providerId: string, installation: AgentProviderInstallation): Omit<VersionApproval, 'approvedAt'> | undefined {
    if (!providerId || !installation.executable || !installation.version) return undefined;
    const key: Omit<VersionApproval, 'approvedAt'> = {
      provider: providerId, executable: installation.executable,
      runtimeTarget: installation.runtimeTarget, version: installation.version
    };
    if (installation.distribution) key.distribution = installation.distribution;
    return key;
  }

  approvalMatchesKey(approval: VersionApproval, key: Omit<VersionApproval, 'approvedAt'>): boolean {
    return approval.provider === key.provider && approval.executable === key.executable &&
      approval.runtimeTarget === key.runtimeTarget && approval.version === key.version &&
      (approval.distribution ?? '') === (key.distribution ?? '');
  }

  agentProviderSetupRows(): Array<{ key: string; providerId: string; installation: AgentProviderInstallation; approvalKey?: Omit<VersionApproval, 'approvedAt'>; approval?: VersionApproval }> {
    const rows: Array<{ key: string; providerId: string; installation: AgentProviderInstallation; approvalKey?: Omit<VersionApproval, 'approvedAt'>; approval?: VersionApproval }> = [];
    for (const provider of this.agentProviders) {
      for (const installation of provider.installations ?? []) {
        const approvalKey = this.versionApprovalKey(provider.id, installation);
        if (!approvalKey) continue;
        rows.push({
          key: `${provider.id}:${installation.runtimeTarget}:${installation.distribution ?? ''}:${installation.version ?? ''}:${installation.executable ?? ''}`,
          providerId: provider.id, installation, approvalKey,
          approval: this.agentVersionApprovals.approvals.find((item) => this.approvalMatchesKey(item, approvalKey))
        });
      }
    }
    return rows;
  }

  orphanedVersionApprovals(): VersionApproval[] {
    const keys = this.agentProviderSetupRows().map((row) => row.approvalKey).filter((key): key is Omit<VersionApproval, 'approvedAt'> => Boolean(key));
    return this.agentVersionApprovals.approvals.filter((approval) => !keys.some((key) => this.approvalMatchesKey(approval, key)));
  }

  approveProviderInstallation(providerId: string, installation: AgentProviderInstallation): void {
    const key = this.versionApprovalKey(providerId, installation);
    if (!key || this.agentProviderSetupBusy) return;
    this.agentProviderSetupBusy = true;
    this.agentProviderSetupError = '';
    this.api.saveVersionApproval(this.agentVersionApprovals.updatedAt, key).subscribe({
      next: (snapshot) => {
        this.agentVersionApprovals = snapshot;
        this.agentProviderSetupBusy = false;
        this.loadAgentProviders(true);
        this.host.refreshView();
      },
      error: (error) => { this.agentProviderSetupBusy = false; this.agentProviderSetupError = this.host.message(error); this.host.refreshView(); }
    });
  }

  revokeProviderInstallation(approval: VersionApproval): void {
    if (this.agentProviderSetupBusy) return;
    const key: Omit<VersionApproval, 'approvedAt'> = {
      provider: approval.provider, executable: approval.executable,
      runtimeTarget: approval.runtimeTarget, version: approval.version
    };
    if (approval.distribution) key.distribution = approval.distribution;
    this.agentProviderSetupBusy = true;
    this.agentProviderSetupError = '';
    this.api.revokeVersionApproval(this.agentVersionApprovals.updatedAt, key).subscribe({
      next: (snapshot) => {
        this.agentVersionApprovals = snapshot;
        this.agentProviderSetupBusy = false;
        this.loadAgentProviders(true);
        this.host.refreshView();
      },
      error: (error) => { this.agentProviderSetupBusy = false; this.agentProviderSetupError = this.host.message(error); this.host.refreshView(); }
    });
  }

  selectCredentialProvider(providerId: string): void {
    this.agentCredentialDraft = {
      providerId, envKey: providerId === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY',
      envSecret: '', endpointUrl: '', confirmed: false
    };
  }

  /** OpenRouter endpoint is optional; empty means the official default. */
  openRouterEndpointFromDraft(): string {
    return this.agentCredentialDraft.endpointUrl.trim();
  }

  credentialSaveUnavailableReason(): string {
    if (!this.agentCredentialDraft.providerId) return 'Wähle einen Provider für den API-Key.';
    if (this.agentCredentialDraft.providerId === 'openrouter' && this.agentCredentialDraft.envKey !== 'OPENROUTER_API_KEY') return 'Für OpenRouter ist der Schlüsselname OPENROUTER_API_KEY erforderlich.';
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(this.agentCredentialDraft.envKey)) {
      return 'Der Schlüsselname erlaubt nur Großbuchstaben, Ziffern und Unterstriche, zum Beispiel OPENAI_API_KEY.';
    }
    if (!this.agentCredentialDraft.envSecret) return 'Gib den Wert des API-Keys ein.';
    if (this.agentCredentialDraft.providerId === 'openrouter') {
      const endpoint = this.openRouterEndpointFromDraft();
      if (endpoint && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9./_-]*$/.test(endpoint)) {
        return 'Die OpenRouter-URL muss mit https:// beginnen und darf keine Leerzeichen oder Parameter enthalten.';
      }
    }
    if (!this.agentCredentialDraft.confirmed) return 'Die Speicherung des Schlüssels muss bestätigt werden.';
    return '';
  }

  saveProviderCredentials(): void {
    const reason = this.credentialSaveUnavailableReason();
    if (reason) { this.agentProviderSetupError = reason; this.host.refreshView(); return; }
    if (this.agentProviderSetupBusy) return;
    const { providerId, envKey, envSecret } = this.agentCredentialDraft;
    const endpoint = providerId === 'openrouter' ? this.openRouterEndpointFromDraft() : '';
    const env: Record<string, string> = { [envKey]: envSecret };
    if (endpoint) env['OPENROUTER_ENDPOINT'] = endpoint;
    this.agentProviderSetupBusy = true;
    this.agentProviderSetupError = '';
    this.api.saveProviderCredentials(providerId, env).subscribe({
      next: (summary) => {
        this.agentProviderCredentials = [
          ...this.agentProviderCredentials.filter((item) => item.providerId !== providerId), summary
        ].sort((left, right) => left.providerId.localeCompare(right.providerId));
        this.agentCredentialDraft = { ...this.agentCredentialDraft, envSecret: '', confirmed: false };
        this.agentProviderSetupBusy = false;
        this.loadAgentProviders(true);
        this.host.refreshView();
      },
      error: (error) => { this.agentProviderSetupBusy = false; this.agentProviderSetupError = this.host.message(error); this.host.refreshView(); }
    });
  }

  deleteProviderCredentials(providerId: string): void {
    if (this.agentProviderSetupBusy) return;
    this.agentProviderSetupBusy = true;
    this.agentProviderSetupError = '';
    this.api.deleteProviderCredentials(providerId).subscribe({
      next: () => {
        this.agentProviderCredentials = this.agentProviderCredentials.filter((item) => item.providerId !== providerId);
        this.agentProviderSetupBusy = false;
        this.loadAgentProviders(true);
        this.host.refreshView();
      },
      error: (error) => { this.agentProviderSetupBusy = false; this.agentProviderSetupError = this.host.message(error); this.host.refreshView(); }
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
      next: (catalog) => { this.agentModelCatalogs[key] = catalog; this.agentModelCatalogBusy[key] = false; this.host.refreshView(); },
      error: (error) => { this.agentModelCatalogBusy[key] = false; this.agentModelCatalogError[key] = this.host.message(error); this.host.refreshView(); }
    });
  }

  readonly careerRoleOptions = [
    {id: 'evidence' as const, label: 'Fakten prüfen'}, {id: 'author' as const, label: 'Dokument schreiben'},
    {id: 'ats' as const, label: 'ATS prüfen'}, {id: 'style' as const, label: 'Sprache prüfen'},
    {id: 'finalizer' as const, label: 'Dokument fertigstellen'},
  ];

  setCareerRoleSetting(provider: AgentProviderConfigProfile, role: 'evidence' | 'author' | 'ats' | 'style' | 'finalizer', key: 'model' | 'reasoning', value: string): void {
    provider.roleSettings ??= {};
    const setting = provider.roleSettings[role] ??= {};
    if (key === 'model') setting.model = value.trim() || undefined;
    else setting.reasoning = (value || undefined) as typeof setting.reasoning;
    this.invalidateAgentConfigConfirmation();
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
        this.host.notice = `Agenten-Sicherheitsprofil ${view.profile.profileId} wurde per CAS gespeichert. Provider und Preflight werden neu geprüft.`;
        this.loadAgentProviders(true);
        this.host.refreshView();
      },
      error: (error) => {
        this.agentConfigProfileBusy = false;
        this.agentConfigProfileConfirmed = false;
        this.agentCodexAppServerOptInConfirmed = false;
        this.agentConfigProfileError = this.host.message(error);
        this.host.refreshView();
      }
    });
  }

  agentConfigRuntimeLabel(provider: AgentProviderConfigProfile): string {
    return `${provider.runtimeTarget}${provider.wslDistribution ? ` · ${provider.wslDistribution}` : ''}`;
  }

  applyAgentConfigProfile(view: AgentConfigProfileView): void {
    this.agentConfigProfile = view;
    this.agentConfigProfileDraft = structuredClone(view.profile);
    this.agentConfigCostAmount = view.profile.budgets.maxCostMicros
      ? this.formatAgentConfigCost(view.profile.budgets.maxCostMicros.amountMicros)
      : '';
    this.agentConfigCostCurrency = view.profile.budgets.maxCostMicros?.currency ?? 'EUR';
    this.agentConfigProfileConfirmed = false;
    this.agentCodexAppServerOptInConfirmed = false;
    this.agentConfigProfileError = '';
    this.ensureAgentRuntimeSelection();
    this.ensureAgentOrchestrationRuntimeSelection();
  }

  parseAgentConfigCostMicros(): number | undefined {
    const normalized = this.agentConfigCostAmount.trim().replace(',', '.');
    if (!normalized) return undefined;
    const match = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,6}))?$/.exec(normalized);
    if (!match) return Number.NaN;
    const whole = BigInt(match[1]);
    const fraction = BigInt((match[2] ?? '').padEnd(6, '0') || '0');
    const amountMicros = whole * 1_000_000n + fraction;
    return amountMicros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amountMicros) : Number.NaN;
  }

  formatAgentConfigCost(amountMicros: number): string {
    const whole = Math.trunc(amountMicros / 1_000_000);
    const fraction = String(amountMicros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole},${fraction}` : String(whole);
  }

  agentConfigProfileForSave(draft: AgentConfigProfile): AgentConfigProfile {
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
        if (!this.agentCredentialDraft.providerId) this.selectCredentialProvider(this.agentProviders[0]?.id ?? '');
        this.ensureAgentRuntimeSelection();
        this.ensureAgentOrchestrationRuntimeSelection();
        this.agentBusy = false; this.refreshAgentPreflight(); this.host.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
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
        this.host.refreshView();
      },
      error: (error) => { this.agentPollInFlight = false; this.host.error = this.host.message(error); this.host.refreshView(); }
    });
  }

  refreshAgentOrchestrations(): void {
    if (this.agentOrchestrationPollInFlight) return;
    this.agentOrchestrationPollInFlight = true;
    this.api.agentOrchestrations().subscribe({
      next: ({ orchestrations }) => {
        this.agentOrchestrations = [...orchestrations].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        if (this.host.section === 'cv' && this.host.cvSelectedApplicationCaseId) {
          const latestCvRun = this.agentOrchestrations.find((item) => item.workflowId === 'evidence-application-package'
            && item.scope.applicationCaseId === this.host.cvSelectedApplicationCaseId);
          if (latestCvRun) this.host.cvAgentOrchestrationId = latestCvRun.id;
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
        this.agentOrchestrationPollInFlight = false; this.host.refreshView();
      },
      error: (error) => {
        this.agentOrchestrationPollInFlight = false; this.agentOrchestrationError = this.host.message(error); this.host.refreshView();
      }
    });
  }

  selectAgentOrchestration(orchestration: AgentOrchestrationRecord, refresh = true): void {
    const apply = (current: AgentOrchestrationRecord) => {
      this.selectedAgentOrchestration = current;
      this.agentOrchestrationUserInputConfirmed = false;
      this.agentOrchestrationCancelConfirmed = false;
      this.resetAgentOrchestrationConflictInputs();
      if (current.scope.applicationCaseId) this.host.loadApplicationArtifacts(current.scope.applicationCaseId);
      this.host.refreshView();
    };
    if (!refresh) { apply(orchestration); return; }
    this.api.agentOrchestration(orchestration.id).subscribe({ next: apply, error: (error) => { this.agentOrchestrationError = this.host.message(error); this.host.refreshView(); } });
  }

  agentOrchestrationProvider(): AgentProvider | undefined {
    return this.agentProviders.find((item) => item.id === this.agentOrchestrationForm.providerId);
  }

  agentOrchestrationInstallations(): AgentProviderInstallation[] { return this.agentProviderInstallations(this.agentOrchestrationProvider()); }

  selectedAgentOrchestrationInstallation(): AgentProviderInstallation | undefined {
    const installations = this.agentOrchestrationInstallations();
    const keyed = this.agentOrchestrationInstallationKey
      ? installations.find((item) => this.agentInstallationKey(item) === this.agentOrchestrationInstallationKey) : undefined;
    if (keyed) return keyed;
    return installations.find((item) => item.runtimeTarget === this.agentOrchestrationForm.runtimeTarget
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
    if (caseId) this.host.loadApplicationArtifacts(caseId);
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
    const profileBlock = this.agentProfileInstallationBlockedReason(form.providerId, installation);
    if (profileBlock) { this.agentOrchestrationError = profileBlock; return; }
    if (prompt.length < 3) { this.agentOrchestrationError = 'Bitte einen konkreten Orchestrierungsauftrag eingeben.'; return; }
    if (workflow.requiredScope !== 'search_profile' && !form.applicationCaseId) { this.agentOrchestrationError = 'Dieser Workflow benötigt einen expliziten Bewerbungsfall.'; return; }
    if (workflow.id === 'employer-response-triage' && !form.mailId) {
      this.agentOrchestrationError = 'Employer-Triage benötigt eine explizit gewählte Inbox-Mail. Öffne sie über die CRM-Aktion; Mailinhalt wird nicht in das Browserformular kopiert.';
      return;
    }
    const boundCase = this.host.applicationCases.find((item) => item.id === form.applicationCaseId);
    const request: AgentOrchestrationCreateRequest = {
      workflowId: workflow.id, providerId: form.providerId, prompt, runtimeTarget: installation.runtimeTarget,
      ...(boundCase?.documentType === 'cover_letter' ? { clarifications: true } : {}),
      ...(installation.runtimeTarget === 'wsl' && installation.distribution ? { wslDistribution: installation.distribution } : {}),
      ...(installation.version && installation.executable ? { installation: { version: installation.version, executable: installation.executable } } : {}),
      ...(form.applicationCaseId ? { applicationCaseId: form.applicationCaseId } : {}),
      ...(form.mailId ? { mailId: form.mailId } : {})
    };
    this.agentOrchestrationBusy = true; this.agentOrchestrationError = '';
    this.api.createAgentOrchestration(request).subscribe({
      next: (created) => {
        this.agentOrchestrationBusy = false;
        this.agentOrchestrations = [created, ...this.agentOrchestrations.filter((item) => item.id !== created.id)];
        this.selectAgentOrchestration(created, false);
        if (this.host.section === 'cv' && created.workflowId === 'evidence-application-package'
          && created.scope.applicationCaseId === this.host.cvSelectedApplicationCaseId) this.host.cvAgentOrchestrationId = created.id;
        if (this.host.section === 'applications' && created.workflowId === 'evidence-application-package'
          && created.scope.applicationCaseId === this.host.selectedApplicationCaseId) this.host.applicationAgentOrchestrationId = created.id;
        this.agentOrchestrationForm.prompt = '';
        this.agentOrchestrationForm.userInputConfirmed = false;
        this.host.notice = created.workflowId === 'evidence-application-package'
          ? `Alle fünf Agenten laufen automatisch. Die finale HTML-Seite erscheint hier, sobald der Finalizer fertig ist.`
          : `Multi-Agent-Workflow ${created.id} wurde serverseitig angenommen.`;
        this.host.refreshView();
      },
      error: (error) => { this.agentOrchestrationBusy = false; this.agentOrchestrationError = this.host.message(error); this.host.refreshView(); }
    });
  }

  agentOrchestrationHasGate(gate: AgentOrchestrationGate): boolean {
    return this.selectedAgentOrchestration?.unresolvedGates.some((item) => item.gate === gate) ?? false;
  }

  agentOrchestrationResultArtifact(
    orchestration: AgentOrchestrationRecord
  ): AgentOrchestrationRecord['artifactRefs'][number] | undefined {
    if (orchestration.workflowId !== 'evidence-application-package' || orchestration.status !== 'succeeded') return undefined;
    const packages = orchestration.artifactRefs.filter((artifact) => ['final_html', 'package_proposal'].includes(artifact.outputRef));
    if (packages.length !== 1) return undefined;
    const result = packages[0];
    const finalizer = orchestration.nodes.find((node) => node.nodeId === 'finalizer' && node.role === 'finalizer');
    if (finalizer?.status !== 'succeeded' || !finalizer.artifacts.some((artifact) =>
      artifact.outputRef === result.outputRef && artifact.artifactId === result.artifactId
      && artifact.runId === result.runId && artifact.sha256 === result.sha256)) return undefined;
    return result;
  }

  agentOrchestrationResultUrl(orchestration: AgentOrchestrationRecord): SafeResourceUrl | undefined {
    const artifact = this.agentOrchestrationResultArtifact(orchestration);
    if (!artifact
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orchestration.id)
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return undefined;
    const cacheKey = `${orchestration.id}:${artifact.sha256}`;
    const cached = this.agentOrchestrationResultUrls.get(cacheKey);
    if (cached) return cached;
    const route = this.api.agentOrchestrationResultHtmlUrl(orchestration.id, artifact.sha256);
    if (!/^\/api\/agent-orchestrations\/[0-9a-f-]{36}\/result\.html\?sha256=[a-f0-9]{64}$/i.test(route)) return undefined;
    const trusted = this.sanitizer.bypassSecurityTrustResourceUrl(route);
    this.agentOrchestrationResultUrls.set(cacheKey, trusted);
    return trusted;
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
        this.host.notice = 'Der Fan-in-Konflikt wurde revisions- und variantengebunden aufgelöst. Die Finalizer-Ausgabe bleibt ein Vorschlag.';
        this.host.refreshView();
      },
      error: (error) => {
        this.agentOrchestrationBusy = false;
        if (typeof error === 'object' && error && 'status' in error && (error as { status?: number }).status === 409) {
          this.agentOrchestrationConflictConfirmed = {};
          this.agentOrchestrationUserInputConfirmed = false;
          this.agentOrchestrationCancelConfirmed = false;
        } else this.agentOrchestrationConflictConfirmed[key] = false;
        this.agentOrchestrationError = this.host.message(error);
        this.host.refreshView();
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
        this.host.notice = 'Nur die offenen Orchestrierungsrollen wurden fortgesetzt; erfolgreiche Rollen werden nicht erneut ausgeführt.'; this.host.refreshView();
      },
      error: (error) => { this.agentOrchestrationBusy = false; this.agentOrchestrationError = this.host.message(error); this.host.refreshView(); }
    });
  }

  cancelAgentOrchestration(): void {
    const orchestration = this.selectedAgentOrchestration; if (!orchestration) return;
    if (!this.agentOrchestrationCancelConfirmed) { this.agentOrchestrationError = 'Der Abbruch muss für die aktuelle Orchestrierungsrevision bestätigt werden.'; return; }
    this.agentOrchestrationBusy = true; this.agentOrchestrationError = '';
    this.api.cancelAgentOrchestration(orchestration.id, orchestration.revision).subscribe({
      next: (updated) => {
        this.agentOrchestrationBusy = false; this.upsertAgentOrchestration(updated); this.selectAgentOrchestration(updated, false);
        this.host.notice = 'Orchestrierungsabbruch wurde revisionsgebunden angefordert.'; this.host.refreshView();
      },
      error: (error) => { this.agentOrchestrationBusy = false; this.agentOrchestrationError = this.host.message(error); this.host.refreshView(); }
    });
  }

  agentOrchestrationFailureLabel(run: AgentOrchestrationRecord): string {
    const reasons = [run.failureReason, ...run.nodes.map(node => node.reason)];
    const legacyBudgetError = run.nodes.some(node => node.status === 'failed'
      && this.agentRuns.some(agent => node.runIds.includes(agent.id) && agent.error === 'Das Modell hat das Antwortbudget ausgeschöpft.'));
    if (reasons.includes('openrouter_output_truncated') || legacyBudgetError) return 'Das Antwortbudget eines Agenten wurde ausgeschöpft. Reasoning und fertiges Dokument teilen sich dieses Limit. Die erfolgreichen Vorstufen können bei einer gezielten Wiederholung erhalten bleiben.';
    if (reasons.includes('budget_exceeded:tokens')) return 'Das Tokenbudget des Laufs wurde überschritten. Es liegt kein fertiges Dokument vor.';
    return run.failureReason || 'Ohne neuen Lauf entsteht kein Ergebnis.';
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
        this.host.notice = 'Zugehöriger Node-Run geöffnet. Review und Adoption bleiben an dessen Artefaktrevision gebunden.';
      },
      error: (error) => { this.agentOrchestrationError = this.host.message(error); this.host.refreshView(); }
    });
  }

  upsertAgentOrchestration(updated: AgentOrchestrationRecord): void {
    this.agentOrchestrations = [updated, ...this.agentOrchestrations.filter((item) => item.id !== updated.id)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  agentOrchestrationConflictFingerprint(orchestration: AgentOrchestrationRecord): string {
    return JSON.stringify((orchestration.conflicts ?? []).map((conflict) => [
      conflict.id, conflict.status, conflict.variantsSha256, conflict.resolution?.resolvedAgainstRevision
    ]));
  }

  resetAgentOrchestrationConflictInputs(): void {
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
        this.host.refreshView();
      },
      error: (error) => {
        this.agentOperationsPollInFlight = false;
        this.agentOperationalError = this.host.message(error);
        this.host.refreshView();
      }
    });
  }

  buildAgentRunRequest(): AgentRunRequest | undefined {
    const provider = this.selectedAgentProvider();
    const installation = this.selectedAgentInstallation();
    if (!provider || !installation) return undefined;
    return {
      providerId: provider.id,
      prompt: this.agentRunForm.prompt.trim(),
      runtimeTarget: installation.runtimeTarget,
      ...(installation.runtimeTarget === 'wsl' && installation.distribution ? { wslDistribution: installation.distribution } : {}),
      ...(installation.version && installation.executable ? { installation: { version: installation.version, executable: installation.executable } } : {}),
      workspaceMode: this.agentRunForm.workspaceMode,
      network: Boolean(this.agentRunForm.network),
      budget: { ...this.agentRunForm.budget },
      ...(this.agentRunForm.workflowId ? { workflowId: this.agentRunForm.workflowId } : {}),
      ...(this.agentRunForm.applicationCaseId ? { applicationCaseId: this.agentRunForm.applicationCaseId } : {}),
      ...(this.agentRunForm.parentRunId ? { parentRunId: this.agentRunForm.parentRunId } : {})
    };
  }

  agentRunRequestFingerprint(request: AgentRunRequest): string { return JSON.stringify(request); }

  scheduleAgentPreflight(delayMs = 180): void {
    if (this.agentPreflightTimer) clearTimeout(this.agentPreflightTimer);
    this.agentPreflightRevision += 1;
    this.agentPreflight = undefined;
    this.agentPreflightFingerprint = undefined;
    this.agentPreflightError = '';
    const request = this.buildAgentRunRequest();
    if (!request || request.prompt.length < 3) { this.agentPreflightLoading = false; this.host.refreshView(); return; }
    this.agentPreflightLoading = true;
    this.agentPreflightTimer = setTimeout(() => { this.agentPreflightTimer = undefined; this.refreshAgentPreflight(); }, delayMs);
    this.host.refreshView();
  }

  refreshAgentPreflight(): void {
    if (this.agentPreflightTimer) { clearTimeout(this.agentPreflightTimer); this.agentPreflightTimer = undefined; }
    const request = this.buildAgentRunRequest();
    if (!request || request.prompt.length < 3) {
      this.agentPreflight = undefined; this.agentPreflightFingerprint = undefined;
      this.agentPreflightLoading = false; this.agentPreflightError = ''; this.host.refreshView(); return;
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
        this.host.refreshView();
      },
      error: (error) => {
        if (revision !== this.agentPreflightRevision) return;
        this.agentPreflight = undefined; this.agentPreflightFingerprint = undefined;
        this.agentPreflightLoading = false; this.agentPreflightError = this.host.message(error); this.host.refreshView();
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
    if (!provider?.available) { this.host.error = 'Bitte einen verfügbaren Agenten wählen.'; return; }
    if (!installation || installation.support !== 'supported') { this.host.error = 'Bitte eine unterstützte Provider-Installation und Laufzeit wählen.'; return; }
    const profileBlock = this.agentProfileInstallationBlockedReason(this.agentRunForm.providerId, installation);
    if (profileBlock) { this.host.error = profileBlock; return; }
    if (prompt.length < 3) { this.host.error = 'Bitte eine konkrete Aufgabe mit mindestens drei Zeichen beschreiben.'; return; }
    const request = this.buildAgentRunRequest();
    if (!request || !this.agentPreflightMatchesCurrentDraft()) {
      this.host.error = 'Die serverseitige Startprüfung fehlt oder ist für diesen Entwurf veraltet.';
      this.refreshAgentPreflight(); return;
    }
    if (!this.agentPreflight?.ready) {
      this.host.error = this.agentPreflight?.blockers.map((item) => item.message).join(' ') || 'Die serverseitige Startprüfung blockiert diesen Run.';
      this.host.refreshView(); return;
    }
    this.agentBusy = true; this.host.error = '';
    this.api.createAgentRun(request).subscribe({
      next: (run) => {
        this.agentBusy = false;
        this.agentRuns = [run, ...this.agentRuns.filter((item) => item.id !== run.id)];
        this.agentRunForm.prompt = '';
        this.agentRunForm.parentRunId = undefined;
        this.agentRunForm.network = false;
        this.scheduleAgentPreflight();
        this.host.notice = `Run ${run.id} wurde sicher eingereiht.`;
        this.selectAgentRun(run);
        this.host.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
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
    if (!runId || this.host.section !== 'agents') return;
    this.api.agentRun(runId).subscribe({
      next: (run) => {
        if (this.selectedAgentRun?.id !== run.id) return;
        this.selectedAgentRun = run;
        this.agentRuns = this.agentRuns.map((item) => item.id === run.id ? run : item);
        this.refreshAgentEvents(run.id);
        this.host.refreshView();
      },
      error: (error) => { this.host.error = this.host.message(error); this.host.refreshView(); }
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
        this.host.refreshView();
        this.scheduleAgentAutoScroll();
      },
      error: (error) => { this.host.error = this.host.message(error); this.host.refreshView(); }
    });
  }

  loadAgentArtifacts(runId = this.selectedAgentRun?.id): void {
    if (!runId) return;
    this.api.agentArtifacts(runId).subscribe({
      next: ({ artifacts }) => {
        if (this.selectedAgentRun?.id !== runId) return;
        this.agentArtifacts = artifacts;
        this.host.refreshView();
      },
      error: (error) => { this.host.error = this.host.message(error); this.host.refreshView(); }
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
        this.host.refreshView();
      },
      error: (error) => this.host.fail(error)
    });
  }

  closeAgentArtifactContent(): void {
    this.agentArtifactContent = undefined;
    this.employerResponseTriageProposal = undefined;
    this.applicationNextActionsProposal = undefined;
  }

  reviewAgentArtifact(artifact: AgentArtifactRecord, decision: 'approved' | 'rejected'): void {
    const run = this.selectedAgentRun; if (!run) return;
    if (!this.agentArtifactReviewConfirmed[artifact.id]) { this.host.error = 'Die Agentenartefakt-Revision muss ausdrücklich bestätigt werden.'; return; }
    if (artifact.lifecycle !== 'proposed') { this.host.error = 'Nur ein unverändertes vorgeschlagenes Agentenartefakt kann geprüft werden.'; return; }
    this.agentBusy = true;
    this.api.reviewAgentArtifact(run.id, artifact.id, decision, artifact.revision).subscribe({
      next: (updated) => {
        this.agentArtifacts = this.agentArtifacts.map((item) => item.id === updated.id ? updated : item);
        this.agentArtifactReviewConfirmed[artifact.id] = false;
        this.agentBusy = false;
        this.host.notice = decision === 'approved'
          ? 'Agentenartefakt wurde revisionsgebunden freigegeben. Nur passende Pipeline-Pakete können danach über die getrennte Adopt-Prüfung als fachliche Vorschlagsrevision übernommen werden.'
          : 'Agentenartefakt wurde revisionsgebunden abgelehnt.';
        this.host.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
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
    if (!run || !application || reason) { this.host.error = reason || 'Agentenartefakt kann nicht übernommen werden.'; return; }
    if (!this.agentArtifactAdoptionConfirmed[artifact.id]) { this.host.error = 'Die erneute Pipeline-Prüfung und Übernahme muss ausdrücklich bestätigt werden.'; return; }
    this.agentBusy = true; this.host.error = '';
    this.api.adoptAgentArtifact(run.id, artifact.id, artifact.revision).subscribe({
      next: ({ artifact: updated, documentRevisionId }) => {
        this.agentArtifacts = this.agentArtifacts.map((item) => item.id === updated.id ? updated : item);
        this.agentArtifactAdoptionConfirmed[artifact.id] = false;
        this.adoptedDocumentRevisionId = documentRevisionId;
        this.host.selectApplicationCase(application);
        this.host.loadApplicationArtifacts(application.id);
        this.agentBusy = false;
        this.host.notice = `Agentenpaket wurde erneut deterministisch geprüft; fachliche Revision ${documentRevisionId} liegt als Vorschlag zur menschlichen Hash-Prüfung vor.`;
        this.host.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
    });
  }

  cancelAgentRun(): void {
    const run = this.selectedAgentRun; if (!run || !this.isAgentRunActive(run.status)) return;
    this.agentBusy = true;
    this.api.cancelAgentRun(run.id, run.lastEventSequence).subscribe({
      next: (updated) => { this.agentBusy = false; this.selectedAgentRun = updated; this.host.notice = 'Abbruch wurde angefordert.'; this.refreshAgentRuns(); },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
    });
  }

  sendAgentInput(): void {
    const run = this.selectedAgentRun; const input = this.agentInput.trim();
    if (!run || !input) return;
    this.agentBusy = true;
    this.api.sendAgentInput(run.id, input, run.lastEventSequence).subscribe({
      next: (updated) => { this.agentBusy = false; this.selectedAgentRun = updated; this.agentInput = ''; this.agentInputSensitive = false; this.host.notice = 'Antwort wurde dem Agenten übergeben.'; this.refreshSelectedAgentRun(); },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
    });
  }

  decideAgentApproval(approval: AgentApproval, decision: 'approve' | 'deny', run = this.selectedAgentRun): void {
    if (!run) return;
    const unavailableReason = this.agentApprovalUnavailableReason(run, approval);
    if (unavailableReason) { this.host.error = unavailableReason; this.host.refreshView(); return; }
    this.agentBusy = true;
    const request = approval.expectedRevision === undefined
      ? this.api.decideAgentApproval(run.id, approval.id, decision)
      : this.api.decideAgentApproval(run.id, approval.id, decision, approval.expectedRevision);
    request.subscribe({
      next: (updated) => {
        this.agentBusy = false;
        this.agentRuns = this.agentRuns.map((item) => item.id === updated.id ? updated : item);
        if (this.selectedAgentRun?.id === updated.id) this.selectedAgentRun = updated;
        this.host.notice = decision === 'approve' ? 'Aktion wurde ausdrücklich freigegeben.' : 'Aktion wurde abgelehnt.';
        this.refreshAgentRuns();
      },
      error: (error) => { this.agentBusy = false; this.host.fail(error); }
    });
  }

  previewAgentExport(): void {
    const run = this.selectedAgentRun; if (!run) return;
    this.api.exportAgentRun(run.id).subscribe({
      next: (value) => { this.agentExportPreview = value; this.host.notice = 'Nachvollziehbarer Run-Export wurde als Vorschau geladen.'; this.host.refreshView(); },
      error: (error) => this.host.fail(error)
    });
  }

  loadAgentReplayTemplate(): void {
    const run = this.selectedAgentRun; if (!run) return;
    this.agentRunForm = { ...run.request, parentRunId: run.id, network: false, budget: { ...run.request.budget } };
    this.agentRunInstallationKey = '';
    this.ensureAgentRuntimeSelection();
    if (!this.agentProviderSupportsWorkspace(this.agentRunForm.workspaceMode)) this.agentRunForm.workspaceMode = 'read_only';
    this.host.notice = 'Run als neue Vorlage geladen. Netzwerkzugriff bleibt für den Replay standardmäßig aus.';
    this.scheduleAgentPreflight();
    this.host.refreshView();
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
    const keyed = this.agentRunInstallationKey
      ? installations.find((item) => this.agentInstallationKey(item) === this.agentRunInstallationKey) : undefined;
    if (keyed) return keyed;
    return installations.find((item) => item.runtimeTarget === this.agentRunForm.runtimeTarget
      && (item.runtimeTarget !== 'wsl' || item.distribution === this.agentRunForm.wslDistribution))
      ?? (this.agentRunForm.runtimeTarget === 'wsl' && !this.agentRunForm.wslDistribution
        ? installations.find((item) => item.runtimeTarget === 'wsl') : undefined);
  }

  agentInstallationKey(installation: AgentProviderInstallation): string {
    return [
      installation.runtimeTarget,
      encodeURIComponent(installation.distribution ?? ''),
      encodeURIComponent(installation.version ?? ''),
      encodeURIComponent(installation.executable ?? '')
    ].join(':');
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

  agentPreflightByteLabel(bytes: number): string {
    if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
    if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
    return `${bytes} Byte`;
  }

  agentProfileRuntimeRule(providerId: string | undefined): { runtimeTarget: AgentRuntimeTarget; wslDistribution?: string; profileId: string } | undefined {
    if (!providerId) return undefined;
    const saved = this.agentConfigProfile?.profile;
    const rule = saved?.providers.find((candidate) => candidate.provider === providerId);
    return rule && rule.enabled
      ? { runtimeTarget: rule.runtimeTarget, wslDistribution: rule.wslDistribution, profileId: saved!.profileId }
      : undefined;
  }

  /**
   * Shared start gate for single runs and orchestrations: only the SAVED profile
   * authorizes a runtime. The unsaved editor draft never does. Mirrors the
   * server-side evaluateAgentProfile blockers (enabled, runtime, wsl distribution).
   */
  agentProfileInstallationBlockedReason(providerId: string | undefined, installation: AgentProviderInstallation | undefined): string {
    if (!this.agentConfigProfile) {
      return this.agentConfigProfileError
        ? 'Das aktive Sicherheitsprofil konnte nicht geladen werden; der Start bleibt gesperrt.'
        : 'Das aktive Sicherheitsprofil wird noch geladen; der Start bleibt gesperrt.';
    }
    const profile = this.agentConfigProfile.profile;
    const rule = profile.providers.find((candidate) => candidate.provider === providerId);
    if (!rule || !rule.enabled) return `Der Provider ${providerId ?? ''} ist im aktiven Profil deaktiviert.`;
    if (!installation) return 'Wähle eine Providerinstallation.';
    const name = this.agentProviderName(providerId!);
    if (rule.runtimeTarget !== installation.runtimeTarget) {
      return `Das aktive Profil ${profile.profileId} erlaubt fuer ${name} nur ${rule.runtimeTarget}; gewaehlt ist ${installation.runtimeTarget}. Passe das Profil an oder waehle eine passende Installation.`;
    }
    if (rule.wslDistribution && installation.distribution !== rule.wslDistribution) {
      return `Das aktive Profil ${profile.profileId} erlaubt fuer ${name} nur die WSL-Distribution ${rule.wslDistribution}; gewaehlt ist ${installation.distribution ?? 'keine'}.`;
    }
    return '';
  }

  agentProfileRuntimeBlockedReason(installation: AgentProviderInstallation | undefined): string {
    return this.agentProfileInstallationBlockedReason(this.agentOrchestrationForm.providerId, installation);
  }

  agentProfileRuntimeFixAvailable(): string | undefined {
    return this.agentProfileRuntimeBlockedReason(this.selectedAgentOrchestrationInstallation()) || undefined;
  }

  agentProfileRuntimeFixConfirmed = false;

  ensureAgentRuntimeSelection(): void {
    const provider = this.selectedAgentProvider() ?? this.agentProviders.find((item) => item.available) ?? this.agentProviders[0];
    if (!provider) return;
    this.agentRunForm.providerId = provider.id;
    const ruleRuntime = this.agentProfileRuntimeRule(provider.id)?.runtimeTarget;
    const selected = this.selectedAgentInstallation();
    if (selected?.support === 'supported' && (!ruleRuntime || selected.runtimeTarget === ruleRuntime)) return;
    const installations = this.agentProviderInstallations(provider);
    const installation = installations.find((item) => item.support === 'supported' && (!ruleRuntime || item.runtimeTarget === ruleRuntime))
      ?? installations.find((item) => item.support === 'supported') ?? installations[0];
    if (installation) this.applyAgentInstallation(installation);
  }

  ensureAgentOrchestrationRuntimeSelection(): void {
    const provider = this.agentOrchestrationProvider() ?? this.agentProviders.find((item) => item.available) ?? this.agentProviders[0];
    if (!provider) return;
    this.agentOrchestrationForm.providerId = provider.id;
    const ruleRuntime = this.agentProfileRuntimeRule(provider.id)?.runtimeTarget;
    const selected = this.selectedAgentOrchestrationInstallation();
    if (selected?.support === 'supported' && (!ruleRuntime || selected.runtimeTarget === ruleRuntime)) return;
    const installations = this.agentProviderInstallations(provider);
    const installation = installations.find((item) => item.support === 'supported' && (!ruleRuntime || item.runtimeTarget === ruleRuntime))
      ?? installations.find((item) => item.support === 'supported') ?? installations[0];
    if (installation) this.applyAgentOrchestrationInstallation(installation);
  }

  applyAgentInstallation(installation: AgentProviderInstallation): void {
    this.agentRunForm.runtimeTarget = installation.runtimeTarget;
    this.agentRunForm.wslDistribution = installation.runtimeTarget === 'wsl' ? installation.distribution : undefined;
    this.agentRunInstallationKey = this.agentInstallationKey(installation);
  }

  applyAgentOrchestrationInstallation(installation: AgentProviderInstallation): void {
    this.agentOrchestrationForm.runtimeTarget = installation.runtimeTarget;
    this.agentOrchestrationForm.wslDistribution = installation.runtimeTarget === 'wsl' ? installation.distribution : undefined;
    this.agentOrchestrationInstallationKey = this.agentInstallationKey(installation);
  }

  selectedAgentWorkflow(): AgentWorkflow | undefined { return this.agentWorkflows.find((item) => item.id === this.agentRunForm.workflowId); }

  agentProviderSupportsNetwork(): boolean { return false; }

  agentProviderName(providerId: string): string { return this.agentProviders.find((item) => item.id === providerId)?.name ?? providerId; }

  agentProviderStatusLabel(provider: AgentProvider): string {
    if (provider.experimental) {
      return provider.fallbackProviderId ? 'Experimentell · exec-Fallback' : 'Experimentell';
    }
    return provider.available ? 'Bereit' : 'Nicht verfügbar';
  }

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

  agentRunApplication(run: AgentRun): ApplicationCase | undefined { return this.host.applicationCases.find((item) => item.id === run.request.applicationCaseId); }

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
      this.host.error = unavailable ?? 'Die Serverrevision fehlt.'; this.host.refreshView(); return;
    }
    this.agentBusy = true; this.host.error = '';
    this.api.acquireAgentRecoveryLease(recovery.runId, run.lastEventSequence).subscribe({
      next: (lease) => {
        this.agentBusy = false;
        if (lease.runId !== recovery.runId || !lease.leaseId || this.agentRecoveryLeaseExpired(lease)) {
          this.host.error = 'Die Recovery-Lease-Antwort ist unvollständig oder bereits abgelaufen.';
          this.refreshAgentOperationalState(); this.host.refreshView(); return;
        }
        this.agentRecoveryLeases.set(recovery.runId, lease);
        this.host.notice = `Recovery-Lease für ${recovery.runId} ist an Operator ${lease.operatorId} gebunden.`;
        this.refreshAgentOperationalState(); this.host.refreshView();
      },
      error: (error) => { this.agentBusy = false; this.host.error = this.host.message(error); this.refreshAgentOperationalState(); this.host.refreshView(); }
    });
  }

  openAgentRecoveryDialog(recovery: AgentRecoveryRun, decision: AgentRecoveryDecision, returnFocus?: HTMLElement): void {
    const unavailable = this.agentRecoveryActionUnavailableReason(recovery, decision);
    const run = this.agentRecoveryRunView(recovery);
    const lease = this.agentRecoveryLeaseFor(recovery.runId);
    if (unavailable || run?.lastEventSequence === undefined || !lease) {
      this.host.error = unavailable ?? 'Revision oder Lease fehlt.'; this.host.refreshView(); return;
    }
    this.agentRecoveryDialog = { runId: recovery.runId, decision, expectedRevision: run.lastEventSequence, leaseId: lease.leaseId };
    this.agentRecoveryConfirmed = false;
    this.agentRecoveryInput = '';
    this.agentRecoveryReturnFocus = returnFocus;
    this.host.error = '';
    this.host.refreshView();
    setTimeout(() => this.host.openNativeDialog(this.agentRecoveryDialogElement, this.agentRecoveryConfirm));
  }

  closeAgentRecoveryDialog(): void {
    const returnFocus = this.agentRecoveryReturnFocus;
    this.host.closeNativeDialog(this.agentRecoveryDialogElement);
    this.agentRecoveryDialog = undefined;
    this.agentRecoveryConfirmed = false;
    this.agentRecoveryInput = '';
    this.agentRecoveryReturnFocus = undefined;
    this.host.refreshView();
    this.host.restoreDialogFocus(returnFocus);
  }

  cancelAgentRecoveryDialog(event: Event): void {
    event.preventDefault();
    this.closeAgentRecoveryDialog();
  }

  confirmAgentRecovery(): void {
    const dialog = this.agentRecoveryDialog;
    if (!dialog || !this.agentRecoveryConfirmed) return;
    const recovery = this.agentRecoveryRuns.find((item) => item.runId === dialog.runId);
    const unavailable = this.agentRecoveryActionUnavailableReason(recovery, dialog.decision);
    const run = recovery ? this.agentRecoveryRunView(recovery) : undefined;
    if (unavailable || run?.lastEventSequence !== dialog.expectedRevision) {
      this.host.error = unavailable ?? 'Der Lauf wurde seit Öffnen des Dialogs verändert. Bitte Diagnose und Revision neu prüfen.';
      this.closeAgentRecoveryDialog(); this.refreshAgentOperationalState(); return;
    }
    this.agentBusy = true; this.host.error = '';
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
        this.host.notice = dialog.decision === 'resume'
          ? `Recovery abgeschlossen: Ein neuer Prozess und neuer Run ${result.replacement?.id ?? 'wurde angefordert'} ersetzt ${dialog.runId}; der alte Prozess wurde nicht adoptiert.`
          : `Verwaister Run ${dialog.runId} wurde nach expliziter Operatorentscheidung bereinigt.`;
        this.refreshAgentRuns(); this.host.refreshView();
      },
      error: (error) => {
        this.agentBusy = false; this.host.error = this.host.message(error);
        this.closeAgentRecoveryDialog(); this.refreshAgentRuns(); this.host.refreshView();
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
    this.host.refreshView();
    if (list && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { list.scrollTop += Math.max(0, list.scrollHeight - previousHeight); });
  }

  toggleAgentTimelinePause(): void {
    if (this.agentTimelinePaused) {
      this.agentTimelinePaused = false;
      this.agentPausedEvents = [];
      this.agentEventRenderLimit = Math.max(this.agentEventRenderLimit, this.agentEventRenderChunk);
      this.host.notice = 'Timeline-Darstellung läuft weiter; gepufferte Events wurden vollständig übernommen.';
      this.host.refreshView();
      this.scheduleAgentAutoScroll();
      return;
    }
    this.agentPausedEvents = [...this.agentEvents];
    this.agentTimelinePaused = true;
    this.host.notice = 'Nur die Darstellung ist pausiert. Eingehende Events werden weiterhin verlustfrei gepuffert.';
    this.host.refreshView();
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
      ...(this.host.config?.identities ?? []).flatMap((identity) => [identity.fullName, identity.email, identity.phone, identity.location, identity.linkedin, ...Object.values(identity.placeholders)]),
      this.host.config?.assistant.candidateProfilePath, this.host.config?.assistant.skillPath, this.host.config?.assistant.styleProfilePath,
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
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) { this.host.error = 'Die Zwischenablage ist in dieser Laufzeit nicht verfügbar.'; this.host.refreshView(); return; }
    try {
      await navigator.clipboard.writeText(this.redactAgentText(value));
      this.host.notice = `${label} wurde ausschließlich in lokal redigierter Form kopiert.`;
      this.host.error = '';
    } catch { this.host.error = 'Redigiertes Kopieren wurde vom Browser abgelehnt.'; }
    this.host.refreshView();
  }

  copyAgentTimelineEntry(entry: AgentTimelineEntry): void {
    void this.copyRedactedAgentText(`${entry.type} #${entry.sequence}${entry.sequenceEnd > entry.sequence ? `–${entry.sequenceEnd}` : ''}\n${this.agentTimelineDisplayText(entry)}`, `Event #${entry.sequence}`);
  }

  copyAgentResult(run: AgentRun): void { void this.copyRedactedAgentText(run.error ?? run.output ?? '', 'Run-Ergebnis'); }

  agentArtifactPromotionAvailable(_run: AgentRun): boolean { return false; }

  agentArtifactPromotionReason(): string {
    return 'Proposal-only: Der vorhandene Agent-Run-API-Vertrag bietet keinen validierten Übergabepfad in Domain-Commands oder Dokumentrevisionen. Nutze dafür die fachliche Bewerbungspipeline mit Evidenzprüfung und Review.';
  }

  escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  mergeAgentEvents(events: AgentRunEvent[]): void {
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

  scheduleAgentAutoScroll(force = false): void {
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

  startAgentPolling(): void {
    this.stopAgentPolling();
    this.agentPollHandle = setInterval(() => {
      // Im Hintergrund-Tab nicht pollen; beim nächsten Tick im Vordergrund wird nachgeladen.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (this.host.section === 'agents') this.refreshAgentRuns();
      if (this.host.section === 'agents' || this.host.section === 'cv' || this.host.section === 'applications') {
        this.refreshAgentOrchestrations();
        const application = this.host.section === 'applications' ? this.host.selectedApplicationCase() : undefined;
        if (application) this.host.loadApplicationArtifacts(application.id);
      }
    }, 2500);
  }

  stopAgentPolling(): void {
    if (this.agentPollHandle) clearInterval(this.agentPollHandle);
    this.agentPollHandle = undefined;
  }

  startAgentStream(runId: string): void {
    this.stopAgentStream();
    this.agentEventSubscription = this.api.agentRunEventStream(runId, this.agentEventsAfter).subscribe({
      next: (event) => {
        if (this.selectedAgentRun?.id !== runId) return;
        this.mergeAgentEvents([event]);
        this.agentEventsAfter = Math.max(this.agentEventsAfter, event.sequence);
        if (event.type === 'run_completed') { this.stopAgentStream(); this.refreshAgentRuns(); }
        this.host.refreshView();
        this.scheduleAgentAutoScroll();
      },
      error: () => { this.stopAgentStream(); }
    });
  }

  stopAgentStream(): void {
    this.agentEventSubscription?.unsubscribe();
    this.agentEventSubscription = undefined;
  }

  /**
   * Renders the incognito result for viewing and download. Adoption and case
   * release stay closed; this only makes the outcome visible, which the general
   * contract has always allowed incognito to reach.
   */
  /** Artifacts of the selected run that an incognito preview can render from. */
  selectedAgentRunArtifacts(): AgentArtifactRecord[] {
    return this.agentArtifacts.filter((artifact) => artifact.lifecycle === 'proposed' || artifact.lifecycle === 'approved');
  }

  formatProposalConfidence(value: number): string { return `${Math.round(value * 100)} %`; }

  parseEmployerResponseTriageProposal(content: string): EmployerResponseTriageProposalProjection | undefined {
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

  parseApplicationNextActionsProposal(content: string): ApplicationNextActionsProposalProjection | undefined {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const proposal = parsed['proposal'] as Record<string, unknown> | undefined;
      if (parsed['contract'] !== 'application-next-actions-proposal' || parsed['contractVersion'] !== '1.0'
        || typeof parsed['sha256'] !== 'string' || !proposal || proposal['schemaVersion'] !== 1
        || typeof proposal['companyKey'] !== 'string' || !Array.isArray(proposal['suggestions']) || !Array.isArray(proposal['conflicts'])) return undefined;
      return parsed as unknown as ApplicationNextActionsProposalProjection;
    } catch { return undefined; }
  }

  isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }}
