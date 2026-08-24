import { TestBed } from '@angular/core/testing';
import { EMPTY, of, throwError } from 'rxjs';
import { App } from './app';
import { ApiService } from './api.service';
import type { AgentArtifactRecord, AgentConfigProfileView, AgentOrchestrationConflict, AgentOrchestrationRecord, AgentRecoveryRun, AgentRun, AgentRunPreflight, AgentRunRequest, AppConfig, ApplicationCase, ApplicationStyleProfileView, ArtifactRevision, CorrelatedMail, CvAiStructuringOptions, CvAiStructuringPublicRun, CvImportRecord, CvLayoutFingerprint, CvRecognitionVersionList, JobInventoryView } from './models';

const CV_DETERMINISTIC_RECOGNITION_ID = 'recognition-1111111111111111';
const CV_AI_RECOGNITION_ID = 'recognition-2222222222222222';

const config: AppConfig = {
  revision: 0,
  searchProfile: {
    name: 'Testprofil', query: 'Angular', regions: ['Berlin'], radiusKm: 50,
    workModels: ['hybrid'], employmentTypes: ['full_time'], mustHave: ['TypeScript'],
    niceToHave: ['Angular'], exclude: [], sourceIds: ['stepstone']
  },
  identities: [{
    id: 'demo', label: 'Inkognito', mode: 'incognito', fullName: 'Alex Beispiel',
    email: 'alex@example.invalid', phone: '', location: 'Berlin', linkedin: '', placeholders: {}
  }],
  activeIdentityId: 'demo',
  mcp: {
    mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'windows', command: 'C:\\synthetic\\job-search-mcp.exe', args: [],
    env: { ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' }, configuredEnvironmentKeys: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']
  },
  assistant: { skillPath: '', candidateProfilePath: '', styleProfilePath: '' }
};

