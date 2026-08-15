import { expect, test as base, type Page, type Route } from '@playwright/test';
import type {
  AgentApproval,
  AgentArtifactContent,
  AgentArtifactRecord,
  AgentConfigProfileView,
  AgentOrchestrationConflict,
  AgentOrchestrationConflictResolution,
  AgentOrchestrationCreateRequest,
  AgentOrchestrationRecord,
  AgentProvider,
  AgentQueueSnapshot,
  AgentRecoveryLease,
  AgentRecoveryRun,
  AgentRun,
  AgentRunEvent,
  AgentRunPreflight,
  AgentRunRequest,
  AgentRunStatus,
  AgentWorkflow,
  AppConfig,
  ApplicationCase,
  ApplicationProfileSetupStatus,
  ApplicationStyleProfileView,
  ArtifactRevision,
  CorrelatedMail,
  CvAiStructuringOptions,
  CvAiStructuringPublicRun,
  CvAiStructuringSuggestion,
  CvFactOperation,
  CvImportRecord,
  CvImportSummary,
  CvRecognitionVersionList,
  CvTheme,
  McpRuntimeStatus
} from '../../src/app/models';

const FIXED_TIME = '2026-08-13T18:00:00.000Z';
const CV_DETERMINISTIC_RECOGNITION_ID = 'recognition-1111111111111111';
const CV_AI_RECOGNITION_ID = 'recognition-2222222222222222';
const CV_RECOGNITION_VERSION_SHA256 = '6'.repeat(64);

