import { TestBed } from '@angular/core/testing';
import { EMPTY, of, throwError } from 'rxjs';
import { App } from './app';
import { ApiService } from './api.service';
import type { AgentArtifactRecord, AgentConfigProfileView, AgentOrchestrationConflict, AgentOrchestrationRecord, AgentRecoveryRun, AgentRun, AgentRunPreflight, AgentRunRequest, AppConfig, ApplicationCase, ApplicationStyleProfileView, ArtifactRevision, CorrelatedMail } from './models';

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

function orchestrationFixture(status: AgentOrchestrationRecord['status'] = 'waiting_for_gate'): AgentOrchestrationRecord {
  const packageProposal = {
    outputRef: 'package_proposal', artifactId: 'artifact-package', runId: 'run-finalizer',
    sha256: '4'.repeat(64), lifecycle: 'proposed' as const
  };
  return {
    schemaVersion: 1, id: '33333333-3333-4333-8333-333333333333', revision: 1,
    workflowId: 'evidence-application-package', workflowVersion: '1.0.0', providerId: 'codex', status,
    producesSuggestionsOnly: true, promptSha256: '1'.repeat(64), redactedSummary: 'Evidence-Paket · getrennte Rollen · nur Vorschläge',
    scope: { applicationCaseId: applicationCaseFixture.id, applicationCaseRevision: applicationCaseFixture.revision, jobId: applicationCaseFixture.job.id, companyKey: 'beispiel', identityMode: 'real', workspaceRootId: 'workspace-local' },
    resolvedGates: [
      { nodeId: 'evidence', gate: 'evidence_complete', authority: 'server_evidence', bindingSha256: '3'.repeat(64) },
      ...(status === 'succeeded' ? [{ nodeId: 'finalizer', gate: 'user_input' as const, authority: 'server_revision_confirmation' as const, bindingSha256: '5'.repeat(64) }] : [])
    ],
    unresolvedGates: status === 'waiting_for_gate' ? [{ nodeId: 'finalizer', gate: 'user_input' }] : [],
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

  it('starts without an existing document revision and continues only the user-input gate to a package proposal', async () => {
    const waiting = orchestrationFixture();
    const completed: AgentOrchestrationRecord = { ...orchestrationFixture('succeeded'), revision: 2, finishedAt: '2026-08-14T08:02:00Z' };
    apiMock['agentWorkflows'].mockReturnValue(of([{
      id: 'evidence-application-package', version: '1.0.0', title: 'Evidence-Bewerbungspaket', description: 'Getrennte Rollen.',
      requiredScope: 'application_case', producesSuggestionsOnly: true, prohibitedActions: ['submit_application']
    }]));
    apiMock['applicationCases'].mockReturnValue(of([applicationCaseFixture]));
    apiMock['applicationArtifacts'].mockReturnValue(of([]));
    apiMock['createAgentOrchestration'].mockReturnValue(of(waiting));
    apiMock['continueAgentOrchestration'].mockReturnValue(of(completed));
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
    component.agentOrchestrationUserInputConfirmed = true;
    component.continueAgentOrchestration();
    expect(apiMock['continueAgentOrchestration']).toHaveBeenCalledWith(waiting.id, 1, {
      userInput: { confirmed: true }
    });
    expect(component.selectedAgentOrchestration?.status).toBe('succeeded');
    expect(component.selectedAgentOrchestration?.artifactRefs).toContainEqual(expect.objectContaining({ outputRef: 'package_proposal', lifecycle: 'proposed' }));
    expect(component.notice).toContain('erfolgreiche Rollen werden nicht erneut ausgeführt');
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
});