const agentConfigProfileFixture: AgentConfigProfileView = {
  source: 'primary',
  profile: {
    schemaVersion: 2, profileId: 'safe-default', updatedAt: '2026-08-14T08:00:00.000Z',
    providers: [
      { provider: 'codex-exec', enabled: true, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit' },
      { provider: 'opencode', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }
    ],
    budgets: { warningAtPercent: 80, maxTotalTokens: 100_000, maxToolCalls: 100, maxRunDurationMs: 1_800_000 },
    features: { codexAppServerExperimental: false, multiAgentExperimental: true, realtimeWebSocketExperimental: false, rawProviderLogs: false }
  }
};

function preflightFixture(request: AgentRunRequest): AgentRunPreflight {
  const guided = request.workflowId === 'guided-job-analysis';
  const outputBytes = request.budget.maxOutputMiB * 1024 * 1024;
  return {
    contract: 'agent-run-preflight', contractVersion: '1.0', capturedAt: '2026-08-14T08:00:00Z',
    ready: true, blockers: [], warnings: guided ? [{ code: 'trusted_host_search_at_start', message: 'Die Jobsuche läuft erst beim Start als Trusted-Host-MCP.' }] : [],
    provider: {
      id: request.providerId, name: 'Codex CLI', available: true, source: 'server_discovery',
      installation: {
        runtimeTarget: request.runtimeTarget, ...(request.wslDistribution ? { distribution: request.wslDistribution } : {}),
        version: request.runtimeTarget === 'wsl' ? '1.1' : '1.0', adapterVersion: 'agent-runner-v1', support: 'supported', authStatus: 'authenticated'
      }
    },
    runtime: { runtimeTarget: request.runtimeTarget, ...(request.wslDistribution ? { distribution: request.wslDistribution } : {}), supported: true },
    workspace: { ownership: 'server', mode: request.workspaceMode, supported: true, pathDisclosed: false },
    ...(guided ? { workflow: {
      id: 'guided-job-analysis' as const, version: '1.0.0', title: 'Geführte Stellenanalyse', requiredScope: 'search_profile' as const,
      producesSuggestionsOnly: true as const, prohibitedActions: ['submit_application']
    } } : {}),
    data: {
      declaredScope: guided ? 'search_profile' : 'workspace', selectedApplicationCaseCount: 0,
      categories: guided
        ? [
            { kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 },
            { kind: 'job', availability: 'unknown_until_start', trust: 'untrusted', maxItems: 20 }
          ]
        : [{ kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 }],
      exactSourceCount: null, maxContextCharacters: 60_000, actualManifestAvailableAfterStart: true
    },
    tools: {
      policy: 'deny_by_default', allowedRootMcpTools: [], allowlistComplete: true,
      providerTooling: 'server_owned_dynamic_tools', providerToolNamesExposed: false,
      prohibitedActions: guided ? ['submit_application'] : []
    },
    network: {
      requested: request.network, effective: 'disabled', enforced: true,
      trustedHostServices: guided ? [{ id: 'job-search-mcp', executionIsolation: 'trusted-host', agentAccessible: false, invocation: 'root_before_agent' }] : []
    },
    limits: {
      requested: { ...request.budget },
      effective: {
        wallTimeMs: request.budget.wallTimeMinutes * 60_000,
        idleTimeMs: Math.min(request.budget.wallTimeMinutes, 5) * 60_000,
        totalOutputBytes: outputBytes, stdoutBytes: Math.floor(outputBytes * 0.8), stderrBytes: Math.floor(outputBytes * 0.2), maxInputBytes: 256 * 1024
      }
    },
    scheduling: {
      queueDepth: 0, active: 0,
      limits: { global: 2, perProvider: 1, perWorkspace: 1, perOwner: 1, queuedGlobal: 20, queuedPerWorkspace: 5, queuedPerOwner: 5 }
    }
  };
}

const applicationCaseFixture: ApplicationCase = {
  id: '11111111-1111-4111-8111-111111111111',
  job: {
    id: 'job-pipeline-fixture', sourceId: 'fixture', title: 'Angular Engineer', company: 'Beispiel GmbH', location: 'Berlin',
    workModel: 'hybrid', employmentType: 'full_time', description: 'Synthetische Stellenbeschreibung', skills: ['Angular']
  },
  identityId: 'real-fixture', identityMode: 'real', documentType: 'cover_letter', state: 'review',
  createdAt: '2026-08-14T08:00:00Z', updatedAt: '2026-08-14T08:01:00Z', revision: 4, artifactNames: [], warnings: []
};

const styleProfileFixture: ApplicationStyleProfileView = {
  contract: 'application-style-profile', contractVersion: '1.0', revision: 3, sha256: '8'.repeat(64), initialized: true,
  languageBackend: { backend: 'nspell', localOnly: true, remoteServiceAllowed: false },
  profile: {
    language: 'Deutsch', locale: 'de-DE', tone: 'klar', formality: 'professionell', directness: 'direkt',
    sentenceLength: 'kurz bis mittel', technicalDepth: 'konkret', enthusiasm: 'zurückhaltend', selfPromotion: 'belegbasiert', humor: 'sparsam',
    vocabulary: { prefer: ['umgesetzt'], avoid: ['Guru'] }, preferredPatterns: ['Ergebnis zuerst'], avoidPatterns: ['Superlative'],
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

const validIterationManifest = JSON.stringify({
  schema_version: 1, mode: 'standard', execution: 'independent_agents', cycle: 1,
  passes: [
    { id: 'pass-author-1', role: 'author', independent_context: true, input_revision: 'source', output_revision: 'revision-1', findings: [] },
    { id: 'pass-evidence-ats-1', role: 'evidence_ats_reviewer', independent_context: true, input_revision: 'revision-1', output_revision: 'revision-2', findings: [] },
    { id: 'pass-recruiter-style-1', role: 'recruiter_style_reviewer', independent_context: true, input_revision: 'revision-2', output_revision: 'revision-3', findings: [] },
    { id: 'pass-finalizer-1', role: 'finalizer', independent_context: true, input_revision: 'revision-3', output_revision: 'final', findings: [] }
  ]
});

const artifactRevisionFixture: ArtifactRevision = {
  id: '22222222-2222-4222-8222-222222222222', applicationCaseId: applicationCaseFixture.id,
  companyKey: 'beispiel', jobId: applicationCaseFixture.job.id, type: 'cover_letter', lifecycle: 'proposed',
  sha256: 'a'.repeat(64), bytes: 1234, artifactPath: '.application-work/synthetic-not-exposed.txt', pipelineContractVersion: '1.0.0',
  pipelineProof: {
    contract: 'application-pipeline-proof', contractVersion: '1.0', pipelineContractVersion: '1.0.0',
    applicationCaseId: applicationCaseFixture.id, jobId: applicationCaseFixture.job.id, identityId: applicationCaseFixture.identityId,
    documentType: 'cover_letter', issuedAt: '2026-08-14T08:02:00Z', signature: 'synthetic-signature',
    completedStages: ['validate_profiles', 'analyze_job', 'build_match_matrix', 'questions_reviewed', 'validate_iteration', 'audit_claims', 'check_style'],
    annotatedSha256: 'b'.repeat(64), iterationManifestSha256: 'c'.repeat(64), candidateProfileSha256: 'd'.repeat(64),
    styleProfileSha256: 'e'.repeat(64), artifactSha256: 'a'.repeat(64),
    languageCheck: { available: true, backend: 'nspell-local', language: 'de-DE', issueCount: 1, issuesSha256: 'f'.repeat(64), checkedArtifactSha256: 'a'.repeat(64) },
    preparation: { jobAnalysisSha256: '1'.repeat(64), matchMatrixSha256: '2'.repeat(64), unresolvedQuestionsSha256: '3'.repeat(64), matchMatrixValid: true }
  },
  createdAt: '2026-08-14T08:02:00Z'
};

function cvImportFixture(decisions: Array<'pending' | 'confirmed' | 'rejected'> = ['pending', 'pending']): CvImportRecord {
  const sourceSha256 = '6'.repeat(64);
  return {
    contract: 'cv-import', contractVersion: '1.0',
    id: '66666666-6666-4666-8666-666666666666', revision: 1, sha256: '7'.repeat(64), status: 'facts_pending',
    createdAt: '2026-08-14T08:00:00Z', updatedAt: '2026-08-14T08:00:00Z',
    source: {
      fileName: 'synthetischer-lebenslauf.html', mimeType: 'text/html', bytes: 321, sha256: sourceSha256,
      retention: 'upload_deleted_after_local_extraction'
    },
    facts: [
      {
        id: 'fact-employment-company', category: 'employment', recordId: 'employment-1', field: 'company', value: 'Beispiel GmbH',
        decision: decisions[0] ?? 'pending', provenance: { sourceSha256, anchor: 'Zeile 4', origin: 'imported' }
      },
      {
        id: 'fact-employment-period', category: 'employment', recordId: 'employment-1', field: 'period', value: '2022–2026',
        decision: decisions[1] ?? 'pending', provenance: { sourceSha256, anchor: 'Zeile 5', origin: 'imported' }
      }
    ],
    warnings: ['Synthetische Zeitangabe bitte prüfen.'],
    activeRecognitionVersionId: CV_DETERMINISTIC_RECOGNITION_ID
  };
}

function adoptedCvImportFixture(): CvImportRecord {
  return {
    ...cvImportFixture(['confirmed', 'rejected']), revision: 4, sha256: 'a'.repeat(64), status: 'adopted',
    adoption: {
      adoptedAt: '2026-08-14T08:03:00Z', adoptedClaimIds: ['claim-cv-employment-company'], adoptedRecordIds: ['employment-1'],
      candidateProfileSha256: 'b'.repeat(64), candidateProfileRevision: 'profile-revision-4',
      recognitionVersionId: CV_DETERMINISTIC_RECOGNITION_ID, recognitionVersionSha256: '6'.repeat(64)
    }
  };
}

function cvAiOptionsFixture(current: CvImportRecord): CvAiStructuringOptions {
  return {
    contract: 'cv-ai-structuring-options', contractVersion: '1.0', capturedAt: '2026-08-14T08:01:00Z',
    cvImport: { id: current.id, revision: current.revision, sha256: current.sha256 },
    providers: [{
      providerId: 'codex', installations: [{
        runtimeTarget: 'windows', version: '1.0', adapterVersion: '1.0', support: 'supported',
        authStatus: 'authenticated', ready: true, blockers: [],
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

function cvRecognitionVersionsFixture(current: CvImportRecord, active: 'deterministic' | 'ai' = 'deterministic'): CvRecognitionVersionList {
  const deterministic = {
    id: CV_DETERMINISTIC_RECOGNITION_ID, ordinal: 1, kind: 'deterministic' as const, label: 'Lokale Erkennung',
    createdAt: current.createdAt, updatedAt: current.updatedAt, active: active === 'deterministic',
    factCounts: {
      total: current.facts.length,
      pending: current.facts.filter((fact) => fact.decision === 'pending').length,
      confirmed: current.facts.filter((fact) => fact.decision === 'confirmed').length,
      rejected: current.facts.filter((fact) => fact.decision === 'rejected').length
    },
    warningCount: current.warnings.length
  };
  const ai = {
    id: CV_AI_RECOGNITION_ID, ordinal: 2, kind: 'ai' as const, label: 'KI-Strukturierung',
    createdAt: '2026-08-14T08:04:00Z', updatedAt: current.updatedAt, active: active === 'ai',
    factCounts: { ...deterministic.factCounts }, warningCount: current.warnings.length,
    provider: { id: 'codex', version: '1.0' }
  };
  return {
    contract: 'cv-recognition-version-list', contractVersion: '1.0', importId: current.id,
    activeVersionId: active === 'ai' ? ai.id : deterministic.id,
    versions: active === 'ai' ? [deterministic, ai] : [deterministic]
  };
}

function cvAiRunFixture(
  current: CvImportRecord,
  status: CvAiStructuringPublicRun['status'] = 'suggestions_ready'
): CvAiStructuringPublicRun {
  const proposal = {
    sha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64), suggestions: [
      {
        id: 'suggestion-1111111111111111', path: 'experience[0].employer', collection: 'experience',
        recordId: 'employment-1', field: 'employer', category: 'employment', mergeable: true,
        value: 'Beispiel GmbH', sourceAnchor: { lineStart: 4, lineEnd: 4, charStart: 0, charEnd: 13, quote: 'Beispiel GmbH' },
        confidence: .93, alternatives: [], questions: [], status: 'unverified' as const
      },
      {
        id: 'suggestion-2222222222222222', path: 'experience[0].role', collection: 'experience',
        recordId: 'employment-1', field: 'role', category: 'employment', mergeable: true,
        value: 'Entwickler', sourceAnchor: { lineStart: 5, lineEnd: 5, charStart: 0, charEnd: 10, quote: 'Entwickler' },
        confidence: .62, alternatives: [{
          id: 'alternative-3333333333333333', value: 'Senior Entwickler',
          sourceAnchor: { lineStart: 5, lineEnd: 5, charStart: 0, charEnd: 17, quote: 'Senior Entwickler' }, confidence: .54
        }], questions: ['Welche Rollenbezeichnung ist belegt?'], status: 'unverified' as const
      }
    ]
  };
  return {
    contract: 'cv-ai-structuring-run', contractVersion: '1.0',
    id: '88888888-8888-4888-8888-888888888888', cvImportId: current.id, revision: 3,
    sha256: 'd'.repeat(64), status, mode: 'replace_with_ai_version', attempt: 1,
    createdAt: '2026-08-14T08:02:00Z', updatedAt: '2026-08-14T08:03:00Z', expiresAt: '2026-08-15T08:02:00Z',
    provider: { id: 'codex', runtimeTarget: 'windows', version: '1.0', adapterVersion: '1.0' },
    disclosure: {
      version: '1.0', confirmedAt: '2026-08-14T08:02:00Z', confirmedBy: { id: 'local-user', type: 'local' },
      extractedCvTextShared: true, providerControlPlaneNetworkAcknowledged: true,
      toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false
    },
    binding: {
      cvImportRevision: current.revision, cvImportSha256: current.sha256, sourceId: 'source-cv-1111111111111111',
      sourceSha256: current.source.sha256, extractedTextSha256: 'e'.repeat(64), baseProposalSha256: 'f'.repeat(64),
      lineManifestSha256: '1'.repeat(64), promptTemplateVersion: 'cv-ai-structuring/1.0', promptSha256: '2'.repeat(64),
      outputContractVersion: '1.0', outputSchemaSha256: '3'.repeat(64), inputSha256: '4'.repeat(64)
    },
    ...(status === 'suggestions_ready' || status === 'applying' || status === 'applied' ? { proposal } : {}),
    ...(status === 'applied' ? {
      result: {
        cvImportRevision: current.revision + 1, cvImportSha256: '9'.repeat(64), stagedFactIds: ['fact-ai-role'],
        factsRemainPending: true as const, recognitionVersionId: CV_AI_RECOGNITION_ID, recognitionVersionCount: 2
      }
    } : {}),
    auditTrail: [{ sequence: 1, occurredAt: '2026-08-14T08:02:00Z', action: 'started' }]
  };
}

function orchestrationFixture(status: AgentOrchestrationRecord['status'] = 'running'): AgentOrchestrationRecord {
  const packageProposal = {
    outputRef: 'final_html', artifactId: 'artifact-html', runId: 'run-finalizer',
    sha256: '4'.repeat(64), lifecycle: 'proposed' as const
  };
  return {
    schemaVersion: 1, id: '33333333-3333-4333-8333-333333333333', revision: 1,
    workflowId: 'evidence-application-package', workflowVersion: '1.1.0', providerId: 'codex', status,
    producesSuggestionsOnly: true, promptSha256: '1'.repeat(64), redactedSummary: 'Evidence-Paket · getrennte Rollen · nur Vorschläge',
    scope: { applicationCaseId: applicationCaseFixture.id, applicationCaseRevision: applicationCaseFixture.revision, jobId: applicationCaseFixture.job.id, companyKey: 'beispiel', identityMode: 'real', workspaceRootId: 'workspace-local' },
    resolvedGates: [
      { nodeId: 'evidence', gate: 'evidence_complete', authority: 'server_evidence', bindingSha256: '3'.repeat(64) }
    ],
    unresolvedGates: [],
    conflicts: [],
    nodes: [
      { nodeId: 'evidence', role: 'evidence_reviewer', dependsOn: [], status: 'succeeded', attempts: 1, runIds: ['run-evidence'], inputDigests: {}, artifacts: [{ outputRef: 'evidence_matrix', artifactId: 'artifact-evidence', runId: 'run-evidence', sha256: '2'.repeat(64), lifecycle: 'proposed' }] },
      { nodeId: 'author', role: 'author', dependsOn: ['evidence'], status: 'succeeded', attempts: 1, runIds: ['run-author'], inputDigests: {}, artifacts: [] },
      { nodeId: 'ats', role: 'ats_reviewer', dependsOn: ['author'], status: 'succeeded', attempts: 1, runIds: ['run-ats'], inputDigests: {}, artifacts: [] },
      { nodeId: 'style', role: 'recruiter_style_reviewer', dependsOn: ['author'], status: 'succeeded', attempts: 1, runIds: ['run-style'], inputDigests: {}, artifacts: [] },
      { nodeId: 'finalizer', role: 'finalizer', dependsOn: ['ats', 'style'], status: status === 'succeeded' ? 'succeeded' : 'pending', attempts: status === 'succeeded' ? 1 : 0, runIds: status === 'succeeded' ? ['run-finalizer'] : [], inputDigests: {}, artifacts: status === 'succeeded' ? [packageProposal] : [] }
    ],
    nodeRunIds: { evidence: ['run-evidence'], author: ['run-author'], ats: ['run-ats'], style: ['run-style'], finalizer: status === 'succeeded' ? ['run-finalizer'] : [] },
    artifactRefs: [
      { outputRef: 'evidence_matrix', artifactId: 'artifact-evidence', runId: 'run-evidence', sha256: '2'.repeat(64), lifecycle: 'proposed' },
      ...(status === 'succeeded' ? [packageProposal] : [])
    ],
    budget: { wallTimeMs: 2000, tokens: 120, costMicros: 0, toolCalls: 1, iterations: 1 },
    createdAt: '2026-08-14T08:00:00Z', updatedAt: '2026-08-14T08:01:00Z'
  };
}

function orchestrationConflictFixture(): AgentOrchestrationConflict {
  return {
    id: 'ats-style-finalizer-1', targetNodeId: 'finalizer', kind: 'ats_style_fan_in', status: 'unresolved',
    requiresDomainResolution: true, variantsSha256: '9'.repeat(64),
    variants: [
      {
        sourceNodeId: 'ats', sourceRole: 'ats_reviewer', outputRef: 'ats_review', runId: 'run-ats',
        artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sha256: 'a'.repeat(64)
      },
      {
        sourceNodeId: 'style', sourceRole: 'recruiter_style_reviewer', outputRef: 'style_review', runId: 'run-style',
        artifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sha256: 'b'.repeat(64)
      }
    ]
  };
}

describe('App', () => {
  let apiMock: Record<string, ReturnType<typeof vi.fn>>;
  const agentRun: AgentRun = {
    id: 'run-1', providerId: 'codex', status: 'waiting_for_approval',
    request: { providerId: 'codex', prompt: 'Prüfe den Bewerbungsfall', runtimeTarget: 'windows', workspaceMode: 'read_only', network: false, budget: { wallTimeMinutes: 30, maxOutputMiB: 10 } },
    createdAt: '2026-08-13T18:00:00Z', updatedAt: '2026-08-13T18:01:00Z',
    pendingApprovals: [{ id: 'approval-1', kind: 'workspace_write', title: 'Datei ändern', risk: 'medium', expectedRevision: 3, status: 'pending' }],
    usage: { inputTokens: 120, outputTokens: 30, toolCalls: 1, durationMs: 2500 }, lastEventSequence: 3
  };

  beforeEach(async () => {
    apiMock = {
      config: vi.fn().mockReturnValue(of(structuredClone(config))),
      sources: vi.fn().mockReturnValue(of([])),
      sourceRuntime: vi.fn().mockReturnValue(of({
        contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'ready_to_connect',
        runtimeTarget: 'windows', launchValidated: true, connected: false, note: 'Synthetischer Startpfad ist validiert.'
      })),
      mcpRuntimeCandidates: vi.fn().mockReturnValue(of({ candidates: [
        { runtimeTarget: 'windows', available: true, active: true, note: 'nativ validiert' },
        { runtimeTarget: 'wsl', available: true, active: false, distribution: 'Ubuntu', note: 'WSL validiert' }
      ] })),
      selectMcpRuntime: vi.fn().mockImplementation(() => of(structuredClone(config))),
      capabilities: vi.fn().mockReturnValue(of({ contract: 'job-search-mcp', contractVersion: '1.0', compatible: true, tools: [], errorCategories: [], sources: [] })),
      applicationPipelineSetup: vi.fn().mockReturnValue(of({
        contract: 'application-profile-setup', contractVersion: '1.0', candidateProfile: 'present', styleProfile: 'present', initialized: true,
        containsCandidateFacts: false, note: 'Synthetische Profile sind vorhanden.'
      })),
      initializeApplicationProfiles: vi.fn().mockReturnValue(of({
        contract: 'application-profile-setup', contractVersion: '1.0', candidateProfile: 'present', styleProfile: 'present', initialized: true,
        containsCandidateFacts: false, note: 'Leere Vorlagen angelegt.', created: ['candidate-profile', 'style-profile']
      })),
      applicationStyleProfile: vi.fn().mockReturnValue(of(structuredClone(styleProfileFixture))),
      saveApplicationStyleProfile: vi.fn().mockImplementation((_current, profile) => of({
        ...structuredClone(styleProfileFixture), revision: 4, sha256: '9'.repeat(64), profile: structuredClone(profile)
      })),
      candidateProfile: vi.fn().mockReturnValue(of({ contractVersion: '1.0', valid: true, errors: [], profile: {}, claims: [] })),
      importCv: vi.fn(),
      cvImports: vi.fn().mockReturnValue(of([])),
      cvImport: vi.fn(),
      cvRecognitionVersions: vi.fn().mockImplementation((current: CvImportRecord) => of(cvRecognitionVersionsFixture(current))),
      activateCvRecognitionVersion: vi.fn(),
      confirmCvRecognitionVersion: vi.fn(),
      revocableCvAdoptions: vi.fn().mockImplementation((current: CvImportRecord) => of({
        contract: 'cv-adoption-revocation-candidates', contractVersion: '1.0',
        importId: current.id, candidateProfileSha256: 'a'.repeat(64), adoptions: []
      })),
      revokeCvAdoption: vi.fn(),
      cvProfileSnapshots: vi.fn().mockImplementation((current: CvImportRecord) => of({
        contract: 'cv-profile-snapshot-list', contractVersion: '1.0',
        importId: current.id, candidateProfileSha256: 'a'.repeat(64), snapshots: []
      })),
      restoreCvProfileSnapshot: vi.fn(),
      cvAiStructuringOptions: vi.fn().mockImplementation((current: CvImportRecord) => of(cvAiOptionsFixture(current))),
      cvAiStructuringRuns: vi.fn().mockReturnValue(of([])),
      cvAiStructuringRun: vi.fn(),
      startCvAiStructuring: vi.fn(),
      cancelCvAiStructuring: vi.fn(),
      retryCvAiStructuring: vi.fn(),
      applyCvAiStructuring: vi.fn(),
      deleteCvImport: vi.fn(),
      reviewCvFacts: vi.fn(),
      saveCvTheme: vi.fn(),
      previewCvTheme: vi.fn().mockReturnValue(of({ html: '<!doctype html><html></html>', htmlSha256: 'e'.repeat(64) })),
      atsCheckCv: vi.fn(),
      adoptCvFacts: vi.fn(),
      createCvProposal: vi.fn(),
      cvProposalHtmlUrl: vi.fn().mockImplementation((importId: string, sha256: string) => `/api/cv-imports/${importId}/proposal.html?sha256=${sha256}&download=false`),
      downloadCvProposal: vi.fn(),
      applicationCases: vi.fn().mockReturnValue(of([])),
      applicationArtifacts: vi.fn().mockReturnValue(of([])),
      languageCheck: vi.fn().mockReturnValue(of({ available: true, backend: 'nspell-local', issues: [], disclosure: 'Lokal geprüft.' })),
      finalizeApplicationCase: vi.fn(),
      reviewApplicationArtifact: vi.fn(),
      transitionApplicationCase: vi.fn(),
      exportApplicationArtifact: vi.fn(),
      createApplicationPackage: vi.fn(),
      createSubmissionDryRun: vi.fn(),
      jobDecisions: vi.fn().mockReturnValue(of([])),
      jobInventory: vi.fn().mockReturnValue(of([])),
      setJobInventoryCategory: vi.fn(),
      markJobInventoryApplied: vi.fn(),
      searchRunsSummary: vi.fn().mockReturnValue(of([])),
      dataInventory: vi.fn().mockReturnValue(of({ generatedAt: '2026-01-01T00:00:00Z', stores: [] })),
      schedules: vi.fn().mockReturnValue(of([])),
      saveConfig: vi.fn().mockImplementation((value) => of(structuredClone(value))),
      setMcpPortalAccess: vi.fn().mockImplementation(() => of(structuredClone(config))),
      assistantStatus: vi.fn().mockReturnValue(of({ available: false, note: 'Test' })),
      agentProviders: vi.fn().mockReturnValue(of([{
        id: 'codex', name: 'Codex CLI', available: true, version: '1.0', authStatus: 'authenticated',
        installations: [
          { runtimeTarget: 'windows', version: '1.0', support: 'supported', authStatus: 'authenticated', note: 'Windows-Anmeldung aktiv', executable: 'C:\\tools\\codex.exe' },
          { runtimeTarget: 'wsl', distribution: 'Ubuntu-24.04', version: '1.1', support: 'supported', authStatus: 'authenticated', note: 'WSL-Anmeldung aktiv', executable: '/usr/local/bin/codex' }
        ]
      }])),
      agentConfigProfile: vi.fn().mockReturnValue(of(structuredClone(agentConfigProfileFixture))),
      saveAgentConfigProfile: vi.fn().mockImplementation((_current, profile) => of({
        source: 'primary', profile: { ...structuredClone(profile), schemaVersion: 2, updatedAt: '2026-08-14T08:00:01.000Z' }
      })),
      agentWorkflows: vi.fn().mockReturnValue(of([])),
      agentOrchestrations: vi.fn().mockReturnValue(of({ orchestrations: [] })),
      agentOrchestration: vi.fn(),
      agentOrchestrationResultHtmlUrl: vi.fn().mockImplementation((orchestrationId: string, sha256: string) =>
        `/api/agent-orchestrations/${orchestrationId}/result.html?sha256=${sha256}`),
      createAgentOrchestration: vi.fn(),
      continueAgentOrchestration: vi.fn(),
      cancelAgentOrchestration: vi.fn(),
      resolveAgentOrchestrationConflict: vi.fn(),
      agentQueue: vi.fn().mockReturnValue(of({
        capturedAt: '2026-08-14T08:00:00Z', depth: 0, active: 0,
        limits: { global: 2, perProvider: 1, perWorkspace: 1, perOwner: 1, queuedGlobal: 20, queuedPerWorkspace: 5, queuedPerOwner: 5 },
        activeByProvider: {}, activeByWorkspace: {}, activeByOwner: {}, queue: []
      })),
      agentRecovery: vi.fn().mockReturnValue(of({ runs: [] })),
      agentRuns: vi.fn().mockReturnValue(of([])),
      agentRun: vi.fn().mockReturnValue(of(agentRun)),
      agentRunEvents: vi.fn().mockReturnValue(of({ events: [], nextAfter: 0 })),
      agentArtifacts: vi.fn().mockReturnValue(of({ artifacts: [] })),
      agentArtifactContent: vi.fn(),
      reviewAgentArtifact: vi.fn(),
      adoptAgentArtifact: vi.fn(),
      agentRunEventStream: vi.fn().mockReturnValue(EMPTY),
      agentRunPreflight: vi.fn().mockImplementation((request: AgentRunRequest) => of(preflightFixture(request))),
      createAgentRun: vi.fn().mockReturnValue(of({ ...agentRun, status: 'queued', pendingApprovals: [] })),
      decideAgentApproval: vi.fn().mockReturnValue(of({ ...agentRun, status: 'running', pendingApprovals: [] })),
      cancelAgentRun: vi.fn().mockReturnValue(of({ ...agentRun, status: 'cancelling' })),
      sendAgentInput: vi.fn().mockReturnValue(of({ ...agentRun, status: 'running' })),
      exportAgentRun: vi.fn().mockReturnValue(of({ run: agentRun, redacted: true })),
      acquireAgentRecoveryLease: vi.fn().mockReturnValue(of({
        runId: 'run-orphan', leaseId: '11111111-1111-4111-8111-111111111111', operatorId: 'local-user',
        acquiredAt: '2026-08-14T08:00:00Z', expiresAt: '2099-08-14T08:05:00Z'
      })),
      resolveAgentRecovery: vi.fn().mockReturnValue(of({ resolved: { ...agentRun, id: 'run-orphan', status: 'cancelled', pendingApprovals: [] } }))
    };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: ApiService, useValue: apiMock }]
    }).compileComponents();
  });

  it('creates the workspace and renders the overview', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance).toBeTruthy();
    expect(compiled.querySelector('h1')?.textContent).toContain('Guten Tag');
    expect(compiled.textContent).toContain('Testprofil');
  });

  it('provides a keyboard skip target, live regions and labelled controls in every workspace section', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main-content');
    expect(element.querySelector('main')?.getAttribute('tabindex')).toBe('-1');
    for (const section of ['search', 'identity', 'sources', 'applications', 'agents', 'operations'] as const) {
      fixture.componentInstance.select(section); fixture.detectChanges(); await fixture.whenStable();
      for (const control of element.querySelectorAll('input, select, textarea')) {
        expect(Boolean(control.closest('label') || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')), `${section}: ${control.outerHTML}`).toBe(true);
      }
      for (const button of element.querySelectorAll('button')) {
        expect(Boolean(button.textContent?.trim() || button.getAttribute('aria-label'))).toBe(true);
      }
    }
  });

  it('exposes exactly one current page in the primary navigation', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const currentNavigation = (): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>('nav[aria-label="Hauptnavigation"] button[aria-current="page"]')];
    expect(currentNavigation()).toHaveLength(1);
    expect(currentNavigation()[0]?.textContent).toContain('Übersicht');

    fixture.componentInstance.select('search'); fixture.detectChanges(); await fixture.whenStable();
    expect(currentNavigation()).toHaveLength(1);
    expect(currentNavigation()[0]?.textContent).toContain('Jobsuche');
  });

  it('uses runtime diagnostics instead of mode and exposes no free MCP launch or environment inputs', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('sources'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const panel = element.querySelector('[data-testid="mcp-runtime-panel"]') as HTMLElement;
    expect(panel.textContent).toContain('Startpfad bereit');
    expect(panel.textContent).toContain('Windows');
    expect(panel.textContent).toContain('Startvalidierung');
    expect(panel.textContent).toContain('Nicht verbunden');
    expect(panel.textContent).toContain('ALLOW_EXTERNAL_PORTALS');
    expect(panel.textContent).toContain('JOB_MCP_STATE_DIR');
    expect(panel.querySelectorAll('input, select')).toHaveLength(0);
    expect(element.textContent).toContain('Vertrauenswürdiger Hostprozess');
    fixture.destroy();
  });

  it('saves the closed agent profile and exact hard-cost budget by CAS and requires a second Codex opt-in', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    expect(component.agentConfigProfile?.profile.features.codexAppServerExperimental).toBe(false);
    expect(component.agentConfigProfileDraft?.providers.find((item) => item.provider === 'opencode')?.wslDistribution).toBeUndefined();
    component.setAgentPrompt('Synthetischen Preflight nach Profiländerung neu prüfen');
    component.refreshAgentPreflight();
    const preflightCallsBeforeSave = apiMock['agentRunPreflight'].mock.calls.length;

    component.setAgentConfigCostAmount('7,000001');
    component.setAgentConfigCostCurrency('eur');
    component.setCodexAppServerEnabled(true);
    component.agentConfigProfileConfirmed = true;
    component.saveAgentConfigProfile();
    expect(apiMock['saveAgentConfigProfile']).not.toHaveBeenCalled();
    expect(component.agentConfigProfileError).toContain('zweite ausdrückliche Opt-in-Bestätigung');

    component.agentCodexAppServerOptInConfirmed = true;
    component.saveAgentConfigProfile();
    expect(apiMock['saveAgentConfigProfile']).toHaveBeenCalledTimes(1);
    const [current, submitted] = apiMock['saveAgentConfigProfile'].mock.calls[0] as [AgentConfigProfileView, AgentConfigProfileView['profile']];
    expect(current.profile.updatedAt).toBe('2026-08-14T08:00:00.000Z');
    expect(submitted.features.codexAppServerExperimental).toBe(true);
    expect(submitted.budgets.maxCostMicros).toEqual({ amountMicros: 7_000_001, currency: 'EUR' });
    expect(submitted.providers.find((item) => item.provider === 'opencode')?.wslDistribution).toBeUndefined();
    expect(JSON.stringify(submitted)).not.toMatch(/secret|command|executable|workspaceRoot/i);
    expect(apiMock['agentProviders']).toHaveBeenLastCalledWith(true);
    expect(apiMock['agentRunPreflight'].mock.calls.length).toBeGreaterThan(preflightCallsBeforeSave);
    expect(component.agentConfigProfile?.profile.updatedAt).toBe('2026-08-14T08:00:01.000Z');
    fixture.destroy();
  });

  it('keeps the agent profile draft and never retries a stale CAS save', async () => {
    apiMock['saveAgentConfigProfile'].mockReturnValue(throwError(() => ({ error: { error: 'Das Agentenprofil wurde zwischenzeitlich geändert.' } })));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    component.agentConfigProfileDraft!.features.multiAgentExperimental = false;
    component.agentConfigProfileConfirmed = true;
    component.saveAgentConfigProfile();
    expect(apiMock['saveAgentConfigProfile']).toHaveBeenCalledTimes(1);
    expect(component.agentConfigProfileDraft?.features.multiAgentExperimental).toBe(false);
    expect(component.agentConfigProfile?.profile.features.multiAgentExperimental).toBe(true);
    expect(component.agentConfigProfileError).toContain('zwischenzeitlich geändert');
    expect(component.agentConfigProfileConfirmed).toBe(false);
    expect(apiMock['agentProviders']).not.toHaveBeenCalledWith(true);
    fixture.destroy();
  });

  it('preserves redacted server environment keys on normal config saves', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.config!.mcp.env['ALLOW_EXTERNAL_PORTALS'] = 'synthetic-value-that-must-not-leave-the-ui';
    fixture.componentInstance.saveConfig('Synthetisch gespeichert.');
    expect(apiMock['saveConfig']).toHaveBeenCalledTimes(1);
    const submitted = apiMock['saveConfig'].mock.calls[0][0] as AppConfig;
    expect(submitted.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(submitted.mcp.configuredEnvironmentKeys).toEqual(['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']);
    expect(submitted.mcp.command).toBe('C:\\synthetic\\job-search-mcp.exe');
    expect(fixture.componentInstance.notice).toBe('Synthetisch gespeichert.');
    fixture.destroy();
  });

  it('renders the complete server-owned guided preflight without leaking draft or runtime details', async () => {
    apiMock['agentWorkflows'].mockReturnValue(of([{
      id: 'guided-job-analysis', version: '1.0.0', title: 'Geführte Stellenanalyse',
      description: 'Synthetische Stellenanalyse.', requiredScope: 'search_profile',
      producesSuggestionsOnly: true, prohibitedActions: ['submit_application']
    }]));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.setAgentWorkflow('guided-job-analysis');
    component.setAgentPrompt('Synthetische Stellen serverseitig vorprüfen');
    component.refreshAgentPreflight();
    fixture.detectChanges();
    const preflight = (fixture.nativeElement as HTMLElement).querySelector('.agent-preflight') as HTMLElement;
    expect(preflight.querySelectorAll('[data-preflight-field]')).toHaveLength(9);
    expect(preflight.querySelector('[data-preflight-field="provider"]')?.textContent).toContain('Codex CLI');
    expect(preflight.querySelector('[data-preflight-field="provider"]')?.textContent).toContain('angemeldet');
    expect(preflight.querySelector('[data-preflight-field="runtime"]')?.textContent).toContain('Windows');
    expect(preflight.querySelector('[data-preflight-field="workspace"]')?.textContent).toContain('Serverseitiger Projektbereich');
    expect(preflight.querySelector('[data-preflight-field="workspace"]')?.textContent).toContain('Pfad offengelegt: nein');
    expect(preflight.querySelector('[data-preflight-field="data"]')?.textContent).toContain('Suchprofil');
    expect(preflight.querySelector('[data-preflight-field="data"]')?.textContent).toContain('Stelle · Anzahl erst beim Start · max. 20 · untrusted');
    expect(preflight.querySelector('[data-preflight-field="tools"]')?.textContent).toContain('Keine Root-MCP-Tools freigegeben');
    expect(preflight.querySelector('[data-preflight-field="tools"]')?.textContent).toContain('Allowlist vollständig');
    expect(preflight.querySelector('[data-preflight-field="network"]')?.textContent).toContain('Agent offline');
    expect(preflight.querySelector('[data-preflight-field="limits"]')?.textContent).toContain('30 Min · 10 MiB angefordert');
    expect(preflight.querySelector('[data-preflight-field="limits"]')?.textContent).toContain('Eingabe 256 KiB');
    expect(preflight.querySelector('[data-preflight-field="scheduling"]')?.textContent).toContain('aktiv 0/2');
    expect(preflight.textContent).toContain('Jobsuche läuft im separaten Trusted-Host-MCP');
    expect(preflight.textContent).toContain('Agent bleibt offline/sandboxed');
    expect(preflight.textContent).toContain('Portalzugriff gemäß explizitem Server-Gate');
    expect(preflight.textContent).not.toContain('Synthetische Stellen serverseitig vorprüfen');
    expect(preflight.textContent).not.toContain('C:\\tools\\codex.exe');
    expect(apiMock['agentRunPreflight']).toHaveBeenLastCalledWith({
      providerId: 'codex', prompt: 'Synthetische Stellen serverseitig vorprüfen', runtimeTarget: 'windows',
      workspaceMode: 'read_only', network: false, workflowId: 'guided-job-analysis',
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('changes portal access only through the dedicated confirmed endpoint', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.openPortalPermissionDialog('enable');
    expect(component.portalPermissionIntent).toBe('enable');
    component.confirmPortalPermission();
    expect(apiMock['setMcpPortalAccess']).not.toHaveBeenCalled();
    component.portalPermissionConfirmed = true;
    component.confirmPortalPermission();
    expect(apiMock['setMcpPortalAccess']).toHaveBeenCalledWith(true, 0);
    expect(apiMock['saveConfig']).not.toHaveBeenCalled();
    expect(component.notice).toContain('ALLOW_EXTERNAL_PORTALS=1');
    expect(component.config?.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    fixture.destroy();
  });

  it('blocks portal enable when runtime diagnostics are invalid even if config mode is stdio', async () => {
    apiMock['sourceRuntime'].mockReturnValue(of({
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'invalid',
      launchValidated: false, connected: false, note: 'synthetic_runtime_invalid'
    }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.openPortalPermissionDialog('enable');
    expect(component.portalPermissionIntent).toBeUndefined();
    expect(component.error).toContain('validierten oder verbundenen');
    expect(apiMock['setMcpPortalAccess']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('starts provider-controlled runs with safe defaults and no executable input', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Eine sichere Oberfläche für alle Agenten');
    expect(element.querySelector('[name="executable"], [name="arguments"]')).toBeNull();
    expect(fixture.componentInstance.agentRunForm.workspaceMode).toBe('read_only');
    expect(fixture.componentInstance.agentRunForm.network).toBe(false);
    fixture.componentInstance.setAgentPrompt('Analysiere den lokalen Teststand');
    fixture.componentInstance.refreshAgentPreflight();
    fixture.componentInstance.createAgentRun();
    expect(apiMock['createAgentRun']).toHaveBeenCalledWith({
      providerId: 'codex', prompt: 'Analysiere den lokalen Teststand', runtimeTarget: 'windows', workspaceMode: 'read_only', network: false,
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    fixture.destroy();
  });

  it('selects an explicit WSL installation and summarizes the start configuration', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Installation und Laufzeit');
    expect(element.textContent).toContain('Konfiguration vor dem Start');
    expect(element.textContent).toContain('Windows-Anmeldung aktiv');
    component.selectAgentInstallation('wsl:Ubuntu-24.04');
    component.setAgentPrompt('Analysiere den lokalen Teststand');
    component.refreshAgentPreflight();
    fixture.detectChanges();
    expect(element.querySelector('.agent-preflight')?.textContent).toContain('WSL · Ubuntu-24.04');
    expect(element.querySelector('.agent-preflight')?.textContent).toContain('Serverseitiger Projektbereich · Nur lesen');
    expect(element.querySelector('.agent-preflight')?.textContent).toContain('30 Min · 10 MiB angefordert');
    component.createAgentRun();
    expect(apiMock['createAgentRun']).toHaveBeenLastCalledWith({
      providerId: 'codex', prompt: 'Analysiere den lokalen Teststand', runtimeTarget: 'wsl', wslDistribution: 'Ubuntu-24.04',
      workspaceMode: 'read_only', network: false, budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    fixture.destroy();
  });

  it('blocks start on the current server preflight and invalidates it when the draft changes', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.setAgentPrompt('Prüfung mit bewusstem Serverblocker');
    apiMock['agentRunPreflight'].mockImplementation((request: AgentRunRequest) => of({
      ...preflightFixture(request), ready: false,
      blockers: [{ code: 'emergency_stop', message: 'Der Emergency Stop blockiert neue Agentenläufe.' }]
    }));
    component.refreshAgentPreflight(); fixture.detectChanges();
    const start = (fixture.nativeElement as HTMLElement).querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="Blocker der Startprüfung"]')?.textContent).toContain('Emergency Stop');
    component.createAgentRun();
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    expect(component.error).toContain('Emergency Stop');

    component.setAgentOutputLimit(9);
    fixture.detectChanges();
    expect(component.agentPreflight).toBeUndefined();
    expect(start.disabled).toBe(true);
    fixture.destroy();
  });

  it('renders approvals as explicit approve and deny decisions', async () => {
    apiMock['agentRuns'].mockReturnValue(of([agentRun]));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Offene Entscheidungen aller Runs');
    expect(element.textContent).toContain('Ausdrücklich freigeben');
    expect(element.textContent).toContain('Ablehnen');
    fixture.componentInstance.decideAgentApproval(agentRun.pendingApprovals![0], 'deny');
    expect(apiMock['decideAgentApproval']).toHaveBeenCalledWith('run-1', 'approval-1', 'deny', 3);
    fixture.destroy();
  });

  it('keeps a large canonical timeline while rendering and loading fixed-size windows', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const events = Array.from({ length: 450 }, (_, index) => ({
      sequence: index + 1, type: index % 2 ? 'tool_output' : 'agent_message_completed',
      timestamp: '2026-08-13T18:00:00Z', level: index % 25 === 0 ? 'warning' as const : 'info' as const,
      message: index === 24 ? 'gesuchtes Ereignis' : `Fixture-Ereignis ${index + 1}`
    }));
    component.section = 'agents'; component.selectedAgentRun = { ...agentRun, status: 'running', pendingApprovals: [], lastEventSequence: 450 };
    apiMock['agentRunEvents'].mockReturnValue(of({ events, nextAfter: 450 }));
    component.refreshAgentEvents();
    expect(component.agentEvents).toHaveLength(450);
    expect(component.renderedAgentTimelineEntries()).toHaveLength(100);
    expect(component.hiddenAgentTimelineEntriesCount()).toBe(350);
    component.loadOlderAgentEvents();
    expect(component.renderedAgentTimelineEntries()).toHaveLength(200);
    component.agentEventSearch = 'gesuchtes Ereignis';
    expect(component.renderedAgentTimelineEntries().map((item) => item.sequence)).toEqual([25]);
    component.agentEventSearch = ''; component.agentEventTypeFilter = 'tool_output';
    expect(component.agentTimelineEntries().every((item) => item.type === 'tool_output')).toBe(true);

    component.agentEventTypeFilter = 'all'; component.toggleAgentTimelinePause();
    apiMock['agentRunEvents'].mockReturnValue(of({ events: [{ sequence: 451, type: 'warning', timestamp: '2026-08-13T18:02:00Z', level: 'warning', message: 'Während Pause gepuffert' }], nextAfter: 451 }));
    component.refreshAgentEvents();
    expect(component.agentEvents).toHaveLength(451);
    expect(component.bufferedAgentEventsCount()).toBe(1);
    expect(component.agentTimelineEntries().some((item) => item.sequence === 451)).toBe(false);
    component.toggleAgentTimelinePause();
    expect(component.agentTimelineEntries().some((item) => item.sequence === 451)).toBe(true);
    apiMock['agentRunEvents'].mockReturnValue(of({ events: [
      { sequence: 452, type: 'agent_message_delta', timestamp: '2026-08-13T18:03:00Z', level: 'info', correlationId: 'delta-group', message: 'Teil A' },
      { sequence: 453, type: 'agent_message_delta', timestamp: '2026-08-13T18:03:01Z', level: 'info', correlationId: 'delta-group', message: ' + Teil B' }
    ], nextAfter: 453 }));
    component.refreshAgentEvents();
    expect(component.agentEvents).toHaveLength(453);
    expect(component.agentTimelineEntries().at(-1)).toMatchObject({ sequence: 452, sequenceEnd: 453, groupedCount: 2, text: 'Teil A + Teil B' });
    fixture.destroy();
  });

  it('blocks expired, stale and targetless high-risk approvals across all runs', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const expired: AgentRun = { ...structuredClone(agentRun), id: 'run-expired', lastEventSequence: 3, pendingApprovals: [{ ...agentRun.pendingApprovals![0], id: 'expired', expiresAt: '2000-01-01T00:00:00Z' }] };
    const stale: AgentRun = { ...structuredClone(agentRun), id: 'run-stale', lastEventSequence: 4, pendingApprovals: [{ ...agentRun.pendingApprovals![0], id: 'stale', expectedRevision: 3 }] };
    const targetless: AgentRun = { ...structuredClone(agentRun), id: 'run-targetless', lastEventSequence: 3, pendingApprovals: [{ ...agentRun.pendingApprovals![0], id: 'targetless', risk: 'destructive', expectedRevision: 3 }] };
    component.agentRuns = [expired, stale, targetless];
    expect(component.globalAgentApprovals()).toHaveLength(3);
    expect(component.globalAgentApprovals().every((item) => !item.actionable)).toBe(true);
    component.decideAgentApproval(stale.pendingApprovals![0], 'approve', stale);
    expect(apiMock['decideAgentApproval']).not.toHaveBeenCalled();
    expect(component.error).toContain('fortgeschritten');
    fixture.destroy();
  });

  it('masks sensitive answers and states the plaintext transport boundary', async () => {
    const waitingRun: AgentRun = { ...structuredClone(agentRun), status: 'waiting_for_input', pendingApprovals: [] };
    apiMock['agentRuns'].mockReturnValue(of([waitingRun]));
    apiMock['agentRun'].mockReturnValue(of(waitingRun));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.agentInputSensitive = true; fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector<HTMLInputElement>('#agent-user-input')?.type).toBe('password');
    expect(element.textContent).toContain('Nur die Anzeige ist maskiert');
    expect(element.textContent).toContain('im Klartext an den lokalen Agentenprozess');
    fixture.destroy();
  });

  it('redacts configured identity, paths, email, phone and secrets before copy', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const redacted = fixture.componentInstance.redactAgentText('Alex Beispiel alex@example.invalid C:\\tools\\codex.exe token=very-secret +49 170 1234567');
    expect(redacted).not.toContain('Alex Beispiel');
    expect(redacted).not.toContain('alex@example.invalid');
    expect(redacted).not.toContain('C:\\tools\\codex.exe');
    expect(redacted).not.toContain('very-secret');
    expect(redacted).not.toContain('1234567');
    expect(redacted).toContain('REDIGIERT');
    fixture.destroy();
  });

  it('prepares a lineage-preserving replay and compares version, policy, context, usage and result', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const parent: AgentRun = { ...structuredClone(agentRun), id: 'run-parent', status: 'succeeded', pendingApprovals: [], output: 'Ergebnis A', providerVersion: '1.0', workflowVersion: '1.0', policyVersion: '1.0', contextSummary: { scope: 'case-a', sourceCount: 2, redactedHash: 'abcdef0123456789' } };
    const child: AgentRun = { ...structuredClone(parent), id: 'run-child', parentRunId: parent.id, status: 'failed', output: 'Ergebnis B', request: { ...parent.request, workspaceMode: 'workspace_write' }, usage: { inputTokens: 140, outputTokens: 20, toolCalls: 2, durationMs: 4000 } };
    component.agentRuns = [child, parent]; component.selectedAgentRun = child;
    const sections = component.agentRunComparison(child);
    expect(sections.map((section) => section.id)).toEqual(['lineage', 'versions', 'policy', 'context', 'usage', 'result']);
    expect(sections.find((section) => section.id === 'policy')?.rows.some((row) => row.changed)).toBe(true);
    expect(sections.find((section) => section.id === 'result')?.rows.some((row) => row.changed)).toBe(true);
    component.loadAgentReplayTemplate();
    expect(component.agentRunForm.parentRunId).toBe('run-child');
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('renders queue limits, scoped activity, priority aging and block reasons from the diagnostic endpoint', async () => {
    const orphan: AgentRun = { ...structuredClone(agentRun), id: 'run-orphan', status: 'orphaned', pendingApprovals: [], lastEventSequence: 7 };
    const recovery: AgentRecoveryRun = {
      runId: orphan.id, state: 'orphaned', provider: 'codex', providerSessionPresent: true,
      processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume']
    };
    apiMock['agentRuns'].mockReturnValue(of([orphan]));
    apiMock['agentRun'].mockReturnValue(of(orphan));
    apiMock['agentQueue'].mockReturnValue(of({
      capturedAt: '2026-08-14T08:00:00Z', depth: 1, active: 2,
      limits: { global: 3, perProvider: 1, perWorkspace: 1, perOwner: 2, queuedGlobal: 12, queuedPerWorkspace: 4, queuedPerOwner: 3 },
      activeByProvider: { codex: 1 }, activeByWorkspace: { 'X:\\Synthetic\\Workspace': 1 }, activeByOwner: { 'fixture-owner': 1 },
      queue: [{
        runId: 'queued-fixture', provider: 'codex', workspaceRoot: 'X:\\Synthetic\\Workspace', ownerId: 'fixture-owner',
        position: 1, basePriority: 20, effectivePriority: 35, waitMs: 65_000, blockedBy: ['provider_limit', 'workspace_limit']
      }]
    }));
    apiMock['agentRecovery'].mockReturnValue(of({ runs: [recovery] }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="agent-queue-diagnostics"]')?.textContent).toContain('2/3');
    expect(element.textContent).toContain('X:\\Synthetic\\Workspace');
    expect(element.textContent).toContain('Effektiv');
    expect(element.textContent).toContain('+35');
    expect(element.textContent).toContain('Provider-Limit');
    expect(element.textContent).toContain('Keine Prozess-Adoption');
    expect(element.textContent).toContain('Operator-Lease übernehmen');
    fixture.destroy();
  });

  it('binds recovery decisions to the local lease, explicit dialog confirmation and expected revision', async () => {
    const orphan: AgentRun = { ...structuredClone(agentRun), id: 'run-orphan', status: 'orphaned', pendingApprovals: [], lastEventSequence: 7 };
    const recovery: AgentRecoveryRun = {
      runId: orphan.id, state: 'orphaned', provider: 'codex', providerSessionPresent: false,
      processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume']
    };
    const lease = {
      runId: orphan.id, leaseId: '11111111-1111-4111-8111-111111111111', operatorId: 'local-user',
      acquiredAt: '2026-08-14T08:00:00Z', expiresAt: '2099-08-14T08:05:00Z'
    };
    const recoveryWithLease: AgentRecoveryRun = { ...recovery, lease: {
      runId: orphan.id, operatorId: lease.operatorId, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt
    } };
    apiMock['acquireAgentRecoveryLease'].mockReturnValue(of(lease));
    apiMock['agentRecovery'].mockReturnValue(of({ runs: [recoveryWithLease] }));
    apiMock['agentRuns'].mockReturnValue(of([orphan]));
    apiMock['resolveAgentRecovery'].mockReturnValue(of({ resolved: { ...orphan, status: 'cancelled' } }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.agentRuns = [orphan];
    const foreignRecovery: AgentRecoveryRun = { ...recovery, lease: {
      runId: orphan.id, operatorId: 'other-operator', acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt
    } };
    component.agentRecoveryRuns = [foreignRecovery];
    component.openAgentRecoveryDialog(foreignRecovery, 'cleanup');
    expect(component.agentRecoveryDialog).toBeUndefined();
    expect(component.error).toContain('keine Lease-ID');
    expect(apiMock['resolveAgentRecovery']).not.toHaveBeenCalled();

    component.error = ''; component.agentRecoveryRuns = [recovery];
    component.acquireAgentRecoveryLease(recovery);
    expect(apiMock['acquireAgentRecoveryLease']).toHaveBeenCalledWith('run-orphan', 7);
    expect(component.agentRecoveryLeaseFor('run-orphan')).toEqual(lease);

    component.agentRecoveryRuns = [recoveryWithLease];
    component.openAgentRecoveryDialog(recoveryWithLease, 'cleanup');
    expect(component.agentRecoveryDialog).toMatchObject({ runId: 'run-orphan', decision: 'cleanup', expectedRevision: 7, leaseId: lease.leaseId });
    component.confirmAgentRecovery();
    expect(apiMock['resolveAgentRecovery']).not.toHaveBeenCalled();
    component.agentRecoveryConfirmed = true;
    component.confirmAgentRecovery();
    expect(apiMock['resolveAgentRecovery']).toHaveBeenCalledWith('run-orphan', {
      expectedRevision: 7, leaseId: lease.leaseId, decision: 'cleanup'
    });
    expect(component.notice).toContain('expliziter Operatorentscheidung');
    fixture.destroy();
  });

  it('initializes only empty application profiles after explicit onboarding confirmation', async () => {
    apiMock['applicationPipelineSetup'].mockReturnValue(of({
      contract: 'application-profile-setup', contractVersion: '1.0', candidateProfile: 'missing', styleProfile: 'missing', initialized: false,
      containsCandidateFacts: false, note: 'Profile fehlen.'
    }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('identity'); fixture.detectChanges(); await fixture.whenStable();
    const panel = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="application-profile-setup"]') as HTMLElement;
    expect(panel.textContent).toContain('Nur leere Vorlagen');
    component.initializeApplicationProfiles();
    expect(apiMock['initializeApplicationProfiles']).not.toHaveBeenCalled();
    expect(component.error).toContain('ausdrücklich bestätigt');
    component.profileSetupConfirmed = true;
    component.initializeApplicationProfiles();
    expect(apiMock['initializeApplicationProfiles']).toHaveBeenCalledTimes(1);
    expect(component.notice).toContain('Kandidatenfakten wurden nicht erfunden');
    fixture.destroy();
  });

  it('updates the closed style profile contract only with CAS and explicit confirmation', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('identity'); fixture.detectChanges(); await fixture.whenStable();
    expect(component.applicationStyleProfile?.revision).toBe(3);
    expect(component.styleProfileDraft?.tone).toBe('klar');
    component.styleProfileDraft!.tone = 'präzise und ruhig';
    component.styleVocabularyPreferText = 'umgesetzt\nbelegt';
    component.styleAvoidPatternsText = 'Superlative\nUnbelegte Behauptung';
    component.saveApplicationStyleProfile();
    expect(apiMock['saveApplicationStyleProfile']).not.toHaveBeenCalled();
    component.styleProfileConfirmed = true;
    component.saveApplicationStyleProfile();
    expect(apiMock['saveApplicationStyleProfile']).toHaveBeenCalledTimes(1);
    const [current, profile] = apiMock['saveApplicationStyleProfile'].mock.calls[0];
    expect(current).toMatchObject({ revision: 3, sha256: '8'.repeat(64) });
    expect(profile).toMatchObject({
      tone: 'präzise und ruhig', vocabulary: { prefer: ['umgesetzt', 'belegt'], avoid: ['Guru'] },
      avoidPatterns: ['Superlative', 'Unbelegte Behauptung']
    });
    expect(JSON.stringify(profile)).not.toMatch(/styleProfilePath|languageQuality|local_server|yaml/i);
    expect(component.applicationStyleProfile).toMatchObject({ revision: 4, sha256: '9'.repeat(64) });
    expect(component.styleProfileConfirmed).toBe(false);
    fixture.destroy();
  });

  it('finalizes, reviews, approves and exports only the exact case-bound artifact revision', async () => {
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const approvedRevision: ArtifactRevision = {
      ...structuredClone(artifactRevisionFixture), lifecycle: 'approved',
      review: { decision: 'approved', reviewer: 'local-user', reviewedAt: '2026-08-14T08:03:00Z', expectedSha256: artifactRevisionFixture.sha256, acknowledgedLanguageIssueCount: 1 }
    };
    const approvedCase: ApplicationCase = {
      ...structuredClone(applicationCaseFixture), state: 'approved', revision: 5,
      approvedArtifactRevisionId: approvedRevision.id, approvedArtifactSha256: approvedRevision.sha256, approvedAt: '2026-08-14T08:04:00Z'
    };
    apiMock['applicationCases'].mockReturnValue(of([structuredClone(applicationCaseFixture)]));
    apiMock['applicationArtifacts'].mockReturnValue(of([]));
    apiMock['finalizeApplicationCase'].mockReturnValue(of({
      draft: { jobId: applicationCaseFixture.job.id, identityId: applicationCaseFixture.identityId, documentType: 'cover_letter', content: 'Belegter finaler Inhalt', strongestMatches: [], gaps: [], warnings: [], lifecycle: 'final' },
      revision: structuredClone(artifactRevisionFixture)
    }));
    apiMock['reviewApplicationArtifact'].mockReturnValue(of(approvedRevision));
    apiMock['transitionApplicationCase'].mockReturnValue(of(approvedCase));
    apiMock['exportApplicationArtifact'].mockReturnValue(of({
      fileName: 'bewerbung.pdf', mimeType: 'application/pdf', bytes: 3, base64: 'UERG', revision: 6,
      artifactRevisionId: approvedRevision.id, artifactSha256: approvedRevision.sha256, quality: { valid: true, warnings: [] }
    }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('applications'); component.selectApplicationCase(applicationCaseFixture);
    component.pipelineAnnotatedContent = 'Belegter finaler Inhalt';
    component.pipelineIterationManifest = validIterationManifest;
    component.runLocalLanguageCheck();
    expect(apiMock['languageCheck']).toHaveBeenCalledWith('Belegter finaler Inhalt', 'de-DE');
    component.finalizeSelectedApplicationCase();
    expect(apiMock['finalizeApplicationCase']).toHaveBeenCalledWith(
      applicationCaseFixture.id, 'Belegter finaler Inhalt', validIterationManifest
    );
    component.artifactReviewConfirmed[artifactRevisionFixture.id] = true;
    component.reviewApplicationRevision(applicationCaseFixture, artifactRevisionFixture, 'approved');
    expect(apiMock['reviewApplicationArtifact']).toHaveBeenCalledWith(
      applicationCaseFixture.id, artifactRevisionFixture.id, 'approved', artifactRevisionFixture.sha256, 1
    );
    component.approveApplicationCase(applicationCaseFixture, approvedRevision);
    expect(apiMock['transitionApplicationCase']).toHaveBeenCalledWith(applicationCaseFixture.id, 'approved', {
      revisionId: approvedRevision.id, expectedSha256: approvedRevision.sha256
    });
    component.artifactExportConfirmed[approvedRevision.id] = true;
    component.artifactExportFormat[approvedRevision.id] = 'pdf';
    component.exportApplicationRevision(approvedCase, approvedRevision);
    expect(apiMock['exportApplicationArtifact']).toHaveBeenCalledWith(applicationCaseFixture.id, approvedRevision.id, 'pdf');
    expect(component.applicationExportResult?.artifactSha256).toBe(approvedRevision.sha256);
    downloadClick.mockRestore();
    fixture.destroy();
  });

  it('adopts only an approved real-case pipeline package and reloads the proposed domain revision', async () => {
    const packageArtifact: AgentArtifactRecord = {
      schemaVersion: 1, id: 'agent-artifact-1', kind: 'application-pipeline-package', sha256: '9'.repeat(64), bytes: 321,
      mediaType: 'application/json', createdAt: '2026-08-14T08:00:00Z', updatedAt: '2026-08-14T08:01:00Z', revision: 2, lifecycle: 'approved',
      provenance: {
        runId: 'run-1', provider: 'codex', providerVersion: '1.0', adapterVersion: 'agent-runner-v1', templateId: 'pipeline-package', templateVersion: '1.0',
        workflowId: 'evidence-application-package', workflowVersion: '1.0.0', applicationCaseId: applicationCaseFixture.id,
        applicationCaseRevision: applicationCaseFixture.revision, jobId: applicationCaseFixture.job.id, companyKey: 'beispiel', identityMode: 'real'
      }
    };
    const usedArtifact: AgentArtifactRecord = { ...structuredClone(packageArtifact), lifecycle: 'used', revision: 3, adoption: { sourceReference: 'domain-revision', occurredAt: '2026-08-14T08:02:00Z' } };
    apiMock['adoptAgentArtifact'].mockReturnValue(of({ artifact: usedArtifact, documentRevisionId: artifactRevisionFixture.id }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.applicationCases = [structuredClone(applicationCaseFixture)];
    component.selectedAgentRun = { ...structuredClone(agentRun), request: { ...agentRun.request, applicationCaseId: applicationCaseFixture.id } };
    component.agentArtifacts = [packageArtifact];
    expect(component.agentArtifactAdoptionReason({
      ...packageArtifact, provenance: { ...packageArtifact.provenance, applicationCaseRevision: applicationCaseFixture.revision + 1 }
    })).toContain('Fallrevision');
    expect(component.agentArtifactAdoptionReason({
      ...packageArtifact, provenance: { ...packageArtifact.provenance, identityMode: 'incognito' }
    })).toContain('reale Identität');
    expect(component.agentArtifactAdoptionReason(packageArtifact)).toBe('');
    component.adoptAgentArtifact(packageArtifact);
    expect(apiMock['adoptAgentArtifact']).not.toHaveBeenCalled();
    component.agentArtifactAdoptionConfirmed[packageArtifact.id] = true;
    component.adoptAgentArtifact(packageArtifact);
    expect(apiMock['adoptAgentArtifact']).toHaveBeenCalledWith('run-1', packageArtifact.id, 2);
    expect(apiMock['applicationArtifacts']).toHaveBeenCalledWith(applicationCaseFixture.id);
    expect(component.adoptedDocumentRevisionId).toBe(artifactRevisionFixture.id);
    expect(component.notice).toContain('menschlichen Hash-Prüfung');
    fixture.destroy();
  });

  it('projects typed triage and next-action artifacts with sources, confidence and no automatic action', async () => {
    const artifactBase: AgentArtifactRecord = {
      schemaVersion: 1, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'employer-response-triage-proposal',
      sha256: 'c'.repeat(64), bytes: 240, mediaType: 'application/json', createdAt: '2026-08-14T08:00:00Z',
      updatedAt: '2026-08-14T08:01:00Z', revision: 1, lifecycle: 'proposed',
      provenance: {
        runId: 'run-1', provider: 'codex', providerVersion: '1.0', adapterVersion: 'agent-runner-v1',
        templateId: 'employer-response-triage', templateVersion: '1.0', workflowId: 'employer-response-triage', workflowVersion: '1.0.0',
        applicationCaseId: applicationCaseFixture.id, applicationCaseRevision: applicationCaseFixture.revision,
        jobId: applicationCaseFixture.job.id, companyKey: 'beispiel', mailId: '55555555-5555-4555-8555-555555555555', identityMode: 'real'
      }
    };
    const employerProjection = {
      contract: 'employer-response-triage-proposal', contractVersion: '1.0', sha256: 'd'.repeat(64),
      proposal: {
        schemaVersion: 1, classification: 'request', confidence: 0.91, selectedMailId: artifactBase.provenance.mailId,
        sourceReferences: [`mail:${artifactBase.provenance.mailId}`],
        caseCandidates: [{ caseId: applicationCaseFixture.id, confidence: 0.84, reason: 'Synthetischer Fallbezug.', sourceReferences: [`case:${applicationCaseFixture.id}`] }]
      }
    };
    const nextActionsProvenance = structuredClone(artifactBase.provenance);
    delete nextActionsProvenance.mailId;
    const nextArtifact: AgentArtifactRecord = {
      ...artifactBase, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'application-next-actions-proposal',
      provenance: { ...nextActionsProvenance, workflowId: 'application-next-actions' }
    };
    const nextProjection = {
      contract: 'application-next-actions-proposal', contractVersion: '1.0', sha256: 'e'.repeat(64),
      proposal: {
        schemaVersion: 1, companyKey: 'beispiel', suggestions: [{
          id: 'follow-up-1', applicationCaseId: applicationCaseFixture.id, kind: 'follow_up', title: 'Follow-up prüfen',
          reason: 'Sieben Tage ohne Rückmeldung.', confidence: 0.78, sourceReferences: ['tracking:event-1']
        }], conflicts: [{ id: 'collision-1', kind: 'timeline_overlap', applicationCaseIds: [applicationCaseFixture.id], reason: 'Termine überlappen.', sourceReferences: ['tracking:event-1'] }]
      }
    };
    apiMock['agentArtifactContent']
      .mockReturnValueOnce(of({ id: artifactBase.id, sha256: artifactBase.sha256, mediaType: artifactBase.mediaType, content: JSON.stringify(employerProjection) }))
      .mockReturnValueOnce(of({ id: nextArtifact.id, sha256: nextArtifact.sha256, mediaType: nextArtifact.mediaType, content: JSON.stringify(nextProjection) }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    component.selectedAgentRun = structuredClone(agentRun);
    component.agentArtifacts = [artifactBase, nextArtifact];
    component.viewAgentArtifact(artifactBase); fixture.detectChanges();
    expect(component.employerResponseTriageProposal?.proposal.confidence).toBe(0.91);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('91 %');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(`mail:${artifactBase.provenance.mailId}`);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('führt nichts aus');
    component.viewAgentArtifact(nextArtifact); fixture.detectChanges();
    expect(component.applicationNextActionsProposal?.proposal.suggestions[0].confidence).toBe(0.78);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('78 %');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('tracking:event-1');
    expect(apiMock['reviewAgentArtifact']).not.toHaveBeenCalled();
    expect(apiMock['adoptAgentArtifact']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('opens case-bound mail triage and company-wide next-actions as agent workflow drafts', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.agentRunForm = {
      providerId: 'codex', prompt: 'stale replay', runtimeTarget: 'windows', workspaceMode: 'workspace_write', network: false,
      parentRunId: 'foreign-parent', workflowId: 'guided-job-analysis', budget: { wallTimeMinutes: 99, maxOutputMiB: 99 }
    };
    component.openCaseAgentWorkflow(applicationCaseFixture, 'employer-response-triage');
    expect(component.section).toBe('agents');
    expect(component.agentRunForm).toMatchObject({
      workflowId: 'employer-response-triage', applicationCaseId: applicationCaseFixture.id,
      workspaceMode: 'read_only', network: false, budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    expect(component.agentRunForm.parentRunId).toBeUndefined();
    expect(component.agentRunForm.prompt).toContain('Unternehmensantworten');
    component.openCaseAgentWorkflow(applicationCaseFixture, 'application-next-actions');
    expect(component.agentRunForm).toMatchObject({ workflowId: 'application-next-actions', applicationCaseId: applicationCaseFixture.id });
    expect(component.agentRunForm.prompt).toContain('firmenweit');
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('starts explicit inbox triage with only the selected mail UUID and no echoed mail content', async () => {
    const message: CorrelatedMail = {
      id: '55555555-5555-4555-8555-555555555555', accountId: 'fixture-account',
      from: ['synthetic-employer@example.invalid'], to: ['local@example.invalid'], subject: 'Synthetische Rückfrage',
      sentAt: '2026-08-14T08:00:00Z', text: 'UNTRUSTED_BODY_NICHT_ECHOEN', source: 'eml', responseKind: 'question',
      calendarEvents: [], correlation: { confidence: 0.4, reasons: ['synthetisch'], confirmed: false }
    };
    const workflow = {
      id: 'employer-response-triage' as const, version: '1.0.0', title: 'Arbeitgeberantworten einordnen', description: 'Nur Vorschläge.',
      requiredScope: 'application_case' as const, producesSuggestionsOnly: true as const, prohibitedActions: ['send_message']
    };
    const created = {
      ...orchestrationFixture(), workflowId: workflow.id, status: 'waiting_for_gate' as const,
      scope: { ...orchestrationFixture().scope, mailId: message.id },
      unresolvedGates: [{ nodeId: 'respond', gate: 'user_input' as const }]
    };
    apiMock['agentWorkflows'].mockReturnValue(of([workflow]));
    apiMock['createAgentOrchestration'].mockReturnValue(of(created));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.applicationCases = [structuredClone(applicationCaseFixture)];
    component.mailCorrelationTarget[message.id] = applicationCaseFixture.id;
    component.openInboxMailAgentOrchestration(message);
    expect(component.agentOrchestrationForm.mailId).toBe(message.id);
    expect(component.agentOrchestrationForm.prompt).not.toContain(message.text);
    component.createAgentOrchestration();
    const request = apiMock['createAgentOrchestration'].mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({
      workflowId: 'employer-response-triage', applicationCaseId: applicationCaseFixture.id, mailId: message.id,
      providerId: 'codex', runtimeTarget: 'windows'
    });
    expect(JSON.stringify(request)).not.toContain(message.text);
    expect(JSON.stringify(request)).not.toContain(message.from[0]);
    fixture.destroy();
  });

  it('blocks employer-response triage without an explicitly selected inbox mail ID', async () => {
    const workflow = {
      id: 'employer-response-triage' as const, version: '1.0.0', title: 'Arbeitgeberantworten einordnen', description: 'Nur Vorschläge.',
      requiredScope: 'application_case' as const, producesSuggestionsOnly: true as const, prohibitedActions: ['send_message']
    };
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    component.agentWorkflows = [workflow];
    component.agentOrchestrationForm = {
      workflowId: workflow.id, providerId: 'codex', prompt: 'Antwort als Vorschlag einordnen', runtimeTarget: 'windows',
      applicationCaseId: applicationCaseFixture.id, userInputConfirmed: false
    };
    component.createAgentOrchestration();
    expect(apiMock['createAgentOrchestration']).not.toHaveBeenCalled();
    expect(component.agentOrchestrationError).toContain('explizit gewählte Inbox-Mail');
    fixture.destroy();
  });

  it('keeps pipeline drafts isolated per case and invalidates a stale language result after text changes', async () => {
    const secondCase: ApplicationCase = {
      ...structuredClone(applicationCaseFixture), id: '44444444-4444-4444-8444-444444444444',
      job: { ...structuredClone(applicationCaseFixture.job), id: 'job-second', company: 'Andere AG', title: 'Zweite Stelle' }
    };
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.applicationCases = [structuredClone(applicationCaseFixture), secondCase];
    component.selectApplicationCase(applicationCaseFixture);
    component.setPipelineAnnotatedContent('Fall A'); component.setPipelineIterationManifest('Manifest A');
    component.languageCheckResult = { available: true, backend: 'nspell', issues: [] };
    component.setPipelineAnnotatedContent('Fall A geändert');
    expect(component.languageCheckResult).toBeUndefined();
    component.selectApplicationCase(secondCase);
    expect(component.pipelineAnnotatedContent).toBe('');
    expect(component.pipelineIterationManifest).toBe('');
    component.setPipelineAnnotatedContent('Fall B'); component.setPipelineIterationManifest('Manifest B');
    component.selectApplicationCase(applicationCaseFixture);
    expect(component.pipelineAnnotatedContent).toBe('Fall A geändert');
    expect(component.pipelineIterationManifest).toBe('Manifest A');
    fixture.destroy();
  });

  it('invalidates user-input confirmation when prompt or server revision changes', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.agentOrchestrationForm.userInputConfirmed = true;
    component.setAgentOrchestrationPrompt('Neuer Auftrag');
    expect(component.agentOrchestrationForm.userInputConfirmed).toBe(false);
    component.selectedAgentOrchestration = orchestrationFixture();
    component.agentOrchestrationUserInputConfirmed = true;
    component.agentOrchestrationCancelConfirmed = true;
    apiMock['agentOrchestrations'].mockReturnValue(of({ orchestrations: [{ ...orchestrationFixture(), revision: 2 }] }));
    component.refreshAgentOrchestrations();
    expect(component.agentOrchestrationUserInputConfirmed).toBe(false);
    expect(component.agentOrchestrationCancelConfirmed).toBe(false);
    fixture.destroy();
  });

  it('runs all five application roles and displays the final HTML without a continuation gate', async () => {
    const completed: AgentOrchestrationRecord = { ...orchestrationFixture('succeeded'), finishedAt: '2026-08-14T08:02:00Z' };
    apiMock['agentWorkflows'].mockReturnValue(of([{
      id: 'evidence-application-package', version: '1.1.0', title: 'Evidence-Bewerbungspaket', description: 'Getrennte Rollen.',
      requiredScope: 'application_case', producesSuggestionsOnly: true, prohibitedActions: ['submit_application']
    }]));
    apiMock['applicationCases'].mockReturnValue(of([applicationCaseFixture]));
    apiMock['applicationArtifacts'].mockReturnValue(of([]));
    apiMock['createAgentOrchestration'].mockReturnValue(of(completed));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    component.setAgentOrchestrationWorkflow('evidence-application-package');
    component.setAgentOrchestrationApplicationCase(applicationCaseFixture.id);
    component.agentOrchestrationForm.prompt = 'Getrennte Evidence- und Finalizer-Rollen ausführen';
    component.createAgentOrchestration();
    expect(apiMock['createAgentOrchestration']).toHaveBeenCalledWith({
      workflowId: 'evidence-application-package', providerId: 'codex', prompt: 'Getrennte Evidence- und Finalizer-Rollen ausführen',
      runtimeTarget: 'windows', applicationCaseId: applicationCaseFixture.id
    });
    expect(component.selectedAgentOrchestration?.nodes[0].artifacts[0].lifecycle).toBe('proposed');
    expect(apiMock['continueAgentOrchestration']).not.toHaveBeenCalled();
    expect(component.selectedAgentOrchestration?.status).toBe('succeeded');
    expect(component.selectedAgentOrchestration?.artifactRefs).toContainEqual(expect.objectContaining({ outputRef: 'final_html', lifecycle: 'proposed' }));
    expect(component.notice).toContain('finale HTML-Seite erscheint');
    fixture.detectChanges();
    const htmlResult = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLIFrameElement>('[data-testid="agent-orchestration-html-result"]');
    expect(htmlResult).toBeTruthy();
    expect(htmlResult?.hasAttribute('sandbox')).toBe(true);
    expect(htmlResult?.getAttribute('sandbox')).toBe('');
    expect(htmlResult?.getAttribute('src')).toBe(
      `/api/agent-orchestrations/${completed.id}/result.html?sha256=${'4'.repeat(64)}`,
    );
    fixture.destroy();
  });

  it('resolves an ATS/style fan-in only after an explicit revision- and variants-bound decision', async () => {
    const conflict = orchestrationConflictFixture();
    const waiting: AgentOrchestrationRecord = {
      ...orchestrationFixture('waiting_for_gate'), revision: 7, unresolvedGates: [], conflicts: [conflict]
    };
    const resolved: AgentOrchestrationRecord = {
      ...waiting, revision: 8, status: 'running', conflicts: [{
        ...conflict, status: 'resolved', requiresDomainResolution: false,
        resolution: {
          strategy: 'select_variant', selectedArtifactId: conflict.variants[1].artifactId,
          resolverId: 'local-operator', resolutionReference: 'conflict-resolution-fixture',
          resolvedAt: '2026-08-14T08:04:00Z', resolvedAgainstRevision: 7, variantsSha256: conflict.variantsSha256
        }
      }]
    };
    apiMock['resolveAgentOrchestrationConflict'].mockReturnValue(of(resolved));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'agents';
    component.selectAgentOrchestration(waiting, false); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(conflict.variantsSha256);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(conflict.variants[1].sha256);

    component.setAgentOrchestrationConflictStrategy(conflict, 'select_variant');
    component.setAgentOrchestrationConflictArtifact(conflict, conflict.variants[1].artifactId);
    expect(component.canResolveAgentOrchestrationConflict(conflict)).toBe(false);
    component.setAgentOrchestrationConflictConfirmation(conflict, true);
    component.resolveAgentOrchestrationConflict(conflict);

    expect(apiMock['resolveAgentOrchestrationConflict']).toHaveBeenCalledTimes(1);
    expect(apiMock['resolveAgentOrchestrationConflict']).toHaveBeenCalledWith(
      waiting.id, conflict, 7, 'select_variant', conflict.variants[1].artifactId
    );
    expect(component.selectedAgentOrchestration?.conflicts?.[0]).toMatchObject({
      status: 'resolved', resolution: { strategy: 'select_variant', resolvedAgainstRevision: 7 }
    });
    expect(component.notice).toContain('bleibt ein Vorschlag');
    fixture.destroy();
  });

  it('does not retry a stale conflict resolution and invalidates only its confirmation', async () => {
    const conflict = orchestrationConflictFixture();
    const waiting: AgentOrchestrationRecord = {
      ...orchestrationFixture('waiting_for_gate'), revision: 7, unresolvedGates: [], conflicts: [conflict]
    };
    apiMock['resolveAgentOrchestrationConflict'].mockReturnValue(throwError(() => ({
      status: 409, error: { error: 'Die Konfliktentscheidung ist stale.', category: 'policy' }
    })));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.selectAgentOrchestration(waiting, false);
    component.setAgentOrchestrationConflictStrategy(conflict, 'accept_complementary');
    component.setAgentOrchestrationConflictConfirmation(conflict, true);
    component.resolveAgentOrchestrationConflict(conflict);

    expect(apiMock['resolveAgentOrchestrationConflict']).toHaveBeenCalledTimes(1);
    expect(component.agentOrchestrationConflictStrategy(conflict)).toBe('accept_complementary');
    expect(component.agentOrchestrationConflictConfirmed[component.agentOrchestrationConflictKey(conflict)]).not.toBe(true);
    expect(component.agentOrchestrationError).toContain('stale');
    expect(component.selectedAgentOrchestration?.revision).toBe(7);
    fixture.destroy();
  });

  it('cancels only the explicitly confirmed current orchestration revision', async () => {
    const running = { ...orchestrationFixture('running'), unresolvedGates: [] };
    const cancelled: AgentOrchestrationRecord = { ...running, revision: 2, status: 'cancelled', finishedAt: '2026-08-14T08:03:00Z' };
    apiMock['cancelAgentOrchestration'].mockReturnValue(of(cancelled));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.selectedAgentOrchestration = running;
    component.cancelAgentOrchestration();
    expect(apiMock['cancelAgentOrchestration']).not.toHaveBeenCalled();
    component.agentOrchestrationCancelConfirmed = true;
    component.cancelAgentOrchestration();
    expect(apiMock['cancelAgentOrchestration']).toHaveBeenCalledWith(running.id, 1);
    expect(component.selectedAgentOrchestration?.status).toBe('cancelled');
    fixture.destroy();
  });

  it('imports only an allowlisted CV format and opens the six-step fact review', async () => {
    apiMock['importCv'].mockReturnValue(of(cvImportFixture()));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('cv'); fixture.detectChanges(); await fixture.whenStable();
    expect(apiMock['cvImports']).toHaveBeenCalledWith(20);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('nav[aria-label="Lebenslauf-Schritte"] ol > li')).toHaveLength(6);
    expect(element.querySelector('nav[aria-label="Lebenslauf-Schritte"] [aria-current="step"]')?.textContent).toContain('Import');
    const input = element.querySelector<HTMLInputElement>('[data-testid="cv-file-input"]')!;
    const file = new File(['<main>Rein synthetischer Lebenslauf</main>'], 'synthetischer-lebenslauf.html', { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(apiMock['importCv']).toHaveBeenCalledTimes(1));
    expect(apiMock['importCv']).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'synthetischer-lebenslauf.html', mimeType: 'text/html'
    }));
    expect((apiMock['importCv'].mock.calls[0]?.[0] as { base64: string }).base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    fixture.detectChanges();
    expect(component.cvStep).toBe(2);
    expect(element.querySelector('nav[aria-label="Lebenslauf-Schritte"] [aria-current="step"]')?.textContent).toContain('Fakten');
    expect(element.querySelector('[data-testid="cv-facts-step"]')?.textContent).toContain('Ungeprüft');
    expect(component.cvImport?.source.retention).toBe('upload_deleted_after_local_extraction');
    fixture.destroy();
  });

  it('renders and downloads an incognito result without ever making it a revision', async () => {
    const preview = {
      contract: 'cv-incognito-preview', contractVersion: '1.0',
      importId: '66666666-6666-4666-8666-666666666666',
      artifactId: '33333333-3333-4333-8333-333333333333',
      artifactLifecycle: 'proposed', html: '<html><body><div role="note">INKOGNITO-VORSCHAU</div></body></html>',
      htmlSha256: 'c'.repeat(64), usableAsDocumentRevision: false
    };
    apiMock['renderIncognitoCvPreview'] = vi.fn().mockReturnValue(of(preview));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 5; component.cvImport = cvImportFixture();
    component.selectedAgentRun = { id: 'run-1' } as never;
    component.cvSelectedApplicationCaseId = '55555555-5555-4555-8555-555555555555';
    component.applicationCases = [{
      id: '55555555-5555-4555-8555-555555555555', documentType: 'cv', identityMode: 'incognito', state: 'selected'
    }] as never;
    component.agentArtifacts = [
      { id: '33333333-3333-4333-8333-333333333333', lifecycle: 'proposed', kind: 'annotated_draft' },
      { id: '44444444-4444-4444-8444-444444444444', lifecycle: 'used', kind: 'other' }
    ] as never;
    // Only renderable states are offered; a used artifact is not a preview source.
    expect(component.selectedAgentRunArtifacts().map((item) => item.id))
      .toEqual(['33333333-3333-4333-8333-333333333333']);

    const anchors: Array<{ download?: string; click: () => void }> = [];
    const createElement = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'a') return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
      const anchor = { href: '', download: '', click: vi.fn() };
      anchors.push(anchor as never);
      return anchor as unknown as HTMLElement;
    }) as never);
    try {
      component.renderIncognitoCvPreview(component.agentArtifacts[0]!);
      await vi.waitFor(() => expect(component.cvIncognitoPreview).toBeDefined());
      component.downloadIncognitoCvPreview();
    } finally {
      createElement.mockRestore();
    }

    expect(component.cvIncognitoPreview?.usableAsDocumentRevision).toBe(false);
    // The unconfirmed state is carried in the file name, not just on screen.
    expect(anchors[0]?.download).toBe(`lebenslauf-inkognito-proposed-${'c'.repeat(12)}.html`);
    // Nothing here turns the import into a proposal-bearing record.
    expect(component.cvImport?.proposal).toBeUndefined();
    fixture.destroy();
  });

  it('explains an unreadable style profile instead of hiding the editor', async () => {
    // A rejected style profile used to leave the identity section blank: the
    // editor is gated on the loaded profile and there was no else branch.
    apiMock['applicationStyleProfile'].mockReturnValue(throwError(() => ({
      error: { error: 'style_profile_linkedin_technical_density_invalid', category: 'policy' }
    })));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('identity');
    await vi.waitFor(() => expect(component.styleProfileError).toContain('technical_density'));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="style-profile-editor"]')).toBeNull();
    const panel = element.querySelector('[data-testid="style-profile-unavailable"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-testid="style-profile-unavailable-reason"]')?.textContent)
      .toContain('style_profile_linkedin_technical_density_invalid');
    // The four document types and the offending field are named, so the fix is findable.
    expect(panel.textContent).toContain('technical_density');
    expect(panel.textContent).toContain('linkedin');
    fixture.destroy();
  });

  it('blocks the CV template step and says why when the style profile is unreadable', async () => {
    apiMock['applicationStyleProfile'].mockReturnValue(throwError(() => ({
      error: { error: 'style_profile_linkedin_technical_density_invalid', category: 'policy' }
    })));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('cv');
    await vi.waitFor(() => expect(component.styleProfileError).toBeTruthy());
    component.cvImport = cvImportFixture(); component.cvStep = 3;
    component.loadApplicationStyleProfile();
    await vi.waitFor(() => expect(component.styleProfileBusy).toBe(false));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const notice = element.querySelector('[data-testid="cv-style-profile-unavailable"]');
    expect(notice?.textContent).toContain('style_profile_linkedin_technical_density_invalid');
    const buttons = [...element.querySelectorAll('[data-testid="cv-writing-style-step"] .cv-step-actions button')];
    expect(buttons.map((button) => button.textContent?.trim())).toContain('Stilprofil im Profil reparieren');
    expect(buttons.find((button) => button.textContent?.includes('Formatvorlage'))?.hasAttribute('disabled')).toBe(true);
    fixture.destroy();
  });

  it('offers claim management only when the profile still holds a revocable adoption', async () => {
    const current = cvImportFixture();
    const confirmed = { ...current, facts: current.facts.map((fact) => ({ ...fact, decision: 'confirmed' as const })) };
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = confirmed;
    component.loadCvClaimManagement();
    await vi.waitFor(() => expect(component.cvClaimManagementBusy).toBe(false));
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="cv-claim-management"]')).toBeNull();

    apiMock['revocableCvAdoptions'].mockReturnValue(of({
      contract: 'cv-adoption-revocation-candidates', contractVersion: '1.0',
      importId: confirmed.id, candidateProfileSha256: 'a'.repeat(64),
      adoptions: [{
        transactionId: 'c'.repeat(32), occurredAt: '2026-08-15T10:28:58.136Z',
        sourceSha256: confirmed.source.sha256, claimCount: 213, presentClaimCount: 213
      }]
    }));
    component.loadCvClaimManagement();
    await vi.waitFor(() => expect(component.cvRevocableAdoptions).toHaveLength(1));
    fixture.detectChanges();
    const panel = element.querySelector('[data-testid="cv-claim-management"]')!;
    expect(panel.textContent).toContain('213');
    // Without a pre-adoption snapshot the scalar limit must be stated, not hidden.
    expect(panel.textContent).toContain('Überschriebene Profilfelder');
    fixture.destroy();
  });

  it('requires explicit confirmation before discarding an adoption and then re-adopts in one flow', async () => {
    const current = cvImportFixture();
    const confirmed = { ...current, facts: current.facts.map((fact) => ({ ...fact, decision: 'confirmed' as const })) };
    const revoked = { ...confirmed, revision: confirmed.revision + 1, sha256: 'b'.repeat(64) };
    const readopted = {
      ...revoked, revision: revoked.revision + 1, status: 'adopted' as const,
      adoption: {
        adoptedAt: '2026-08-16T10:00:00.000Z', adoptedClaimIds: ['claim-one', 'claim-two'],
        adoptedRecordIds: [], candidateProfileSha256: 'c'.repeat(64),
        candidateProfileRevision: `sha256:${'c'.repeat(64)}`
      }
    };
    apiMock['revokeCvAdoption'].mockReturnValue(of(revoked));
    apiMock['adoptCvFacts'].mockReturnValue(of(readopted));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = confirmed;
    component.cvRevocableAdoptions = [{
      transactionId: 'c'.repeat(32), occurredAt: '2026-08-15T10:28:58.136Z',
      sourceSha256: confirmed.source.sha256, claimCount: 213, presentClaimCount: 213
    }];

    component.revokeAndReadoptCvAdoption();
    expect(apiMock['revokeCvAdoption']).not.toHaveBeenCalled();

    component.cvRevokeConfirmed = true;
    component.revokeAndReadoptCvAdoption();
    await vi.waitFor(() => expect(apiMock['adoptCvFacts']).toHaveBeenCalled());
    expect(apiMock['revokeCvAdoption']).toHaveBeenCalledWith(confirmed, 'c'.repeat(32));
    expect(apiMock['adoptCvFacts']).toHaveBeenCalledWith(revoked);
    expect(component.cvImport?.status).toBe('adopted');
    expect(component.cvRevokeConfirmed).toBe(false);
    expect(component.cvClaimManagementNotice).toContain('verworfen');
    fixture.destroy();
  });

  it('explains a partial overlap instead of booking it as already adopted', async () => {
    const current = cvImportFixture();
    const confirmed = { ...current, facts: current.facts.map((fact) => ({ ...fact, decision: 'confirmed' as const })) };
    apiMock['adoptCvFacts'].mockReturnValue(throwError(() => ({ status: 409 })));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = confirmed;

    component.markCvAlreadyAdopted();
    await vi.waitFor(() => expect(component.cvClaimManagementError).toContain('Nur ein Teil'));
    expect(component.cvImport?.adoption).toBeUndefined();
    fixture.destroy();
  });

  it('rolls the candidate profile back to a chosen snapshot only after explicit confirmation', async () => {
    const current = cvImportFixture();
    const rolledBack = { ...current, revision: current.revision + 1, sha256: 'b'.repeat(64) };
    apiMock['restoreCvProfileSnapshot'].mockReturnValue(of(rolledBack));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    apiMock['cvProfileSnapshots'].mockReturnValue(of({
      contract: 'cv-profile-snapshot-list', contractVersion: '1.0',
      importId: current.id, candidateProfileSha256: 'e'.repeat(64),
      snapshots: [
        {
          id: 'profile-snapshot-' + 'a'.repeat(16), createdAt: '2026-08-15T10:00:00.000Z',
          candidateProfileSha256: 'd'.repeat(64), byteSize: 2_048, reason: 'pre_adoption',
          claimCount: 4, current: false
        },
        {
          id: 'profile-snapshot-' + 'b'.repeat(16), createdAt: '2026-08-15T10:28:58.136Z',
          candidateProfileSha256: 'e'.repeat(64), byteSize: 4_096, reason: 'pre_revoke',
          claimCount: 213, current: true
        }
      ]
    }));
    component.loadCvClaimManagement();
    await vi.waitFor(() => expect(component.cvProfileSnapshots).toHaveLength(2));
    fixture.detectChanges();
    // The load preselects the newest restorable state, never the live one.
    expect(component.cvSelectedSnapshotId).toBe('profile-snapshot-' + 'a'.repeat(16));
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="cv-profile-snapshots"] li')).toHaveLength(2);

    component.restoreCvProfileSnapshot();
    expect(apiMock['restoreCvProfileSnapshot']).not.toHaveBeenCalled();

    component.cvSnapshotConfirmed = true;
    component.restoreCvProfileSnapshot();
    await vi.waitFor(() => expect(apiMock['restoreCvProfileSnapshot']).toHaveBeenCalled());
    expect(apiMock['restoreCvProfileSnapshot']).toHaveBeenCalledWith(current, 'profile-snapshot-' + 'a'.repeat(16));
    expect(component.cvSnapshotConfirmed).toBe(false);
    expect(component.cvClaimManagementNotice).toContain('zurückgerollt');

    // The live state must never be selectable as a rollback target.
    component.cvSelectedSnapshotId = 'profile-snapshot-' + 'b'.repeat(16);
    component.cvSnapshotConfirmed = true;
    apiMock['restoreCvProfileSnapshot'].mockClear();
    component.restoreCvProfileSnapshot();
    expect(apiMock['restoreCvProfileSnapshot']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('starts optional AI structuring only after the combined explicit disclosure and leaves current facts unchanged', async () => {
    const current = cvImportFixture();
    const queued = cvAiRunFixture(current, 'queued');
    apiMock['startCvAiStructuring'].mockReturnValue(of(queued));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    component.cvAiOptions = cvAiOptionsFixture(current);
    const installation = component.cvAiInstallations()[0]!;
    component.cvAiInstallationKey = component.cvAiInstallationKeyFor(installation.providerId, installation.installation);
    component.startCvAiStructuring();
    expect(apiMock['startCvAiStructuring']).not.toHaveBeenCalled();
    expect(component.cvAiError).toContain('Weitergabe');
    component.cvAiDisclosureConfirmed = true;
    component.startCvAiStructuring();
    expect(apiMock['startCvAiStructuring']).toHaveBeenCalledWith(current, {
      providerId: 'codex', runtimeTarget: 'windows', expectedVersion: '1.0'
    });
    expect(component.cvImport?.facts).toEqual(current.facts);
    expect(component.cvAiRun?.status).toBe('queued');
    expect(component.cvAiDisclosureConfirmed).toBe(false);
    fixture.detectChanges();
    const content = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="cv-ai-assist"]')?.textContent ?? '';
    expect(content).toContain('Einfach prüfbar, nicht automatisch freigegeben');
    expect(content).toContain('keine Root-MCP-Werkzeuge');
    fixture.destroy();
  });

  it('keeps replacement suggestions ready for recovery polling but leaves legacy suggestions in review state', async () => {
    const current = cvImportFixture();
    const replacement = cvAiRunFixture(current, 'suggestions_ready');
    const legacy: CvAiStructuringPublicRun = {
      ...replacement, id: '77777777-7777-4777-8777-777777777777', mode: 'review_suggestions'
    };
    apiMock['cvAiStructuringRuns'].mockReturnValue(of([replacement]));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvImport = current;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    try {
      component.loadCvAiStructuringState();
      expect(component.cvAiRunActive(replacement)).toBe(true);
      expect(component.cvAiStartUnavailableReason()).toContain('aktuellen AI-Lauf');
      const cvPollingCalls = () => intervalSpy.mock.calls.filter((call) => call[1] === 1_500);
      expect(cvPollingCalls()).toHaveLength(1);

      apiMock['cvAiStructuringRun'].mockReturnValueOnce(of(replacement)).mockReturnValueOnce(of(legacy));
      const poll = cvPollingCalls()[0]?.[0];
      expect(typeof poll).toBe('function');
      if (typeof poll === 'function') poll();
      expect(apiMock['cvAiStructuringRun']).toHaveBeenNthCalledWith(1, current.id, replacement.id);
      expect(cvPollingCalls()).toHaveLength(1);

      component.selectCvAiRun(legacy.id);
      expect(apiMock['cvAiStructuringRun']).toHaveBeenNthCalledWith(2, current.id, legacy.id);
      expect(component.cvAiRunActive(legacy)).toBe(false);
      expect(component.cvAiRun?.proposal).toEqual(legacy.proposal);
      expect(clearIntervalSpy).toHaveBeenCalled();
      component.cvAiDisclosureConfirmed = true;
      expect(component.cvAiStartUnavailableReason()).toBe('');
    } finally {
      fixture.destroy(); intervalSpy.mockRestore(); clearIntervalSpy.mockRestore();
    }
  });

  it('reconciles an applied runs-list result before stale options can fail on the mutated import CAS', async () => {
    const current = cvImportFixture();
    const applied = cvAiRunFixture(current, 'applied');
    const recognized: CvImportRecord = {
      ...current,
      revision: applied.result!.cvImportRevision,
      sha256: applied.result!.cvImportSha256,
      updatedAt: '2026-08-14T08:04:00Z',
      activeRecognitionVersionId: CV_AI_RECOGNITION_ID,
      facts: [{
        id: 'fact-ai-role', category: 'employment', recordId: 'employment-1', field: 'role', value: 'Senior Entwickler',
        decision: 'pending', provenance: {
          sourceSha256: current.source.sha256, anchor: 'Zeile 5', origin: 'imported',
          recognition: {
            method: 'ai_assisted', runId: applied.id, proposalSha256: applied.proposal!.sha256,
            suggestionId: 'suggestion-2222222222222222', confidence: .62,
            questions: ['Welche Rollenbezeichnung ist belegt?'],
            sourceSpan: { lineStart: 5, lineEnd: 5, charStart: 0, charEnd: 10 }
          }
        }
      }]
    };
    apiMock['cvAiStructuringOptions'].mockImplementation((record: CvImportRecord) => record.revision === current.revision
      ? throwError(() => ({ status: 409, error: { error: 'Die Runs-Liste hat den Import bereits mutiert.' } }))
      : of(cvAiOptionsFixture(record)));
    apiMock['cvAiStructuringRuns'].mockReturnValue(of([applied]));
    apiMock['cvImport'].mockReturnValue(of(recognized));
    apiMock['cvRecognitionVersions'].mockImplementation((record: CvImportRecord) => of(cvRecognitionVersionsFixture(record, 'ai')));

    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    component.cvRecognitionVersions = cvRecognitionVersionsFixture(current);
    component.loadCvAiStructuringState();

    await vi.waitFor(() => expect(component.cvRecognitionVersions?.activeVersionId).toBe(CV_AI_RECOGNITION_ID));
    expect(apiMock['cvImport']).toHaveBeenCalledTimes(1);
    expect(apiMock['cvImport']).toHaveBeenCalledWith(current.id);
    expect(apiMock['cvRecognitionVersions']).toHaveBeenCalledWith(recognized);
    expect(apiMock['cvAiStructuringOptions']).not.toHaveBeenCalledWith(current);
    expect(apiMock['cvAiStructuringOptions']).toHaveBeenCalledWith(recognized);
    expect(apiMock['cvAiStructuringRun']).not.toHaveBeenCalled();
    expect(component.cvImport).toBe(recognized);
    expect(component.cvImport?.facts).toEqual([expect.objectContaining({ decision: 'pending' })]);
    expect(component.cvImport?.adoption).toBeUndefined();
    expect(component.cvAiRun?.status).toBe('applied');
    fixture.destroy();
  });

  it('reconciles an applied replacement returned while selecting a saved run', async () => {
    const current = cvImportFixture();
    const applied = cvAiRunFixture(current, 'applied');
    const recognized: CvImportRecord = {
      ...current, revision: applied.result!.cvImportRevision, sha256: applied.result!.cvImportSha256,
      updatedAt: '2026-08-14T08:04:00Z', activeRecognitionVersionId: CV_AI_RECOGNITION_ID,
      facts: [{
        ...current.facts[0]!, id: 'fact-ai-role', field: 'role', value: 'Senior Entwickler', decision: 'pending',
        provenance: {
          ...current.facts[0]!.provenance,
          recognition: {
            method: 'ai_assisted', runId: applied.id, proposalSha256: applied.proposal!.sha256,
            suggestionId: 'suggestion-2222222222222222', confidence: .62,
            sourceSpan: { lineStart: 5, lineEnd: 5, charStart: 0, charEnd: 10 }
          }
        }
      }]
    };
    apiMock['cvAiStructuringRun'].mockReturnValue(of(applied));
    apiMock['cvAiStructuringRuns'].mockReturnValue(of([applied]));
    apiMock['cvImport'].mockReturnValue(of(recognized));
    apiMock['cvRecognitionVersions'].mockImplementation((record: CvImportRecord) => of(cvRecognitionVersionsFixture(record, 'ai')));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    component.cvRecognitionVersions = cvRecognitionVersionsFixture(current);

    component.selectCvAiRun(applied.id);

    await vi.waitFor(() => expect(component.cvRecognitionVersions?.activeVersionId).toBe(CV_AI_RECOGNITION_ID));
    expect(apiMock['cvAiStructuringRun']).toHaveBeenCalledWith(current.id, applied.id);
    expect(apiMock['cvImport']).toHaveBeenCalledTimes(1);
    expect(component.cvImport).toBe(recognized);
    expect(component.cvImport?.facts).toEqual([expect.objectContaining({ decision: 'pending' })]);
    expect(component.cvImport?.adoption).toBeUndefined();
    expect(component.cvAiRun?.status).toBe('applied');
    fixture.destroy();
  });

  it('describes an applied run as active only while its recognition version is selected', async () => {
    const base = cvImportFixture();
    const applied = cvAiRunFixture(base, 'applied');
    const current: CvImportRecord = {
      ...base, revision: 3, sha256: '8'.repeat(64), activeRecognitionVersionId: CV_DETERMINISTIC_RECOGNITION_ID
    };
    apiMock['cvAiStructuringRuns'].mockReturnValue(of([applied]));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    const aiActive = cvRecognitionVersionsFixture(current, 'ai');
    component.cvRecognitionVersions = {
      ...aiActive, activeVersionId: CV_DETERMINISTIC_RECOGNITION_ID,
      versions: aiActive.versions.map((version) => ({ ...version, active: version.id === CV_DETERMINISTIC_RECOGNITION_ID }))
    };
    component.loadCvAiStructuringState();
    expect(apiMock['cvImport']).not.toHaveBeenCalled();
    expect(component.cvAiRecognitionVersionActive(applied)).toBe(false);
    expect(component.cvAiRunStatusLabel('applied', applied)).toBe('KI-Erkennungsstand angelegt');

    component.cvRecognitionVersions = aiActive;
    expect(component.cvAiRecognitionVersionActive(applied)).toBe(true);
    expect(component.cvAiRunStatusLabel('applied', applied)).toBe('KI-Erkennungsstand aktiv');
    fixture.destroy();
  });

  it('activates a recognition version with import CAS and keeps its facts unverified', async () => {
    const current = cvImportFixture();
    const switched: CvImportRecord = {
      ...current, revision: 2, sha256: '9'.repeat(64), updatedAt: '2026-08-14T08:04:00Z',
      activeRecognitionVersionId: CV_AI_RECOGNITION_ID,
      facts: [...current.facts, {
        id: 'fact-ai-role', category: 'employment', recordId: 'employment-1', field: 'role', value: 'Senior Entwickler',
        decision: 'pending', provenance: {
          sourceSha256: current.source.sha256, anchor: 'Zeile 5', origin: 'imported',
          recognition: {
            method: 'ai_assisted', runId: '88888888-8888-4888-8888-888888888888', proposalSha256: 'b'.repeat(64),
            suggestionId: 'suggestion-2222222222222222',
            confidence: .54, questions: ['Welche Rollenbezeichnung ist belegt?'],
            sourceSpan: { lineStart: 5, lineEnd: 5, charStart: 0, charEnd: 17 }
          }
        }
      }]
    };
    const versions = cvRecognitionVersionsFixture(switched, 'ai');
    versions.activeVersionId = versions.versions[0]!.id;
    versions.versions[0]!.active = true; versions.versions[1]!.active = false;
    apiMock['activateCvRecognitionVersion'].mockReturnValue(of(switched));
    apiMock['cvRecognitionVersions'].mockReturnValue(of(cvRecognitionVersionsFixture(switched, 'ai')));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    component.cvRecognitionVersions = versions;
    component.activateCvRecognitionVersion(versions.versions[1]!.id);
    expect(apiMock['activateCvRecognitionVersion']).toHaveBeenCalledWith(current, versions.versions[1]!.id);
    expect(component.cvImport?.facts.at(-1)).toMatchObject({
      value: 'Senior Entwickler', decision: 'pending',
      provenance: { recognition: { method: 'ai_assisted', suggestionId: 'suggestion-2222222222222222' } }
    });
    expect(component.cvImport?.adoption).toBeUndefined();
    expect(component.cvRecognitionVersionNotice).toContain('ungeprüft');
    fixture.destroy();
  });

  it('confirms all pending facts of the active recognition version while preserving rejected facts', async () => {
    const current = cvImportFixture(['pending', 'rejected']);
    const confirmed: CvImportRecord = {
      ...current, revision: 2, sha256: '8'.repeat(64), status: 'facts_reviewed',
      facts: current.facts.map((fact) => fact.decision === 'pending' ? { ...fact, decision: 'confirmed' as const } : fact)
    };
    apiMock['confirmCvRecognitionVersion'].mockReturnValue(of(confirmed));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.section = 'cv'; component.cvStep = 2; component.cvImport = current;
    component.cvRecognitionVersions = cvRecognitionVersionsFixture(current);
    component.confirmCvRecognitionVersion();
    expect(apiMock['confirmCvRecognitionVersion']).not.toHaveBeenCalled();
    component.cvRecognitionVersionConfirmed = true;
    component.confirmCvRecognitionVersion();
    expect(apiMock['confirmCvRecognitionVersion']).toHaveBeenCalledWith(current, CV_DETERMINISTIC_RECOGNITION_ID);
    expect(component.cvImport?.facts.map((fact) => fact.decision)).toEqual(['confirmed', 'rejected']);
    expect(component.cvRecognitionVersionConfirmed).toBe(false);
    expect(component.cvRecognitionVersionNotice).toContain('Verworfene Fakten bleiben ausgeschlossen');
    fixture.destroy();
  });

  it('adds one user-supplied fact with the exact CAS operation and keeps adoption separate', async () => {
    const initial = cvImportFixture();
    const added: CvImportRecord = {
      ...initial, revision: 2, sha256: '8'.repeat(64), updatedAt: '2026-08-14T08:01:00Z',
      facts: [...initial.facts, {
        id: 'fact-user-synthetic', category: 'additional', recordId: 'record-user-synthetic', field: 'detail',
        value: 'Synthetischer Zusatzfakt', decision: 'confirmed',
        provenance: { sourceSha256: initial.source.sha256, anchor: 'user:2026-08-14T08:01:00Z', origin: 'user_supplied' }
      }]
    };
    apiMock['reviewCvFacts'].mockReturnValue(of(added));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(initial);
    component.cvNewFactDraft.value = 'Synthetischer Zusatzfakt';
    component.cvNewFactDraft.explicitlyConfirmed = true;
    component.addCvFact();
    expect(apiMock['reviewCvFacts']).toHaveBeenCalledWith(initial, [{
      action: 'add', category: 'additional', newRecordKey: 'additional-fact', field: 'detail',
      value: 'Synthetischer Zusatzfakt', explicitlyConfirmed: true
    }]);
    expect(component.cvImport?.facts.at(-1)).toMatchObject({ decision: 'confirmed', provenance: { origin: 'user_supplied' } });
    expect(component.cvImport?.adoption).toBeUndefined();
    expect(component.cvNewFactDraft.value).toBe('');
    fixture.destroy();
  });

  it('sorts current employment first and summarizes role, company and period without using rejected values', async () => {
    const current = cvImportFixture();
    const provenance = { sourceSha256: current.source.sha256, anchor: 'fixture', origin: 'imported' as const };
    current.facts = [
      { id: 'fact-skill', category: 'skill', recordId: 'skill-1', field: 'name', value: 'Angular', decision: 'confirmed', provenance },
      { id: 'fact-old-role', category: 'employment', recordId: 'employment-old', field: 'role', value: 'Entwickler', decision: 'confirmed', provenance },
      { id: 'fact-old-company', category: 'employment', recordId: 'employment-old', field: 'company', value: 'Alt GmbH', decision: 'confirmed', provenance },
      { id: 'fact-old-period', category: 'employment', recordId: 'employment-old', field: 'period', value: '2019–2021', decision: 'confirmed', provenance },
      { id: 'fact-current-role-rejected', category: 'employment', recordId: 'employment-current', field: 'role', value: 'Falsche Rolle', decision: 'rejected', provenance },
      { id: 'fact-current-role', category: 'employment', recordId: 'employment-current', field: 'role', value: 'Senior Engineer', decision: 'pending', provenance },
      { id: 'fact-current-company', category: 'employment', recordId: 'employment-current', field: 'company', value: 'Heute AG', decision: 'confirmed', provenance },
      { id: 'fact-current-period', category: 'employment', recordId: 'employment-current', field: 'period', value: '2022–heute', decision: 'pending', provenance }
    ];
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(current);
    expect(component.cvFactGroups().map((group) => group.recordId)).toEqual(['employment-current', 'employment-old', 'skill-1']);
    expect(component.cvFactGroups()[0]).toMatchObject({ title: 'Senior Engineer · Heute AG', period: '2022–heute' });
    fixture.destroy();
  });

  it('deletes the current import only after the exact typed confirmation', async () => {
    const current = cvImportFixture();
    apiMock['deleteCvImport'].mockReturnValue(of({ removed: 1 }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(current);
    component.cvDeleteConfirmation = 'DELETE cv-import wrong';
    component.deleteCurrentCvImport();
    expect(apiMock['deleteCvImport']).not.toHaveBeenCalled();
    component.cvDeleteConfirmation = `DELETE cv-import ${current.id}`;
    component.deleteCurrentCvImport();
    expect(apiMock['deleteCvImport']).toHaveBeenCalledWith(current);
    expect(component.cvImport).toBeUndefined();
    expect(component.cvStep).toBe(1);
    fixture.destroy();
  });

  it('rejects legacy Word and files over 10 MiB before any CV upload request', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('cv'); fixture.detectChanges(); await fixture.whenStable();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('[data-testid="cv-file-input"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['legacy'], 'legacy.doc', { type: 'application/msword' })] });
    input.dispatchEvent(new Event('change'));
    expect(component.cvError).toContain('ausschließlich PDF, DOCX, ODT, HTML und HTM');
    const oversized = new File(['x'], 'zu-gross.html', { type: 'text/html' });
    Object.defineProperty(oversized, 'size', { configurable: true, value: 10 * 1024 * 1024 + 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [oversized] });
    input.dispatchEvent(new Event('change'));
    expect(component.cvError).toContain('zwischen 1 Byte und 10 MiB');
    expect(apiMock['importCv']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('reviews facts atomically by CAS, preserves a stale edit and adopts only after explicit confirmation', async () => {
    const initial = cvImportFixture();
    const firstReviewed: CvImportRecord = {
      ...cvImportFixture(['confirmed', 'pending']), revision: 2, sha256: '8'.repeat(64), updatedAt: '2026-08-14T08:01:00Z'
    };
    const fullyReviewed: CvImportRecord = {
      ...cvImportFixture(['confirmed', 'rejected']), revision: 3, sha256: '9'.repeat(64), status: 'facts_reviewed', updatedAt: '2026-08-14T08:02:00Z'
    };
    apiMock['reviewCvFacts'].mockReturnValueOnce(of(firstReviewed)).mockReturnValueOnce(of(fullyReviewed));
    apiMock['adoptCvFacts'].mockReturnValue(of(adoptedCvImportFixture()));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(initial);
    component.cvStep = 2;
    component.decideCvFact(initial.facts[0]!, 'confirm');
    expect(apiMock['reviewCvFacts']).toHaveBeenNthCalledWith(1, initial, [{ factId: 'fact-employment-company', action: 'confirm' }]);
    component.decideCvFact(firstReviewed.facts[1]!, 'reject');
    expect(apiMock['reviewCvFacts']).toHaveBeenNthCalledWith(2, firstReviewed, [{ factId: 'fact-employment-period', action: 'reject' }]);
    component.adoptCvFacts();
    expect(apiMock['adoptCvFacts']).not.toHaveBeenCalled();
    component.cvAdoptionConfirmed = true;
    component.adoptCvFacts();
    expect(apiMock['adoptCvFacts']).toHaveBeenCalledWith(fullyReviewed);
    expect(component.cvImport?.adoption?.adoptedClaimIds).toEqual(['claim-cv-employment-company']);
    expect(component.cvImport?.facts.find((fact) => fact.id === 'fact-employment-period')?.decision).toBe('rejected');

    const adopted = component.cvImport!;
    component.updateCvFactDraft(adopted.facts[0]!, 'value', 'Lokale, noch nicht gespeicherte Änderung');
    apiMock['reviewCvFacts'].mockReturnValueOnce(throwError(() => ({ status: 409, error: { error: 'CV-Import wurde zwischenzeitlich geändert.' } })));
    component.saveCvFact(adopted.facts[0]!);
    expect(apiMock['reviewCvFacts']).toHaveBeenCalledTimes(3);
    expect(component.cvFactDraft(adopted.facts[0]!).value).toBe('Lokale, noch nicht gespeicherte Änderung');
    expect(component.cvImport?.revision).toBe(4);
    expect(component.cvError).toContain('zwischenzeitlich geändert');
    fixture.destroy();
  });

  it('shows the five-role result directly while retaining the separately bound approved export renderer', async () => {
    const adopted = adoptedCvImportFixture();
    const cvCase: ApplicationCase = { ...structuredClone(applicationCaseFixture), documentType: 'cv' };
    const approvedCvCase: ApplicationCase = {
      ...cvCase, state: 'approved', revision: 5,
      approvedArtifactRevisionId: artifactRevisionFixture.id, approvedArtifactSha256: artifactRevisionFixture.sha256,
      approvedAt: '2026-08-14T08:04:00Z'
    };
    const themed: CvImportRecord = {
      ...adopted, revision: 5, sha256: 'c'.repeat(64), theme: {
        template: 'classic', font: 'Arial', accentColor: '#1f2937', spacing: 'comfortable',
        sectionOrder: ['profile', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional']
      }
    };
    const proposed: CvImportRecord = {
      ...themed, revision: 6, sha256: 'd'.repeat(64), status: 'proposal_ready', proposal: {
        applicationCaseId: cvCase.id, jobId: cvCase.job.id, createdAt: '2026-08-14T08:05:00Z',
        htmlSha256: 'e'.repeat(64), documentRevisionId: artifactRevisionFixture.id, documentSha256: artifactRevisionFixture.sha256,
        lifecycle: 'approved_revision_preview', format: 'html', downloadAllowed: true,
        inputSnapshot: {
          cvImportRevision: 5, cvImportSha256: themed.sha256, candidateProfileSha256: 'b'.repeat(64), candidateProfileRevision: 'profile-revision-4',
          styleProfileRevision: 3, styleProfileSha256: '8'.repeat(64), themeSha256: 'f'.repeat(64),
          agentWorkflowId: 'evidence-application-package', sourceAgentArtifactId: 'used-agent-artifact',
          pipelineContractVersion: '1.0.0', completedStages: ['validate_profiles', 'audit_claims', 'validate_iteration'],
          agentOrchestrationRequired: false, recognitionVersionId: CV_DETERMINISTIC_RECOGNITION_ID,
          recognitionVersionSha256: '6'.repeat(64)
        }
      }
    };
    apiMock['applicationCases'].mockReturnValue(of([structuredClone(cvCase)]));
    apiMock['saveCvTheme'].mockReturnValue(of(themed));
    apiMock['createCvProposal'].mockReturnValue(of(proposed));
    apiMock['agentWorkflows'].mockReturnValue(of([{
      id: 'evidence-application-package', version: '1.1.0', title: 'Evidence-Bewerbungspaket', description: 'Fixture',
      requiredScope: 'application_case', producesSuggestionsOnly: true, prohibitedActions: ['submit_application']
    }]));
    apiMock['createAgentOrchestration'].mockReturnValue(of(orchestrationFixture('running')));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('cv'); fixture.detectChanges(); await fixture.whenStable();
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(adopted);
    component.cvStep = 4; component.cvThemeConfirmed = true;
    component.saveCvTheme();
    expect(apiMock['saveCvTheme']).toHaveBeenCalledWith(adopted, expect.objectContaining({ template: 'classic', font: 'Arial' }));
    component.applicationCases = [structuredClone(cvCase)]; component.cvSelectedApplicationCaseId = cvCase.id;
    expect(component.cvHtmlRenderUnavailableReason()).toContain('zuerst geprüft');
    component.startCvAgentOrchestration();
    expect(apiMock['createAgentOrchestration']).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'evidence-application-package', providerId: 'codex', runtimeTarget: 'windows', applicationCaseId: cvCase.id
    }));
    expect(apiMock['createAgentOrchestration'].mock.calls[0]?.[0].prompt).toContain('ausschließlich bestätigte CandidateProfile-Claims');
    expect(component.cvAgentOrchestrationId).toBe('33333333-3333-4333-8333-333333333333');

    component.agentOrchestrations = [orchestrationFixture('succeeded')];
    component.cvStep = 6;
    fixture.detectChanges();
    const directResult = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLIFrameElement>('[data-testid="cv-agent-html-result"]');
    expect(directResult).toBeTruthy();
    expect(directResult?.hasAttribute('sandbox')).toBe(true);
    expect(directResult?.getAttribute('sandbox')).toBe('');

    component.applicationCases = [approvedCvCase];
    component.renderApprovedCvHtml();
    expect(apiMock['createCvProposal']).toHaveBeenCalledWith(
      cvCase.id, themed, artifactRevisionFixture.id, artifactRevisionFixture.sha256
    );
    expect(apiMock['cvProposalHtmlUrl']).toHaveBeenCalledWith(proposed.id, proposed.proposal!.htmlSha256);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const iframe = element.querySelector<HTMLIFrameElement>('[data-testid="cv-html-preview"]')!;
    expect(iframe).toBeTruthy();
    expect(iframe.hasAttribute('sandbox')).toBe(true);
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(element.querySelector('[data-testid="cv-pipeline-step"]')?.textContent).toContain('Proof-verifizierter HTML-Lebenslauf');
    expect(element.querySelector('[data-testid="cv-html-download"]')).toBeTruthy();
    expect(apiMock['downloadCvProposal']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('keeps an incognito agent proposal inspectable but blocks HTML creation and download', async () => {
    const adopted = adoptedCvImportFixture();
    const incognitoCase: ApplicationCase = {
      ...structuredClone(applicationCaseFixture), documentType: 'cv', identityMode: 'incognito', state: 'review',
    };
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(adopted);
    component.applicationCases = [incognitoCase];
    component.cvSelectedApplicationCaseId = incognitoCase.id;
    expect(component.cvHtmlRenderUnavailableReason()).toContain('nicht verwendbare Vorschläge');
    component.renderApprovedCvHtml();
    expect(apiMock['createCvProposal']).not.toHaveBeenCalled();
    expect(component.cvError).toContain('HTML-Erzeugung und Download sind gesperrt');
    fixture.destroy();
  });

  it('derives ATS and original format templates from the captured layout fingerprint', async () => {
    const fingerprint: CvLayoutFingerprint = {
      contract: 'cv-layout-fingerprint', contractVersion: '1.0', sourceFormat: 'html', columns: 2, fontFamily: 'sans',
      confidence: 'high',
      palette: { text: '#222222', heading: '#111111', accent: '#7c3aed', background: '#ffffff', sidebar: '#0f172a', sidebarText: '#f9fafb' },
      sections: [
        { section: 'profile', label: 'Profil', column: 'side' },
        { section: 'skill', label: 'Kenntnisse', column: 'side' },
        { section: 'employment', label: 'Berufserfahrung', column: 'main' },
        { section: 'education', label: 'Ausbildung', column: 'main' }
      ],
      warnings: []
    };
    const record: CvImportRecord = {
      ...cvImportFixture(['confirmed', 'confirmed']), status: 'facts_reviewed', layoutFingerprint: fingerprint
    };
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('cv'); fixture.detectChanges(); await fixture.whenStable();
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(record);
    expect(component.cvThemeVariant).toBe('ats');

    component.selectCvThemeVariant('original');
    expect(component.cvThemeDraft.mode).toBe('original');
    expect(component.cvThemeDraft.original?.columns).toBe(2);
    expect(component.cvThemeDraft.original?.side).toEqual(['profile', 'skill']);
    expect(component.cvThemeDraft.original?.main).toEqual(['employment', 'education']);
    expect(component.cvThemeDraft.original?.palette.accent).toBe('#7c3aed');
    expect(component.cvThemeDraft.accentColor).toBe('#7c3aed');

    component.prefillAtsFromOriginal();
    expect(component.cvThemeDraft.mode).toBe('ats');
    expect(component.cvThemeDraft.original).toBeUndefined();
    expect(component.cvThemeDraft.sectionOrder.slice(0, 4)).toEqual(['profile', 'skill', 'employment', 'education']);
    expect(component.cvThemeDraft.sectionOrder.length).toBe(8);
    fixture.destroy();
  });

  it('shows the central job inventory grouped by category and moves jobs between categories', async () => {
    const entry: JobInventoryView = {
      key: 'angular engineer|beispiel gmbh|berlin',
      job: { id: 'job-1', sourceId: 'demo', title: 'Angular Engineer', company: 'Beispiel GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: 'x', skills: ['Angular', 'RxJS'] },
      category: 'inbox', firstSeenAt: '2026-08-15T09:00:00Z', lastSeenAt: '2026-08-15T10:00:00Z', runCount: 2, sourceIds: ['demo'],
      match: { score: 82, accepted: true, matchedMustHave: ['Angular'], missingMustHave: ['Kubernetes'], matchedNiceToHave: ['RxJS'] },
      status: { applied: false, cases: [], documents: [], appliedWith: [], tracking: [] }
    };
    apiMock['jobInventory'].mockReturnValue(of([entry]));
    apiMock['searchRunsSummary'].mockReturnValue(of([{ id: 'run-1', createdAt: '2026-08-15T10:00:00Z', sourceIds: ['demo'], matchCount: 5, acceptedCount: 3, newJobCount: 2, partialFailureCount: 0 }]));
    apiMock['setJobInventoryCategory'].mockImplementation((_key: string, category: string) => of({ ...structuredClone(entry), category }));
    apiMock['markJobInventoryApplied'].mockImplementation((_key: string, applied: boolean, note?: string) => of({ ...structuredClone(entry), status: { ...entry.status, applied, ...(applied ? { manualApplied: { at: '2026-08-15T11:00:00Z', note } } : {}) } }));

    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('jobs'); fixture.detectChanges(); await fixture.whenStable();
    expect(component.jobInventory).toHaveLength(1);
    expect(component.jobsInCategory('inbox')).toHaveLength(1);
    expect(component.jobCategoryCount('inbox')).toBe(1);
    expect(component.searchRunSummaries[0].newJobCount).toBe(2);

    component.moveJobCategory(entry, 'apply');
    expect(apiMock['setJobInventoryCategory']).toHaveBeenCalledWith(entry.key, 'apply');
    expect(component.jobInventory[0].category).toBe('apply');
    expect(component.jobsInCategory('inbox')).toHaveLength(0);
    expect(component.jobsInCategory('apply')).toHaveLength(1);

    component.toggleJobApplied(component.jobInventory[0]!);
    expect(apiMock['markJobInventoryApplied']).toHaveBeenCalledWith(entry.key, true);
    expect(component.jobInventory[0].status.applied).toBe(true);
    expect(component.appliedJobCount()).toBe(1);

    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const board = element.querySelector('[data-testid="jobs-board"]')!;
    expect(board).toBeTruthy();
    expect(board.querySelector('.job-score')?.textContent).toContain('82');
    expect(board.textContent).toContain('fehlt: Kubernetes');
    fixture.destroy();
  });

  it('runs the local ATS check and surfaces the deterministic report', async () => {
    apiMock['atsCheckCv'].mockReturnValue(of({
      contract: 'ats-check', contractVersion: '1.0', engine: 'deterministic-local', checkedAt: '2026-08-15T10:00:00Z', htmlSha256: 'a'.repeat(64),
      summary: { pass: 4, warn: 1, fail: 0, parseable: true },
      lint: [{ id: 'single-column', label: 'Einspaltige Lesereihenfolge', status: 'pass', detail: 'Eine Spalte.' }],
      parse: { parser: 'local-rule-based-ats-parser', parserVersion: '1.0', detectedSections: [], recovered: { hasDateRanges: true }, counts: { sections: 3, experienceItems: 2, educationItems: 1, skills: 3, bullets: 6 }, warnings: [] },
      coverage: { mustHave: { total: 2, matched: 1, terms: [] }, niceToHave: { total: 1, matched: 1, terms: [] } },
      disclaimer: 'Lokale ATS-Heuristik ohne Score.'
    }));
    const record: CvImportRecord = { ...cvImportFixture(['confirmed', 'confirmed']), status: 'facts_reviewed' };
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('cv'); fixture.detectChanges(); await fixture.whenStable();
    (component as unknown as { applyCvImport(record: CvImportRecord): void }).applyCvImport(record);

    component.runCvAtsCheck('theme-preview');
    expect(apiMock['atsCheckCv']).toHaveBeenCalledWith(record, 'theme-preview', expect.any(Array), expect.any(Array));
    expect(component.cvAtsReport?.summary.parseable).toBe(true);
    expect(component.cvAtsReport?.summary.fail).toBe(0);
    fixture.destroy();
  });

  it('lists both MCP runtime candidates and switches to a selected one', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('sources'); fixture.detectChanges(); await fixture.whenStable();
    expect(component.mcpRuntimeCandidates.map((candidate) => candidate.runtimeTarget).sort()).toEqual(['windows', 'wsl']);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="mcp-runtime-candidates"]')).toBeTruthy();
    component.selectMcpRuntime('wsl');
    expect(apiMock['selectMcpRuntime']).toHaveBeenCalledWith('wsl', expect.any(Number));
    fixture.destroy();
  });
});