const CONFIG: AppConfig = {
  revision: 0,
  searchProfile: {
    name: 'Synthetisches E2E-Profil', query: 'Angular', regions: ['Testregion'], radiusKm: 25,
    workModels: ['hybrid'], employmentTypes: ['full_time'], mustHave: ['TypeScript'], niceToHave: ['Angular'], exclude: [], sourceIds: []
  },
  identities: [
    {
      id: 'fixture-incognito', label: 'E2E-Inkognito', mode: 'incognito', fullName: 'Testperson Beispiel',
      email: 'testperson@example.invalid', phone: '', location: 'Testregion', linkedin: '', placeholders: {}
    },
    {
      id: 'fixture-real', label: 'E2E-Evidence-Profil', mode: 'real', fullName: 'Lokales Testprofil',
      email: 'local-fixture@example.invalid', phone: '', location: 'Testregion', linkedin: '', placeholders: {}
    }
  ],
  activeIdentityId: 'fixture-incognito',
  mcp: {
    mode: 'demo', executionIsolation: 'trusted-host', command: '', args: [],
    env: { ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' },
    configuredEnvironmentKeys: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']
  },
  assistant: { skillPath: '', candidateProfilePath: '', styleProfilePath: '' }
};

const AGENT_CONFIG_PROFILE: AgentConfigProfileView = {
  source: 'primary',
  profile: {
    schemaVersion: 2, profileId: 'safe-default', updatedAt: '2026-08-14T08:00:00.000Z',
    providers: [
      { provider: 'fake', enabled: true, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      { provider: 'fake-interactive', enabled: true, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit' },
      { provider: 'codex-exec', enabled: true, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit' },
      { provider: 'opencode', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      { provider: 'claude-cli', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }
    ],
    budgets: { warningAtPercent: 80, maxTotalTokens: 100_000, maxToolCalls: 100, maxRunDurationMs: 1_800_000 },
    features: { codexAppServerExperimental: false, multiAgentExperimental: true, realtimeWebSocketExperimental: false, rawProviderLogs: false }
  }
};

const PROVIDERS: AgentProvider[] = [{
  id: 'fake-interactive', name: 'Synthetischer Offline-Agent', available: true, version: '1.0.0',
  authStatus: 'not_required', transport: 'fixture-jsonl', note: 'Offline-Fixture ohne Konto, Netzwerk oder persönliche Daten.',
  installations: [
    { runtimeTarget: 'windows', version: '1.0.0', support: 'supported', authStatus: 'not_required', note: 'Synthetische Windows-Laufzeit.' },
    { runtimeTarget: 'wsl', distribution: 'E2E-Ubuntu', version: '1.0.0', support: 'supported', authStatus: 'not_required', note: 'Synthetische WSL-Laufzeit.' }
  ],
  capabilities: { interactiveInput: true, approvals: true, networkControl: false, workspaceModes: ['read_only', 'workspace_write'] }
}];

const WORKFLOWS: AgentWorkflow[] = [
  {
    id: 'guided-job-analysis', version: '1.0.0', title: 'Geführte Stellenanalyse',
    description: 'Analysiert ausschließlich synthetischen Stellenkontext.', requiredScope: 'search_profile',
    producesSuggestionsOnly: true, prohibitedActions: ['submit_application', 'send_message']
  },
  {
    id: 'evidence-application-package', version: '1.0.0', title: 'Evidence-Bewerbungspaket',
    description: 'Prüft ein fallgebundenes synthetisches Bewerbungspaket.', requiredScope: 'application_case',
    producesSuggestionsOnly: true, prohibitedActions: ['submit_application', 'send_message']
  },
  {
    id: 'employer-response-triage', version: '1.0.0', title: 'Arbeitgeberantworten einordnen',
    description: 'Ordnet lokal korrelierte synthetische Antworten ein.', requiredScope: 'application_case',
    producesSuggestionsOnly: true, prohibitedActions: ['send_message', 'schedule_event']
  },
  {
    id: 'application-next-actions', version: '1.0.0', title: 'Firmenweite nächste Schritte',
    description: 'Plant lokale synthetische nächste Schritte.', requiredScope: 'company',
    producesSuggestionsOnly: true, prohibitedActions: ['send_message', 'submit_application']
  }
];

const PIPELINE_CASE: ApplicationCase = {
  id: '11111111-1111-4111-8111-111111111111',
  job: {
    id: 'fixture-job-pipeline', sourceId: 'fixture', title: 'Angular Engineer', company: 'Beispiel GmbH', location: 'Testregion',
    workModel: 'hybrid', employmentType: 'full_time', description: 'Rein synthetischer Offline-Stellenkontext.', skills: ['Angular', 'TypeScript']
  },
  identityId: 'fixture-real', identityMode: 'real', documentType: 'cover_letter', state: 'review',
  createdAt: FIXED_TIME, updatedAt: FIXED_TIME, revision: 4, artifactNames: [], warnings: []
};

const STYLE_PROFILE: ApplicationStyleProfileView = {
  contract: 'application-style-profile', contractVersion: '1.0', revision: 3, sha256: '8'.repeat(64), initialized: true,
  languageBackend: { backend: 'nspell', localOnly: true, remoteServiceAllowed: false },
  profile: {
    language: 'Deutsch', locale: 'de-DE', tone: 'klar und respektvoll', formality: 'professionell', directness: 'direkt',
    sentenceLength: 'kurz bis mittel', technicalDepth: 'konkret', enthusiasm: 'zurückhaltend', selfPromotion: 'belegbasiert', humor: 'sparsam',
    vocabulary: { prefer: ['umgesetzt', 'belegt'], avoid: ['Guru', 'Rockstar'] },
    preferredPatterns: ['Ergebnis vor Behauptung'], avoidPatterns: ['Übertriebene Superlative'],
    documentStyles: {
      cv: { perspective: 'fragmentarisch', technicalDensity: 'hoch', maxSentenceWords: 22 },
      cover_letter: { perspective: 'erste Person', technicalDensity: 'mittel', maxSentenceWords: 26 },
      email: { perspective: 'erste Person', technicalDensity: 'niedrig', maxSentenceWords: 20 },
      linkedin: { perspective: 'erste Person', technicalDensity: 'mittel', maxSentenceWords: 24 }
    },
    personalizationDefault: 'professional', approvedExamples: [], rejectedExamples: [],
    qualityThresholds: { maxRepeatedSentenceStarts: 2, maxAvoidPatternMatches: 0 },
    reviewWorkflow: { defaultMode: 'standard', maxRevisionCycles: 3, preferIndependentAgents: true }
  }
};

function cvImportRecord(): CvImportRecord {
  const sourceSha256 = '6'.repeat(64);
  return {
    contract: 'cv-import', contractVersion: '1.0',
    id: '66666666-6666-4666-8666-666666666666', revision: 1, sha256: '7'.repeat(64), status: 'facts_pending',
    createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
    source: {
      fileName: 'synthetischer-cv.html', mimeType: 'text/html', bytes: 64, sha256: sourceSha256,
      retention: 'upload_deleted_after_local_extraction'
    },
    facts: [
      {
        id: 'fact-employer', category: 'employment', recordId: 'employment-fixture', field: 'company', value: 'Beispiel GmbH',
        decision: 'pending', provenance: { sourceSha256, anchor: 'Zeile 2', origin: 'imported' }
      },
      {
        id: 'fact-period', category: 'employment', recordId: 'employment-fixture', field: 'period', value: '2022–2026',
        decision: 'pending', provenance: { sourceSha256, anchor: 'Zeile 3', origin: 'imported' }
      }
    ],
    warnings: ['Synthetische Zeitangabe bitte einzeln prüfen.'],
    activeRecognitionVersionId: CV_DETERMINISTIC_RECOGNITION_ID
  };
}

function cvImportSummary(record: CvImportRecord): CvImportSummary {
  const factCount = (decision: 'pending' | 'confirmed' | 'rejected') => record.facts.filter((fact) => fact.decision === decision).length;
  return {
    contract: 'cv-import-summary', contractVersion: '1.0', id: record.id, revision: record.revision, sha256: record.sha256,
    status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, source: clone(record.source),
    factCounts: {
      total: record.facts.length, pending: factCount('pending'), confirmed: factCount('confirmed'), rejected: factCount('rejected')
    },
    warningCount: record.warnings.length, unresolvedConflictCount: 0,
    hasTheme: Boolean(record.theme), hasLayoutFingerprint: Boolean(record.layoutFingerprint),
    hasAdoption: Boolean(record.adoption), hasProposal: Boolean(record.proposal)
  };
}

function cvAiOptions(record: CvImportRecord): CvAiStructuringOptions {
  return {
    contract: 'cv-ai-structuring-options', contractVersion: '1.0', capturedAt: FIXED_TIME,
    cvImport: { id: record.id, revision: record.revision, sha256: record.sha256 },
    providers: [{
      providerId: 'fake-interactive', installations: [{
        runtimeTarget: 'windows', version: '1.0.0', adapterVersion: 'fixture-1', support: 'supported',
        authStatus: 'not_required', ready: true, blockers: [],
        network: {
          toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false,
          providerControlPlane: 'provider_managed_may_use_network'
        }
      }]
    }],
    disclosure: {
      required: true, version: '1.0', extractedCvTextSentToSelectedProvider: true,
      toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false,
      providerControlPlane: 'provider_managed_may_use_network'
    }
  };
}

function cvAiSuggestions(): CvAiStructuringSuggestion[] {
  const anchor = (line: number, quote: string) => ({
    lineStart: line, lineEnd: line, charStart: 0, charEnd: quote.length, quote
  });
  return [
    {
      id: 'suggestion-1111111111111111', path: 'experience[0].employer', collection: 'experience', recordId: 'employment-fixture',
      field: 'employer', category: 'employment', mergeable: true, value: 'Beispiel GmbH', sourceAnchor: anchor(2, 'Beispiel GmbH'),
      confidence: .96, alternatives: [], questions: [], status: 'unverified'
    },
    {
      id: 'suggestion-2222222222222222', path: 'experience[0].role', collection: 'experience', recordId: 'employment-fixture',
      field: 'role', category: 'employment', mergeable: true, value: 'Entwickler', sourceAnchor: anchor(2, 'Entwickler'),
      confidence: .63, alternatives: [{
        id: 'alternative-aaaaaaaaaaaaaaaa', value: 'Senior Entwickler', sourceAnchor: anchor(2, 'Senior Entwickler'), confidence: .57
      }], questions: ['Ist „Senior Entwickler“ die belegte Rollenbezeichnung?'], status: 'unverified'
    },
    {
      id: 'suggestion-3333333333333333', path: 'experience[0].start_date', collection: 'experience', recordId: 'employment-fixture',
      field: 'start_date', category: 'employment', mergeable: true, value: '2022-01', sourceAnchor: anchor(3, '01/2022'),
      confidence: .91, alternatives: [], questions: [], status: 'unverified'
    },
    {
      id: 'suggestion-4444444444444444', path: 'experience[0].end_date', collection: 'experience', recordId: 'employment-fixture',
      field: 'end_date', category: 'employment', mergeable: true, value: 'present', sourceAnchor: anchor(3, 'heute'),
      confidence: .89, alternatives: [], questions: [], status: 'unverified'
    },
    {
      id: 'suggestion-5555555555555555', path: 'experience[0].location', collection: 'experience', recordId: 'employment-fixture',
      field: 'location', category: 'employment', mergeable: true, value: 'Testregion', sourceAnchor: anchor(4, 'Testregion'),
      confidence: .82, alternatives: [], questions: [], status: 'unverified'
    },
    {
      id: 'suggestion-6666666666666666', path: 'sections[0].heading', collection: 'sections', recordId: null,
      field: 'heading', category: 'additional', mergeable: false, sectionKind: 'unclassified', value: null, sourceAnchor: null,
      confidence: .28, alternatives: [], questions: ['Welchem Lebenslaufabschnitt gehört diese Passage an?'], status: 'unverified'
    }
  ];
}

function cvAiRun(
  record: CvImportRecord,
  input: { attempt?: number; retryOf?: string; provider?: Record<string, unknown>; mode?: CvAiStructuringPublicRun['mode'] } = {}
): CvAiStructuringPublicRun {
  const provider = input.provider ?? {};
  return {
    contract: 'cv-ai-structuring-run', contractVersion: '1.0',
    id: input.attempt === 2 ? '99999999-9999-4999-8999-999999999999' : '88888888-8888-4888-8888-888888888888',
    cvImportId: record.id, revision: 1, sha256: 'a'.repeat(64), status: 'queued',
    mode: input.mode ?? 'replace_with_ai_version', attempt: input.attempt ?? 1,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    createdAt: FIXED_TIME, updatedAt: FIXED_TIME, expiresAt: '2026-08-14T18:00:00.000Z',
    provider: {
      id: String(provider['providerId'] ?? 'fake-interactive'),
      runtimeTarget: (provider['runtimeTarget'] ?? 'windows') as 'windows',
      ...(typeof provider['wslDistribution'] === 'string' ? { wslDistribution: provider['wslDistribution'] } : {}),
      version: String(provider['expectedVersion'] ?? '1.0.0'), adapterVersion: 'fixture-1'
    },
    disclosure: {
      version: '1.0', confirmedAt: FIXED_TIME, confirmedBy: { id: 'local-user', type: 'local' },
      extractedCvTextShared: true, providerControlPlaneNetworkAcknowledged: true,
      toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false
    },
    binding: {
      cvImportRevision: record.revision, cvImportSha256: record.sha256, sourceId: 'source-cv-1111111111111111',
      sourceSha256: record.source.sha256, extractedTextSha256: 'b'.repeat(64), baseProposalSha256: 'c'.repeat(64),
      lineManifestSha256: 'd'.repeat(64), promptTemplateVersion: 'cv-ai-structuring/1.0', promptSha256: 'e'.repeat(64),
      outputContractVersion: '1.0', outputSchemaSha256: 'f'.repeat(64), inputSha256: '1'.repeat(64)
    },
    auditTrail: [{ sequence: 1, occurredAt: FIXED_TIME, action: 'started' }]
  };
}

function pipelineRevision(lifecycle: ArtifactRevision['lifecycle'] = 'proposed'): ArtifactRevision {
  const sha256 = 'a'.repeat(64);
  return {
    id: '22222222-2222-4222-8222-222222222222', applicationCaseId: PIPELINE_CASE.id, companyKey: 'beispiel',
    jobId: PIPELINE_CASE.job.id, type: 'cover_letter', lifecycle, sha256, bytes: 1200,
    artifactPath: '.application-work/fixture/application.txt', pipelineContractVersion: '1.0.0', createdAt: FIXED_TIME,
    pipelineProof: {
      contract: 'application-pipeline-proof', contractVersion: '1.0', pipelineContractVersion: '1.0.0',
      applicationCaseId: PIPELINE_CASE.id, jobId: PIPELINE_CASE.job.id, identityId: PIPELINE_CASE.identityId,
      documentType: 'cover_letter', issuedAt: FIXED_TIME, signature: 'fixture-signature',
      completedStages: ['validate_profiles', 'analyze_job', 'build_match_matrix', 'questions_reviewed', 'validate_iteration', 'audit_claims', 'check_style'],
      annotatedSha256: 'b'.repeat(64), iterationManifestSha256: 'c'.repeat(64), candidateProfileSha256: 'd'.repeat(64),
      styleProfileSha256: 'e'.repeat(64), artifactSha256: sha256,
      languageCheck: { available: true, backend: 'nspell-local', language: 'de-DE', issueCount: 1, issuesSha256: 'f'.repeat(64), checkedArtifactSha256: sha256 },
      preparation: { jobAnalysisSha256: '1'.repeat(64), matchMatrixSha256: '2'.repeat(64), unresolvedQuestionsSha256: '3'.repeat(64), matchMatrixValid: true }
    },
    ...(lifecycle === 'approved' || lifecycle === 'used' ? {
      review: { decision: 'approved' as const, reviewer: 'local-user' as const, reviewedAt: FIXED_TIME, expectedSha256: sha256, acknowledgedLanguageIssueCount: 1 }
    } : {})
  };
}

function clone<T>(value: T): T { return structuredClone(value); }

function event(sequence: number, type: string, message: string, level: AgentRunEvent['level'] = 'info'): AgentRunEvent {
  return { sequence, type, timestamp: FIXED_TIME, correlationId: 'fixture-correlation', message, level };
}

function runFixture(id: string, status: AgentRunStatus, prompt: string, pendingApprovals: AgentApproval[] = []): AgentRun {
  return {
    id, providerId: 'fake-interactive', status,
    request: {
      providerId: 'fake-interactive', prompt, runtimeTarget: 'windows', workspaceMode: 'read_only', network: false,
      workflowId: 'guided-job-analysis', budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    },
    createdAt: FIXED_TIME, updatedAt: FIXED_TIME, startedAt: FIXED_TIME,
    usage: { inputTokens: 120, outputTokens: 42, toolCalls: 1, durationMs: 2_500, cost: 0, currency: 'EUR' },
    pendingApprovals, lastEventSequence: 0,
    providerVersion: '1.0.0', workflowVersion: '1.0.0', policyVersion: 'fixture-policy-1',
    contextSummary: { scope: 'synthetic-workspace', sourceCount: 1, redactedHash: 'fixture-redacted-witness' }
  };
}

export class AgentApiStub {
  readonly configSaveRequests: AppConfig[] = [];
  readonly agentConfigProfileSaveRequests: Array<Record<string, unknown>> = [];
  readonly providerRefreshRequests: string[] = [];
  readonly portalAccessRequests: Array<{ enabled: boolean; confirmed: boolean; expectedRevision: number }> = [];
  readonly preflightRequests: AgentRunRequest[] = [];
  readonly createRequests: AgentRunRequest[] = [];
  readonly inputRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly approvalRequests: Array<{ runId: string; approvalId: string; body: Record<string, unknown> }> = [];
  readonly cancelRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly recoveryLeaseRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly recoveryResolveRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly profileSetupRequests: Array<{ confirmed: boolean }> = [];
  readonly styleProfileUpdateRequests: Array<Record<string, unknown>> = [];
  readonly languageCheckRequests: Array<{ content: string; language: string }> = [];
  readonly pipelineFinalizeRequests: Array<{ caseId: string; body: Record<string, unknown> }> = [];
  readonly artifactReviewRequests: Array<{ caseId: string; revisionId: string; body: Record<string, unknown> }> = [];
  readonly artifactExportRequests: Array<{ caseId: string; body: Record<string, unknown> }> = [];
  readonly applicationTransitionRequests: Array<{ caseId: string; body: Record<string, unknown> }> = [];
  readonly agentArtifactReviewRequests: Array<{ runId: string; artifactId: string; body: Record<string, unknown> }> = [];
  readonly agentArtifactAdoptionRequests: Array<{ runId: string; artifactId: string; body: Record<string, unknown> }> = [];
  readonly orchestrationCreateRequests: AgentOrchestrationCreateRequest[] = [];
  readonly orchestrationContinueRequests: Array<{ orchestrationId: string; body: Record<string, unknown> }> = [];
  readonly orchestrationCancelRequests: Array<{ orchestrationId: string; body: Record<string, unknown> }> = [];
  readonly orchestrationConflictResolveRequests: Array<{ orchestrationId: string; conflictId: string; body: Record<string, unknown> }> = [];
  readonly cvImportRequests: Array<Record<string, unknown>> = [];
  readonly cvFactReviewRequests: Array<Record<string, unknown>> = [];
  readonly cvImportListRequests: string[] = [];
  readonly cvImportDeleteRequests: Array<Record<string, unknown>> = [];
  readonly cvThemeRequests: Array<Record<string, unknown>> = [];
  readonly cvAdoptionRequests: Array<Record<string, unknown>> = [];
  readonly cvRecognitionVersionListRequests: string[] = [];
  readonly cvRecognitionVersionActivationRequests: Array<{ versionId: string; body: Record<string, unknown> }> = [];
  readonly cvRecognitionVersionConfirmationRequests: Array<{ versionId: string; body: Record<string, unknown> }> = [];
  readonly cvAiOptionsRequests: string[] = [];
  readonly cvAiRunListRequests: string[] = [];
  readonly cvAiStartRequests: Array<Record<string, unknown>> = [];
  readonly cvAiRunGetRequests: string[] = [];
  readonly cvAiCancelRequests: Array<Record<string, unknown>> = [];
  readonly cvAiRetryRequests: Array<Record<string, unknown>> = [];
  readonly cvAiApplyRequests: Array<Record<string, unknown>> = [];
  readonly cvHtmlRenderRequests: Array<{ caseId: string; body: Record<string, unknown> }> = [];
  readonly cvHtmlDownloadRequests: string[] = [];
  readonly unknownRequests: string[] = [];
  readonly externalRequests: string[] = [];

  private config = clone(CONFIG);
  private agentConfigProfileView = clone(AGENT_CONFIG_PROFILE);
  private rejectNextAgentConfigProfileSave = false;
  private rejectNextOrchestrationConflictResolve = false;
  private profileSetup: ApplicationProfileSetupStatus = {
    contract: 'application-profile-setup', contractVersion: '1.0', candidateProfile: 'present', styleProfile: 'present', initialized: true,
    containsCandidateFacts: true, note: 'Synthetische lokale Evidence- und Stilprofile sind bereit.'
  };
  private styleProfile = clone(STYLE_PROFILE);
  private languageBackendAvailable = true;
  private runtimeStatus: McpRuntimeStatus = {
    contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'demo', state: 'demo',
    launchValidated: false, connected: false, note: 'Deterministischer Offline-Demomodus ohne externen Zugriff.'
  };
  private readonly runs = new Map<string, AgentRun>();
  private readonly events = new Map<string, AgentRunEvent[]>();
  private readonly applicationCases = new Map<string, ApplicationCase>();
  private readonly applicationArtifacts = new Map<string, ArtifactRevision[]>();
  private mailMessages: CorrelatedMail[] = [];
  private readonly agentArtifacts = new Map<string, AgentArtifactRecord[]>();
  private readonly agentArtifactContents = new Map<string, AgentArtifactContent>();
  private readonly orchestrations = new Map<string, AgentOrchestrationRecord>();
  private readonly pendingOrchestrationCompletions = new Map<string, AgentOrchestrationRecord>();
  private createdOrchestrations = 0;
  private readonly recoveries = new Map<string, AgentRecoveryRun>();
  private readonly recoveryLeases = new Map<string, AgentRecoveryLease>();
  private cvImport?: CvImportRecord;
  private cvRecognitionVersions?: CvRecognitionVersionList;
  private readonly cvRecognitionFacts = new Map<string, CvImportRecord['facts']>();
  private rejectNextCvRecognitionActivation = false;
  private failNextCvAiRun = false;
  private readonly failedCvAiRuns = new Set<string>();
  private readonly cvAiRuns = new Map<string, CvAiStructuringPublicRun>();
  private createdCvFacts = 0;
  private createdRuns = 0;
  private readonly queueSnapshot: AgentQueueSnapshot = {
    capturedAt: '2026-08-14T08:00:00.000Z', depth: 1, active: 2,
    limits: { global: 3, perProvider: 1, perWorkspace: 1, perOwner: 2, queuedGlobal: 20, queuedPerWorkspace: 4, queuedPerOwner: 5 },
    activeByProvider: { 'fake-interactive': 1, 'fixture-reviewer': 1 },
    activeByWorkspace: { 'X:\\Synthetic\\Fixture\\Workspace': 1, 'X:\\Synthetic\\Fixture\\Review': 1 },
    activeByOwner: { 'fixture-owner': 2 },
    queue: [{
      runId: 'fixture-queued-diagnostic', provider: 'fake-interactive', workspaceRoot: 'X:\\Synthetic\\Fixture\\Workspace', ownerId: 'fixture-owner',
      position: 1, basePriority: 20, effectivePriority: 35, waitMs: 65_000, blockedBy: ['provider_limit', 'workspace_limit']
    }]
  };

  async install(page: Page): Promise<void> {
    await page.route(/^https?:\/\/(?!(?:127\.0\.0\.1|localhost)(?::\d+)?\/)/i, async (route) => {
      this.externalRequests.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await page.route('**/api/**', (route) => this.handle(route));
  }

  seedReadyMcpRuntime(): void {
    this.config.mcp = {
      mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'windows',
      command: 'X:\\Synthetic\\job-search-mcp\\runtime.exe', args: [],
      env: { ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' },
      configuredEnvironmentKeys: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']
    };
    this.runtimeStatus = {
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'ready_to_connect',
      runtimeTarget: 'windows', launchValidated: true, connected: false,
      note: 'Synthetischer Windows-Startpfad wurde validiert; es besteht noch keine Protokollverbindung.'
    };
  }

  seedInvalidMcpRuntime(): void {
    this.seedReadyMcpRuntime();
    this.runtimeStatus = {
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'invalid',
      runtimeTarget: 'windows', launchValidated: false, connected: false,
      note: 'Der synthetische Startpfad ist absichtlich ungültig.'
    };
  }

  seedMissingProfileSetup(): void {
    this.profileSetup = {
      contract: 'application-profile-setup', contractVersion: '1.0', candidateProfile: 'missing', styleProfile: 'missing', initialized: false,
      containsCandidateFacts: false, note: 'Synthetische lokale Profile fehlen noch.'
    };
  }

  seedAgentProviderDisabled(providerId = 'fake-interactive'): void {
    const provider = this.agentConfigProfileView.profile.providers.find((item) => item.provider === providerId);
    if (provider) provider.enabled = false;
  }

  seedAgentProviderRuntime(providerId: string, runtimeTarget: 'windows' | 'wsl' | 'linux' | 'darwin', wslDistribution?: string): void {
    const provider = this.agentConfigProfileView.profile.providers.find((item) => item.provider === providerId);
    if (!provider) return;
    provider.runtimeTarget = runtimeTarget;
    provider.wslDistribution = runtimeTarget === 'wsl' ? wslDistribution : undefined;
  }

  seedStaleAgentConfigProfileSave(): void { this.rejectNextAgentConfigProfileSave = true; }
  seedStaleOrchestrationConflictResolve(): void { this.rejectNextOrchestrationConflictResolve = true; }
  seedStaleCvRecognitionActivation(): void { this.rejectNextCvRecognitionActivation = true; }
  seedFailedCvAiStructuring(): void { this.failNextCvAiRun = true; }

  seedLastKnownGoodAgentConfig(): void {
    this.agentConfigProfileView = {
      ...this.agentConfigProfileView,
      source: 'last_known_good',
      primaryError: 'Synthetisches Primärprofil ist ungültig; keine Pfad- oder Secretdetails offengelegt.'
    };
  }

  seedUnassignedMail(): { application: ApplicationCase; message: CorrelatedMail } {
    const application = this.seedPipelineCase();
    const message: CorrelatedMail = {
      id: '55555555-5555-4555-8555-555555555555', accountId: 'fixture-mail-account',
      from: ['synthetic-employer@example.invalid'], to: ['local-fixture@example.invalid'],
      subject: 'Synthetische Rückfrage', sentAt: FIXED_TIME,
      text: 'UNTRUSTED_FIXTURE_BODY_DARF_NICHT_IM_AGENTENAUFTRAG_STEHEN', source: 'eml', responseKind: 'question',
      calendarEvents: [], correlation: { confidence: 0.4, reasons: ['synthetischer Firmenhinweis'], confirmed: false }
    };
    this.mailMessages = [message];
    return { application, message: clone(message) };
  }

  seedUnresolvedOrchestrationConflict(): { orchestration: AgentOrchestrationRecord; conflict: AgentOrchestrationConflict } {
    const application = this.seedPipelineCase();
    const id = '77777777-7777-4777-8777-777777777777';
    const base = this.buildOrchestration(id, {
      workflowId: 'evidence-application-package', providerId: 'fake-interactive',
      prompt: 'Synthetischen ATS-/Stil-Fan-in fachlich auflösen', runtimeTarget: 'windows',
      applicationCaseId: application.id
    });
    const atsArtifact = {
      outputRef: 'ats_review', artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId: 'fixture-orchestration-ats',
      sha256: 'a'.repeat(64), lifecycle: 'proposed' as const
    };
    const styleArtifact = {
      outputRef: 'style_review', artifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runId: 'fixture-orchestration-style',
      sha256: 'b'.repeat(64), lifecycle: 'proposed' as const
    };
    const conflict: AgentOrchestrationConflict = {
      id: 'ats-style-finalizer-1', targetNodeId: 'finalizer', kind: 'ats_style_fan_in', status: 'unresolved',
      requiresDomainResolution: true, variantsSha256: 'c'.repeat(64),
      variants: [
        { sourceNodeId: 'ats', sourceRole: 'ats_reviewer', outputRef: atsArtifact.outputRef, runId: atsArtifact.runId, artifactId: atsArtifact.artifactId, sha256: atsArtifact.sha256 },
        { sourceNodeId: 'style', sourceRole: 'recruiter_style_reviewer', outputRef: styleArtifact.outputRef, runId: styleArtifact.runId, artifactId: styleArtifact.artifactId, sha256: styleArtifact.sha256 }
      ]
    };
    const orchestration: AgentOrchestrationRecord = {
      ...base, revision: 3, status: 'waiting_for_gate', unresolvedGates: [], conflicts: [conflict],
      resolvedGates: [...base.resolvedGates, {
        nodeId: 'finalizer', gate: 'user_input', authority: 'server_revision_confirmation', bindingSha256: '8'.repeat(64)
      }],
      nodes: base.nodes.map((node) => node.nodeId === 'ats'
        ? { ...node, artifacts: [atsArtifact] }
        : node.nodeId === 'style'
          ? { ...node, artifacts: [styleArtifact] }
          : node.nodeId === 'finalizer'
            ? { ...node, status: 'pending' as const, attempts: 0, runIds: [], artifacts: [] }
            : node),
      artifactRefs: [...base.artifactRefs, atsArtifact, styleArtifact]
    };
    this.orchestrations.set(id, orchestration);
    return { orchestration: clone(orchestration), conflict: clone(conflict) };
  }

  seedNextActionsProposal(): { orchestration: AgentOrchestrationRecord; artifact: AgentArtifactRecord } {
    const application = this.seedPipelineCase();
    const id = '88888888-8888-4888-8888-888888888888';
    const base = this.buildOrchestration(id, {
      workflowId: 'application-next-actions', providerId: 'fake-interactive', prompt: 'Firmenweite nächste Schritte nur vorschlagen',
      runtimeTarget: 'windows', applicationCaseId: application.id
    });
    const run = runFixture('fixture-orchestration-next-actions', 'succeeded', 'Firmenweite nächste Schritte als Vorschlag erzeugen');
    run.request = { ...run.request, workflowId: 'application-next-actions', applicationCaseId: application.id };
    run.output = 'Strikt typisierte nächste Schritte wurden nur als Vorschlag erzeugt.';
    const artifact: AgentArtifactRecord = {
      schemaVersion: 1, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'application-next-actions-proposal',
      sha256: 'f'.repeat(64), bytes: 320, mediaType: 'application/json', createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
      revision: 1, lifecycle: 'proposed', contentState: 'available',
      provenance: {
        runId: run.id, provider: run.providerId, providerVersion: '1.0.0', adapterVersion: 'fixture-adapter-1',
        templateId: 'application-next-actions', templateVersion: '1.0.0', workflowId: 'application-next-actions', workflowVersion: '1.0.0',
        applicationCaseId: application.id, applicationCaseRevision: application.revision, jobId: application.job.id,
        companyKey: 'beispiel', identityMode: application.identityMode
      }
    };
    const reference = { outputRef: 'suggestions', artifactId: artifact.id, runId: run.id, sha256: artifact.sha256, lifecycle: 'proposed' as const };
    const orchestration: AgentOrchestrationRecord = {
      ...base, status: 'succeeded', revision: 2, finishedAt: FIXED_TIME,
      nodes: base.nodes.map((node) => ({ ...node, status: 'succeeded' as const, attempts: 1, runIds: [run.id], artifacts: [reference] })),
      nodeRunIds: { 'next-actions': [run.id] }, artifactRefs: [reference]
    };
    this.seed(run, [event(1, 'run_started', 'Next-actions-Node gestartet.'), event(2, 'artifact_created', 'Typisierte nächste Schritte vorgeschlagen.'), event(3, 'run_completed', 'Next-actions-Node erfolgreich.')]);
    this.agentArtifacts.set(run.id, [artifact]);
    this.agentArtifactContents.set(`${run.id}:${artifact.id}`, {
      id: artifact.id, sha256: artifact.sha256, mediaType: artifact.mediaType,
      content: JSON.stringify({
        contract: 'application-next-actions-proposal', contractVersion: '1.0', sha256: '1'.repeat(64),
        proposal: {
          schemaVersion: 1, companyKey: 'beispiel',
          suggestions: [{
            id: 'follow-up-fixture', applicationCaseId: application.id, kind: 'follow_up', title: 'Manuelles Follow-up prüfen',
            reason: 'Seit der letzten synthetischen Rückmeldung sind sieben Tage vergangen.', confidence: 0.78,
            sourceReferences: [`case:${application.id}`, 'tracking:fixture-event'], dueAt: '2026-08-21T09:00:00.000Z'
          }],
          conflicts: [{
            id: 'timeline-fixture', kind: 'timeline_overlap', applicationCaseIds: [application.id],
            reason: 'Ein synthetischer Termin überschneidet sich mit einem Follow-up.', sourceReferences: ['tracking:fixture-event']
          }]
        }
      })
    });
    this.orchestrations.set(id, orchestration);
    return { orchestration: clone(orchestration), artifact: clone(artifact) };
  }

  seedPipelineCase(): ApplicationCase {
    const application = clone(PIPELINE_CASE);
    this.applicationCases.set(application.id, application);
    this.applicationArtifacts.set(application.id, []);
    return clone(application);
  }

  seedCvPipelineCase(): ApplicationCase {
    const application: ApplicationCase = { ...clone(PIPELINE_CASE), documentType: 'cv' };
    this.applicationCases.set(application.id, application);
    this.applicationArtifacts.set(application.id, []);
    return clone(application);
  }

  approveCvCaseForHtml(caseId: string): ApplicationCase {
    const current = this.applicationCases.get(caseId);
    if (!current || current.documentType !== 'cv') throw new Error(`Unbekannter CV-Fixture-Fall ${caseId}`);
    const approved: ApplicationCase = {
      ...current, state: 'approved', revision: current.revision + 1, updatedAt: FIXED_TIME,
      approvedArtifactRevisionId: '22222222-2222-4222-8222-222222222222',
      approvedArtifactSha256: 'a'.repeat(64), approvedAt: FIXED_TIME
    };
    this.applicationCases.set(caseId, approved);
    return clone(approved);
  }

  seedUnavailableLanguageBackend(): void { this.languageBackendAvailable = false; }

  seedPipelineCaseWithApprovedRevision(): { application: ApplicationCase; revision: ArtifactRevision } {
    const application = this.seedPipelineCase();
    const revision = pipelineRevision('approved');
    this.applicationArtifacts.set(application.id, [revision]);
    return { application, revision: clone(revision) };
  }

  seedAgentPipelinePackageRun(): { run: AgentRun; artifact: AgentArtifactRecord; application: ApplicationCase } {
    const application = this.seedPipelineCase();
    const run = runFixture('fixture-agent-package', 'succeeded', 'Synthetisches Pipeline-Paket als Vorschlag prüfen');
    run.request = {
      ...run.request, workflowId: 'evidence-application-package', applicationCaseId: application.id
    };
    run.output = 'Ein fallgebundenes Pipeline-Paket liegt als Vorschlag vor.';
    const artifact: AgentArtifactRecord = {
      schemaVersion: 1, id: 'fixture-agent-artifact', kind: 'application-pipeline-package', sha256: '8'.repeat(64), bytes: 256,
      mediaType: 'application/json', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, revision: 1, lifecycle: 'proposed', contentState: 'available',
      provenance: {
        runId: run.id, provider: run.providerId, providerVersion: '1.0.0', adapterVersion: 'fixture-adapter-1',
        templateId: 'application-pipeline-package', templateVersion: '1.0.0', workflowId: 'evidence-application-package', workflowVersion: '1.0.0',
        applicationCaseId: application.id, applicationCaseRevision: application.revision, jobId: application.job.id,
        companyKey: 'beispiel', identityMode: 'real'
      }
    };
    this.seed(run, [event(1, 'run_started', 'Fixture-Paketlauf gestartet.'), event(2, 'artifact_created', 'Pipeline-Paket als Vorschlag gespeichert.'), event(3, 'run_completed', 'Fixture-Paketlauf beendet.')]);
    this.agentArtifacts.set(run.id, [artifact]);
    this.agentArtifactContents.set(`${run.id}:${artifact.id}`, {
      id: artifact.id, sha256: artifact.sha256, mediaType: artifact.mediaType,
      content: JSON.stringify({ annotatedContent: 'Synthetischer belegter Inhalt.', iterationManifest: '{"reviews":["evidence","ats","finalizer"]}' })
    });
    return { run: clone(run), artifact: clone(artifact), application };
  }

  seedRunningRun(id = 'fixture-running'): AgentRun {
    const run = runFixture(id, 'running', 'Synthetischen Projektstand nachvollziehbar prüfen');
    this.seed(run, [
      event(1, 'run_started', 'Offline-Run wurde gestartet.'),
      event(2, 'tool_started', 'Read-only Analysewerkzeug wurde aufgerufen.'),
      event(3, 'tool_completed', 'Analysewerkzeug wurde ohne externe Aktion beendet.')
    ]);
    return clone(run);
  }

  seedWaitingForInputRun(id = 'fixture-interactive'): AgentRun {
    const run = runFixture(id, 'waiting_for_input', 'Rückfrage und Freigabe kontrolliert prüfen');
    this.seed(run, [
      event(1, 'run_started', 'Interaktiver Offline-Run wurde gestartet.'),
      event(2, 'input_requested', 'Welche synthetische Prüftiefe soll verwendet werden?', 'warning')
    ]);
    return clone(run);
  }

  seedVisualRun(): AgentRun {
    const approval: AgentApproval = {
      id: 'fixture-approval-visual', kind: 'workspace_write', title: 'Synthetische Dateiänderung prüfen',
      description: 'Diese Freigabe verändert ausschließlich den lokalen Fixture-Zustand.', risk: 'medium',
      target: 'fixture/workspace/result.txt', diff: '+ synthetische Prüfnotiz', expectedRevision: 3,
      requestedAt: FIXED_TIME, expiresAt: '2099-08-13T19:00:00.000Z', status: 'pending'
    };
    const run = runFixture('fixture-visual', 'waiting_for_approval', 'Agent Center visuell und barrierefrei prüfen', [approval]);
    run.request.runtimeTarget = 'wsl';
    run.request.wslDistribution = 'E2E-Ubuntu';
    this.seed(run, [
      event(1, 'run_started', 'Synthetischer visueller Run wurde gestartet.'),
      event(2, 'assistant_message', 'Die lokale Analyse ist abgeschlossen.'),
      event(3, 'approval_requested', 'Eine ausdrückliche Fixture-Freigabe ist erforderlich.', 'warning')
    ]);
    this.seedRecoveryRun('fixture-orphan-visual');
    return clone(run);
  }

  seedRecoveryRun(id = 'fixture-orphan'): AgentRun {
    const run = runFixture(id, 'orphaned', 'Verwaisten synthetischen Run sicher entscheiden');
    this.seed(run, [
      event(1, 'run_started', 'Früherer Fixture-Prozess wurde gestartet.'),
      event(2, 'tool_started', 'Synthetischer Providerprozess war aktiv.'),
      event(3, 'warning', 'Serverneustart hat den Run als verwaist markiert.', 'warning')
    ]);
    this.recoveries.set(id, {
      runId: id, state: 'orphaned', provider: 'fake-interactive', providerSessionPresent: true,
      processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume']
    });
    return clone(run);
  }

  seedLargeTimelineRun(id = 'fixture-large'): AgentRun {
    const run = runFixture(id, 'running', 'Große synthetische Timeline prüfen');
    const events = Array.from({ length: 450 }, (_, index) => {
      const sequence = index + 1;
      const type = sequence % 3 === 0 ? 'tool_output' : sequence % 3 === 1 ? 'agent_message_completed' : 'usage_updated';
      const message = sequence === 25 ? 'needle-event-025 mit testperson@example.invalid und token=fixture-secret' : `Synthetisches Timeline-Ereignis ${sequence}`;
      return event(sequence, type, message, sequence % 50 === 0 ? 'warning' : 'info');
    });
    this.seed(run, events);
    return clone(run);
  }

  seedApprovalInboxRuns(): AgentRun[] {
    const actionable = runFixture('fixture-approval-actionable', 'waiting_for_approval', 'Globale Freigabe prüfen', [{
      id: 'approval-actionable', kind: 'external_write', title: 'Externe Fixture-Aktion', risk: 'external_write',
      description: 'Nur ein synthetisches Ziel wird geprüft.', target: 'fixture://company/example', diff: '+ fixture proposal',
      expectedRevision: 2, requestedAt: FIXED_TIME, expiresAt: '2099-01-01T00:00:00.000Z', status: 'pending'
    }]);
    const expired = runFixture('fixture-approval-expired', 'waiting_for_approval', 'Abgelaufene Freigabe prüfen', [{
      id: 'approval-expired', kind: 'destructive', title: 'Abgelaufene Fixture-Aktion', risk: 'destructive', target: 'fixture://expired',
      expectedRevision: 2, requestedAt: FIXED_TIME, expiresAt: '2000-01-01T00:00:00.000Z', status: 'pending'
    }]);
    const stale = runFixture('fixture-approval-stale', 'waiting_for_approval', 'Veraltete Freigabe prüfen', [{
      id: 'approval-stale', kind: 'workspace_write', title: 'Veraltete Fixture-Aktion', risk: 'high', target: 'fixture/workspace/stale.txt',
      expectedRevision: 1, requestedAt: FIXED_TIME, expiresAt: '2099-01-01T00:00:00.000Z', status: 'pending'
    }]);
    for (const run of [actionable, expired, stale]) this.seed(run, [event(1, 'run_started', 'Fixture-Run gestartet.'), event(2, 'approval_requested', 'Fixture-Freigabe angefordert.', 'warning')]);
    return [actionable, expired, stale].map(clone);
  }

  seedComparisonRuns(): { parent: AgentRun; child: AgentRun } {
    const parent = runFixture('fixture-parent', 'succeeded', 'Synthetischen Ausgangslauf analysieren');
    parent.output = 'Ausgangsvorschlag'; parent.completedAt = FIXED_TIME;
    parent.contextSummary = { scope: 'fixture-case', sourceCount: 2, redactedHash: 'parent-witness' };
    const child = runFixture('fixture-child', 'succeeded', 'Synthetischen Ausgangslauf mit engerer Policy analysieren');
    child.parentRunId = parent.id; child.request.parentRunId = parent.id; child.request.workspaceMode = 'workspace_write';
    child.createdAt = '2026-08-13T18:05:00.000Z'; child.updatedAt = child.createdAt; child.completedAt = child.createdAt;
    child.usage = { inputTokens: 160, outputTokens: 55, toolCalls: 2, durationMs: 4_000, cost: 0, currency: 'EUR' };
    child.output = 'Vorschlag für Testperson Beispiel, testperson@example.invalid, X:\\Synthetic\\Fixture\\result.txt, token=fixture-secret';
    child.contextSummary = { scope: 'fixture-case', sourceCount: 3, redactedHash: 'child-witness' };
    this.seed(parent, [event(1, 'run_started', 'Ausgangslauf gestartet.'), event(2, 'run_completed', 'Ausgangslauf beendet.')]);
    this.seed(child, [event(1, 'run_started', 'Kindlauf gestartet.'), event(2, 'run_completed', 'Kindlauf beendet.')]);
    return { parent: clone(parent), child: clone(child) };
  }

  appendLiveEvent(runId: string, message: string, type = 'agent_message_completed', level: AgentRunEvent['level'] = 'info'): AgentRunEvent {
    const run = this.requireRun(runId);
    const item = event((run.lastEventSequence ?? 0) + 1, type, message, level);
    this.append(runId, item);
    run.updatedAt = FIXED_TIME;
    return clone(item);
  }

  private seed(run: AgentRun, events: AgentRunEvent[]): void {
    run.lastEventSequence = Math.max(0, ...events.map((item) => item.sequence));
    this.runs.set(run.id, clone(run));
    this.events.set(run.id, clone(events));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'GET' && path === '/api/config') return this.json(route, this.config);
    if (method === 'PUT' && path === '/api/config') {
      const body = request.postDataJSON() as AppConfig;
      this.configSaveRequests.push(clone(body));
      this.config = { ...clone(body), revision: this.config.revision + 1 };
      return this.json(route, this.config);
    }
    if (method === 'PUT' && path === '/api/config/mcp/portal-access') {
      const body = request.postDataJSON() as { enabled: boolean; confirmed: boolean; expectedRevision: number };
      this.portalAccessRequests.push(clone(body));
      this.config = { ...this.config, revision: this.config.revision + 1 };
      return this.json(route, this.config);
    }
    if (method === 'GET' && path === '/api/sources') return this.json(route, []);
    if (method === 'GET' && path === '/api/sources/runtime') {
      return this.json(route, this.runtimeStatus, this.runtimeStatus.state === 'invalid' ? 503 : 200);
    }
    if (method === 'GET' && path === '/api/capabilities') return this.json(route, { contract: 'fixture', contractVersion: '1.0.0', compatible: true, tools: [], errorCategories: [], sources: [] });
    if (method === 'GET' && path === '/api/job-decisions') return this.json(route, []);
    if (method === 'GET' && path === '/api/job-inventory') return this.json(route, []);
    if (method === 'GET' && path === '/api/search-runs-summary') return this.json(route, []);
    const jobInventoryCategoryMatch = path.match(/^\/api\/job-inventory\/([^/]+)\/category$/);
    if (method === 'PUT' && jobInventoryCategoryMatch) {
      const body = request.postDataJSON() as { category: string };
      return this.json(route, { key: decodeURIComponent(jobInventoryCategoryMatch[1]!), category: body.category, status: { applied: false, cases: [], documents: [], appliedWith: [], tracking: [] } });
    }
    const jobInventoryAppliedMatch = path.match(/^\/api\/job-inventory\/([^/]+)\/applied$/);
    if (method === 'POST' && jobInventoryAppliedMatch) {
      const body = request.postDataJSON() as { applied: boolean; note?: string };
      return this.json(route, { key: decodeURIComponent(jobInventoryAppliedMatch[1]!), category: 'inbox', status: { applied: body.applied, ...(body.applied ? { manualApplied: { at: FIXED_TIME, note: body.note } } : {}), cases: [], documents: [], appliedWith: [], tracking: [] } });
    }
    if (method === 'GET' && path === '/api/assistant/status') return this.json(route, { available: true, note: 'Synthetisches Offline-Fixture.' });
    if (method === 'GET' && path === '/api/agents/config-profile') return this.json(route, this.agentConfigProfileView);
    if (method === 'PUT' && path === '/api/agents/config-profile') {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.agentConfigProfileSaveRequests.push(clone(body));
      if (this.rejectNextAgentConfigProfileSave) {
        this.rejectNextAgentConfigProfileSave = false;
        return this.json(route, { error: 'Das Agentenprofil wurde zwischenzeitlich geändert.' }, 409);
      }
      if (body['confirmed'] !== true || body['expectedUpdatedAt'] !== this.agentConfigProfileView.profile.updatedAt || !body['profile']) {
        return this.json(route, { error: 'Fixture-CAS für das Agentenprofil ist stale.' }, 409);
      }
      this.agentConfigProfileView = {
        source: 'primary',
        profile: { ...(clone(body['profile']) as AgentConfigProfileView['profile']), schemaVersion: 2, updatedAt: '2026-08-14T08:00:01.000Z' }
      };
      return this.json(route, this.agentConfigProfileView);
    }
    if (method === 'GET' && path === '/api/application-pipeline/setup') return this.json(route, this.profileSetup);
    if (method === 'POST' && path === '/api/application-pipeline/setup/profiles') {
      const body = request.postDataJSON() as { confirmed: boolean };
      this.profileSetupRequests.push(clone(body));
      this.profileSetup = {
        contract: 'application-profile-setup', contractVersion: '1.0', candidateProfile: 'present', styleProfile: 'present', initialized: true,
        containsCandidateFacts: false, note: 'Leere synthetische Vorlagen wurden angelegt.', created: ['candidate-profile', 'style-profile']
      };
      return this.json(route, this.profileSetup, 201);
    }
    if (method === 'GET' && path === '/api/application-pipeline/style-profile') return this.json(route, this.styleProfile);
    if (method === 'PUT' && path === '/api/application-pipeline/style-profile') {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.styleProfileUpdateRequests.push(clone(body));
      if (body['confirmed'] !== true || body['expectedRevision'] !== this.styleProfile.revision || body['expectedSha256'] !== this.styleProfile.sha256
        || !body['profile'] || typeof body['profile'] !== 'object') {
        return this.json(route, { error: 'Fixture-Stilprofilrevision ist stale oder unvollständig.' }, 409);
      }
      this.styleProfile = {
        ...this.styleProfile, revision: this.styleProfile.revision + 1, sha256: '9'.repeat(64),
        profile: clone(body['profile'] as ApplicationStyleProfileView['profile'])
      };
      return this.json(route, this.styleProfile);
    }
    if (method === 'GET' && path === '/api/candidate-profile') return this.json(route, {
      contractVersion: '1.0.0', valid: true, errors: [], profile: {}, claims: [{
        id: 'fixture-claim', statement: 'Synthetischer, lokal belegter Angular-Claim.', status: 'verified', evidenceRefs: ['fixture:evidence'], allowedOutputs: ['cv', 'cover_letter']
      }]
    });
    if (method === 'POST' && path === '/api/language-check') {
      const body = request.postDataJSON() as { content: string; language: string };
      this.languageCheckRequests.push(clone(body));
      if (!this.languageBackendAvailable) return this.json(route, {
        available: false, issues: [], disclosure: 'Lokales nspell-Fixture ist absichtlich nicht verfügbar; kein Remote-Fallback wurde verwendet.'
      });
      return this.json(route, {
        available: true, backend: 'nspell-local', issues: [{ kind: 'spelling', ruleId: 'fixture-word', word: 'Angularrr', suggestions: ['Angular'] }],
        disclosure: 'Lokaler deterministischer Fixture-Check ohne Netzwerk.'
      });
    }
    if (method === 'GET' && path === '/api/agents/providers') {
      if (url.searchParams.get('refresh') === 'true') this.providerRefreshRequests.push(request.url());
      return this.json(route, PROVIDERS);
    }
    if (method === 'GET' && path === '/api/application-cases') return this.json(route, [...this.applicationCases.values()]);
    if (method === 'GET' && path === '/api/cv-imports') {
      this.cvImportListRequests.push(request.url());
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return this.json(route, this.cvImport && limit > 0 ? [cvImportSummary(this.cvImport)] : []);
    }
    if (method === 'POST' && path === '/api/cv-imports') {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.cvImportRequests.push(clone(body));
      if (body['confirmed'] !== true || body['mimeType'] !== 'text/html' || typeof body['base64'] !== 'string') {
        return this.json(route, { error: 'Fixture-CV-Import ist unvollständig.' }, 400);
      }
      this.cvImport = cvImportRecord();
      this.initializeCvRecognitionVersions(this.cvImport);
      return this.json(route, this.cvImport, 201);
    }
    const cvRecognitionVersionsMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/recognition-versions$/);
    if (method === 'GET' && cvRecognitionVersionsMatch) {
      this.cvRecognitionVersionListRequests.push(request.url());
      const importId = decodeURIComponent(cvRecognitionVersionsMatch[1]);
      if (!this.cvImport || !this.cvRecognitionVersions || importId !== this.cvImport.id) {
        return this.json(route, { error: 'Fixture-Erkennungsstände nicht gefunden.' }, 404);
      }
      return this.json(route, this.cvRecognitionVersions);
    }
    const cvRecognitionActivationMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/recognition-versions\/([^/]+)\/activate$/);
    if (method === 'POST' && cvRecognitionActivationMatch) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const importId = decodeURIComponent(cvRecognitionActivationMatch[1]);
      const versionId = decodeURIComponent(cvRecognitionActivationMatch[2]);
      this.cvRecognitionVersionActivationRequests.push({ versionId, body: clone(body) });
      if (this.rejectNextCvRecognitionActivation) {
        this.rejectNextCvRecognitionActivation = false;
        return this.json(route, { error: 'Fixture-CAS wurde absichtlich als veraltet abgelehnt.' }, 409);
      }
      const version = this.cvRecognitionVersions?.versions.find((item) => item.id === versionId);
      const facts = this.cvRecognitionFacts.get(versionId);
      if (!this.cvImport || !this.cvRecognitionVersions || importId !== this.cvImport.id || !version || !facts
        || body['confirmed'] !== true || body['expectedRevision'] !== this.cvImport.revision
        || body['expectedSha256'] !== this.cvImport.sha256) {
        return this.json(route, { error: 'Fixture-Aktivierung benötigt die aktuelle Import-CAS und Bestätigung.' }, 409);
      }
      const revision = this.cvImport.revision + 1;
      this.cvImport = {
        ...this.cvImport, revision, sha256: Math.min(15, revision).toString(16).repeat(64), updatedAt: FIXED_TIME,
        status: 'facts_pending', facts: clone(facts), activeRecognitionVersionId: versionId,
        adoption: undefined, proposal: undefined
      };
      this.cvRecognitionVersions = {
        ...this.cvRecognitionVersions, activeVersionId: versionId,
        versions: this.cvRecognitionVersions.versions.map((item) => ({ ...item, active: item.id === versionId }))
      };
      return this.json(route, this.cvImport);
    }
    const cvRecognitionConfirmationMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/recognition-versions\/([^/]+)\/confirm$/);
    if (method === 'POST' && cvRecognitionConfirmationMatch) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const importId = decodeURIComponent(cvRecognitionConfirmationMatch[1]);
      const versionId = decodeURIComponent(cvRecognitionConfirmationMatch[2]);
      this.cvRecognitionVersionConfirmationRequests.push({ versionId, body: clone(body) });
      const active = this.cvRecognitionVersions?.versions.find((item) => item.id === versionId && item.active);
      if (!this.cvImport || !this.cvRecognitionVersions || importId !== this.cvImport.id || !active
        || active.factCounts.pending < 1 || body['confirmed'] !== true
        || body['expectedRevision'] !== this.cvImport.revision || body['expectedSha256'] !== this.cvImport.sha256) {
        return this.json(route, { error: 'Fixture-Standbestätigung benötigt den aktiven Stand und aktuelle CAS-Daten.' }, 409);
      }
      const revision = this.cvImport.revision + 1;
      const facts = this.cvImport.facts.map((fact) => fact.decision === 'pending'
        ? { ...fact, decision: 'confirmed' as const } : fact);
      this.cvImport = {
        ...this.cvImport, revision, sha256: Math.min(15, revision).toString(16).repeat(64), updatedAt: FIXED_TIME,
        status: facts.some((fact) => fact.decision === 'pending') ? 'facts_pending' : 'facts_reviewed', facts
      };
      this.syncActiveCvRecognitionVersion();
      return this.json(route, this.cvImport);
    }
    const cvAiOptionsMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ai-structuring\/options$/);
    if (method === 'GET' && cvAiOptionsMatch) {
      this.cvAiOptionsRequests.push(request.url());
      const importId = decodeURIComponent(cvAiOptionsMatch[1]);
      if (!this.cvImport || importId !== this.cvImport.id
        || Number(url.searchParams.get('expectedRevision')) !== this.cvImport.revision
        || url.searchParams.get('expectedSha256') !== this.cvImport.sha256) {
        return this.json(route, { error: 'Fixture-AI-Optionen sind nicht an die aktuelle CV-Revision gebunden.' }, 409);
      }
      return this.json(route, cvAiOptions(this.cvImport));
    }
    const cvAiRunListMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ai-structuring\/runs$/);
    if (method === 'GET' && cvAiRunListMatch) {
      this.cvAiRunListRequests.push(request.url());
      const importId = decodeURIComponent(cvAiRunListMatch[1]);
      const limit = Number(url.searchParams.get('limit') ?? '20');
      return this.json(route, [...this.cvAiRuns.values()].filter((run) => run.cvImportId === importId).slice(0, limit));
    }
    if (method === 'POST' && cvAiRunListMatch) {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.cvAiStartRequests.push(clone(body));
      const importId = decodeURIComponent(cvAiRunListMatch[1]);
      const disclosure = body['disclosure'] as Record<string, unknown> | undefined;
      const provider = body['provider'] as Record<string, unknown> | undefined;
      if (!this.cvImport || importId !== this.cvImport.id || body['expectedRevision'] !== this.cvImport.revision
        || body['expectedSha256'] !== this.cvImport.sha256 || body['mode'] !== 'replace_with_ai_version' || !provider
        || disclosure?.['version'] !== '1.0' || disclosure['confirmed'] !== true
        || disclosure['sendExtractedCvTextToProvider'] !== true
        || disclosure['acknowledgeProviderControlPlaneNetwork'] !== true) {
        return this.json(route, { error: 'Fixture-AI-Start benötigt aktuelle CAS-Daten und eine explizite Disclosure.' }, 409);
      }
      const run = cvAiRun(this.cvImport, { provider, mode: 'replace_with_ai_version' });
      if (this.failNextCvAiRun) { this.failedCvAiRuns.add(run.id); this.failNextCvAiRun = false; }
      this.cvAiRuns.set(run.id, run);
      return this.json(route, run, 202);
    }
    const cvAiRunMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ai-structuring\/runs\/([^/]+)$/);
    if (method === 'GET' && cvAiRunMatch) {
      const importId = decodeURIComponent(cvAiRunMatch[1]); const runId = decodeURIComponent(cvAiRunMatch[2]);
      this.cvAiRunGetRequests.push(request.url());
      const current = this.cvAiRuns.get(runId);
      if (!current || current.cvImportId !== importId) return this.json(route, { error: 'Fixture-AI-Lauf nicht gefunden.' }, 404);
      const next = this.advanceCvAiRun(current); this.cvAiRuns.set(runId, next);
      return this.json(route, next);
    }
    const cvAiCancelMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ai-structuring\/runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cvAiCancelMatch) {
      const body = request.postDataJSON() as Record<string, unknown>; this.cvAiCancelRequests.push(clone(body));
      const importId = decodeURIComponent(cvAiCancelMatch[1]); const runId = decodeURIComponent(cvAiCancelMatch[2]);
      const current = this.cvAiRuns.get(runId);
      if (!current || current.cvImportId !== importId || body['confirmed'] !== true
        || body['expectedRunRevision'] !== current.revision || body['expectedRunSha256'] !== current.sha256
        || !['queued', 'running', 'validating', 'cancel_requested'].includes(current.status)) {
        return this.json(route, { error: 'Fixture-AI-Abbruch benötigt die aktuelle Run-CAS.' }, 409);
      }
      const cancelled = this.updateCvAiRun(current, 'cancel_requested', 'cancel_requested');
      this.cvAiRuns.set(runId, cancelled); return this.json(route, cancelled);
    }
    const cvAiRetryMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ai-structuring\/runs\/([^/]+)\/retry$/);
    if (method === 'POST' && cvAiRetryMatch) {
      const body = request.postDataJSON() as Record<string, unknown>; this.cvAiRetryRequests.push(clone(body));
      const importId = decodeURIComponent(cvAiRetryMatch[1]); const runId = decodeURIComponent(cvAiRetryMatch[2]);
      const current = this.cvAiRuns.get(runId); const disclosure = body['disclosure'] as Record<string, unknown> | undefined;
      const provider = body['provider'] as Record<string, unknown> | undefined;
      if (!this.cvImport || !current || current.cvImportId !== importId || !['cancelled', 'failed'].includes(current.status)
        || body['expectedRunRevision'] !== current.revision || body['expectedRunSha256'] !== current.sha256
        || body['expectedCvImportRevision'] !== this.cvImport.revision || body['expectedCvImportSha256'] !== this.cvImport.sha256
        || body['mode'] !== 'replace_with_ai_version' || !provider || disclosure?.['version'] !== '1.0' || disclosure['confirmed'] !== true
        || disclosure['sendExtractedCvTextToProvider'] !== true
        || disclosure['acknowledgeProviderControlPlaneNetwork'] !== true) {
        return this.json(route, { error: 'Fixture-AI-Retry benötigt frische Disclosure und beide CAS-Bindungen.' }, 409);
      }
      const retried = cvAiRun(this.cvImport, {
        attempt: current.attempt + 1, retryOf: current.id, provider, mode: 'replace_with_ai_version'
      });
      if (this.failNextCvAiRun) { this.failedCvAiRuns.add(retried.id); this.failNextCvAiRun = false; }
      this.cvAiRuns.set(retried.id, retried); return this.json(route, retried, 202);
    }
    const cvAiApplyMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ai-structuring\/runs\/([^/]+)\/apply$/);
    if (method === 'POST' && cvAiApplyMatch) {
      const body = request.postDataJSON() as Record<string, unknown>; this.cvAiApplyRequests.push(clone(body));
      const importId = decodeURIComponent(cvAiApplyMatch[1]); const runId = decodeURIComponent(cvAiApplyMatch[2]);
      const current = this.cvAiRuns.get(runId);
      const selections = body['selections'] as Array<{ suggestionId: string; alternativeId: string | null }> | undefined;
      if (!this.cvImport || !current || current.cvImportId !== importId || current.status !== 'suggestions_ready' || !current.proposal
        || body['confirmed'] !== true || body['expectedRunRevision'] !== current.revision || body['expectedRunSha256'] !== current.sha256
        || body['expectedCvImportRevision'] !== this.cvImport.revision || body['expectedCvImportSha256'] !== this.cvImport.sha256
        || !Array.isArray(selections) || selections.length < 1) {
        return this.json(route, { error: 'Fixture-AI-Apply benötigt Auswahl und beide aktuellen CAS-Bindungen.' }, 409);
      }
      const stagedFactIds: string[] = []; const facts = clone(this.cvImport.facts);
      for (const selection of selections) {
        const suggestion = current.proposal.suggestions.find((item) => item.id === selection.suggestionId);
        const alternative = suggestion?.alternatives.find((item) => item.id === selection.alternativeId);
        const value = selection.alternativeId === null ? suggestion?.value : alternative?.value;
        const sourceAnchor = selection.alternativeId === null ? suggestion?.sourceAnchor : alternative?.sourceAnchor;
        if (!suggestion?.mergeable || !value || !sourceAnchor
          || (selection.alternativeId !== null && !alternative)) return this.json(route, { error: 'Fixture-AI-Auswahl ist ungültig.' }, 400);
        const factId = `fact-ai-fixture-${stagedFactIds.length + 1}`; stagedFactIds.push(factId);
        facts.push({
          id: factId, category: suggestion.category as CvImportRecord['facts'][number]['category'],
          recordId: suggestion.recordId ?? `ai-record-${stagedFactIds.length}`, field: suggestion.field, value, decision: 'pending',
          provenance: {
            sourceSha256: this.cvImport.source.sha256, anchor: `Zeilen ${sourceAnchor.lineStart}-${sourceAnchor.lineEnd}`, origin: 'imported',
            recognition: {
              method: 'ai_assisted', runId: current.id, proposalSha256: current.proposal.sha256,
              suggestionId: suggestion.id, ...(selection.alternativeId ? { selectedAlternativeId: selection.alternativeId } : {}),
              confidence: alternative?.confidence ?? suggestion.confidence, questions: clone(suggestion.questions),
              sourceSpan: {
                lineStart: sourceAnchor.lineStart, lineEnd: sourceAnchor.lineEnd,
                charStart: sourceAnchor.charStart, charEnd: sourceAnchor.charEnd
              }
            }
          }
        });
      }
      const revision = this.cvImport.revision + 1; const sha256 = revision.toString(16).repeat(64);
      this.cvImport = {
        ...this.cvImport, revision, sha256, updatedAt: FIXED_TIME, status: 'facts_pending', facts,
        adoption: undefined, proposal: undefined
      };
      this.syncActiveCvRecognitionVersion();
      const applied: CvAiStructuringPublicRun = {
        ...current, revision: current.revision + 1, sha256: (current.revision + 1).toString(16).repeat(64), status: 'applied',
        updatedAt: FIXED_TIME, result: { cvImportRevision: revision, cvImportSha256: sha256, stagedFactIds, factsRemainPending: true },
        auditTrail: [...current.auditTrail, { sequence: current.auditTrail.length + 1, occurredAt: FIXED_TIME, action: 'applied' }]
      };
      this.cvAiRuns.set(runId, applied); return this.json(route, applied);
    }
    const cvImportMatch = path.match(/^\/api\/cv-imports\/([^/]+)$/);
    if (method === 'GET' && cvImportMatch) {
      return this.cvImport?.id === decodeURIComponent(cvImportMatch[1])
        ? this.json(route, this.cvImport) : this.json(route, { error: 'Fixture-CV-Import nicht gefunden.' }, 404);
    }
    if (method === 'DELETE' && cvImportMatch) {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.cvImportDeleteRequests.push(clone(body));
      const id = decodeURIComponent(cvImportMatch[1]);
      if (!this.cvImport || id !== this.cvImport.id) return this.json(route, { removed: 0 });
      if (body['confirmation'] !== `DELETE cv-import ${id}`
        || body['expectedRevision'] !== this.cvImport.revision || body['expectedSha256'] !== this.cvImport.sha256) {
        return this.json(route, { error: 'Fixture-CV-Löschung benötigt exakte Bestätigung und CAS.' }, 409);
      }
      this.cvImport = undefined;
      this.cvRecognitionVersions = undefined; this.cvRecognitionFacts.clear();
      return this.json(route, { removed: 1 });
    }
    const cvFactsMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/facts$/);
    if (method === 'PATCH' && cvFactsMatch) {
      const body = request.postDataJSON() as { expectedRevision: number; expectedSha256: string; confirmed: boolean; operations: CvFactOperation[] };
      this.cvFactReviewRequests.push(clone(body) as Record<string, unknown>);
      if (!this.cvImport || body.confirmed !== true || body.expectedRevision !== this.cvImport.revision || body.expectedSha256 !== this.cvImport.sha256) {
        return this.json(route, { error: 'Fixture-CV-CAS ist stale.' }, 409);
      }
      const facts = clone(this.cvImport.facts);
      const newRecordIds = new Map<string, string>();
      for (const operation of body.operations) {
        if (operation.action === 'add') {
          const recordId = operation.recordId ?? (operation.newRecordKey
            ? (newRecordIds.get(operation.newRecordKey) ?? `record-user-fixture-${this.createdCvFacts + 1}`) : undefined);
          if (!recordId || (operation.recordId && !facts.some((fact) => fact.recordId === operation.recordId && fact.category === operation.category))) {
            return this.json(route, { error: 'Fixture-Zusatzfakt referenziert keine passende Station.' }, 409);
          }
          if (operation.newRecordKey) newRecordIds.set(operation.newRecordKey, recordId);
          this.createdCvFacts += 1;
          facts.push({
            id: `fact-user-fixture-${this.createdCvFacts}`, category: operation.category, recordId,
            field: operation.field, value: operation.value, decision: operation.explicitlyConfirmed === true ? 'confirmed' : 'pending',
            provenance: { sourceSha256: this.cvImport.source.sha256, anchor: `user:${FIXED_TIME}`, origin: 'user_supplied' }
          });
          continue;
        }
        const index = facts.findIndex((fact) => fact.id === operation.factId);
        if (index < 0) return this.json(route, { error: 'Fixture-Fakt unbekannt.' }, 409);
        const fact = facts[index]!;
        if (operation.action === 'edit') {
          facts[index] = { ...fact, decision: 'rejected' };
          this.createdCvFacts += 1;
          facts.push({
            id: `fact-user-fixture-${this.createdCvFacts}`, category: operation.category, recordId: operation.recordId,
            field: operation.field, value: operation.value, decision: 'pending',
            provenance: { ...fact.provenance, anchor: `user:${FIXED_TIME}`, origin: 'user_supplied' }
          });
        } else facts[index] = { ...fact, decision: operation.action === 'confirm' ? 'confirmed' : 'rejected' };
      }
      const revision = this.cvImport.revision + 1;
      this.cvImport = {
        ...this.cvImport, revision, sha256: revision.toString(16).repeat(64), updatedAt: FIXED_TIME, facts,
        status: facts.some((fact) => fact.decision === 'pending') ? 'facts_pending' : 'facts_reviewed', adoption: undefined, proposal: undefined
      };
      this.syncActiveCvRecognitionVersion();
      return this.json(route, this.cvImport);
    }
    const cvThemePreviewMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/theme\/preview$/);
    if (method === 'POST' && cvThemePreviewMatch) {
      const body = request.postDataJSON() as { theme: CvTheme };
      const mode = body.theme?.mode === 'original' ? 'original' : 'ats';
      const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"></head><body data-mode="${mode}"><main><h1>Layout-Vorschau</h1></main></body></html>`;
      return this.json(route, { html, htmlSha256: 'e'.repeat(64) });
    }
    const cvAtsCheckMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/ats-check$/);
    if (method === 'POST' && cvAtsCheckMatch) {
      return this.json(route, {
        contract: 'ats-check', contractVersion: '1.0', engine: 'deterministic-local', checkedAt: FIXED_TIME, htmlSha256: 'a'.repeat(64),
        summary: { pass: 4, warn: 1, fail: 0, parseable: true },
        lint: [{ id: 'single-column', label: 'Einspaltige Lesereihenfolge', status: 'pass', detail: 'Eine Spalte.' }],
        parse: { parser: 'local-rule-based-ats-parser', parserVersion: '1.0', detectedSections: [], recovered: { hasDateRanges: true }, counts: { sections: 3, experienceItems: 2, educationItems: 1, skills: 3, bullets: 6 }, warnings: [] },
        disclaimer: 'Lokale ATS-Heuristik ohne Score.'
      });
    }
    const cvThemeMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/theme$/);
    if (method === 'PUT' && cvThemeMatch) {
      const body = request.postDataJSON() as { expectedRevision: number; expectedSha256: string; confirmed: boolean; theme: CvTheme | null };
      this.cvThemeRequests.push(clone(body) as Record<string, unknown>);
      if (!this.cvImport || body.confirmed !== true || body.expectedRevision !== this.cvImport.revision || body.expectedSha256 !== this.cvImport.sha256) {
        return this.json(route, { error: 'Fixture-CV-Theme-CAS ist stale.' }, 409);
      }
      const revision = this.cvImport.revision + 1;
      this.cvImport = {
        ...this.cvImport, revision, sha256: revision.toString(16).repeat(64), updatedAt: FIXED_TIME,
        ...(body.theme ? { theme: clone(body.theme) } : { theme: undefined }), proposal: undefined
      };
      return this.json(route, this.cvImport);
    }
    const cvAdoptMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/adopt$/);
    if (method === 'POST' && cvAdoptMatch) {
      const body = request.postDataJSON() as { expectedRevision: number; expectedSha256: string; confirmed: boolean };
      this.cvAdoptionRequests.push(clone(body) as Record<string, unknown>);
      if (!this.cvImport || body.confirmed !== true || body.expectedRevision !== this.cvImport.revision || body.expectedSha256 !== this.cvImport.sha256
        || this.cvImport.facts.some((fact) => fact.decision === 'pending')) {
        return this.json(route, { error: 'Fixture-CV-Adoption ist nicht freigegeben.' }, 409);
      }
      const confirmedFacts = this.cvImport.facts.filter((fact) => fact.decision === 'confirmed');
      const revision = this.cvImport.revision + 1;
      this.cvImport = {
        ...this.cvImport, revision, sha256: revision.toString(16).repeat(64), updatedAt: FIXED_TIME, status: 'adopted',
        adoption: {
          adoptedAt: FIXED_TIME, adoptedClaimIds: confirmedFacts.map((fact) => `claim-${fact.id}`),
          adoptedRecordIds: [...new Set(confirmedFacts.map((fact) => fact.recordId))],
          candidateProfileSha256: 'b'.repeat(64), candidateProfileRevision: 'fixture-profile-revision-1',
          recognitionVersionId: this.cvImport.activeRecognitionVersionId,
          recognitionVersionSha256: CV_RECOGNITION_VERSION_SHA256
        }
      };
      return this.json(route, this.cvImport);
    }
    const cvRenderMatch = path.match(/^\/api\/application-cases\/([^/]+)\/cv-proposals$/);
    if (method === 'POST' && cvRenderMatch) {
      const caseId = decodeURIComponent(cvRenderMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.cvHtmlRenderRequests.push({ caseId, body: clone(body) });
      const application = this.applicationCases.get(caseId);
      if (!this.cvImport || !application || application.state !== 'approved'
        || body['confirmed'] !== true || body['expectedRevision'] !== this.cvImport.revision || body['expectedSha256'] !== this.cvImport.sha256
        || body['documentRevisionId'] !== application.approvedArtifactRevisionId || body['expectedDocumentSha256'] !== application.approvedArtifactSha256) {
        return this.json(route, { error: 'Fixture-HTML benötigt die exakt freigegebene CV-Revision.' }, 409);
      }
      const revision = this.cvImport.revision + 1;
      this.cvImport = {
        ...this.cvImport, revision, sha256: revision.toString(16).repeat(64), updatedAt: FIXED_TIME, status: 'proposal_ready',
        proposal: {
          applicationCaseId: application.id, jobId: application.job.id, createdAt: FIXED_TIME,
          htmlSha256: 'e'.repeat(64), documentRevisionId: application.approvedArtifactRevisionId!,
          documentSha256: application.approvedArtifactSha256!, lifecycle: 'approved_revision_preview', format: 'html',
          downloadAllowed: application.identityMode === 'real',
          inputSnapshot: {
            cvImportRevision: this.cvImport.revision, cvImportSha256: this.cvImport.sha256,
            candidateProfileSha256: 'b'.repeat(64), candidateProfileRevision: 'fixture-profile-revision-1',
            styleProfileRevision: 3, styleProfileSha256: '8'.repeat(64), themeSha256: 'f'.repeat(64),
            agentWorkflowId: 'evidence-application-package', sourceAgentArtifactId: 'fixture-used-agent-artifact',
            pipelineContractVersion: '1.0.0',
            completedStages: ['validate_profiles', 'analyze_job', 'build_match_matrix', 'audit_claims', 'check_style', 'validate_iteration'],
            agentOrchestrationRequired: false,
            recognitionVersionId: this.cvImport.activeRecognitionVersionId,
            recognitionVersionSha256: CV_RECOGNITION_VERSION_SHA256
          }
        }
      };
      return this.json(route, this.cvImport, 201);
    }
    const cvHtmlMatch = path.match(/^\/api\/cv-imports\/([^/]+)\/proposal\.html$/);
    if (method === 'GET' && cvHtmlMatch) {
      if (!this.cvImport?.proposal || url.searchParams.get('sha256') !== this.cvImport.proposal.htmlSha256) {
        return this.json(route, { error: 'Fixture-HTML-Hash ist stale.' }, 409);
      }
      if (url.searchParams.get('download') === 'true') this.cvHtmlDownloadRequests.push(request.url());
      return route.fulfill({
        status: 200, contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff' },
        body: '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fixture CV</title></head><body><h1>Synthetischer HTML-Lebenslauf</h1><p>Proof-verifizierte Offline-Fixture.</p></body></html>'
      });
    }
    if (method === 'GET' && path === '/api/crm/companies') {
      const applications = [...this.applicationCases.values()].map((application) => ({
        ...clone(application), tracking: [{ id: 'fixture-tracking', status: 'review', occurredAt: FIXED_TIME }], messages: [],
        artifacts: clone(this.applicationArtifacts.get(application.id) ?? [])
      }));
      return this.json(route, applications.length ? [{ key: 'beispiel', name: 'Beispiel GmbH', unassignedMessages: [], applications }] : []);
    }
    if (method === 'GET' && path === '/api/mail/accounts') return this.json(route, []);
    if (method === 'GET' && path === '/api/mail/messages') return this.json(route, this.mailMessages);
    if (method === 'GET' && path === '/api/agents/workflows') return this.json(route, WORKFLOWS);
    if (method === 'GET' && path === '/api/agents/queue') return this.json(route, this.queueSnapshot);
    if (method === 'GET' && path === '/api/agents/recovery') return this.json(route, { runs: [...this.recoveries.values()] });
    if (method === 'GET' && path === '/api/agent-orchestrations') {
      for (const [id, completed] of this.pendingOrchestrationCompletions) {
        this.orchestrations.set(id, completed);
        this.pendingOrchestrationCompletions.delete(id);
      }
      return this.json(route, { orchestrations: [...this.orchestrations.values()] });
    }
    if (method === 'POST' && path === '/api/agent-orchestrations') {
      const body = request.postDataJSON() as AgentOrchestrationCreateRequest;
      this.orchestrationCreateRequests.push(clone(body));
      if (!this.agentConfigProfileView.profile.features.multiAgentExperimental) {
        return this.json(route, { error: 'Die suggestion-only Multi-Agent-Kette ist im aktiven lokalen Profil deaktiviert.' }, 409);
      }
      if (body.workflowId === 'employer-response-triage' && !body.mailId) {
        return this.json(route, { error: 'Employer-Triage erfordert eine explizit ausgewählte Mail-ID.' }, 400);
      }
      if (body.mailId && (body.workflowId !== 'employer-response-triage' || !body.applicationCaseId)) {
        return this.json(route, { error: 'Eine Mailbindung ist nur für die fallgebundene Antworttriage erlaubt.' }, 400);
      }
      if (body.mailId && !this.mailMessages.some((message) => message.id === body.mailId)) {
        return this.json(route, { error: 'Die ausgewählte Nachricht wurde nicht gefunden.' }, 404);
      }
      const configuredProvider = this.agentConfigProfileView.profile.providers.find((item) => item.provider === body.providerId);
      if (!configuredProvider?.enabled || configuredProvider.runtimeTarget !== body.runtimeTarget
        || (body.wslDistribution && configuredProvider.wslDistribution !== body.wslDistribution)) {
        return this.json(route, { error: 'Der Provider oder die Laufzeit ist im aktiven lokalen Profil gesperrt.' }, 409);
      }
      const id = `33333333-3333-4333-8333-${String(++this.createdOrchestrations).padStart(12, '0')}`;
      const orchestration = this.buildOrchestration(id, body);
      this.orchestrations.set(id, orchestration);
      return this.json(route, orchestration, 202);
    }
    const orchestrationContinueMatch = path.match(/^\/api\/agent-orchestrations\/([^/]+)\/continue$/);
    if (method === 'POST' && orchestrationContinueMatch) {
      const orchestrationId = decodeURIComponent(orchestrationContinueMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.orchestrationContinueRequests.push({ orchestrationId, body: clone(body) });
      const current = this.orchestrations.get(orchestrationId);
      const userInput = body['userInput'] as Record<string, unknown> | undefined;
      if (!current || body['expectedRevision'] !== current.revision || userInput?.['confirmed'] !== true || body['review'] !== undefined) {
        return this.json(route, { error: 'Fixture-Orchestrierung oder Gate-Revision ist stale.' }, 409);
      }
      const isEvidencePackage = current.workflowId === 'evidence-application-package';
      const isEmployerProposal = current.workflowId === 'employer-response-triage';
      const gatedNodeId = isEvidencePackage ? 'finalizer' : current.workflowId === 'employer-response-triage' ? 'respond' : undefined;
      if (!gatedNodeId || !current.unresolvedGates.some((gate) => gate.nodeId === gatedNodeId && gate.gate === 'user_input')) {
        return this.json(route, { error: 'Diese Orchestrierung besitzt kein browserauflösbares user_input-Gate.' }, 409);
      }
      const run = runFixture(
        isEvidencePackage ? 'fixture-orchestration-finalizer' : 'fixture-orchestration-response',
        'succeeded',
        isEvidencePackage ? 'Finales Pipeline-Paket streng erzeugen' : 'Antwort- und Terminvorschlag lokal erzeugen'
      );
      run.request = { ...run.request, workflowId: current.workflowId, applicationCaseId: current.scope.applicationCaseId };
      run.output = isEvidencePackage ? 'Striktes Pipeline-Paket wurde als Vorschlag erzeugt.' : 'Antwort- und Terminvorschlag wurde lokal erzeugt.';
      const proposalArtifact: AgentArtifactRecord | undefined = isEvidencePackage || isEmployerProposal ? {
        schemaVersion: 1, id: isEvidencePackage ? 'fixture-orchestration-package' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: isEvidencePackage ? 'application-pipeline-package' : 'employer-response-triage-proposal', sha256: isEvidencePackage ? '7'.repeat(64) : 'd'.repeat(64), bytes: 240,
        mediaType: 'application/json', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, revision: 1, lifecycle: 'proposed', contentState: 'available',
        provenance: {
          runId: run.id, provider: run.providerId, providerVersion: '1.0.0', adapterVersion: 'fixture-adapter-1', templateId: 'orchestration-finalizer', templateVersion: '1.0.0',
          workflowId: current.workflowId, workflowVersion: current.workflowVersion, applicationCaseId: current.scope.applicationCaseId,
          applicationCaseRevision: current.scope.applicationCaseRevision, jobId: current.scope.jobId, companyKey: current.scope.companyKey,
          mailId: current.scope.mailId, identityMode: current.scope.identityMode
        }
      } : undefined;
      this.seed(run, [
        event(1, 'run_started', `${gatedNodeId}-Node gestartet.`),
        ...(proposalArtifact ? [event(2, 'artifact_created', isEvidencePackage ? 'Striktes Pipeline-Paket vorgeschlagen.' : 'Typisierte Antworttriage vorgeschlagen.')] : []),
        event(proposalArtifact ? 3 : 2, 'run_completed', `${gatedNodeId}-Node erfolgreich.`)
      ]);
      this.agentArtifacts.set(run.id, proposalArtifact ? [proposalArtifact] : []);
      if (proposalArtifact) {
        const content = isEvidencePackage
          ? JSON.stringify({ annotatedContent: 'Synthetischer belegter Inhalt.', iterationManifest: '{"reviews":["evidence","ats","finalizer"]}' })
          : JSON.stringify({
              contract: 'employer-response-triage-proposal', contractVersion: '1.0', sha256: 'e'.repeat(64),
              proposal: {
                schemaVersion: 1, classification: 'request', confidence: 0.91, selectedMailId: current.scope.mailId,
                sourceReferences: [`mail:${current.scope.mailId}`],
                caseCandidates: [{
                  caseId: current.scope.applicationCaseId, confidence: 0.84, reason: 'Firmen- und Stellenbezug stimmen synthetisch überein.',
                  sourceReferences: [`mail:${current.scope.mailId}`, `case:${current.scope.applicationCaseId}`]
                }],
                followUp: {
                  dueAt: '2026-08-20T09:00:00.000Z', timeZone: 'Europe/Berlin', reason: 'Antwort nach manueller Prüfung erwägen.',
                  sourceReferences: [`mail:${current.scope.mailId}`]
                },
                replyDraft: {
                  subject: 'Synthetischer Antwortentwurf', body: 'Vielen Dank für Ihre Nachricht. Dies ist nur ein lokaler Vorschlag.', language: 'de',
                  sourceReferences: [`mail:${current.scope.mailId}`]
                }
              }
            });
        this.agentArtifactContents.set(`${run.id}:${proposalArtifact.id}`, {
          id: proposalArtifact.id, sha256: proposalArtifact.sha256, mediaType: proposalArtifact.mediaType, content
        });
      }
      const proposalRef = proposalArtifact
        ? { outputRef: isEvidencePackage ? 'package_proposal' : 'response_and_calendar_proposal', artifactId: proposalArtifact.id, runId: run.id, sha256: proposalArtifact.sha256, lifecycle: 'proposed' as const }
        : undefined;
      const nodes = current.nodes.map((node) => node.nodeId === gatedNodeId
        ? { ...node, status: 'succeeded' as const, attempts: 1, runIds: [run.id], artifacts: proposalRef ? [proposalRef] : [] }
        : node);
      const resolvedGates = [
        ...current.resolvedGates,
        { nodeId: gatedNodeId, gate: 'user_input' as const, authority: 'server_revision_confirmation' as const, bindingSha256: '8'.repeat(64) }
      ];
      const running: AgentOrchestrationRecord = {
        ...current, revision: current.revision + 1, status: 'running', unresolvedGates: [], resolvedGates,
        nodes: current.nodes.map((node) => node.nodeId === gatedNodeId
          ? { ...node, status: 'running' as const, attempts: 1, runIds: [run.id], artifacts: [] }
          : node),
        nodeRunIds: { ...current.nodeRunIds, [gatedNodeId]: [run.id] }, updatedAt: FIXED_TIME
      };
      const completed: AgentOrchestrationRecord = {
        ...running, revision: running.revision + 1, status: 'succeeded', nodes,
        artifactRefs: proposalRef ? [...current.artifactRefs, proposalRef] : current.artifactRefs,
        budget: { wallTimeMs: 2600, tokens: 180, costMicros: 0, toolCalls: 2, iterations: 2 },
        updatedAt: FIXED_TIME, finishedAt: FIXED_TIME
      };
      this.orchestrations.set(orchestrationId, running);
      this.pendingOrchestrationCompletions.set(orchestrationId, completed);
      return this.json(route, running);
    }
    const orchestrationConflictResolveMatch = path.match(/^\/api\/agent-orchestrations\/([^/]+)\/conflicts\/([^/]+)\/resolve$/);
    if (method === 'POST' && orchestrationConflictResolveMatch) {
      const orchestrationId = decodeURIComponent(orchestrationConflictResolveMatch[1]);
      const conflictId = decodeURIComponent(orchestrationConflictResolveMatch[2]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.orchestrationConflictResolveRequests.push({ orchestrationId, conflictId, body: clone(body) });
      if (this.rejectNextOrchestrationConflictResolve) {
        this.rejectNextOrchestrationConflictResolve = false;
        return this.json(route, { error: 'Die synthetische Konfliktrevision ist stale.' }, 409);
      }
      const current = this.orchestrations.get(orchestrationId);
      const conflict = current?.conflicts?.find((candidate) => candidate.id === conflictId);
      const strategy = body['strategy'];
      const resolvedStrategy: 'accept_complementary' | 'select_variant' | undefined = strategy === 'accept_complementary' || strategy === 'select_variant' ? strategy : undefined;
      const selectedArtifactId = body['selectedArtifactId'];
      const validSelection = resolvedStrategy === 'select_variant'
        ? typeof selectedArtifactId === 'string' && conflict?.variants.some((variant) => variant.artifactId === selectedArtifactId)
        : selectedArtifactId === undefined;
      const expectedKeys = resolvedStrategy === 'select_variant'
        ? ['confirmed', 'expectedRevision', 'selectedArtifactId', 'strategy', 'variantsSha256']
        : ['confirmed', 'expectedRevision', 'strategy', 'variantsSha256'];
      if (!current || !conflict || conflict.status !== 'unresolved' || !conflict.requiresDomainResolution
        || body['expectedRevision'] !== current.revision || body['variantsSha256'] !== conflict.variantsSha256
        || body['confirmed'] !== true || !resolvedStrategy || !validSelection
        || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)) {
        return this.json(route, { error: 'Fixture-Konfliktentscheidung verletzt Revision, Variantenbindung oder strict Body.' }, 409);
      }
      const resolution: AgentOrchestrationConflictResolution = {
        strategy: resolvedStrategy, resolverId: 'fixture-local-operator', resolutionReference: `fixture-conflict:${conflict.id}`,
        ...(typeof selectedArtifactId === 'string' ? { selectedArtifactId } : {}), resolvedAt: FIXED_TIME,
        resolvedAgainstRevision: current.revision, variantsSha256: conflict.variantsSha256
      };
      const updated: AgentOrchestrationRecord = {
        ...current, revision: current.revision + 1, status: 'running', updatedAt: FIXED_TIME,
        conflicts: (current.conflicts ?? []).map((candidate) => candidate.id === conflict.id
          ? { ...candidate, status: 'resolved' as const, requiresDomainResolution: false, resolution }
          : candidate)
      };
      this.orchestrations.set(orchestrationId, updated);
      return this.json(route, updated);
    }
    const orchestrationCancelMatch = path.match(/^\/api\/agent-orchestrations\/([^/]+)\/cancel$/);
    if (method === 'POST' && orchestrationCancelMatch) {
      const orchestrationId = decodeURIComponent(orchestrationCancelMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.orchestrationCancelRequests.push({ orchestrationId, body: clone(body) });
      const current = this.orchestrations.get(orchestrationId);
      if (!current || body['expectedRevision'] !== current.revision || body['confirmed'] !== true) return this.json(route, { error: 'Fixture-Abbruchrevision ist stale.' }, 409);
      const updated: AgentOrchestrationRecord = { ...current, revision: current.revision + 1, status: 'cancelled', updatedAt: FIXED_TIME, finishedAt: FIXED_TIME };
      this.orchestrations.set(orchestrationId, updated);
      return this.json(route, updated);
    }
    const orchestrationGetMatch = path.match(/^\/api\/agent-orchestrations\/([^/]+)$/);
    if (method === 'GET' && orchestrationGetMatch) {
      const orchestration = this.orchestrations.get(decodeURIComponent(orchestrationGetMatch[1]));
      return orchestration ? this.json(route, orchestration) : this.json(route, { error: 'Fixture-Orchestrierung fehlt.' }, 404);
    }
    if (method === 'GET' && path === '/api/agent-runs') return this.json(route, [...this.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));

    if (method === 'POST' && path === '/api/agent-runs/preflight') {
      const body = request.postDataJSON() as AgentRunRequest;
      this.preflightRequests.push(clone(body));
      return this.json(route, this.buildPreflight(body));
    }

    const applicationArtifactsMatch = path.match(/^\/api\/application-cases\/([^/]+)\/artifacts$/);
    if (method === 'GET' && applicationArtifactsMatch) {
      const caseId = decodeURIComponent(applicationArtifactsMatch[1]);
      return this.json(route, this.applicationArtifacts.get(caseId) ?? []);
    }

    const pipelineFinalizeMatch = path.match(/^\/api\/application-cases\/([^/]+)\/pipeline\/finalize$/);
    if (method === 'POST' && pipelineFinalizeMatch) {
      const caseId = decodeURIComponent(pipelineFinalizeMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.pipelineFinalizeRequests.push({ caseId, body: clone(body) });
      const application = this.applicationCases.get(caseId);
      if (!application || application.state !== 'review' || application.identityMode !== 'real') return this.json(route, { error: 'Fixture-Fall ist nicht finalisierbar.' }, 409);
      let manifest: { schema_version?: number; execution?: string; passes?: Array<{ role?: string; independent_context?: boolean }> };
      try { manifest = JSON.parse(String(body['iterationManifest'] ?? '')) as typeof manifest; }
      catch { return this.json(route, { error: 'Fixture-Iterationsmanifest ist ungültig.' }, 409); }
      const roles = manifest.passes?.map((item) => item.role) ?? [];
      if (manifest.schema_version !== 1 || manifest.execution !== 'independent_agents'
        || !['author', 'evidence_ats_reviewer', 'recruiter_style_reviewer', 'finalizer'].every((role) => roles.includes(role))
        || manifest.passes?.some((item) => item.independent_context !== true)) {
        return this.json(route, { error: 'Fixture-Iterationsmanifest bildet die unabhängigen Review-Rollen nicht ab.' }, 409);
      }
      const revision = pipelineRevision();
      this.applicationArtifacts.set(caseId, [revision]);
      return this.json(route, {
        draft: {
          jobId: application.job.id, identityId: application.identityId, documentType: application.documentType,
          content: String(body['annotatedContent'] ?? ''), strongestMatches: [], gaps: [], warnings: ['Ein synthetischer Sprachhinweis wurde bestätigt.'], lifecycle: 'final'
        },
        revision
      }, 201);
    }

    const applicationArtifactReviewMatch = path.match(/^\/api\/application-cases\/([^/]+)\/artifacts\/([^/]+)\/review$/);
    if (method === 'POST' && applicationArtifactReviewMatch) {
      const caseId = decodeURIComponent(applicationArtifactReviewMatch[1]);
      const revisionId = decodeURIComponent(applicationArtifactReviewMatch[2]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.artifactReviewRequests.push({ caseId, revisionId, body: clone(body) });
      const current = (this.applicationArtifacts.get(caseId) ?? []).find((item) => item.id === revisionId);
      if (!current || body['confirmed'] !== true || body['expectedSha256'] !== current.sha256 || body['acknowledgedLanguageIssueCount'] !== 1) {
        return this.json(route, { error: 'Fixture-Hash oder Sprachhinweise sind nicht mehr aktuell.' }, 409);
      }
      const decision = body['decision'] === 'approved' ? 'approved' : 'rejected';
      const updated: ArtifactRevision = {
        ...current, lifecycle: decision,
        review: { decision, reviewer: 'local-user', reviewedAt: FIXED_TIME, expectedSha256: current.sha256, acknowledgedLanguageIssueCount: 1 }
      };
      this.applicationArtifacts.set(caseId, [updated]);
      return this.json(route, updated);
    }

    const applicationTransitionMatch = path.match(/^\/api\/application-cases\/([^/]+)\/transition$/);
    if (method === 'POST' && applicationTransitionMatch) {
      const caseId = decodeURIComponent(applicationTransitionMatch[1]);
      const application = this.applicationCases.get(caseId);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.applicationTransitionRequests.push({ caseId, body: clone(body) });
      const approvedRevision = (this.applicationArtifacts.get(caseId) ?? []).find((item) => item.id === body['revisionId']);
      if (!application || body['state'] !== 'approved' || body['confirmed'] !== true || !approvedRevision
        || approvedRevision.lifecycle !== 'approved' || body['expectedSha256'] !== approvedRevision.sha256) {
        return this.json(route, { error: 'Fixture-Fall besitzt keine freigegebene Revision.' }, 409);
      }
      const updated = {
        ...application, state: 'approved' as const, revision: application.revision + 1, updatedAt: FIXED_TIME,
        approvedArtifactRevisionId: approvedRevision.id, approvedArtifactSha256: approvedRevision.sha256, approvedAt: FIXED_TIME
      };
      this.applicationCases.set(caseId, updated);
      return this.json(route, updated);
    }

    const applicationExportMatch = path.match(/^\/api\/application-cases\/([^/]+)\/export$/);
    if (method === 'POST' && applicationExportMatch) {
      const caseId = decodeURIComponent(applicationExportMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.artifactExportRequests.push({ caseId, body: clone(body) });
      const application = this.applicationCases.get(caseId);
      const current = (this.applicationArtifacts.get(caseId) ?? []).find((item) => item.id === body['revisionId']);
      if (!application || application.state !== 'approved' || !current || current.lifecycle !== 'approved' || body['confirmed'] !== true
        || application.approvedArtifactRevisionId !== current.id || application.approvedArtifactSha256 !== current.sha256) {
        return this.json(route, { error: 'Fixture-Export ist nicht revisionsgebunden freigegeben.' }, 409);
      }
      const used: ArtifactRevision = { ...current, lifecycle: 'used', usedAt: FIXED_TIME, usedForApplicationCaseId: caseId };
      this.applicationArtifacts.set(caseId, [used]);
      this.applicationCases.set(caseId, { ...application, state: 'exported', revision: application.revision + 1, updatedAt: FIXED_TIME });
      const format = body['format'] === 'docx' ? 'docx' : 'pdf';
      return this.json(route, {
        fileName: `synthetische-bewerbung.${format}`, mimeType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: 8, base64: 'RklYVFVSRQ==', revision: application.revision + 1, artifactRevisionId: used.id, artifactSha256: used.sha256,
        quality: { valid: true, warnings: [] }
      });
    }

    if (method === 'POST' && path === '/api/agent-runs') {
      const body = request.postDataJSON() as AgentRunRequest;
      this.createRequests.push(clone(body));
      const id = `fixture-created-${++this.createdRuns}`;
      const run = runFixture(id, 'running', body.prompt);
      run.request = clone(body);
      const runEvents = [
        event(1, 'run_queued', 'Run wurde in die lokale Fixture-Warteschlange aufgenommen.'),
        event(2, 'run_started', 'Run wird ohne Netzwerk ausgeführt.'),
        event(3, 'assistant_message', 'Live-Ausgabe aus dem synthetischen Eventstream.')
      ];
      this.seed(run, runEvents);
      return this.json(route, this.runs.get(id), 201);
    }

    const streamMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const runId = decodeURIComponent(streamMatch[1]);
      const after = Number(url.searchParams.get('after') ?? '0');
      const body = (this.events.get(runId) ?? []).filter((item) => item.sequence > after)
        .map((item) => `id: ${item.sequence}\nevent: agent-event\ndata: ${JSON.stringify(item)}\n\n`).join('');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: `retry: 60000\n\n${body}` });
      return;
    }

    const eventsMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const runId = decodeURIComponent(eventsMatch[1]);
      const after = Number(url.searchParams.get('after') ?? '0');
      const events = (this.events.get(runId) ?? []).filter((item) => item.sequence > after);
      return this.json(route, { events, nextAfter: Math.max(after, ...events.map((item) => item.sequence), 0) });
    }

    const recoveryLeaseMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/recovery\/lease$/);
    if (method === 'POST' && recoveryLeaseMatch) {
      const runId = decodeURIComponent(recoveryLeaseMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.recoveryLeaseRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      const recovery = this.recoveries.get(runId);
      if (body['confirmed'] !== true || body['expectedRevision'] !== run.lastEventSequence || run.status !== 'orphaned' || !recovery || recovery.lease) {
        return this.json(route, { error: 'Fixture-Recovery-Zustand wurde verändert.' }, 409);
      }
      const lease: AgentRecoveryLease = {
        runId, leaseId: '11111111-1111-4111-8111-111111111111', operatorId: 'local-user',
        acquiredAt: '2026-08-14T08:00:00.000Z', expiresAt: '2099-08-14T08:05:00.000Z'
      };
      this.recoveryLeases.set(runId, lease);
      recovery.lease = { runId, operatorId: lease.operatorId, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt };
      return this.json(route, lease);
    }

    const recoveryResolveMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/recovery\/resolve$/);
    if (method === 'POST' && recoveryResolveMatch) {
      const runId = decodeURIComponent(recoveryResolveMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.recoveryResolveRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      const lease = this.recoveryLeases.get(runId);
      const decision = body['decision'];
      if (body['confirmed'] !== true || body['expectedRevision'] !== run.lastEventSequence
        || body['leaseId'] !== lease?.leaseId || (decision !== 'cleanup' && decision !== 'resume')) {
        return this.json(route, { error: 'Fixture-Lease oder Revision ist nicht mehr gültig.' }, 409);
      }
      run.status = 'cancelled'; run.completedAt = FIXED_TIME; run.updatedAt = FIXED_TIME;
      this.append(runId, event((run.lastEventSequence ?? 0) + 1, 'run_completed', `Recovery-Entscheidung ${String(decision)} wurde protokolliert.`));
      let replacement: AgentRun | undefined;
      if (decision === 'resume') {
        replacement = runFixture(`${runId}-replacement`, 'queued', typeof body['input'] === 'string' ? body['input'] : run.request.prompt);
        replacement.request = { ...clone(run.request), prompt: replacement.request.prompt };
        replacement.createdAt = '2026-08-14T08:01:00.000Z'; replacement.updatedAt = replacement.createdAt;
        this.seed(replacement, []);
      }
      this.recoveries.delete(runId); this.recoveryLeases.delete(runId);
      return this.json(route, { resolved: run, ...(replacement ? { replacement } : {}) });
    }

    const inputMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/input$/);
    if (method === 'POST' && inputMatch) {
      const runId = decodeURIComponent(inputMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.inputRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      const approval: AgentApproval = {
        id: 'fixture-approval', kind: 'workspace_write', title: 'Synthetische Änderung freigeben',
        description: 'Es werden keine echten Dateien oder externen Systeme berührt.', risk: 'medium',
        target: 'fixture/workspace/result.txt', diff: '+ geprüfte Fixture-Ausgabe', expectedRevision: 4,
        requestedAt: FIXED_TIME, expiresAt: '2099-08-13T19:00:00.000Z', status: 'pending'
      };
      run.status = 'waiting_for_approval'; run.pendingApprovals = [approval]; run.updatedAt = FIXED_TIME;
      this.append(runId, event(3, 'input_received', 'Synthetische Rückfrage wurde beantwortet.'));
      this.append(runId, event(4, 'approval_requested', 'Ausdrückliche Freigabe ist erforderlich.', 'warning'));
      return this.json(route, run);
    }

    const approvalMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (method === 'POST' && approvalMatch) {
      const runId = decodeURIComponent(approvalMatch[1]);
      const approvalId = decodeURIComponent(approvalMatch[2]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.approvalRequests.push({ runId, approvalId, body: clone(body) });
      const run = this.requireRun(runId);
      run.pendingApprovals = [];
      run.status = body['decision'] === 'approve' ? 'succeeded' : 'cancelled';
      run.output = body['decision'] === 'approve' ? 'Synthetische Freigabe wurde nachvollziehbar verarbeitet.' : undefined;
      run.completedAt = FIXED_TIME; run.updatedAt = FIXED_TIME;
      this.append(runId, event(5, 'approval_decision', `Fixture-Entscheidung: ${String(body['decision'])}.`));
      this.append(runId, event(6, run.status === 'succeeded' ? 'run_completed' : 'run_cancelled', 'Interaktiver Fixture-Run wurde beendet.'));
      return this.json(route, run);
    }

    const cancelMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.cancelRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      run.status = 'cancelled'; run.completedAt = FIXED_TIME; run.updatedAt = FIXED_TIME;
      this.append(runId, event((run.lastEventSequence ?? 0) + 1, 'run_cancelled', 'Run wurde auf ausdrücklichen Wunsch abgebrochen.', 'warning'));
      return this.json(route, run);
    }

    const agentArtifactListMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/artifacts$/);
    if (method === 'GET' && agentArtifactListMatch) {
      const runId = decodeURIComponent(agentArtifactListMatch[1]);
      return this.json(route, { artifacts: this.agentArtifacts.get(runId) ?? [] });
    }

    const agentArtifactContentMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/artifacts\/([^/]+)\/content$/);
    if (method === 'GET' && agentArtifactContentMatch) {
      const runId = decodeURIComponent(agentArtifactContentMatch[1]);
      const artifactId = decodeURIComponent(agentArtifactContentMatch[2]);
      const artifact = (this.agentArtifacts.get(runId) ?? []).find((item) => item.id === artifactId);
      const content = this.agentArtifactContents.get(`${runId}:${artifactId}`);
      return artifact && content ? this.json(route, content) : this.json(route, { error: 'Fixture-Artefakt fehlt.' }, 404);
    }

    const agentArtifactReviewMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/artifacts\/([^/]+)\/review$/);
    if (method === 'POST' && agentArtifactReviewMatch) {
      const runId = decodeURIComponent(agentArtifactReviewMatch[1]);
      const artifactId = decodeURIComponent(agentArtifactReviewMatch[2]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.agentArtifactReviewRequests.push({ runId, artifactId, body: clone(body) });
      const artifacts = this.agentArtifacts.get(runId) ?? [];
      const current = artifacts.find((item) => item.id === artifactId);
      if (!current || current.lifecycle !== 'proposed' || body['expectedRevision'] !== current.revision || body['confirmed'] !== true) {
        return this.json(route, { error: 'Fixture-Agentenartefakt ist stale.' }, 409);
      }
      const decision = body['decision'] === 'approved' ? 'approved' : 'rejected';
      const updated: AgentArtifactRecord = {
        ...current, lifecycle: decision, revision: current.revision + 1, updatedAt: FIXED_TIME,
        review: { decision, actor: 'local-user', occurredAt: FIXED_TIME }
      };
      this.agentArtifacts.set(runId, artifacts.map((item) => item.id === artifactId ? updated : item));
      return this.json(route, updated);
    }

    const agentArtifactAdoptMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/artifacts\/([^/]+)\/adopt$/);
    if (method === 'POST' && agentArtifactAdoptMatch) {
      const runId = decodeURIComponent(agentArtifactAdoptMatch[1]);
      const artifactId = decodeURIComponent(agentArtifactAdoptMatch[2]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.agentArtifactAdoptionRequests.push({ runId, artifactId, body: clone(body) });
      const artifacts = this.agentArtifacts.get(runId) ?? [];
      const current = artifacts.find((item) => item.id === artifactId);
      const caseId = current?.provenance.applicationCaseId;
      if (!current || current.lifecycle !== 'approved' || body['expectedRevision'] !== current.revision || body['confirmed'] !== true || !caseId) {
        return this.json(route, { error: 'Fixture-Adoption ist nicht revisionsgebunden freigegeben.' }, 409);
      }
      const used: AgentArtifactRecord = {
        ...current, lifecycle: 'used', revision: current.revision + 1, updatedAt: FIXED_TIME,
        adoption: { sourceReference: pipelineRevision().id, occurredAt: FIXED_TIME }
      };
      const revision = pipelineRevision();
      this.agentArtifacts.set(runId, artifacts.map((item) => item.id === artifactId ? used : item));
      this.applicationArtifacts.set(caseId, [revision]);
      return this.json(route, { artifact: used, documentRevisionId: revision.id });
    }

    const exportMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/export$/);
    if (method === 'GET' && exportMatch) {
      const runId = decodeURIComponent(exportMatch[1]);
      return this.json(route, { run: this.requireRun(runId), events: this.events.get(runId) ?? [], redacted: true });
    }

    const runMatch = path.match(/^\/api\/agent-runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      const run = this.runs.get(decodeURIComponent(runMatch[1]));
      return run ? this.json(route, run) : this.json(route, { error: 'Fixture-Run nicht gefunden.' }, 404);
    }

    this.unknownRequests.push(`${method} ${path}`);
    return this.json(route, { error: `Nicht erlaubter Fixture-Endpunkt: ${method} ${path}` }, 404);
  }

  private buildPreflight(request: AgentRunRequest): AgentRunPreflight {
    const provider = PROVIDERS.find((candidate) => candidate.id === request.providerId);
    const installation = provider?.installations?.find((candidate) => candidate.runtimeTarget === request.runtimeTarget
      && (!request.wslDistribution || candidate.distribution === request.wslDistribution));
    const workflow = request.workflowId ? WORKFLOWS.find((candidate) => candidate.id === request.workflowId) : undefined;
    const capabilities = provider?.capabilities && !Array.isArray(provider.capabilities) ? provider.capabilities : undefined;
    const workspaceSupported = Boolean(capabilities?.workspaceModes?.includes(request.workspaceMode));
    const blockers: AgentRunPreflight['blockers'] = [];
    const warnings: AgentRunPreflight['warnings'] = [];
    const configuredProvider = this.agentConfigProfileView.profile.providers.find((candidate) => candidate.provider === request.providerId);

    if (!configuredProvider?.enabled) {
      blockers.push({ code: 'provider_disabled_by_profile', field: 'providerId', message: 'Der Provider ist im aktiven lokalen Sicherheitsprofil deaktiviert.' });
    } else {
      if (configuredProvider.runtimeTarget !== request.runtimeTarget) {
        blockers.push({ code: 'runtime_blocked_by_profile', field: 'runtimeTarget', message: `Das aktive Profil erlaubt für diesen Provider nur ${configuredProvider.runtimeTarget}.` });
      }
      if (configuredProvider.wslDistribution && configuredProvider.wslDistribution !== request.wslDistribution) {
        blockers.push({ code: 'distribution_blocked_by_profile', field: 'wslDistribution', message: 'Die WSL-Distribution stimmt nicht mit dem aktiven Profil überein.' });
      }
      if (request.workspaceMode === 'workspace_write' && configuredProvider.sandbox !== 'workspace-write') {
        blockers.push({ code: 'workspace_write_blocked_by_profile', field: 'workspaceMode', message: 'Das aktive Profil erlaubt nur einen schreibgeschützten Workspace.' });
      }
      if (request.network && configuredProvider.network === 'disabled') {
        blockers.push({ code: 'network_blocked_by_profile', field: 'network', message: 'Das aktive Profil erlaubt keinen Agenten-Netzwerkzugriff.' });
      }
    }

    if (!provider) blockers.push({ code: 'provider_unknown', field: 'providerId', message: 'Der Provider ist nicht allowlisted.' });
    else if (!provider.available) blockers.push({ code: 'provider_unavailable', field: 'providerId', message: provider.note ?? 'Der Provider ist nicht verfügbar.' });
    if (request.runtimeTarget === 'wsl' && !request.wslDistribution) {
      blockers.push({ code: 'wsl_distribution_required', field: 'wslDistribution', message: 'Für WSL muss eine erkannte Distribution ausgewählt werden.' });
    }
    if (!installation) blockers.push({ code: 'installation_unavailable', field: 'runtimeTarget', message: 'Die ausgewählte Installation ist nicht verfügbar.' });
    else if (installation.support !== 'supported') {
      blockers.push({ code: 'installation_not_supported', field: 'runtimeTarget', message: installation.note ?? 'Diese Installation besitzt keine freigegebene Contract-Fixture.' });
    } else if (installation.authStatus === 'unauthenticated') {
      blockers.push({ code: 'provider_not_authenticated', field: 'providerId', message: installation.note ?? 'Der Provider ist nicht authentifiziert.' });
    }
    if (!workspaceSupported) blockers.push({ code: 'workspace_mode_not_supported', field: 'workspaceMode', message: 'Der Provider erzwingt den angeforderten Workspace-Modus nicht.' });
    if (request.network) blockers.push({ code: 'network_not_enforceable', field: 'network', message: 'Kein freigegebener Provider kann den angeforderten Netzwerkzugriff nachweisbar begrenzen.' });
    if (request.workflowId && !workflow) blockers.push({ code: 'workflow_unknown', field: 'workflowId', message: 'Der Workflow ist nicht versioniert registriert.' });
    if (workflow && workflow.requiredScope !== 'search_profile' && !request.applicationCaseId) {
      blockers.push({ code: 'application_case_required', field: 'applicationCaseId', message: 'Der Workflow benötigt einen expliziten Bewerbungsfall.' });
    } else if (request.applicationCaseId && !this.applicationCases.has(request.applicationCaseId)) {
      blockers.push({ code: 'application_case_not_found', field: 'applicationCaseId', message: 'Der Bewerbungsfall wurde nicht gefunden.' });
    }

    const categories: AgentRunPreflight['data']['categories'] = [
      { kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 }
    ];
    if (workflow?.id === 'guided-job-analysis') {
      categories.push({ kind: 'job', availability: 'unknown_until_start', trust: 'untrusted', maxItems: 20 });
      warnings.push({
        code: 'trusted_host_search_at_start',
        message: 'Die Jobsuche läuft erst beim Start direkt als Trusted-Host-MCP; der Agent erhält ausschließlich normalisierte Ergebnisse.'
      });
    }
    if (request.applicationCaseId && this.applicationCases.has(request.applicationCaseId)) {
      categories.push({ kind: 'application_case', availability: 'included', trust: 'local', maxItems: 1 });
      if (workflow?.id === 'evidence-application-package') categories.push({ kind: 'candidate_claim', availability: 'conditional', trust: 'local' });
      if (workflow?.id === 'employer-response-triage') categories.push({ kind: 'mail', availability: 'conditional', trust: 'untrusted', maxItems: 20 });
      if (workflow?.id === 'application-next-actions') {
        categories.push({ kind: 'company', availability: 'included', trust: 'local', maxItems: 1 });
        categories.push({ kind: 'tracking_event', availability: 'conditional', trust: 'local' });
      }
    }

    const outputBytes = request.budget.maxOutputMiB * 1024 * 1024;
    return {
      contract: 'agent-run-preflight',
      contractVersion: '1.0',
      capturedAt: FIXED_TIME,
      ready: blockers.length === 0,
      blockers,
      warnings,
      provider: {
        id: request.providerId,
        name: provider?.name ?? request.providerId,
        available: provider?.available === true,
        ...(installation ? {
          installation: {
            runtimeTarget: installation.runtimeTarget,
            ...(installation.distribution ? { distribution: installation.distribution } : {}),
            ...(installation.version ? { version: installation.version } : {}),
            support: installation.support,
            ...(installation.authStatus ? { authStatus: installation.authStatus } : {})
          }
        } : {}),
        source: 'server_discovery'
      },
      runtime: {
        runtimeTarget: request.runtimeTarget,
        ...(request.wslDistribution ? { distribution: request.wslDistribution } : {}),
        supported: installation?.support === 'supported'
      },
      workspace: { ownership: 'server', mode: request.workspaceMode, supported: workspaceSupported, pathDisclosed: false },
      ...(workflow ? {
        workflow: {
          id: workflow.id,
          version: workflow.version,
          title: workflow.title,
          requiredScope: workflow.requiredScope,
          producesSuggestionsOnly: workflow.producesSuggestionsOnly,
          prohibitedActions: [...workflow.prohibitedActions]
        }
      } : {}),
      data: {
        declaredScope: workflow?.requiredScope ?? 'workspace',
        selectedApplicationCaseCount: request.applicationCaseId && this.applicationCases.has(request.applicationCaseId) ? 1 : 0,
        categories,
        exactSourceCount: null,
        maxContextCharacters: 60_000,
        actualManifestAvailableAfterStart: true
      },
      tools: {
        policy: 'deny_by_default',
        allowedRootMcpTools: [],
        allowlistComplete: true,
        providerTooling: 'prompt_context_only',
        providerToolNamesExposed: false,
        prohibitedActions: workflow ? [...workflow.prohibitedActions] : []
      },
      network: {
        requested: request.network,
        effective: 'disabled',
        enforced: true,
        trustedHostServices: workflow?.id === 'guided-job-analysis'
          ? [{ id: 'job-search-mcp', executionIsolation: 'trusted-host', agentAccessible: false, invocation: 'root_before_agent' }]
          : []
      },
      limits: {
        requested: clone(request.budget),
        effective: {
          wallTimeMs: request.budget.wallTimeMinutes * 60_000,
          idleTimeMs: Math.min(request.budget.wallTimeMinutes * 60_000, 5 * 60_000),
          totalOutputBytes: outputBytes,
          stdoutBytes: Math.floor(outputBytes * 0.8),
          stderrBytes: Math.floor(outputBytes * 0.2),
          maxInputBytes: 256 * 1024
        }
      },
      scheduling: { queueDepth: this.queueSnapshot.depth, active: this.queueSnapshot.active, limits: clone(this.queueSnapshot.limits) }
    };
  }

  private buildOrchestration(id: string, request: AgentOrchestrationCreateRequest): AgentOrchestrationRecord {
    const application = request.applicationCaseId ? this.applicationCases.get(request.applicationCaseId) : undefined;
    const evidenceWorkflow = request.workflowId === 'evidence-application-package';
    const mailWorkflow = request.workflowId === 'employer-response-triage';
    const gatedNodeId = evidenceWorkflow ? 'finalizer' : mailWorkflow ? 'respond' : undefined;
    const unresolvedGates: AgentOrchestrationRecord['unresolvedGates'] = gatedNodeId
      ? [{ nodeId: gatedNodeId, gate: 'user_input' }]
      : [];
    const evidenceArtifact = { outputRef: 'evidence_matrix', artifactId: 'fixture-evidence-matrix', runId: 'fixture-orchestration-evidence', sha256: '6'.repeat(64), lifecycle: 'proposed' as const };
    const evidenceNodes: AgentOrchestrationRecord['nodes'] = [
      { nodeId: 'evidence', role: 'evidence_reviewer', dependsOn: [], status: 'succeeded', attempts: 1, runIds: ['fixture-orchestration-evidence'], inputDigests: {}, artifacts: [evidenceArtifact] },
      { nodeId: 'author', role: 'author', dependsOn: ['evidence'], status: 'succeeded', attempts: 1, runIds: ['fixture-orchestration-author'], inputDigests: {}, artifacts: [] },
      { nodeId: 'ats', role: 'ats_reviewer', dependsOn: ['author'], status: 'succeeded', attempts: 1, runIds: ['fixture-orchestration-ats'], inputDigests: {}, artifacts: [] },
      { nodeId: 'style', role: 'recruiter_style_reviewer', dependsOn: ['author'], status: 'succeeded', attempts: 1, runIds: ['fixture-orchestration-style'], inputDigests: {}, artifacts: [] },
      { nodeId: 'finalizer', role: 'finalizer', dependsOn: ['ats', 'style'], status: unresolvedGates.length ? 'pending' : 'running', attempts: unresolvedGates.length ? 0 : 1, runIds: [], inputDigests: {}, artifacts: [] }
    ];
    const mailNodes: AgentOrchestrationRecord['nodes'] = [
      { nodeId: 'classify', role: 'mail_classifier', dependsOn: [], status: 'succeeded', attempts: 1, runIds: ['fixture-orchestration-classify'], inputDigests: {}, artifacts: [] },
      { nodeId: 'correlate', role: 'case_correlator', dependsOn: ['classify'], status: 'succeeded', attempts: 1, runIds: ['fixture-orchestration-correlate'], inputDigests: {}, artifacts: [] },
      { nodeId: 'respond', role: 'response_drafter', dependsOn: ['correlate'], status: unresolvedGates.length ? 'pending' : 'running', attempts: unresolvedGates.length ? 0 : 1, runIds: [], inputDigests: {}, artifacts: [] }
    ];
    const genericNodes: AgentOrchestrationRecord['nodes'] = request.workflowId === 'guided-job-analysis'
      ? [
          { nodeId: 'source-analysis', role: 'job_analyst', dependsOn: [], status: 'running', attempts: 1, runIds: [], inputDigests: {}, artifacts: [] },
          { nodeId: 'evidence-ranking', role: 'ranking_explainer', dependsOn: ['source-analysis'], status: 'pending', attempts: 0, runIds: [], inputDigests: {}, artifacts: [] }
        ]
      : [{ nodeId: 'next-actions', role: 'application_coordinator', dependsOn: [], status: 'running', attempts: 1, runIds: [], inputDigests: {}, artifacts: [] }];
    return {
      schemaVersion: 1, id, revision: 1, workflowId: request.workflowId, workflowVersion: '1.0.0', providerId: request.providerId,
      status: unresolvedGates.length ? 'waiting_for_gate' : 'running', producesSuggestionsOnly: true, promptSha256: '4'.repeat(64),
      redactedSummary: `${WORKFLOWS.find((item) => item.id === request.workflowId)?.title ?? request.workflowId} · ${evidenceWorkflow ? 5 : mailWorkflow ? 3 : genericNodes.length} getrennte Rollen · nur Vorschläge`,
      scope: {
        ...(application ? { applicationCaseId: application.id, applicationCaseRevision: application.revision, jobId: application.job.id, companyKey: 'beispiel' } : {}),
        ...(request.mailId ? { mailId: request.mailId } : {}),
        ...(request.documentRevisionId ? { documentRevisionId: request.documentRevisionId } : {}), workspaceRootId: 'workspace-local',
        identityMode: application?.identityMode ?? 'incognito'
      },
      resolvedGates: [
        ...(evidenceWorkflow ? [{ nodeId: 'evidence', gate: 'evidence_complete' as const, authority: 'server_evidence' as const, bindingSha256: '3'.repeat(64) }] : [])
      ],
      unresolvedGates,
      conflicts: [],
      nodes: evidenceWorkflow ? evidenceNodes : mailWorkflow ? mailNodes : genericNodes,
      nodeRunIds: evidenceWorkflow
        ? { evidence: ['fixture-orchestration-evidence'], author: ['fixture-orchestration-author'], ats: ['fixture-orchestration-ats'], style: ['fixture-orchestration-style'], finalizer: [] }
        : mailWorkflow
          ? { classify: ['fixture-orchestration-classify'], correlate: ['fixture-orchestration-correlate'], respond: [] }
          : Object.fromEntries(genericNodes.map((node) => [node.nodeId, node.runIds])),
      artifactRefs: evidenceWorkflow ? [evidenceArtifact] : [], budget: { wallTimeMs: 1500, tokens: 90, costMicros: 0, toolCalls: 1, iterations: 1 },
      createdAt: FIXED_TIME, updatedAt: FIXED_TIME
    };
  }

  private advanceCvAiRun(current: CvAiStructuringPublicRun): CvAiStructuringPublicRun {
    if (current.status === 'queued') return this.updateCvAiRun(current, 'running');
    if (current.status === 'running' && this.failedCvAiRuns.has(current.id)) {
      this.failedCvAiRuns.delete(current.id);
      return {
        ...this.updateCvAiRun(current, 'failed', 'failed'),
        failure: { code: 'fixture_ai_failed', stage: 'agent', retryable: true }
      };
    }
    if (current.status === 'running') return this.updateCvAiRun(current, 'validating', 'provider_completed');
    if (current.status === 'validating') return this.materializeCvAiRecognitionVersion(current);
    if (current.status === 'cancel_requested') return this.updateCvAiRun(current, 'cancelled', 'cancelled');
    return clone(current);
  }

  private initializeCvRecognitionVersions(record: CvImportRecord): void {
    const id = CV_DETERMINISTIC_RECOGNITION_ID;
    this.cvRecognitionFacts.clear(); this.cvRecognitionFacts.set(id, clone(record.facts));
    this.cvRecognitionVersions = {
      contract: 'cv-recognition-version-list', contractVersion: '1.0', importId: record.id, activeVersionId: id,
      versions: [{
        id, ordinal: 1, kind: 'deterministic', label: 'Deterministische Erkennung',
        createdAt: record.createdAt, updatedAt: record.updatedAt, active: true,
        factCounts: this.cvFactCounts(record.facts), warningCount: record.warnings.length
      }]
    };
  }

  private materializeCvAiRecognitionVersion(current: CvAiStructuringPublicRun): CvAiStructuringPublicRun {
    if (!this.cvImport || !this.cvRecognitionVersions) return {
      ...this.updateCvAiRun(current, 'failed', 'failed'),
      failure: { code: 'fixture_recognition_state_missing', stage: 'apply', retryable: false }
    };
    const sourceSha256 = this.cvImport.source.sha256;
    const fields = [
      ['employer', 'Beispiel GmbH'], ['role', 'Entwickler'], ['start_date', '2022-01'],
      ['end_date', 'present'], ['location', 'Testregion']
    ] as const;
    const facts: CvImportRecord['facts'] = fields.map(([field, value], index) => ({
      id: `fact-ai-${field}`, category: 'employment', recordId: 'employment-fixture', field, value,
      decision: 'pending', provenance: {
        sourceSha256, anchor: `Zeile ${index + 2}`, origin: 'imported',
        recognition: {
          method: 'ai_assisted', runId: current.id, proposalSha256: '2'.repeat(64),
          suggestionId: `suggestion-${String(index + 1).repeat(16)}`, confidence: .9,
          questions: [], sourceSpan: { lineStart: index + 2, lineEnd: index + 2, charStart: 0, charEnd: value.length }
        }
      }
    }));
    const versionId = CV_AI_RECOGNITION_ID;
    const revision = this.cvImport.revision + 1; const sha256 = Math.min(15, revision).toString(16).repeat(64);
    this.cvRecognitionFacts.set(versionId, clone(facts));
    this.cvRecognitionVersions = {
      ...this.cvRecognitionVersions, activeVersionId: versionId,
      versions: [
        ...this.cvRecognitionVersions.versions.map((version) => ({ ...version, active: false })),
        {
          id: versionId, ordinal: 2, kind: 'ai', label: 'KI-Strukturierung', createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME, active: true, factCounts: this.cvFactCounts(facts),
          warningCount: 0, provider: { id: current.provider.id, version: current.provider.version }
        }
      ]
    };
    this.cvImport = {
      ...this.cvImport, revision, sha256, updatedAt: FIXED_TIME, status: 'facts_pending', facts: clone(facts),
      activeRecognitionVersionId: versionId, adoption: undefined, proposal: undefined
    };
    const applied = this.updateCvAiRun(current, 'applied', 'applied');
    return {
      ...applied,
      result: {
        cvImportRevision: revision, cvImportSha256: sha256, stagedFactIds: facts.map((fact) => fact.id),
        factsRemainPending: true, recognitionVersionId: versionId,
        recognitionVersionCount: this.cvRecognitionVersions.versions.length
      }
    };
  }

  private cvFactCounts(facts: CvImportRecord['facts']): { total: number; pending: number; confirmed: number; rejected: number } {
    return {
      total: facts.length,
      pending: facts.filter((fact) => fact.decision === 'pending').length,
      confirmed: facts.filter((fact) => fact.decision === 'confirmed').length,
      rejected: facts.filter((fact) => fact.decision === 'rejected').length
    };
  }

  private syncActiveCvRecognitionVersion(): void {
    if (!this.cvImport || !this.cvRecognitionVersions) return;
    const activeId = this.cvRecognitionVersions.activeVersionId;
    this.cvRecognitionFacts.set(activeId, clone(this.cvImport.facts));
    this.cvRecognitionVersions = {
      ...this.cvRecognitionVersions,
      versions: this.cvRecognitionVersions.versions.map((version) => version.id === activeId
        ? { ...version, updatedAt: this.cvImport!.updatedAt, factCounts: this.cvFactCounts(this.cvImport!.facts), warningCount: this.cvImport!.warnings.length }
        : version)
    };
  }

  private updateCvAiRun(
    current: CvAiStructuringPublicRun,
    status: CvAiStructuringPublicRun['status'],
    action?: CvAiStructuringPublicRun['auditTrail'][number]['action']
  ): CvAiStructuringPublicRun {
    const revision = current.revision + 1;
    return {
      ...current, revision, sha256: Math.min(15, revision + 1).toString(16).repeat(64), status, updatedAt: FIXED_TIME,
      auditTrail: action ? [...current.auditTrail, {
        sequence: current.auditTrail.length + 1, occurredAt: FIXED_TIME, action
      }] : current.auditTrail
    };
  }

  private requireRun(runId: string): AgentRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unbekannter Fixture-Run ${runId}`);
    return run;
  }

  private append(runId: string, item: AgentRunEvent): void {
    const events = this.events.get(runId) ?? [];
    events.push(item);
    this.events.set(runId, events);
    const run = this.requireRun(runId);
    run.lastEventSequence = Math.max(run.lastEventSequence ?? 0, item.sequence);
  }

  private async json(route: Route, value: unknown, status = 200): Promise<void> {
    await route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(clone(value)) });
  }
}

export const test = base.extend<{ agentApi: AgentApiStub }>({
  agentApi: async ({ page }, use) => {
    const agentApi = new AgentApiStub();
    await agentApi.install(page);
    await use(agentApi);
    expect(agentApi.unknownRequests, 'Die UI darf nur explizit gestubbte API-Endpunkte verwenden.').toEqual([]);
    expect(agentApi.externalRequests, 'Die Offline-Suite blockiert und meldet jeden externen Request.').toEqual([]);
  }
});

export { expect };
