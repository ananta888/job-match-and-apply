import type { AgentArtifactRecord, AgentOrchestrationRecord, AgentProviderConfigProfile, ApplicationCase, ApplicationSourceCvCandidate, ApplicationStyleProfileView, CvAiProviderSelection, CvAiStructuringOptions, CvAiStructuringPublicRun, CvAiStructuringSelection, CvAiStructuringSuggestion, CvAdoptionLedgerEntry, CvFact, CvFactCategory, CvFactDecision, CvFactOperation, CvImportRecord, CvImportSummary, CvIncognitoPreview, CvProfileSnapshotSummary, CvRecognitionVersionList, CvRecognitionVersionSummary, CvTheme, CvLayoutFingerprint, CvThemeOriginalLayout, AtsCheckReport, ProviderModelCatalog } from './models';
import { Injectable, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { forkJoin } from 'rxjs';
import { ApiService } from './api.service';
import { cvFactGroupIsRaw, groupCvFactRecords } from './cv-facts-view.js';
import type { App } from './app';

export interface CvFactGroup {
  recordId: string;
  category: CvFactCategory;
  facts: CvFact[];
  title: string;
  period?: string;
}

export type CvStudioStep = 1 | 2 | 3 | 4 | 5 | 6;
export type CvFactDraft = Pick<CvFact, 'category' | 'recordId' | 'field' | 'value'>;
export interface CvNewFactDraft {
  category: CvFactCategory;
  target: 'existing_record' | 'new_record';
  recordId: string;
  newRecordKey: string;
  field: string;
  value: string;
  explicitlyConfirmed: boolean;
}

export interface CvAiSuggestionGroup {
  key: string;
  category: string;
  recordId: string | null;
  title: string;
  period?: string;
  suggestions: CvAiStructuringSuggestion[];
}/**
 * Zustand und Logik des Lebenslauf-Studios (Import, Fakten, KI-Strukturierung, Vorlage, HTML).
 *
 * Root-Service wie der AgentCenterStore: Entwürfe und laufende Prüfungen überstehen einen
 * Bereichswechsel. Profil & Identität und die Bewerbungswerkstatt nutzen Teile davon als `app.cv`.
 */
@Injectable({ providedIn: 'root' })
export class CvStudioStore {
  readonly api = inject(ApiService);
  readonly sanitizer = inject(DomSanitizer);
  host!: App;
  /** Wird bei jeder Zustandsänderung erhöht; die Lebenslauf-Ansicht liest es und zeichnet dann neu. */
  readonly revision = signal(0);

  attach(host: App): void { this.host = host; }

  applicationStyleProfile?: ApplicationStyleProfileView;

  styleProfileError = '';

  sourceCvCandidates: ApplicationSourceCvCandidate[] = [];

  sourceCvSelection = '';

  sourceCvCandidatesBusy = false;

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

  cvIncognitoPreviewObjectUrl?: string;

  cvThemePreviewObjectUrl?: string;

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

  cvAiAppliedReloadKey = '';

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

  cvAiPollHandle?: ReturnType<typeof setInterval>;

  cvAiPollInFlight = false;

  loadCvStudio(): void {
    if (!this.host.agents.agentConfigProfile) this.host.agents.loadAgentConfigProfile();
    this.loadCvImportInventory();
    this.host.loadApplicationCases();
    // Lädt das Stilprofil nur, wenn der Setup-Status es als vorhanden meldet (vermeidet einen 404).
    this.host.loadProfileSetup();
    this.host.agents.refreshAgentOrchestrations();
    if (!this.host.agents.agentProviders.length) this.host.agents.loadAgentProviders();
    if (!this.host.agents.agentWorkflows.length) this.api.agentWorkflows().subscribe({
      next: (items) => { this.host.agents.agentWorkflows = items; this.host.refreshView(); },
      error: (error) => { this.cvError = this.host.message(error); this.host.refreshView(); }
    });
    if (this.cvImport) { this.loadCvRecognitionVersions(); this.loadCvAiStructuringState(); }
    this.host.agents.startAgentPolling();
  }

  cvAiModelCatalogTarget(): Pick<AgentProviderConfigProfile, 'provider' | 'runtimeTarget' | 'wslDistribution'> | undefined {
    const selected = this.cvAiSelectedInstallation();
    if (!selected) return undefined;
    return {
      provider: selected.providerId, runtimeTarget: selected.installation.runtimeTarget,
      ...(selected.installation.wslDistribution ? { wslDistribution: selected.installation.wslDistribution } : {}),
    };
  }

  cvAiModelCatalog(): ProviderModelCatalog | undefined {
    const target = this.cvAiModelCatalogTarget();
    return target ? this.host.agents.agentModelCatalogs[this.host.agents.modelCatalogKey(target)] : undefined;
  }

  cvAiModelCatalogKey(): string {
    const target = this.cvAiModelCatalogTarget();
    return target ? this.host.agents.modelCatalogKey(target) : '';
  }

  loadCvAiModels(): void {
    const target = this.cvAiModelCatalogTarget();
    if (target) this.host.agents.loadProviderModels(target);
  }

  applicationRetryBusy = false;

  /** Saves ONLY the confirmed runtime/distribution change on top of the SAVED revision. */
  alignAgentProfileRuntimeTo(): void {
    const view = this.host.agents.agentConfigProfile;
    const installation = this.host.agents.selectedAgentOrchestrationInstallation();
    const providerId = this.host.agents.agentOrchestrationForm.providerId;
    if (!view || !installation || !this.host.agents.agentProfileRuntimeFixConfirmed || this.host.agents.agentConfigProfileBusy) return;
    const saved = structuredClone(view.profile);
    const rule = saved.providers.find((candidate) => candidate.provider === providerId);
    if (!rule) return;
    rule.runtimeTarget = installation.runtimeTarget;
    rule.wslDistribution = installation.runtimeTarget === 'wsl' ? (installation.distribution ?? undefined) : undefined;
    this.host.agents.agentConfigProfileDraft = saved;
    this.host.agents.agentConfigProfileConfirmed = true;
    this.host.agents.agentProfileRuntimeFixConfirmed = false;
    this.host.agents.saveAgentConfigProfile();
  }

  loadSourceCvCandidates(): void {
    this.sourceCvCandidatesBusy = true;
    this.api.applicationSourceCvCandidates().subscribe({
      next: (items) => { this.sourceCvCandidates = items; this.sourceCvCandidatesBusy = false; this.host.refreshView(); },
      error: (error) => { this.sourceCvCandidatesBusy = false; this.host.fail(error); }
    });
  }

  sourceCvCandidateKey(candidate: ApplicationSourceCvCandidate): string {
    return `${candidate.caseId}::${candidate.revisionId}`;
  }

  selectedSourceCvCandidate(): ApplicationSourceCvCandidate | undefined {
    return this.sourceCvCandidates.find((item) => this.sourceCvCandidateKey(item) === this.sourceCvSelection);
  }

  sourceCvBindingForCreation(): { caseId: string; revisionId: string; sha256: string } | undefined {
    if (this.host.documentType === 'cv') return undefined;
    const candidate = this.selectedSourceCvCandidate();
    return candidate ? { caseId: candidate.caseId, revisionId: candidate.revisionId, sha256: candidate.sha256 } : undefined;
  }

  canRetryFinalizerQuickly(run: AgentOrchestrationRecord): boolean {
    return run.status === 'failed' && run.providerId === 'openrouter' && run.workflowId === 'evidence-application-package'
      && run.nodes.some(node => node.nodeId === 'finalizer' && node.status === 'failed' && node.failureCategory !== 'needs_input');
  }

  retryFinalizerQuickly(run: AgentOrchestrationRecord): void {
    if (!this.canRetryFinalizerQuickly(run) || this.applicationRetryBusy) return;
    this.applicationRetryBusy = true; this.host.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(run.id, 'finalizer', undefined, 'off').subscribe({
      next: created => {
        this.applicationRetryBusy = false;
        this.host.agents.agentOrchestrations = [created, ...this.host.agents.agentOrchestrations.filter(item => item.id !== created.id)];
        if (created.scope.applicationCaseId === this.cvSelectedApplicationCaseId) this.cvAgentOrchestrationId = created.id;
        if (created.scope.applicationCaseId === this.host.selectedApplicationCaseId) this.host.applicationAgentOrchestrationId = created.id;
        this.host.notice = 'Nur der Abschluss läuft erneut mit Reasoning Aus. Fertige Vorstufen bleiben erhalten; das gespeicherte Profil bleibt unverändert.';
        this.host.refreshView();
      },
      error: error => { this.applicationRetryBusy = false; this.host.agents.agentOrchestrationError = this.host.message(error); this.host.refreshView(); },
    });
  }

  /** Targeted per-node retry from the status list (failed or policy-blocked steps). */
  retryOrchestrationNode(orchestration: AgentOrchestrationRecord, nodeId: string): void {
    if (this.applicationRetryBusy) return;
    const node = orchestration.nodes.find((item) => item.nodeId === nodeId);
    if (!node || !['failed', 'policy_blocked'].includes(node.status)) return;
    this.applicationRetryBusy = true;
    this.host.agents.agentOrchestrationError = '';
    this.api.retryAgentOrchestrationNode(orchestration.id, nodeId).subscribe({
      next: (created) => {
        this.applicationRetryBusy = false;
        this.host.agents.agentOrchestrations = [created, ...this.host.agents.agentOrchestrations.filter((item) => item.id !== created.id)];
        if (this.host.selectedApplicationCaseId && created.scope.applicationCaseId === this.host.selectedApplicationCaseId) {
          this.host.applicationAgentOrchestrationId = created.id;
        } else {
          this.host.agents.selectedAgentOrchestration = created;
        }
        this.host.notice = `Schritt „${node.role}" wird mit der eingefrorenen Konfiguration wiederholt.`;
        this.host.refreshView();
      },
      error: (error) => { this.applicationRetryBusy = false; this.host.agents.agentOrchestrationError = this.host.message(error); this.host.refreshView(); }
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
          this.host.refreshView(); return;
        }
        if (this.cvRecognitionVersions?.activeVersionId !== list.activeVersionId) this.cvRecognitionVersionConfirmed = false;
        this.cvRecognitionVersions = list; this.cvRecognitionSelectedVersionId = list.activeVersionId;
        this.host.refreshView();
      },
      error: (error) => {
        this.cvRecognitionVersionBusy = false; this.cvRecognitionVersions = undefined;
        this.cvRecognitionVersionError = `Erkennungsstände konnten nicht geladen werden: ${this.host.message(error)}`;
        this.host.refreshView();
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
        if (this.cvImport?.id !== current.id) { this.host.refreshView(); return; }
        this.cvRevocableAdoptions = revocable.adoptions;
        this.cvProfileSnapshots = snapshots.snapshots;
        if (!this.cvProfileSnapshots.some((item) => item.id === this.cvSelectedSnapshotId)) {
          this.cvSelectedSnapshotId = this.cvProfileSnapshots.find((item) => !item.current)?.id ?? '';
        }
        this.host.refreshView();
      },
      error: (error) => {
        this.cvClaimManagementBusy = false;
        this.cvRevocableAdoptions = []; this.cvProfileSnapshots = [];
        this.cvClaimManagementError = `Profilstände konnten nicht geladen werden: ${this.host.message(error)}`;
        this.host.refreshView();
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
        this.host.loadCandidateProfile(); this.loadCvClaimManagement(); this.host.refreshView();
      },
      error: (error) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false;
        this.cvClaimManagementError = (error as { status?: number })?.status === 409
          ? 'Nur ein Teil der bestätigten Claims liegt bereits im Kandidatenprofil. Verwirf die bisherige Übernahme und übernimm neu.'
          : this.host.message(error);
        this.host.refreshView();
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
            this.host.loadCandidateProfile(); this.loadCvClaimManagement(); this.host.refreshView();
          },
          error: (error) => {
            this.cvClaimManagementBusy = false; this.cvBusy = false;
            this.cvClaimManagementError = `Die frühere Übernahme wurde verworfen, die neue Übernahme ist aber fehlgeschlagen: ${this.host.message(error)}`;
            this.host.loadCandidateProfile(); this.loadCvClaimManagement(); this.host.refreshView();
          }
        });
      },
      error: (error) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false;
        this.cvClaimManagementError = (error as { status?: number })?.status === 409
          ? 'Die frühere Übernahme ist nicht mehr widerrufbar. Lade den Import neu.'
          : this.host.message(error);
        this.host.refreshView();
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
        this.host.loadCandidateProfile(); this.loadCvClaimManagement(); this.host.refreshView();
      },
      error: (error) => {
        this.cvClaimManagementBusy = false; this.cvBusy = false;
        this.cvClaimManagementError = (error as { status?: number })?.status === 409
          ? 'Das Kandidatenprofil hat sich zwischenzeitlich geändert. Lade die Profilstände neu.'
          : this.host.message(error);
        this.host.refreshView();
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
        this.focusCvRecognitionVersions(); this.host.refreshView();
      },
      error: (error) => {
        this.cvRecognitionVersionBusy = false; this.cvBusy = false;
        this.cvRecognitionSelectedVersionId = this.cvRecognitionVersions?.activeVersionId ?? '';
        this.cvRecognitionVersionError = (error as { status?: number })?.status === 409
          ? 'Der Erkennungsstand konnte wegen einer neueren Lebenslaufrevision nicht aktiviert werden. Lade den Import neu und versuche es erneut.'
          : this.host.message(error);
        this.host.refreshView();
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
        this.focusCvRecognitionVersions(); this.host.refreshView();
      },
      error: (error) => {
        this.cvRecognitionVersionBusy = false; this.cvBusy = false; this.cvRecognitionVersionConfirmed = false;
        this.cvRecognitionVersionError = (error as { status?: number })?.status === 409
          ? 'Der Stand konnte wegen einer neueren Lebenslaufrevision nicht bestätigt werden. Lade den Import neu.'
          : this.host.message(error);
        this.host.refreshView();
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

  cvRecognitionVersionListMatches(list: CvRecognitionVersionList, current: CvImportRecord): boolean {
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

  resetCvRecognitionVersions(): void {
    this.cvRecognitionVersions = undefined; this.cvRecognitionVersionBusy = false;
    this.cvRecognitionVersionError = ''; this.cvRecognitionVersionNotice = '';
    this.cvRecognitionVersionConfirmed = false;
    this.cvRecognitionSelectedVersionId = '';
  }

  focusCvRecognitionVersions(): void {
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
          this.stopCvAiPolling(); this.host.refreshView();
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
              this.host.refreshView();
              return;
            }
            this.cvAiOptions = options; this.cvAiBusy = false;
            this.setCvAiRun(selected);
            const installations = this.cvAiInstallations();
            if (!installations.some((item) => this.cvAiInstallationKeyFor(item.providerId, item.installation) === this.cvAiInstallationKey)) {
              const first = installations.find((item) => item.installation.ready);
              this.cvAiInstallationKey = first ? this.cvAiInstallationKeyFor(first.providerId, first.installation) : '';
            }
            this.host.refreshView();
          },
          error: (error) => this.failCvAiStructuringStateLoad(error)
        });
      },
      error: (error) => this.failCvAiStructuringStateLoad(error)
    });
  }

  failCvAiStructuringStateLoad(error: unknown): void {
    this.cvAiBusy = false;
    this.cvAiOptions = undefined;
    this.cvAiError = `Optionale AI-Strukturierung ist derzeit nicht verfügbar: ${this.host.message(error)}`;
    this.stopCvAiPolling(); this.host.refreshView();
  }

  cvAiAppliedRunNeedsImportReload(current: CvImportRecord, run: CvAiStructuringPublicRun): boolean {
    const result = run.status === 'applied' ? run.result : undefined;
    if (!result || result.cvImportRevision < current.revision) return false;
    return result.cvImportRevision > current.revision || result.cvImportSha256 !== current.sha256;
  }

  cvAiInstallations(): Array<{
    providerId: string;
    installation: CvAiStructuringOptions['providers'][number]['installations'][number];
  }> {
    return (this.cvAiOptions?.providers ?? [])
      .filter((provider) => this.host.agents.isRealAgentProvider(provider.providerId))
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

  cvAiSelectedInstallation(): ReturnType<CvStudioStore['cvAiInstallations']>[number] | undefined {
    return this.cvAiInstallations().find((item) => this.cvAiInstallationKeyFor(item.providerId, item.installation) === this.cvAiInstallationKey);
  }

  cvAiSelectedProviderLabel(): string {
    const selected = this.cvAiSelectedInstallation();
    return selected ? this.cvAiProviderLabel(selected.providerId) : 'Noch kein Provider gewählt';
  }

  cvAiProviderLabel(providerId: string): string {
    return this.host.agents.agentProviders.find((provider) => provider.id === providerId)?.name ?? providerId;
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
      this.host.refreshView(); return;
    }
    this.cvAiBusy = true; this.cvAiError = ''; this.cvAiNotice = 'AI-Strukturierung wird revisionsgebunden gestartet …';
    this.api.startCvAiStructuring(current, provider).subscribe({
      next: (run) => {
        this.cvAiBusy = false; this.cvAiRuns = [run, ...this.cvAiRuns.filter((item) => item.id !== run.id)];
        this.setCvAiRun(run); this.clearCvAiDisclosure();
        this.cvAiNotice = 'Der optionale AI-Lauf wurde gestartet. Lokale Fakten bleiben unverändert.';
        this.focusCvAiStatus(); this.host.refreshView();
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
        this.cvAiBusy = false; this.setCvAiRun(run); this.focusCvAiStatus(); this.host.refreshView();
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
        this.setCvAiRun(fresh); this.host.refreshView();
      },
      error: (error) => { this.cvAiPollInFlight = false; this.stopCvAiPolling(); this.failCvAi(error); }
    });
  }

  reloadCvImportAfterAiApplied(current: CvImportRecord, run: CvAiStructuringPublicRun): void {
    const result = run.result;
    if (!result) { this.setCvAiRun(run); this.host.refreshView(); return; }
    const reloadKey = `${run.id}:${result.cvImportRevision}:${result.cvImportSha256}`;
    if (this.cvAiAppliedReloadKey === reloadKey) { this.setCvAiRun(run); this.host.refreshView(); return; }
    this.cvAiAppliedReloadKey = reloadKey; this.setCvAiRun(run);
    this.cvAiBusy = true; this.cvBusy = true;
    this.api.cvImport(current.id).subscribe({
      next: (record) => {
        if (record.revision !== result.cvImportRevision || record.sha256 !== result.cvImportSha256) {
          this.cvAiBusy = false; this.cvBusy = false; this.cvAiAppliedReloadKey = '';
          this.cvAiError = 'Der neue KI-Erkennungsstand ist noch nicht an die gemeldete Lebenslaufrevision gebunden. Lade den Import erneut.';
          this.host.refreshView(); return;
        }
        this.cvAiBusy = false; this.cvBusy = false; this.applyCvImport(record, true); this.cvAiRun = run;
        this.cvAiNotice = 'Der neue KI-Erkennungsstand ist aktiv. Prüfe die Struktur und bestätige den gesamten Stand mit einem Klick; einzelne Korrekturen bleiben optional.';
        this.stopCvAiPolling(); this.focusCvRecognitionVersions(); this.host.refreshView();
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
        this.focusCvAiStatus(); this.host.refreshView();
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
        this.host.refreshView();
      },
      error: (error) => this.failCvAi(error)
    });
  }

  retryCvAiStructuring(): void {
    const current = this.cvImport; const previous = this.cvAiRun; const provider = this.cvAiProviderSelection();
    const unavailable = this.cvAiStartUnavailableReason();
    if (!current || !previous || !provider || !this.cvAiCanRetry(previous) || unavailable || this.cvAiBusy) {
      if (unavailable) this.cvAiError = unavailable;
      this.host.refreshView(); return;
    }
    this.cvAiBusy = true; this.cvAiError = '';
    this.api.retryCvAiStructuring(current, previous, provider).subscribe({
      next: (run) => {
        this.cvAiBusy = false; this.cvAiRuns = [run, ...this.cvAiRuns]; this.setCvAiRun(run); this.clearCvAiDisclosure();
        this.cvAiNotice = `Neuer AI-Versuch ${run.attempt} wurde mit aktueller Disclosure gestartet.`;
        this.focusCvAiStatus(); this.host.refreshView();
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
      this.host.refreshView(); return;
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
            this.stopCvAiPolling(); this.focusCvAiStatus(); this.host.refreshView();
          },
          error: (error) => { this.cvBusy = false; this.failCvAi(error); }
        });
      },
      error: (error) => { this.cvBusy = false; this.failCvAi(error); }
    });
  }

  cvAiProviderSelection(): CvAiProviderSelection | undefined {
    const selected = this.cvAiSelectedInstallation();
    if (!selected?.installation.version) return undefined;
    return {
      providerId: selected.providerId, runtimeTarget: selected.installation.runtimeTarget,
      ...(selected.installation.wslDistribution ? { wslDistribution: selected.installation.wslDistribution } : {}),
      expectedVersion: selected.installation.version,
      ...(this.cvAiModelOverride.trim() ? { model: this.cvAiModelOverride.trim() } : {}),
    };
  }

  setCvAiRun(run: CvAiStructuringPublicRun | undefined): void {
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

  startCvAiPolling(): void {
    if (this.cvAiPollHandle || this.host.section !== 'cv') return;
    this.cvAiPollHandle = setInterval(() => this.refreshCvAiRun(), 1_500);
  }

  stopCvAiPolling(): void {
    if (this.cvAiPollHandle) clearInterval(this.cvAiPollHandle);
    this.cvAiPollHandle = undefined; this.cvAiPollInFlight = false;
  }

  clearCvAiDisclosure(): void {
    this.cvAiDisclosureConfirmed = false;
    this.cvAiApplyConfirmed = false;
  }

  resetCvAiStructuringState(): void {
    this.stopCvAiPolling(); this.cvAiOptions = undefined; this.cvAiRuns = []; this.cvAiRun = undefined;
    this.cvAiInstallationKey = ''; this.cvAiSuggestionSelections = {}; this.cvAiAlternativeSelections = {};
    this.cvAiRejectedSuggestions = {}; this.cvAiBusy = false; this.cvAiError = ''; this.cvAiNotice = '';
    this.cvAiAppliedReloadKey = '';
    this.clearCvAiDisclosure();
  }

  focusCvAiStatus(): void {
    setTimeout(() => (document.getElementById('cv-ai-status-heading') as HTMLElement | null)?.focus(), 0);
  }

  failCvAi(error: unknown): void {
    this.cvAiBusy = false; this.cvAiError = this.host.message(error); this.cvAiNotice = ''; this.host.refreshView();
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
      this.host.refreshView();
      return;
    }
    this.selectCvStep(next);
  }

  /** Identity panel: the recognized CV appears automatically from the current import. */
  loadProfileCvImport(importId: string): void {
    if (!importId || importId === this.cvImport?.id) return;
    this.api.cvImport(importId).subscribe({
      next: (record) => { this.applyCvImport(record, true); this.loadCvRecognitionVersions(); this.host.refreshView(); },
      error: (error) => { this.cvError = this.host.message(error); this.host.refreshView(); },
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
            next: (record) => { this.applyCvImport(record, true); this.loadCvRecognitionVersions(); this.host.refreshView(); },
            error: () => this.host.refreshView(),
          });
        } else this.host.refreshView();
      },
      error: () => this.host.refreshView(),
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
    if (unavailable || this.cvBusy) { if (unavailable) this.cvError = unavailable; this.host.refreshView(); return; }
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
      this.host.refreshView(); return;
    }
    if (file.size < 1 || file.size > this.cvMaxFileBytes) {
      this.cvError = 'Die Lebenslaufdatei muss zwischen 1 Byte und 10 MiB groß sein.';
      this.host.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = ''; this.cvNotice = 'Datei wird lokal extrahiert und als ungeprüfte Fakten normalisiert …';
    const reader = new FileReader();
    reader.onerror = () => { this.cvBusy = false; this.cvError = 'Die Datei konnte im Browser nicht gelesen werden.'; this.host.refreshView(); };
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      if (!base64) { this.cvBusy = false; this.cvError = 'Die Datei enthält keine lesbaren Daten.'; this.host.refreshView(); return; }
      this.api.importCv({ fileName: file.name, mimeType, base64 }).subscribe({
        next: (record) => {
          this.applyCvImport(record);
          this.cvBusy = false; this.cvStep = 2;
          this.cvNotice = `${record.facts.length} atomare Fakten wurden importiert. Sie sind noch nicht als Kandidatenfakten übernommen.`;
          this.focusCvStep(); this.host.refreshView();
        },
        error: (error) => this.failCv(error)
      });
    };
    reader.readAsDataURL(file);
  }

  loadCvImportInventory(): void {
    this.api.cvImports(20).subscribe({
      next: (records) => { this.cvImportInventory = records; this.host.refreshView(); },
      error: (error) => { this.cvError = `Gespeicherte Lebenslaufimporte konnten nicht geladen werden: ${this.host.message(error)}`; this.host.refreshView(); }
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
        this.focusCvStep(); this.host.refreshView();
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
        this.focusCvStep(); this.host.refreshView();
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

  removeCvImportFromState(id: string): void {
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
        this.host.refreshView();
      },
      error: (error) => { this.cvInventoryBusy = false; this.cvError = this.host.message(error); this.host.refreshView(); }
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
        this.host.refreshView();
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
      next: (record) => { this.applyCvImport(record, true); this.cvBusy = false; this.cvNotice = `Importrevision ${record.revision} wurde neu geladen.`; this.host.refreshView(); },
      error: (error) => this.failCv(error)
    });
  }

  saveCvFact(fact: CvFact): void {
    const current = this.cvImport;
    if (!current || this.cvBusy) return;
    const draft = this.cvFactDraft(fact);
    if (!this.cvFactDraftDirty(fact)) { this.cvError = 'Dieser Fakt enthält keine ungespeicherte Änderung.'; this.host.refreshView(); return; }
    if (draft.recordId !== fact.recordId) {
      this.cvError = 'Ein Fakt darf nicht in eine andere Station verschoben werden. Ergänze stattdessen dort einen neuen atomaren Fakt.';
      this.host.refreshView(); return;
    }
    if (!/^(?=.{1,64}$)[a-z][a-z0-9_.]*(?:\[[0-9]{1,4}\])?$/.test(draft.field.trim())
      || !draft.value.trim() || draft.value.trim().length > 5_000) {
      this.cvError = 'Feldkennung oder Aussage liegt außerhalb des geschlossenen Serververtrags.';
      this.host.refreshView(); return;
    }
    this.mutateCvFacts([{
      factId: fact.id, action: 'edit', category: draft.category, recordId: draft.recordId.trim(),
      field: draft.field.trim(), value: draft.value.trim()
    }], 'Die Änderung wurde als ungeprüfter Fakt gespeichert. Bestätige oder verwirf ihn anschließend ausdrücklich.');
  }

  decideCvFact(fact: CvFact, decision: 'confirm' | 'reject'): void {
    if (this.cvFactDraftDirty(fact)) {
      this.cvError = 'Speichere die Textänderung zuerst. Bearbeitete Fakten werden serverseitig wieder auf „ungeprüft“ gesetzt.';
      this.host.refreshView(); return;
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
      this.host.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = '';
    this.api.adoptCvFacts(current).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvAdoptionConfirmed = false;
        this.cvNotice = `${record.adoption?.adoptedClaimIds.length ?? 0} bestätigte Claims wurden revisionsgebunden in das Kandidatenprofil übernommen.`;
        this.cvStep = 3; this.host.loadCandidateProfile(); this.focusCvStep(); this.host.refreshView();
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
      this.host.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = '';
    this.api.saveCvTheme(current, structuredClone(this.cvThemeDraft)).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvThemeConfirmed = false;
        this.cvNotice = 'Die geschlossene ATS-Formatvorlage wurde revisionsgebunden gespeichert.'; this.host.refreshView();
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
        this.cvNotice = 'Die optionale Formatvorlage wurde entfernt; der Server verwendet seine ATS-sichere Standardvorlage.'; this.host.refreshView();
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

  buildAtsThemeFromFingerprint(fingerprint: CvLayoutFingerprint): CvTheme {
    const detected = fingerprint.sections.map((entry) => entry.section);
    const sectionOrder = [...detected, ...this.cvSectionCategories.filter((category) => !detected.includes(category))];
    return {
      mode: 'ats', template: this.cvThemeDraft.template, font: this.cvThemeDraft.font,
      accentColor: this.nearestAtsAccent(fingerprint.palette.accent), spacing: this.cvThemeDraft.spacing, sectionOrder,
    };
  }

  buildOriginalThemeFromFingerprint(fingerprint: CvLayoutFingerprint): CvTheme {
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

  nearestAtsAccent(hex: string): CvTheme['accentColor'] {
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
    const run = this.host.agents.selectedAgentRun;
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
        this.host.refreshView();
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
    } catch { this.cvError = 'Der Download konnte in dieser Umgebung nicht gestartet werden.'; this.host.refreshView(); }
  }

  revokeIncognitoPreview(): void {
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
        this.cvThemePreviewBusy = false; this.host.refreshView();
      },
      error: () => { this.cvThemePreviewBusy = false; this.host.refreshView(); }
    });
  }

  revokeThemePreview(): void {
    if (this.cvThemePreviewObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(this.cvThemePreviewObjectUrl);
    }
    this.cvThemePreviewObjectUrl = undefined;
  }

  runCvAtsCheck(source: 'theme-preview' | 'proposal' = this.cvAtsSource): void {
    const current = this.cvImport;
    if (!current) return;
    this.cvAtsSource = source; this.cvAtsBusy = true; this.cvAtsError = '';
    const mustHave = this.host.config?.searchProfile.mustHave ?? [];
    const niceToHave = this.host.config?.searchProfile.niceToHave ?? [];
    this.api.atsCheckCv(current, source, mustHave, niceToHave).subscribe({
      next: (report) => { this.cvAtsReport = report; this.cvAtsBusy = false; this.host.refreshView(); },
      error: (error) => { this.cvAtsError = this.host.message(error); this.cvAtsBusy = false; this.host.refreshView(); }
    });
  }

  atsLintStatusLabel(status: 'pass' | 'warn' | 'fail'): string {
    return { pass: 'OK', warn: 'Hinweis', fail: 'Problem' }[status];
  }

  cvSelectedApplicationCase(): ApplicationCase | undefined {
    return this.host.applicationCases.find((item) => item.id === this.cvSelectedApplicationCaseId);
  }

  cvApplicationCases(): ApplicationCase[] {
    return this.host.applicationCases.filter((item) => item.documentType === 'cv');
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
      this.host.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = ''; this.cvProposalHtmlUrl = undefined;
    this.api.createCvProposal(
      application.id, current, application.approvedArtifactRevisionId, application.approvedArtifactSha256
    ).subscribe({
      next: (record) => {
        this.applyCvImport(record, true); this.cvBusy = false; this.cvStep = 6;
        this.cvNotice = 'Die proof-verifizierte, freigegebene CV-Dokumentrevision wurde als HTML gerendert.';
        this.loadCvProposalHtml(); this.focusCvStep(); this.host.refreshView();
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
      this.host.refreshView(); return;
    }
    const route = this.api.cvProposalHtmlUrl(current.id, htmlSha256);
    if (!/^\/api\/cv-imports\/[0-9a-f-]{36}\/proposal\.html\?sha256=[a-f0-9]{64}&download=false$/i.test(route)) {
      this.cvError = 'Die HTML-Vorschau verweist nicht auf die erlaubte lokale Proof-Route.';
      this.host.refreshView(); return;
    }
    this.cvProposalHtmlUrl = this.sanitizer.bypassSecurityTrustResourceUrl(route);
    this.host.refreshView();
  }

  startCvAgentOrchestration(): void {
    const application = this.cvSelectedApplicationCase();
    const unavailable = this.cvAgentStartUnavailableReason();
    if (unavailable || !application) { this.cvError = unavailable; this.host.refreshView(); return; }
    const workflow = this.host.agents.agentWorkflows.find((item) => item.id === 'evidence-application-package');
    if (!workflow) return;
    const providerId = this.host.agents.agentOrchestrationForm.providerId || this.host.agents.agentProviders.find((item) => item.available)?.id || '';
    this.cvError = ''; this.host.agents.agentOrchestrationError = '';
    this.host.agents.agentOrchestrationForm = {
      workflowId: workflow.id, providerId,
      prompt: `Erstelle einen belegbasierten ATS-sicheren Lebenslauf für den ausgewählten Bewerbungsfall ${application.id}. Verwende ausschließlich bestätigte CandidateProfile-Claims und die serverseitig gespeicherten Stilvorgaben. Der fünfte Agent liefert die direkt sichtbare finale HTML-Fassung.`,
      runtimeTarget: this.host.agents.agentOrchestrationForm.runtimeTarget,
      ...(this.host.agents.agentOrchestrationForm.runtimeTarget === 'wsl' && this.host.agents.agentOrchestrationForm.wslDistribution
        ? { wslDistribution: this.host.agents.agentOrchestrationForm.wslDistribution } : {}),
      applicationCaseId: application.id, userInputConfirmed: false
    };
    this.host.agents.createAgentOrchestration();
  }

  cvAgentStartUnavailableReason(): string {
    const application = this.cvSelectedApplicationCase();
    if (!this.cvImport?.adoption) return 'Bestätige den aktiven Lebenslaufstand und übernimm ihn danach ins Kandidatenprofil.';
    if (!application || application.documentType !== 'cv') return 'Wähle einen Bewerbungsfall vom Typ Lebenslauf.';
    if (!this.host.agents.agentWorkflows.some((item) => item.id === 'evidence-application-package')) {
      return 'Der versionierte Evidence-Agentenworkflow ist serverseitig nicht verfügbar.';
    }
    const provider = this.host.agents.agentProviders.find((item) => item.id === this.host.agents.agentOrchestrationForm.providerId);
    if (!provider?.available) return 'Wähle einen verfügbaren Agentenprovider.';
    const installation = this.host.agents.selectedAgentOrchestrationInstallation();
    const profileBlock = this.host.agents.agentProfileRuntimeBlockedReason(installation);
    if (profileBlock) return profileBlock;
    if (installation?.support !== 'supported') return 'Wähle eine versionsgenau freigegebene Provider-Laufzeit.';
    return '';
  }

  cvAgentOrchestration(): AgentOrchestrationRecord | undefined {
    if (this.cvAgentOrchestrationId) return this.host.agents.agentOrchestrations.find((item) => item.id === this.cvAgentOrchestrationId)
      ?? (this.host.agents.selectedAgentOrchestration?.id === this.cvAgentOrchestrationId ? this.host.agents.selectedAgentOrchestration : undefined);
    return undefined;
  }

  openCvAgentOrchestration(): void {
    const orchestration = this.cvAgentOrchestration();
    this.host.select('agents');
    if (orchestration) this.host.agents.selectAgentOrchestration(orchestration, false);
  }

  refreshCvAgentStatus(): void {
    this.host.agents.refreshAgentOrchestrations();
    this.host.loadApplicationCases();
  }

  cvAgentStatusBusy(): boolean { return this.host.agents.agentOrchestrationPollInFlight; }

  downloadApprovedCvHtml(): void {
    const current = this.cvImport;
    const proposal = current?.proposal;
    if (!current || !proposal?.downloadAllowed || this.cvBusy) {
      this.cvError = proposal && !proposal.downloadAllowed
        ? 'Der Server sperrt den Download für diese Identität oder Revision.' : 'Keine downloadfähige HTML-Revision vorhanden.';
      this.host.refreshView(); return;
    }
    this.cvBusy = true; this.cvError = '';
    this.api.downloadCvProposal(current.id, proposal.htmlSha256).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = 'lebenslauf.html'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
        this.cvBusy = false; this.cvNotice = 'Die exakt freigegebene HTML-Revision wurde heruntergeladen.'; this.host.refreshView();
      },
      error: (error) => this.failCv(error)
    });
  }

  mutateCvFacts(operations: Parameters<ApiService['reviewCvFacts']>[1], notice: string, afterSuccess?: () => void): void {
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
        if (this.cvImport?.id !== current.id) { this.cvBusy = false; this.host.refreshView(); return; }
        this.applyCvImport(record, true);
        this.cvFactDrafts = { ...this.cvFactDrafts, ...preservedDrafts };
        this.cvBusy = false; this.cvNotice = notice; afterSuccess?.(); this.host.refreshView();
      },
      error: (error) => {
        if (this.cvImport?.id !== current.id) { this.cvBusy = false; this.host.refreshView(); return; }
        this.failCv(error);
      }
    });
  }

  applyCvImport(record: CvImportRecord, preserveStep = false): void {
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
    if (this.host.section === 'cv') setTimeout(() => {
      this.loadCvRecognitionVersions();
      this.loadCvAiStructuringState();
      this.loadCvClaimManagement();
    }, 0);
  }

  cvMimeType(fileName: string): CvImportRecord['source']['mimeType'] | undefined {
    const extension = fileName.toLocaleLowerCase('en-US').match(/\.[^.]+$/)?.[0];
    return ({
      '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.odt': 'application/vnd.oasis.opendocument.text'
    } as const)[extension as '.html' | '.htm' | '.pdf' | '.docx' | '.odt'];
  }

  focusCvStep(): void {
    setTimeout(() => (document.getElementById(`cv-step-heading-${this.cvStep}`) as HTMLElement | null)?.focus(), 0);
  }

  failCv(error: unknown): void {
    this.cvBusy = false; this.cvError = this.host.message(error); this.cvNotice = ''; this.host.refreshView();
  }}
