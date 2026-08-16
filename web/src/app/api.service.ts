import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { AtsCheckReport, AgentArtifactAdoptionResult, AgentArtifactContent, AgentArtifactRecord, AgentConfigProfile, AgentConfigProfileView, AgentOrchestrationConfirmationInput, AgentOrchestrationConflict, AgentOrchestrationConflictResolutionRequest, AgentOrchestrationCreateRequest, AgentOrchestrationRecord, AgentProvider, AgentQueueSnapshot, AgentRecoveryDecision, AgentRecoveryLease, AgentRecoveryResolution, AgentRecoverySnapshot, AgentRun, AgentRunEvent, AgentRunEventsPage, AgentRunPreflight, AgentRunRequest, AgentWorkflow, AppConfig, ApplicationCase, ApplicationDraft, ApplicationExportResult, ApplicationPipelineFinalizeResult, ApplicationProfileSetupStatus, ApplicationStyleProfileView, ArtifactRevision, CandidateMatchAnalysis, CandidateProfileSummary, CompanyCrm, CorrelatedMail, CvAiProviderSelection, CvAiStructuringOptions, CvAiStructuringPublicRun, CvAiStructuringSelection, CvAdoptionRevocationCandidates, CvFactOperation, CvImportRecord, CvProfileSnapshotList, CvImportSummary, CvRecognitionVersionList, CvTheme, DataInventory, EditableApplicationStyleProfile, IdentityProfile, JobDecision, JobInventoryCategory, JobInventoryView, JobMatch, JobSearchMcpRuntimeCandidate, JobSourceCapabilities, LanguageCheckResult, MailAccount, McpRuntimeStatus, ProfileImportPreview, ProviderModelCatalog, SearchProfile, SearchRunSummary, SearchSchedule, SourceStatus } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  config(): Observable<AppConfig> { return this.http.get<AppConfig>('/api/config'); }
  saveConfig(config: AppConfig): Observable<AppConfig> { return this.http.put<AppConfig>('/api/config', config); }
  deleteIdentity(identityId: string): Observable<{ removed: number; remainingActiveIdentityId: string }> {
    return this.http.delete<{ removed: number; remainingActiveIdentityId: string }>(
      `/api/identities/${encodeURIComponent(identityId)}`, { body: { confirmation: `DELETE identity ${identityId}` } }
    );
  }
  setMcpPortalAccess(enabled: boolean, expectedRevision: number): Observable<AppConfig> {
    return this.http.put<AppConfig>('/api/config/mcp/portal-access', { enabled, confirmed: true, expectedRevision });
  }
  sources(): Observable<SourceStatus[]> { return this.http.get<SourceStatus[]>('/api/sources'); }
  sourceRuntime(): Observable<McpRuntimeStatus> { return this.http.get<McpRuntimeStatus>('/api/sources/runtime'); }
  mcpRuntimeCandidates(): Observable<{ candidates: JobSearchMcpRuntimeCandidate[] }> {
    return this.http.get<{ candidates: JobSearchMcpRuntimeCandidate[] }>('/api/sources/runtime/candidates');
  }
  selectMcpRuntime(runtimeTarget: 'windows' | 'wsl', expectedRevision: number): Observable<AppConfig> {
    return this.http.post<AppConfig>('/api/sources/runtime/select', { runtimeTarget, confirmed: true, expectedRevision });
  }
  capabilities(): Observable<JobSourceCapabilities> { return this.http.get<JobSourceCapabilities>('/api/capabilities'); }
  createIncognito(location: string): Observable<IdentityProfile> {
    return this.http.post<IdentityProfile>('/api/identities/incognito', { location });
  }
  search(profile: SearchProfile, fold = true): Observable<{ runId: string; matches: JobMatch[]; partialFailures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }>; newJobCount?: number; folded?: boolean }> {
    return this.http.post<{ runId: string; matches: JobMatch[]; partialFailures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }>; newJobCount?: number; folded?: boolean }>(`/api/jobs/search${fold ? '' : '?fold=false'}`, profile);
  }
  adoptSearchRun(runId: string): Observable<{ runId: string; total: number; added: number; duplicates: number }> {
    return this.http.post<{ runId: string; total: number; added: number; duplicates: number }>(`/api/search-runs/${encodeURIComponent(runId)}/adopt`, {});
  }
  login(sourceId: string): Observable<{ status: string; note?: string }> {
    return this.http.post<{ status: string; note?: string }>(`/api/sources/${sourceId}/login`, {});
  }
  jobDecisions(): Observable<JobDecision[]> { return this.http.get<JobDecision[]>('/api/job-decisions'); }
  setJobDecision(jobId: string, state: JobDecision['state']): Observable<JobDecision> {
    return this.http.put<JobDecision>(`/api/job-decisions/${encodeURIComponent(jobId)}`, { state });
  }
  jobInventory(): Observable<JobInventoryView[]> { return this.http.get<JobInventoryView[]>('/api/job-inventory'); }
  deleteJobInventory(key: string): Observable<{ removed: number }> {
    return this.http.delete<{ removed: number }>(`/api/job-inventory/${encodeURIComponent(key)}`, {
      body: { confirmation: `DELETE job-inventory ${key}` }
    });
  }
  setJobInventoryCategory(key: string, category: JobInventoryCategory): Observable<JobInventoryView> {
    return this.http.put<JobInventoryView>(`/api/job-inventory/${encodeURIComponent(key)}/category`, { category });
  }
  markJobInventoryApplied(key: string, applied: boolean, note?: string): Observable<JobInventoryView> {
    return this.http.post<JobInventoryView>(`/api/job-inventory/${encodeURIComponent(key)}/applied`, { applied, ...(note ? { note } : {}) });
  }
  searchRunsSummary(): Observable<SearchRunSummary[]> { return this.http.get<SearchRunSummary[]>('/api/search-runs-summary'); }
  compareJobs(matches: JobMatch[]): Observable<{ comparison: Array<{ jobId: string; title: string; company: string; total: number; factors: Record<string, number> }>; disclaimer: string }> {
    return this.http.post<{ comparison: Array<{ jobId: string; title: string; company: string; total: number; factors: Record<string, number> }>; disclaimer: string }>('/api/jobs/compare', {
      matches, coverage: matches.map((item) => ({ jobId: item.job.id, direct: 0, transferable: 0, partial: 0, gaps: item.missingMustHave.length })),
      weights: { searchPreference: 1, evidenceCoverage: 1, gaps: 1, salary: 1 }
    });
  }
  dataInventory(): Observable<DataInventory> { return this.http.get<DataInventory>('/api/data/inventory'); }
  portableExport(): Observable<Record<string, unknown>> { return this.http.post<Record<string, unknown>>('/api/data/export', { includeIdentities: false, confirmed: false }); }
  schedules(): Observable<SearchSchedule[]> { return this.http.get<SearchSchedule[]>('/api/search-schedules'); }
  deleteSearchSchedule(id: string): Observable<{ removed: number }> {
    return this.http.delete<{ removed: number }>(`/api/search-schedules/${encodeURIComponent(id)}`, {
      body: { confirmation: `DELETE search-schedule ${id}` }
    });
  }
  createSchedule(profile: SearchProfile): Observable<SearchSchedule> {
    return this.http.post<SearchSchedule>('/api/search-schedules', { name: `${profile.name} – lokal`, enabled: false, profile, intervalMinutes: 1440, quietHours: { start: 22, end: 7, timeZone: 'Europe/Berlin' } });
  }
  runRetention(days: number): Observable<Record<string, unknown>> { return this.http.post<Record<string, unknown>>('/api/data/retention/run', { enabled: true, days, confirmed: true }); }
  logout(sourceId: string): Observable<{ status: string; note?: string }> {
    return this.http.delete<{ status: string; note?: string }>(`/api/sources/${sourceId}/session`);
  }
  assistantStatus(): Observable<{ available: boolean; note: string }> {
    return this.http.get<{ available: boolean; note: string }>('/api/assistant/status');
  }
  applicationPipelineSetup(): Observable<ApplicationProfileSetupStatus> {
    return this.http.get<ApplicationProfileSetupStatus>('/api/application-pipeline/setup');
  }
  initializeApplicationProfiles(): Observable<ApplicationProfileSetupStatus> {
    return this.http.post<ApplicationProfileSetupStatus>('/api/application-pipeline/setup/profiles', { confirmed: true });
  }
  applicationStyleProfile(): Observable<ApplicationStyleProfileView> {
    return this.http.get<ApplicationStyleProfileView>('/api/application-pipeline/style-profile');
  }
  saveApplicationStyleProfile(current: ApplicationStyleProfileView, profile: EditableApplicationStyleProfile): Observable<ApplicationStyleProfileView> {
    return this.http.put<ApplicationStyleProfileView>('/api/application-pipeline/style-profile', {
      expectedRevision: current.revision,
      expectedSha256: current.sha256,
      confirmed: true,
      profile
    });
  }
  candidateProfile(): Observable<CandidateProfileSummary> { return this.http.get<CandidateProfileSummary>('/api/candidate-profile'); }
  patchClaim(claimId: string, statement: string, status: string): Observable<unknown> {
    return this.http.patch('/api/candidate-profile/claims', { confirmed: true, operations: [
      { claimId, field: 'statement', value: statement }, { claimId, field: 'status', value: status }
    ] });
  }
  importProfile(fileName: string, mimeType: string, base64: string, sourceKind: string): Observable<ProfileImportPreview> {
    return this.http.post<ProfileImportPreview>('/api/profile-imports/preview', { fileName, mimeType, base64, sourceKind });
  }
  acceptImport(preview: ProfileImportPreview): Observable<unknown> {
    return this.http.post('/api/profile-imports/accept', { confirmed: true, proposals: preview.proposals.map((item, index) => ({
      id: `claim-import-${item.source.sha256.slice(0, 8)}-${index + 1}`, statement: item.statement, sha256: item.source.sha256
    })) });
  }
  importCv(input: {
    fileName: string;
    mimeType: CvImportRecord['source']['mimeType'];
    base64: string;
  }): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>('/api/cv-imports', { ...input, confirmed: true });
  }
  cvImport(importId: string): Observable<CvImportRecord> {
    return this.http.get<CvImportRecord>(`/api/cv-imports/${encodeURIComponent(importId)}`);
  }
  cvImports(limit = 20): Observable<CvImportSummary[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    return this.http.get<CvImportSummary[]>(`/api/cv-imports?limit=${boundedLimit}`);
  }
  deleteCvImport(current: CvImportRecord): Observable<{ removed: number }> {
    return this.deleteCvImportById(current.id, current.revision, current.sha256);
  }
  deleteCvImportById(id: string, revision: number, sha256: string): Observable<{ removed: number }> {
    return this.http.delete<{ removed: number }>(`/api/cv-imports/${encodeURIComponent(id)}`, {
      body: { confirmation: `DELETE cv-import ${id}`, expectedRevision: revision, expectedSha256: sha256 }
    });
  }
  cvRecognitionVersions(current: CvImportRecord): Observable<CvRecognitionVersionList> {
    return this.http.get<CvRecognitionVersionList>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/recognition-versions`
    );
  }
  activateCvRecognitionVersion(current: CvImportRecord, versionId: string): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/recognition-versions/${encodeURIComponent(versionId)}/activate`,
      { expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true }
    );
  }
  confirmCvRecognitionVersion(current: CvImportRecord, versionId: string): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/recognition-versions/${encodeURIComponent(versionId)}/confirm`,
      { expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true }
    );
  }
  cvAiStructuringOptions(current: CvImportRecord): Observable<CvAiStructuringOptions> {
    return this.http.get<CvAiStructuringOptions>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/ai-structuring/options?expectedRevision=${current.revision}&expectedSha256=${encodeURIComponent(current.sha256)}`
    );
  }
  cvAiStructuringRuns(current: CvImportRecord, limit = 20): Observable<CvAiStructuringPublicRun[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    return this.http.get<CvAiStructuringPublicRun[]>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/ai-structuring/runs?limit=${boundedLimit}`
    );
  }
  cvAiStructuringRun(importId: string, runId: string): Observable<CvAiStructuringPublicRun> {
    return this.http.get<CvAiStructuringPublicRun>(
      `/api/cv-imports/${encodeURIComponent(importId)}/ai-structuring/runs/${encodeURIComponent(runId)}`
    );
  }
  startCvAiStructuring(current: CvImportRecord, provider: CvAiProviderSelection): Observable<CvAiStructuringPublicRun> {
    return this.http.post<CvAiStructuringPublicRun>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/ai-structuring/runs`,
      {
        expectedRevision: current.revision, expectedSha256: current.sha256, provider,
        mode: 'replace_with_ai_version',
        disclosure: {
          version: '1.0', confirmed: true, sendExtractedCvTextToProvider: true,
          acknowledgeProviderControlPlaneNetwork: true
        }
      }
    );
  }
  cancelCvAiStructuring(importId: string, run: CvAiStructuringPublicRun): Observable<CvAiStructuringPublicRun> {
    return this.http.post<CvAiStructuringPublicRun>(
      `/api/cv-imports/${encodeURIComponent(importId)}/ai-structuring/runs/${encodeURIComponent(run.id)}/cancel`,
      { expectedRunRevision: run.revision, expectedRunSha256: run.sha256, confirmed: true }
    );
  }
  deleteCvAiRun(importId: string, run: CvAiStructuringPublicRun): Observable<{ removed: number; id: string }> {
    return this.http.delete<{ removed: number; id: string }>(
      `/api/cv-imports/${encodeURIComponent(importId)}/ai-structuring/runs/${encodeURIComponent(run.id)}`,
      { body: { expectedRunRevision: run.revision, expectedRunSha256: run.sha256, confirmed: true } }
    );
  }
  retryCvAiStructuring(
    current: CvImportRecord,
    run: CvAiStructuringPublicRun,
    provider: CvAiProviderSelection
  ): Observable<CvAiStructuringPublicRun> {
    return this.http.post<CvAiStructuringPublicRun>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/ai-structuring/runs/${encodeURIComponent(run.id)}/retry`,
      {
        expectedRunRevision: run.revision, expectedRunSha256: run.sha256,
        expectedCvImportRevision: current.revision, expectedCvImportSha256: current.sha256, provider,
        mode: 'replace_with_ai_version',
        disclosure: {
          version: '1.0', confirmed: true, sendExtractedCvTextToProvider: true,
          acknowledgeProviderControlPlaneNetwork: true
        }
      }
    );
  }
  applyCvAiStructuring(
    current: CvImportRecord,
    run: CvAiStructuringPublicRun,
    selections: CvAiStructuringSelection[]
  ): Observable<CvAiStructuringPublicRun> {
    return this.http.post<CvAiStructuringPublicRun>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/ai-structuring/runs/${encodeURIComponent(run.id)}/apply`,
      {
        expectedRunRevision: run.revision, expectedRunSha256: run.sha256,
        expectedCvImportRevision: current.revision, expectedCvImportSha256: current.sha256,
        selections, confirmed: true
      }
    );
  }
  reviewCvFacts(current: CvImportRecord, operations: CvFactOperation[]): Observable<CvImportRecord> {
    return this.http.patch<CvImportRecord>(`/api/cv-imports/${encodeURIComponent(current.id)}/facts`, {
      expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true, operations
    });
  }
  saveCvTheme(current: CvImportRecord, theme: CvTheme | null): Observable<CvImportRecord> {
    return this.http.put<CvImportRecord>(`/api/cv-imports/${encodeURIComponent(current.id)}/theme`, {
      expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true, theme
    });
  }
  previewCvTheme(current: CvImportRecord, theme: CvTheme): Observable<{ html: string; htmlSha256: string }> {
    return this.http.post<{ html: string; htmlSha256: string }>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/theme/preview`, { theme }
    );
  }
  atsCheckCv(current: CvImportRecord, source: 'theme-preview' | 'proposal', mustHave: string[] = [], niceToHave: string[] = []): Observable<AtsCheckReport> {
    return this.http.post<AtsCheckReport>(`/api/cv-imports/${encodeURIComponent(current.id)}/ats-check`, {
      source, ...(mustHave.length ? { mustHave } : {}), ...(niceToHave.length ? { niceToHave } : {})
    });
  }
  adoptCvFacts(current: CvImportRecord): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>(`/api/cv-imports/${encodeURIComponent(current.id)}/adopt`, {
      expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true
    });
  }
  revocableCvAdoptions(current: CvImportRecord): Observable<CvAdoptionRevocationCandidates> {
    return this.http.get<CvAdoptionRevocationCandidates>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/adoption/revocable`
    );
  }
  revokeCvAdoption(current: CvImportRecord, transactionId: string): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>(`/api/cv-imports/${encodeURIComponent(current.id)}/adoption/revoke`, {
      expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true, transactionId
    });
  }
  cvProfileSnapshots(current: CvImportRecord): Observable<CvProfileSnapshotList> {
    return this.http.get<CvProfileSnapshotList>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/profile-snapshots`
    );
  }
  restoreCvProfileSnapshot(current: CvImportRecord, snapshotId: string): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>(
      `/api/cv-imports/${encodeURIComponent(current.id)}/profile-snapshots/${encodeURIComponent(snapshotId)}/restore`,
      { expectedRevision: current.revision, expectedSha256: current.sha256, confirmed: true }
    );
  }
  createCvProposal(
    applicationCaseId: string,
    current: CvImportRecord,
    documentRevisionId: string,
    expectedDocumentSha256: string
  ): Observable<CvImportRecord> {
    return this.http.post<CvImportRecord>(`/api/application-cases/${encodeURIComponent(applicationCaseId)}/cv-proposals`, {
      importId: current.id, expectedRevision: current.revision, expectedSha256: current.sha256,
      documentRevisionId, expectedDocumentSha256, confirmed: true
    });
  }
  cvProposalHtmlUrl(importId: string, htmlSha256: string, download = false): string {
    return `/api/cv-imports/${encodeURIComponent(importId)}/proposal.html?sha256=${encodeURIComponent(htmlSha256)}&download=${download ? 'true' : 'false'}`;
  }
  downloadCvProposal(importId: string, htmlSha256: string): Observable<Blob> {
    return this.http.get(this.cvProposalHtmlUrl(importId, htmlSha256, true), {
      responseType: 'blob'
    });
  }
  analyze(match: JobMatch, documentType: 'cv' | 'cover_letter' | 'email'): Observable<CandidateMatchAnalysis> {
    return this.http.post<CandidateMatchAnalysis>('/api/applications/analyze', { match, documentType });
  }
  validateMatch(matrix: object, documentType: 'cv' | 'cover_letter' | 'email'): Observable<{ valid: boolean; errors: string[] }> {
    return this.http.post<{ valid: boolean; errors: string[] }>('/api/applications/validate-match', { matrix, documentType });
  }
  applicationCases(): Observable<ApplicationCase[]> { return this.http.get<ApplicationCase[]>('/api/application-cases'); }
  deleteApplicationCase(id: string): Observable<{ removed: number; id: string; cascade: { events: number; trackingEvents: number; artifacts: number } }> {
    return this.http.delete<{ removed: number; id: string; cascade: { events: number; trackingEvents: number; artifacts: number } }>(
      `/api/application-cases/${encodeURIComponent(id)}`, { body: { confirmation: `DELETE application-case ${id}` } }
    );
  }
  agentProviders(refresh = false): Observable<AgentProvider[]> {
    return this.http.get<AgentProvider[]>(refresh ? '/api/agents/providers?refresh=true' : '/api/agents/providers');
  }
  agentConfigProfile(): Observable<AgentConfigProfileView> {
    return this.http.get<AgentConfigProfileView>('/api/agents/config-profile');
  }
  providerModels(providerId: string, runtimeTarget: string, wslDistribution?: string): Observable<ProviderModelCatalog> {
    const params = new URLSearchParams({ runtimeTarget });
    if (wslDistribution) params.set('wslDistribution', wslDistribution);
    return this.http.get<ProviderModelCatalog>(
      `/api/agents/providers/${encodeURIComponent(providerId)}/models?${params.toString()}`,
    );
  }
  saveAgentConfigProfile(current: AgentConfigProfileView, profile: AgentConfigProfile): Observable<AgentConfigProfileView> {
    return this.http.put<AgentConfigProfileView>('/api/agents/config-profile', {
      expectedUpdatedAt: current.profile.updatedAt, confirmed: true, profile
    });
  }
  agentWorkflows(): Observable<AgentWorkflow[]> { return this.http.get<AgentWorkflow[]>('/api/agents/workflows'); }
  agentOrchestrations(): Observable<{ orchestrations: AgentOrchestrationRecord[] }> {
    return this.http.get<{ orchestrations: AgentOrchestrationRecord[] }>('/api/agent-orchestrations');
  }
  agentOrchestration(orchestrationId: string): Observable<AgentOrchestrationRecord> {
    return this.http.get<AgentOrchestrationRecord>(`/api/agent-orchestrations/${encodeURIComponent(orchestrationId)}`);
  }
  createAgentOrchestration(request: AgentOrchestrationCreateRequest): Observable<AgentOrchestrationRecord> {
    return this.http.post<AgentOrchestrationRecord>('/api/agent-orchestrations', request);
  }
  continueAgentOrchestration(orchestrationId: string, expectedRevision: number, confirmations: AgentOrchestrationConfirmationInput): Observable<AgentOrchestrationRecord> {
    return this.http.post<AgentOrchestrationRecord>(`/api/agent-orchestrations/${encodeURIComponent(orchestrationId)}/continue`, {
      expectedRevision, ...confirmations
    });
  }
  cancelAgentOrchestration(orchestrationId: string, expectedRevision: number): Observable<AgentOrchestrationRecord> {
    return this.http.post<AgentOrchestrationRecord>(`/api/agent-orchestrations/${encodeURIComponent(orchestrationId)}/cancel`, {
      expectedRevision, confirmed: true
    });
  }
  resolveAgentOrchestrationConflict(
    orchestrationId: string,
    conflict: AgentOrchestrationConflict,
    expectedRevision: number,
    strategy: AgentOrchestrationConflictResolutionRequest['strategy'],
    selectedArtifactId?: string
  ): Observable<AgentOrchestrationRecord> {
    const request: AgentOrchestrationConflictResolutionRequest = {
      expectedRevision, variantsSha256: conflict.variantsSha256, strategy, confirmed: true,
      ...(strategy === 'select_variant' && selectedArtifactId ? { selectedArtifactId } : {})
    };
    return this.http.post<AgentOrchestrationRecord>(
      `/api/agent-orchestrations/${encodeURIComponent(orchestrationId)}/conflicts/${encodeURIComponent(conflict.id)}/resolve`,
      request
    );
  }
  agentQueue(): Observable<AgentQueueSnapshot> { return this.http.get<AgentQueueSnapshot>('/api/agents/queue'); }
  agentRecovery(): Observable<AgentRecoverySnapshot> { return this.http.get<AgentRecoverySnapshot>('/api/agents/recovery'); }
  agentRuns(): Observable<AgentRun[]> { return this.http.get<AgentRun[]>('/api/agent-runs'); }
  agentRunPreflight(request: AgentRunRequest): Observable<AgentRunPreflight> { return this.http.post<AgentRunPreflight>('/api/agent-runs/preflight', request); }
  createAgentRun(request: AgentRunRequest): Observable<AgentRun> { return this.http.post<AgentRun>('/api/agent-runs', request); }
  agentRun(runId: string): Observable<AgentRun> { return this.http.get<AgentRun>(`/api/agent-runs/${encodeURIComponent(runId)}`); }
  agentRunEvents(runId: string, after: number): Observable<AgentRunEventsPage> {
    return this.http.get<AgentRunEventsPage>(`/api/agent-runs/${encodeURIComponent(runId)}/events?after=${after}`);
  }
  agentArtifacts(runId: string): Observable<{ artifacts: AgentArtifactRecord[] }> {
    return this.http.get<{ artifacts: AgentArtifactRecord[] }>(`/api/agent-runs/${encodeURIComponent(runId)}/artifacts`);
  }
  agentArtifactContent(runId: string, artifactId: string): Observable<AgentArtifactContent> {
    return this.http.get<AgentArtifactContent>(`/api/agent-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/content`);
  }
  reviewAgentArtifact(runId: string, artifactId: string, decision: 'approved' | 'rejected', expectedRevision: number): Observable<AgentArtifactRecord> {
    return this.http.post<AgentArtifactRecord>(`/api/agent-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/review`, {
      decision, expectedRevision, confirmed: true
    });
  }
  adoptAgentArtifact(runId: string, artifactId: string, expectedRevision: number): Observable<AgentArtifactAdoptionResult> {
    return this.http.post<AgentArtifactAdoptionResult>(`/api/agent-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/adopt`, {
      expectedRevision, confirmed: true
    });
  }
  agentRunEventStream(runId: string, after: number): Observable<AgentRunEvent> {
    return new Observable<AgentRunEvent>((subscriber) => {
      if (typeof EventSource === 'undefined') { subscriber.error(new Error('SSE ist in dieser Laufzeit nicht verfügbar.')); return; }
      const source = new EventSource(`/api/agent-runs/${encodeURIComponent(runId)}/stream?after=${after}`);
      const onEvent = (value: Event) => {
        try { subscriber.next(JSON.parse((value as MessageEvent<string>).data) as AgentRunEvent); }
        catch { subscriber.error(new Error('Ungültiges Agentenereignis im SSE-Stream.')); }
      };
      source.addEventListener('agent-event', onEvent);
      // Native EventSource reconnects automatically and carries Last-Event-ID.
      // The owning component unsubscribes once the run becomes terminal.
      source.onerror = () => undefined;
      return () => { source.removeEventListener('agent-event', onEvent); source.close(); };
    });
  }
  cancelAgentRun(runId: string, expectedRevision?: number): Observable<AgentRun> {
    return this.http.post<AgentRun>(`/api/agent-runs/${encodeURIComponent(runId)}/cancel`, { confirmed: true, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  }
  sendAgentInput(runId: string, input: string, expectedRevision?: number): Observable<AgentRun> {
    return this.http.post<AgentRun>(`/api/agent-runs/${encodeURIComponent(runId)}/input`, { input, confirmed: true, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  }
  decideAgentApproval(runId: string, approvalId: string, decision: 'approve' | 'deny', expectedRevision?: number): Observable<AgentRun> {
    return this.http.post<AgentRun>(`/api/agent-runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, { decision, confirmed: true, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  }
  exportAgentRun(runId: string): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(`/api/agent-runs/${encodeURIComponent(runId)}/export`);
  }
  acquireAgentRecoveryLease(runId: string, expectedRevision: number): Observable<AgentRecoveryLease> {
    return this.http.post<AgentRecoveryLease>(`/api/agent-runs/${encodeURIComponent(runId)}/recovery/lease`, { confirmed: true, expectedRevision });
  }
  resolveAgentRecovery(runId: string, input: { expectedRevision: number; leaseId: string; decision: AgentRecoveryDecision; replacementInput?: string }): Observable<AgentRecoveryResolution> {
    return this.http.post<AgentRecoveryResolution>(`/api/agent-runs/${encodeURIComponent(runId)}/recovery/resolve`, {
      confirmed: true, expectedRevision: input.expectedRevision, leaseId: input.leaseId, decision: input.decision,
      ...(input.replacementInput?.trim() ? { input: input.replacementInput.trim() } : {})
    });
  }
  crmCompanies(): Observable<CompanyCrm[]> { return this.http.get<CompanyCrm[]>('/api/crm/companies'); }
  mailAccounts(): Observable<MailAccount[]> { return this.http.get<MailAccount[]>('/api/mail/accounts'); }
  mailMessages(): Observable<CorrelatedMail[]> { return this.http.get<CorrelatedMail[]>('/api/mail/messages'); }
  saveMailAccount(input: { label: string; email: string; host: string; port: number; secure: boolean; username: string; secret: string; authType: 'password' | 'access_token'; enabled: boolean; mailbox: string }): Observable<MailAccount> {
    return this.http.post<MailAccount>('/api/mail/accounts', input);
  }
  setMailAccountEnabled(accountId: string, enabled: boolean): Observable<MailAccount> {
    return this.http.patch<MailAccount>(`/api/mail/accounts/${accountId}`, { enabled, confirmed: true });
  }
  deleteMailAccount(accountId: string): Observable<{ removed: number }> {
    return this.http.request<{ removed: number }>('DELETE', `/api/mail/accounts/${accountId}`, { body: { confirmation: `DELETE mail-account ${accountId}` } });
  }
  syncMailAccount(accountId: string): Observable<{ added: number; fetched: number }> {
    return this.http.post<{ added: number; fetched: number }>(`/api/mail/accounts/${accountId}/sync`, { confirmed: true, limit: 100 });
  }
  testMailAccount(accountId: string): Observable<{ status: 'connected'; mailbox: string }> {
    return this.http.post<{ status: 'connected'; mailbox: string }>(`/api/mail/accounts/${accountId}/test`, { confirmed: true });
  }
  importEml(fileName: string, base64: string): Observable<CorrelatedMail> {
    return this.http.post<CorrelatedMail>('/api/mail/import-eml', { fileName, base64, confirmed: true });
  }
  importLocalMailDrop(): Observable<{ inspected: number; added: number }> {
    return this.http.post<{ inspected: number; added: number }>('/api/mail/import-local-drop', { confirmed: true, limit: 100 });
  }
  confirmMailCorrelation(messageId: string, applicationCaseId: string): Observable<CorrelatedMail> {
    return this.http.post<CorrelatedMail>(`/api/mail/messages/${messageId}/correlation`, { applicationCaseId, confirmed: true });
  }
  applicationArtifacts(caseId: string): Observable<ArtifactRevision[]> {
    return this.http.get<ArtifactRevision[]>(`/api/application-cases/${encodeURIComponent(caseId)}/artifacts`);
  }
  finalizeApplicationCase(caseId: string, annotatedContent: string, iterationManifest: string): Observable<ApplicationPipelineFinalizeResult> {
    return this.http.post<ApplicationPipelineFinalizeResult>(`/api/application-cases/${encodeURIComponent(caseId)}/pipeline/finalize`, {
      annotatedContent, iterationManifest
    });
  }
  reviewApplicationArtifact(
    caseId: string,
    revisionId: string,
    decision: 'approved' | 'rejected',
    expectedSha256: string,
    acknowledgedLanguageIssueCount: number
  ): Observable<ArtifactRevision> {
    return this.http.post<ArtifactRevision>(`/api/application-cases/${encodeURIComponent(caseId)}/artifacts/${encodeURIComponent(revisionId)}/review`, {
      decision, expectedSha256, acknowledgedLanguageIssueCount, confirmed: true
    });
  }
  markArtifactUsed(caseId: string, revisionId: string): Observable<ArtifactRevision> {
    return this.http.post<ArtifactRevision>(`/api/application-cases/${encodeURIComponent(caseId)}/artifacts/${encodeURIComponent(revisionId)}/use`, { confirmed: true });
  }
  exportApplicationArtifact(caseId: string, revisionId: string, format: 'docx' | 'pdf'): Observable<ApplicationExportResult> {
    return this.http.post<ApplicationExportResult>(`/api/application-cases/${encodeURIComponent(caseId)}/export`, {
      revisionId, format, confirmed: true
    });
  }
  createApplicationPackage(caseId: string, revisionIds: string[]): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(`/api/application-cases/${encodeURIComponent(caseId)}/package`, { revisionIds, confirmed: true });
  }
  createSubmissionDryRun(caseId: string, revisionIds: string[]): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(`/api/application-cases/${encodeURIComponent(caseId)}/submission-dry-run`, { revisionIds, confirmed: true });
  }
  languageCheck(content: string, language = 'de-DE'): Observable<LanguageCheckResult> {
    return this.http.post<LanguageCheckResult>('/api/language-check', { content, language });
  }
  createApplicationCase(match: JobMatch, identityId: string, documentType: 'cv' | 'cover_letter' | 'email'): Observable<ApplicationCase> {
    return this.http.post<ApplicationCase>('/api/application-cases', { match, identityId, documentType });
  }
  transitionApplicationCase(caseId: string, state: string, approvedRevision?: { revisionId: string; expectedSha256: string }): Observable<ApplicationCase> {
    return this.http.post<ApplicationCase>(`/api/application-cases/${encodeURIComponent(caseId)}/transition`, {
      state,
      ...(state === 'approved' && approvedRevision
        ? { revisionId: approvedRevision.revisionId, expectedSha256: approvedRevision.expectedSha256, confirmed: true }
        : {})
    });
  }
  draft(match: JobMatch, identityId: string, documentType: 'cv' | 'cover_letter' | 'email'): Observable<ApplicationDraft> {
    return this.http.post<ApplicationDraft>('/api/applications/draft', { match, identityId, documentType });
  }

}
