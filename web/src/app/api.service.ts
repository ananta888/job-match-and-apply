import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { AgentProvider, AgentQueueSnapshot, AgentRecoveryDecision, AgentRecoveryLease, AgentRecoveryResolution, AgentRecoverySnapshot, AgentRun, AgentRunEvent, AgentRunEventsPage, AgentRunPreflight, AgentRunRequest, AgentWorkflow, AppConfig, ApplicationCase, ApplicationDraft, ArtifactRevision, CandidateMatchAnalysis, CandidateProfileSummary, CompanyCrm, CorrelatedMail, DataInventory, IdentityProfile, JobDecision, JobMatch, JobSourceCapabilities, MailAccount, McpRuntimeStatus, ProfileImportPreview, SearchProfile, SearchSchedule, SourceStatus } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  config(): Observable<AppConfig> { return this.http.get<AppConfig>('/api/config'); }
  saveConfig(config: AppConfig): Observable<AppConfig> { return this.http.put<AppConfig>('/api/config', config); }
  setMcpPortalAccess(enabled: boolean): Observable<AppConfig> {
    return this.http.put<AppConfig>('/api/config/mcp/portal-access', { enabled, confirmed: true });
  }
  sources(): Observable<SourceStatus[]> { return this.http.get<SourceStatus[]>('/api/sources'); }
  sourceRuntime(): Observable<McpRuntimeStatus> { return this.http.get<McpRuntimeStatus>('/api/sources/runtime'); }
  capabilities(): Observable<JobSourceCapabilities> { return this.http.get<JobSourceCapabilities>('/api/capabilities'); }
  createIncognito(location: string): Observable<IdentityProfile> {
    return this.http.post<IdentityProfile>('/api/identities/incognito', { location });
  }
  search(profile: SearchProfile): Observable<{ matches: JobMatch[]; partialFailures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }> }> {
    return this.http.post<{ matches: JobMatch[]; partialFailures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }> }>('/api/jobs/search', profile);
  }
  login(sourceId: string): Observable<{ status: string; note?: string }> {
    return this.http.post<{ status: string; note?: string }>(`/api/sources/${sourceId}/login`, {});
  }
  jobDecisions(): Observable<JobDecision[]> { return this.http.get<JobDecision[]>('/api/job-decisions'); }
  setJobDecision(jobId: string, state: JobDecision['state']): Observable<JobDecision> {
    return this.http.put<JobDecision>(`/api/job-decisions/${encodeURIComponent(jobId)}`, { state });
  }
  compareJobs(matches: JobMatch[]): Observable<{ comparison: Array<{ jobId: string; title: string; company: string; total: number; factors: Record<string, number> }>; disclaimer: string }> {
    return this.http.post<{ comparison: Array<{ jobId: string; title: string; company: string; total: number; factors: Record<string, number> }>; disclaimer: string }>('/api/jobs/compare', {
      matches, coverage: matches.map((item) => ({ jobId: item.job.id, direct: 0, transferable: 0, partial: 0, gaps: item.missingMustHave.length })),
      weights: { searchPreference: 1, evidenceCoverage: 1, gaps: 1, salary: 1 }
    });
  }
  dataInventory(): Observable<DataInventory> { return this.http.get<DataInventory>('/api/data/inventory'); }
  portableExport(): Observable<Record<string, unknown>> { return this.http.post<Record<string, unknown>>('/api/data/export', { includeIdentities: false, confirmed: false }); }
  schedules(): Observable<SearchSchedule[]> { return this.http.get<SearchSchedule[]>('/api/search-schedules'); }
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
  analyze(match: JobMatch, documentType: 'cv' | 'cover_letter' | 'email'): Observable<CandidateMatchAnalysis> {
    return this.http.post<CandidateMatchAnalysis>('/api/applications/analyze', { match, documentType });
  }
  validateMatch(matrix: object, documentType: 'cv' | 'cover_letter' | 'email'): Observable<{ valid: boolean; errors: string[] }> {
    return this.http.post<{ valid: boolean; errors: string[] }>('/api/applications/validate-match', { matrix, documentType });
  }
  applicationCases(): Observable<ApplicationCase[]> { return this.http.get<ApplicationCase[]>('/api/application-cases'); }
  agentProviders(refresh = false): Observable<AgentProvider[]> {
    return this.http.get<AgentProvider[]>(refresh ? '/api/agents/providers?refresh=true' : '/api/agents/providers');
  }
  agentWorkflows(): Observable<AgentWorkflow[]> { return this.http.get<AgentWorkflow[]>('/api/agents/workflows'); }
  agentQueue(): Observable<AgentQueueSnapshot> { return this.http.get<AgentQueueSnapshot>('/api/agents/queue'); }
  agentRecovery(): Observable<AgentRecoverySnapshot> { return this.http.get<AgentRecoverySnapshot>('/api/agents/recovery'); }
  agentRuns(): Observable<AgentRun[]> { return this.http.get<AgentRun[]>('/api/agent-runs'); }
  agentRunPreflight(request: AgentRunRequest): Observable<AgentRunPreflight> { return this.http.post<AgentRunPreflight>('/api/agent-runs/preflight', request); }
  createAgentRun(request: AgentRunRequest): Observable<AgentRun> { return this.http.post<AgentRun>('/api/agent-runs', request); }
  agentRun(runId: string): Observable<AgentRun> { return this.http.get<AgentRun>(`/api/agent-runs/${encodeURIComponent(runId)}`); }
  agentRunEvents(runId: string, after: number): Observable<AgentRunEventsPage> {
    return this.http.get<AgentRunEventsPage>(`/api/agent-runs/${encodeURIComponent(runId)}/events?after=${after}`);
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
  createArtifact(caseId: string, type: ArtifactRevision['type'], content: string): Observable<ArtifactRevision> {
    return this.http.post<ArtifactRevision>(`/api/application-cases/${caseId}/artifacts`, { type, content, pipelineContractVersion: '1.0.0' });
  }
  markArtifactUsed(caseId: string, revisionId: string): Observable<ArtifactRevision> {
    return this.http.post<ArtifactRevision>(`/api/application-cases/${caseId}/artifacts/${revisionId}/use`, { confirmed: true });
  }
  createApplicationCase(match: JobMatch, identityId: string, documentType: 'cv' | 'cover_letter' | 'email'): Observable<ApplicationCase> {
    return this.http.post<ApplicationCase>('/api/application-cases', { match, identityId, documentType });
  }
  transitionApplicationCase(caseId: string, state: string): Observable<ApplicationCase> {
    return this.http.post<ApplicationCase>(`/api/application-cases/${caseId}/transition`, { state });
  }
  draft(match: JobMatch, identityId: string, documentType: 'cv' | 'cover_letter' | 'email'): Observable<ApplicationDraft> {
    return this.http.post<ApplicationDraft>('/api/applications/draft', { match, identityId, documentType });
  }

  finalize(
    match: JobMatch,
    identityId: string,
    documentType: 'cv' | 'cover_letter' | 'email',
    annotatedContent: string,
    iterationManifest: string
  ): Observable<ApplicationDraft> {
    return this.http.post<ApplicationDraft>('/api/applications/finalize', {
      match, identityId, documentType, annotatedContent, iterationManifest
    });
  }
}
