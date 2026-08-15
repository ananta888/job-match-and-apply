export type Section = 'overview' | 'search' | 'identity' | 'cv' | 'sources' | 'applications' | 'crm' | 'agents' | 'operations';
export type WorkModel = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'freelance' | 'internship' | 'unknown';

export interface SearchProfile {
  name: string; query: string; regions: string[]; radiusKm: number; workModels: WorkModel[];
  employmentTypes: EmploymentType[]; mustHave: string[]; niceToHave: string[]; exclude: string[];
  minSalary?: number; sourceIds: string[];
}

export interface IdentityProfile {
  id: string; label: string; mode: 'real' | 'incognito'; fullName: string; email: string;
  phone: string; location: string; linkedin: string; placeholders: Record<string, string>;
}

export interface JobPosting {
  id: string; sourceId: string; title: string; company: string; location: string;
  workModel: WorkModel; employmentType: EmploymentType; description: string; skills: string[];
  salaryMin?: number; salaryMax?: number; url?: string; publishedAt?: string;
}

export interface JobMatch {
  job: JobPosting; searchPreferenceScore: number; accepted: boolean; matchedMustHave: string[]; missingMustHave: string[];
  matchedNiceToHave: string[]; exclusions: string[];
  scoreBreakdown: { mustHave: number; niceToHave: number; region: number; workModel: number; exclusions: number };
}

export interface SourceCapability {
  id: string; name: string; enabled: boolean; access: string; supportsLogin: boolean;
  loginRequiredForSearch: boolean; filters: string[]; pagination: boolean; policyStatus: string;
  contractVersion?: string; compatible?: boolean;
}

export interface JobSourceCapabilities {
  contract: string; contractVersion: string; compatible: boolean; tools: string[];
  errorCategories: string[]; sources: SourceCapability[];
}

export interface SourceStatus {
  id: string; name: string; kind: 'mcp' | 'profile' | 'demo'; enabled: boolean; connected: boolean;
  supportsLogin: boolean; sessionAvailable?: boolean; note: string;
}

export interface AppConfig {
  revision: number;
  searchProfile: SearchProfile; identities: IdentityProfile[]; activeIdentityId: string;
  mcp: { mode: 'demo' | 'stdio'; executionIsolation: 'trusted-host'; runtimeTarget?: 'windows' | 'wsl'; distribution?: string; command: string; args: string[]; env: Record<string, string>; configuredEnvironmentKeys?: string[] };
  assistant: { skillPath: string; candidateProfilePath: string; styleProfilePath: string };
}

export interface ApplicationDraft {
  jobId: string; identityId: string; documentType: 'cv' | 'cover_letter' | 'email'; content: string;
  strongestMatches: string[]; gaps: string[]; warnings: string[];
  lifecycle: 'preview' | 'final';
  pipelineEvidence?: ApplicationPipelineEvidence;
}

export interface ApplicationProfileSetupStatus {
  contract: 'application-profile-setup';
  contractVersion: '1.0';
  candidateProfile: 'present' | 'missing';
  styleProfile: 'present' | 'missing';
  initialized: boolean;
  containsCandidateFacts: boolean;
  note: string;
  created?: Array<'candidate-profile' | 'style-profile'>;
}

export type ApplicationStyleDocumentType = 'cv' | 'cover_letter' | 'email' | 'linkedin';
export type ApplicationStyleExampleDocumentType = ApplicationStyleDocumentType | 'interview';

export interface EditableApplicationStyleProfile {
  language: string;
  locale: string;
  tone: string;
  formality: string;
  directness: string;
  sentenceLength: string;
  technicalDepth: string;
  enthusiasm: string;
  selfPromotion: string;
  humor: string;
  vocabulary: { prefer: string[]; avoid: string[] };
  preferredPatterns: string[];
  avoidPatterns: string[];
  documentStyles: Record<ApplicationStyleDocumentType, {
    perspective: string;
    technicalDensity: string;
    maxSentenceWords: number;
  }>;
  personalizationDefault: 'conservative' | 'professional' | 'personal';
  approvedExamples: Array<{
    id: string;
    documentType: ApplicationStyleExampleDocumentType;
    text: string;
    sourceRef?: string;
    notes?: string;
  }>;
  rejectedExamples: Array<{
    id: string;
    documentType: ApplicationStyleExampleDocumentType;
    text: string;
    reason: string;
  }>;
  qualityThresholds: { maxRepeatedSentenceStarts: number; maxAvoidPatternMatches: number };
  reviewWorkflow: {
    defaultMode: 'compact' | 'standard' | 'rigorous';
    maxRevisionCycles: number;
    preferIndependentAgents: boolean;
  };
}

export interface ApplicationStyleProfileView {
  contract: 'application-style-profile';
  contractVersion: '1.0';
  revision: number;
  sha256: string;
  initialized: true;
  profile: EditableApplicationStyleProfile;
  languageBackend: { backend: 'nspell'; localOnly: true; remoteServiceAllowed: false };
}

export interface LanguageCheckIssue {
  kind?: string;
  ruleId?: string;
  word?: string;
  offset?: number;
  length?: number;
  suggestions?: string[];
  [key: string]: unknown;
}

export interface LanguageCheckResult {
  available: boolean;
  backend?: string;
  issues: LanguageCheckIssue[];
  disclosure?: string;
}

export interface McpRuntimeStatus {
  contract: 'job-search-mcp-runtime-status';
  contractVersion: '1.0';
  mode: 'demo' | 'stdio';
  state: 'demo' | 'ready_to_connect' | 'invalid';
  runtimeTarget?: 'windows' | 'wsl';
  distribution?: string;
  launchValidated: boolean;
  connected: boolean;
  note: string;
}

export interface CandidateClaim {
  id: string; statement: string; status: 'verified' | 'user_confirmed' | 'inferred' | 'unverified' | 'do_not_use';
  evidenceRefs: string[]; allowedOutputs: string[]; validFrom?: string; validTo?: string;
}
export interface CandidateProfileSummary { contractVersion: string; valid: boolean; errors: string[]; profile: Record<string, unknown>; claims: CandidateClaim[]; }
export interface CandidateMatchAnalysis { jobAnalysis: Record<string, unknown>; matchMatrix: { matches?: Array<{ competency: string; classification: 'direct_match' | 'transferable_match' | 'partial_match' | 'gap'; evidence_claim_ids: string[]; rationale: string }>; unresolved_questions?: string[] }; }
export type ApplicationCaseState = 'selected' | 'analysis' | 'questions' | 'draft' | 'review' | 'approved' | 'exported' | 'dry_run' | 'submitted' | 'closed';
export interface ApplicationCase {
  id: string; job: JobPosting; identityId: string; identityMode: 'real' | 'incognito'; documentType: 'cv' | 'cover_letter' | 'email';
  state: ApplicationCaseState; createdAt: string; updatedAt: string; revision: number;
  artifactNames: string[]; warnings: string[];
  approvedArtifactRevisionId?: string; approvedArtifactSha256?: string; approvedAt?: string;
}
export interface JobDecision { jobId: string; state: 'saved' | 'hidden' | 'neutral'; updatedAt: string }
export interface DataInventory { generatedAt: string; stores: Array<{ id: string; location: string; purpose: string; records: number | null; encryptedFields: string[] }> }
export interface SearchSchedule { id: string; name: string; enabled: boolean; intervalMinutes: number; nextRunAt: string }
export interface ProfileImportPreview {
  fileName: string; sourceKind: string; requiresUserConfirmation: boolean; persisted: boolean;
  proposals: Array<{ id: string; statement: string; status: 'unverified'; decision: 'pending'; conflict: null | { kind: 'duplicate' | 'possible_conflict'; existingClaimId: string; existingStatement: string }; source: { anchor: string; sha256: string } }>;
  warnings: string[];
}

export type CvFactCategory =
  | 'profile' | 'contact' | 'employment' | 'project' | 'education'
  | 'skill' | 'certification' | 'language' | 'additional';
export type CvFactDecision = 'pending' | 'confirmed' | 'rejected';

export interface CvFact {
  id: string;
  claimId?: string;
  category: CvFactCategory;
  recordId: string;
  field: string;
  value: string;
  decision: CvFactDecision;
  provenance: {
    sourceSha256: string;
    anchor: string;
    origin: 'imported' | 'user_supplied';
    recognition?: {
      method: 'deterministic' | 'ai_assisted';
      runId?: string;
      proposalSha256?: string;
      suggestionId?: string;
      selectedAlternativeId?: string;
      confidence?: number;
      questions?: string[];
      sourceSpan?: { lineStart: number; lineEnd: number; charStart: number; charEnd: number };
    };
  };
}

export interface CvTheme {
  template: 'classic' | 'compact' | 'modern';
  font: 'Arial' | 'Calibri' | 'Georgia' | 'Helvetica';
  accentColor: '#1f2937' | '#1d4ed8' | '#047857' | '#7c3aed';
  spacing: 'compact' | 'comfortable' | 'spacious';
  sectionOrder: Array<Exclude<CvFactCategory, 'contact'>>;
}

export interface CvImportRecord {
  contract: 'cv-import';
  contractVersion: '1.0';
  id: string;
  revision: number;
  sha256: string;
  status: 'facts_pending' | 'facts_reviewed' | 'adopted' | 'proposal_ready';
  createdAt: string;
  updatedAt: string;
  source: {
    fileName: string;
    mimeType: 'text/html' | 'application/pdf'
      | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      | 'application/vnd.oasis.opendocument.text';
    bytes: number;
    sha256: string;
    retention: 'upload_deleted_after_local_extraction';
  };
  facts: CvFact[];
  warnings: string[];
  activeRecognitionVersionId: string;
  theme?: CvTheme;
  adoption?: {
    adoptedAt: string;
    adoptedClaimIds: string[];
    adoptedRecordIds: string[];
    candidateProfileSha256: string;
    candidateProfileRevision: string;
    recognitionVersionId?: string;
    recognitionVersionSha256?: string;
  };
  proposal?: {
    applicationCaseId: string;
    jobId: string;
    createdAt: string;
    htmlSha256: string;
    documentRevisionId: string;
    documentSha256: string;
    lifecycle: 'approved_revision_preview';
    format: 'html';
    downloadAllowed: boolean;
    inputSnapshot: {
      cvImportRevision: number;
      cvImportSha256: string;
      candidateProfileSha256: string;
      candidateProfileRevision: string;
      styleProfileRevision: number;
      styleProfileSha256: string;
      themeSha256?: string;
      agentWorkflowId: 'evidence-application-package';
      sourceAgentArtifactId: string;
      pipelineContractVersion: string;
      completedStages: string[];
      agentOrchestrationRequired: false;
      recognitionVersionId?: string;
      recognitionVersionSha256?: string;
    };
  };
}

export interface CvImportSummary {
  contract: 'cv-import-summary';
  contractVersion: '1.0';
  id: string;
  revision: number;
  sha256: string;
  status: CvImportRecord['status'];
  createdAt: string;
  updatedAt: string;
  source: CvImportRecord['source'];
  factCounts: { total: number; pending: number; confirmed: number; rejected: number };
  warningCount: number;
  unresolvedConflictCount: number;
  hasTheme: boolean;
  hasAdoption: boolean;
  hasProposal: boolean;
}

export interface CvRecognitionVersionSummary {
  id: string;
  ordinal: number;
  kind: 'deterministic' | 'ai';
  label: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  factCounts: { total: number; pending: number; confirmed: number; rejected: number };
  warningCount: number;
  provider?: { id: string; version: string };
}

export interface CvRecognitionVersionList {
  contract: 'cv-recognition-version-list';
  contractVersion: '1.0';
  importId: string;
  activeVersionId: string;
  versions: CvRecognitionVersionSummary[];
}

export type CvFactOperation =
  | { factId: string; action: 'confirm' | 'reject' }
  | { factId: string; action: 'edit'; category: CvFactCategory; recordId: string; field: string; value: string }
  | ({ action: 'add'; category: CvFactCategory; field: string; value: string; explicitlyConfirmed?: true }
    & ({ recordId: string; newRecordKey?: never } | { recordId?: never; newRecordKey: string }));

export interface CvAiStructuringOptions {
  contract: 'cv-ai-structuring-options';
  contractVersion: '1.0';
  capturedAt: string;
  cvImport: { id: string; revision: number; sha256: string };
  providers: Array<{
    providerId: string;
    installations: Array<{
      runtimeTarget: 'windows' | 'wsl' | 'linux' | 'darwin';
      wslDistribution?: string;
      version?: string;
      adapterVersion?: string;
      support: 'supported' | 'untested' | 'unsupported' | 'unavailable';
      authStatus?: 'authenticated' | 'unauthenticated' | 'unknown' | 'not_required';
      ready: boolean;
      blockers: string[];
      network: {
        toolNetwork: 'disabled';
        rootMcpTools: [];
        jobSearchMcpAccessible: false;
        providerControlPlane: 'provider_managed_may_use_network';
      };
    }>;
  }>;
  disclosure: {
    required: true;
    version: '1.0';
    extractedCvTextSentToSelectedProvider: true;
    toolNetwork: 'disabled';
    rootMcpTools: [];
    jobSearchMcpAccessible: false;
    providerControlPlane: 'provider_managed_may_use_network';
  };
}

export interface CvAiSourceAnchor {
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
  quote: string;
}

export interface CvAiStructuringAlternative {
  id: string;
  value: string;
  sourceAnchor: CvAiSourceAnchor;
  confidence: number;
}

export interface CvAiStructuringSuggestion {
  id: string;
  path: string;
  collection: string;
  recordId: string | null;
  field: string;
  category: string;
  mergeable: boolean;
  sectionKind?: string;
  value: string | null;
  sourceAnchor: CvAiSourceAnchor | null;
  confidence: number;
  alternatives: CvAiStructuringAlternative[];
  questions: string[];
  status: 'unverified';
}

export type CvAiStructuringRunStatus =
  | 'queued' | 'running' | 'validating' | 'suggestions_ready' | 'cancel_requested'
  | 'cancelled' | 'applying' | 'applied' | 'failed' | 'expired';

export type CvAiStructuringMode = 'replace_with_ai_version' | 'review_suggestions';

export interface CvAiStructuringPublicRun {
  contract: 'cv-ai-structuring-run';
  contractVersion: '1.0';
  id: string;
  cvImportId: string;
  revision: number;
  sha256: string;
  status: CvAiStructuringRunStatus;
  mode?: CvAiStructuringMode;
  attempt: number;
  retryOf?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  provider: {
    id: string;
    runtimeTarget: 'windows' | 'wsl' | 'linux' | 'darwin';
    wslDistribution?: string;
    version: string;
    adapterVersion: string;
  };
  disclosure: {
    version: '1.0';
    confirmedAt: string;
    confirmedBy: { id: string; type: 'local' | 'authenticated' };
    extractedCvTextShared: true;
    providerControlPlaneNetworkAcknowledged: true;
    toolNetwork: 'disabled';
    rootMcpTools: [];
    jobSearchMcpAccessible: false;
  };
  binding: {
    cvImportRevision: number;
    cvImportSha256: string;
    sourceId: string;
    sourceSha256: string;
    extractedTextSha256: string;
    baseProposalSha256: string;
    lineManifestSha256: string;
    promptTemplateVersion: 'cv-ai-structuring/1.0';
    promptSha256: string;
    outputContractVersion: '1.0';
    outputSchemaSha256: string;
    inputSha256: string;
  };
  proposal?: { sha256: string; outputSha256: string; suggestions: CvAiStructuringSuggestion[] };
  result?: {
    cvImportRevision: number;
    cvImportSha256: string;
    stagedFactIds: string[];
    factsRemainPending: true;
    recognitionVersionId?: string;
    recognitionVersionCount?: number;
  };
  failure?: { code: string; stage: 'preflight' | 'agent' | 'validation' | 'retention' | 'apply'; retryable: boolean };
  auditTrail: Array<{
    sequence: number;
    occurredAt: string;
    action: 'started' | 'provider_completed' | 'validated' | 'cancel_requested' | 'cancelled'
      | 'retried' | 'apply_started' | 'applied' | 'failed' | 'expired';
    actorId?: string;
    correlationId?: string;
    detailSha256?: string;
  }>;
}

export interface CvAiProviderSelection {
  providerId: string;
  runtimeTarget: 'windows' | 'wsl' | 'linux' | 'darwin';
  wslDistribution?: string;
  expectedVersion: string;
}

export interface CvAiStructuringSelection {
  suggestionId: string;
  alternativeId: string | null;
}

export interface ArtifactRevision {
  id: string; applicationCaseId: string; companyKey: string; jobId: string;
  type: 'cv' | 'cover_letter' | 'application_email'; lifecycle: 'proposed' | 'approved' | 'rejected' | 'used' | 'superseded';
  sha256: string; bytes: number; artifactPath: string; pipelineContractVersion: string;
  pipelineProof?: ApplicationPipelineProof;
  review?: {
    decision: 'approved' | 'rejected'; reviewer: 'local-user'; reviewedAt: string;
    expectedSha256: string; acknowledgedLanguageIssueCount: number;
  };
  createdAt: string; usedAt?: string; usedForApplicationCaseId?: string;
}

export interface ApplicationPipelineEvidence {
  pipelineContractVersion: string;
  completedStages: string[];
  annotatedSha256: string;
  iterationManifestSha256: string;
  candidateProfileSha256: string;
  styleProfileSha256: string;
  artifactSha256: string;
  languageCheck: {
    available: boolean; backend: string; language: string; issueCount: number;
    issuesSha256: string; checkedArtifactSha256: string;
  };
  preparation?: {
    jobAnalysisSha256: string; matchMatrixSha256: string; unresolvedQuestionsSha256: string; matchMatrixValid: true;
  };
}

export interface ApplicationPipelineProof extends ApplicationPipelineEvidence {
  contract: 'application-pipeline-proof';
  contractVersion: '1.0';
  applicationCaseId: string;
  jobId: string;
  identityId: string;
  documentType: ArtifactRevision['type'];
  issuedAt: string;
  signature: string;
}

export interface ApplicationPipelineFinalizeResult { draft: ApplicationDraft; revision: ArtifactRevision; }
export interface ApplicationExportResult {
  fileName: string; mimeType: string; bytes: number; base64: string; revision: number;
  artifactRevisionId: string; artifactSha256: string;
  quality: { valid: boolean; warnings: string[]; [key: string]: unknown };
}
export interface CorrelatedMail {
  id: string; accountId: string; from: string[]; to: string[]; subject: string; sentAt: string; text: string;
  source: 'imap' | 'eml' | 'local_smtp'; responseKind: 'acknowledgement' | 'question' | 'interview' | 'rejection' | 'offer' | 'other';
  calendarEvents: Array<{ title: string; start?: string; end?: string; location?: string }>;
  correlation: { applicationCaseId?: string; companyKey?: string; confidence: number; reasons: string[]; confirmed: boolean };
}
export interface MailAccount {
  id: string; label: string; email: string; host: string; port: number; secure: boolean; username: string;
  enabled: boolean; mailbox: string; lastUid?: number; createdAt: string; updatedAt: string;
}
export interface CompanyCrm {
  key: string; name: string; unassignedMessages: CorrelatedMail[];
  applications: Array<ApplicationCase & { tracking: Array<{ id: string; status: string; occurredAt: string; note?: string }>; messages: CorrelatedMail[]; artifacts: ArtifactRevision[] }>;
}

export type AgentWorkspaceMode = 'read_only' | 'workspace_write';
export type AgentRuntimeTarget = 'windows' | 'wsl' | 'linux' | 'darwin';
export type AgentRunStatus =
  | 'queued' | 'starting' | 'running' | 'waiting_for_input' | 'waiting_for_approval'
  | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'timed_out' | 'orphaned' | 'recovering';

export interface AgentProviderInstallation {
  runtimeTarget: AgentRuntimeTarget;
  distribution?: string;
  version?: string;
  adapterVersion?: string;
  support: 'supported' | 'untested' | 'unsupported' | 'unavailable';
  authStatus?: 'authenticated' | 'unauthenticated' | 'unknown' | 'not_required';
  note?: string;
  executable?: string;
}

export interface AgentProvider {
  id: string;
  name: string;
  available: boolean;
  version?: string;
  authStatus?: 'authenticated' | 'unauthenticated' | 'unknown' | 'not_required';
  note?: string;
  transport?: string;
  experimental?: boolean;
  fallbackProviderId?: string;
  installations?: AgentProviderInstallation[];
  capabilities?: string[] | {
    interactiveInput?: boolean;
    approvals?: boolean;
    networkControl?: boolean;
    workspaceModes?: AgentWorkspaceMode[];
  };
}

export interface AgentProviderConfigProfile {
  provider: string;
  enabled: boolean;
  runtimeTarget: AgentRuntimeTarget;
  wslDistribution?: string;
  sandbox: 'read-only' | 'workspace-write';
  network: 'disabled' | 'restricted';
  approvalMode: 'deny' | 'explicit';
  model?: string;
}

export interface AgentConfigProfile {
  schemaVersion: 2;
  profileId: string;
  updatedAt: string;
  providers: AgentProviderConfigProfile[];
  budgets: {
    warningAtPercent: number;
    maxTotalTokens?: number;
    maxToolCalls?: number;
    maxRunDurationMs?: number;
    maxCostMicros?: { amountMicros: number; currency: string };
  };
  features: {
    codexAppServerExperimental: boolean;
    multiAgentExperimental: boolean;
    realtimeWebSocketExperimental: boolean;
    rawProviderLogs: boolean;
  };
}

export interface AgentConfigProfileView {
  profile: AgentConfigProfile;
  source: 'primary' | 'last_known_good';
  migratedFrom?: 1;
  primaryError?: string;
}

export interface AgentRunRequest {
  providerId: string;
  prompt: string;
  runtimeTarget: AgentRuntimeTarget;
  wslDistribution?: string;
  workspaceMode: AgentWorkspaceMode;
  network: boolean;
  applicationCaseId?: string;
  parentRunId?: string;
  workflowId?: 'guided-job-analysis' | 'evidence-application-package' | 'employer-response-triage' | 'application-next-actions';
  budget: { wallTimeMinutes: number; maxOutputMiB: number };
}

export interface AgentWorkflow {
  id: NonNullable<AgentRunRequest['workflowId']>;
  version: string;
  title: string;
  description: string;
  requiredScope: 'search_profile' | 'application_case' | 'company';
  producesSuggestionsOnly: true;
  prohibitedActions: string[];
}

export interface AgentRunPreflightNotice {
  code: string;
  field?: string;
  message: string;
}

export interface AgentRunPreflight {
  contract: 'agent-run-preflight';
  contractVersion: '1.0';
  capturedAt: string;
  ready: boolean;
  blockers: AgentRunPreflightNotice[];
  warnings: AgentRunPreflightNotice[];
  provider: {
    id: string;
    name: string;
    available: boolean;
    installation?: {
      runtimeTarget: AgentRuntimeTarget;
      distribution?: string;
      version?: string;
      adapterVersion?: string;
      support: AgentProviderInstallation['support'];
      authStatus?: AgentProviderInstallation['authStatus'];
    };
    source: 'server_discovery';
  };
  runtime: { runtimeTarget: AgentRuntimeTarget; distribution?: string; supported: boolean };
  workspace: { ownership: 'server'; mode: AgentWorkspaceMode; supported: boolean; pathDisclosed: false };
  workflow?: Pick<AgentWorkflow, 'id' | 'version' | 'title' | 'requiredScope' | 'producesSuggestionsOnly' | 'prohibitedActions'>;
  data: {
    declaredScope: 'workspace' | AgentWorkflow['requiredScope'];
    selectedApplicationCaseCount: 0 | 1;
    categories: Array<{
      kind: 'search_preference' | 'job' | 'application_case' | 'candidate_claim' | 'mail' | 'company' | 'tracking_event';
      availability: 'included' | 'conditional' | 'unknown_until_start' | 'not_wired';
      trust: 'local' | 'untrusted';
      maxItems?: number;
    }>;
    exactSourceCount: number | null;
    maxContextCharacters: number;
    actualManifestAvailableAfterStart: true;
  };
  tools: {
    policy: 'deny_by_default';
    allowedRootMcpTools: string[];
    allowlistComplete: boolean;
    providerTooling: 'server_owned_dynamic_tools' | 'prompt_context_only';
    providerToolNamesExposed: boolean;
    prohibitedActions: string[];
  };
  network: {
    requested: boolean;
    effective: 'disabled';
    enforced: boolean;
    trustedHostServices: Array<{
      id: string;
      executionIsolation: 'trusted-host';
      agentAccessible: false;
      invocation: 'root_before_agent';
    }>;
  };
  limits: {
    requested: AgentRunRequest['budget'];
    effective: {
      wallTimeMs: number;
      idleTimeMs: number;
      totalOutputBytes: number;
      stdoutBytes: number;
      stderrBytes: number;
      maxInputBytes: number;
    };
  };
  scheduling?: {
    queueDepth: number;
    active: number;
    limits: AgentQueueLimits;
  };
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  cost?: number;
  currency?: string;
}

export interface AgentApproval {
  id: string;
  kind: string;
  title?: string;
  description?: string;
  risk?: 'low' | 'medium' | 'high' | 'critical' | string;
  requestedAt?: string;
  expiresAt?: string;
  target?: string;
  diff?: string;
  expectedRevision?: number;
  status?: 'pending' | 'approved' | 'denied' | 'expired';
  decision?: 'approve' | 'deny';
  summary?: string;
}

export interface AgentRunEvent {
  sequence: number;
  type: string;
  timestamp: string;
  correlationId?: string;
  message?: string;
  level?: 'debug' | 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  providerId: string;
  status: AgentRunStatus;
  request: AgentRunRequest;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  usage?: AgentUsage;
  pendingApprovals?: AgentApproval[];
  output?: string;
  error?: string;
  lastEventSequence?: number;
  parentRunId?: string;
  /** Optional immutable provenance fields. Older server contracts omit them; the UI labels that gap explicitly. */
  providerVersion?: string;
  workflowVersion?: string;
  policyVersion?: string;
  contextSummary?: { scope?: string; sourceCount?: number; redactedHash?: string };
}

export interface AgentRunEventsPage {
  events: AgentRunEvent[];
  nextAfter: number;
}

export interface AgentArtifactProvenance {
  runId: string; provider: string; providerVersion: string; adapterVersion: string;
  templateId: string; templateVersion: string; workflowId?: string; workflowVersion?: string;
  applicationCaseId?: string; applicationCaseRevision?: number; jobId?: string; companyKey?: string;
  mailId?: string; documentRevisionId?: string; workspaceRootId?: string;
  identityMode: 'none' | 'real' | 'incognito'; claimIds?: string[]; reviewIds?: string[];
}

export interface AgentArtifactRecord {
  schemaVersion: 1; id: string; kind: string; sha256: string; bytes: number; mediaType: string;
  createdAt: string; updatedAt: string; revision: number;
  lifecycle: 'proposed' | 'approved' | 'used' | 'rejected';
  relativePath?: string; provenance: AgentArtifactProvenance;
  review?: { decision: 'approved' | 'rejected'; actor: string; occurredAt: string };
  adoption?: { sourceReference: string; occurredAt: string };
  contentState?: 'available' | 'deleted'; contentDeletedAt?: string;
}

export interface AgentArtifactContent {
  id: string; sha256: string; mediaType: string; content: string;
}

export interface AgentArtifactAdoptionResult {
  artifact: AgentArtifactRecord;
  documentRevisionId: string;
}

export interface EmployerResponseTriageProposalProjection {
  contract: 'employer-response-triage-proposal'; contractVersion: '1.0'; sha256: string;
  proposal: {
    schemaVersion: 1; classification: 'interview' | 'rejection' | 'request' | 'info' | 'offer' | 'other'; confidence: number;
    selectedMailId: string; sourceReferences: string[];
    caseCandidates: Array<{ caseId: string; confidence: number; reason: string; sourceReferences: string[] }>;
    appointment?: { start: string; end: string; timeZone: string; location: string; sourceReferences: string[] };
    followUp?: { dueAt: string; timeZone: string; reason: string; sourceReferences: string[] };
    replyDraft?: { subject: string; body: string; language: 'de' | 'en'; sourceReferences: string[] };
  };
}

export interface ApplicationNextActionsProposalProjection {
  contract: 'application-next-actions-proposal'; contractVersion: '1.0'; sha256: string;
  proposal: {
    schemaVersion: 1; companyKey: string;
    suggestions: Array<{
      id: string; applicationCaseId: string; kind: 'follow_up' | 'status_review' | 'document_review' | 'duplicate_warning' | 'deadline';
      title: string; reason: string; confidence: number; sourceReferences: string[]; dueAt?: string;
    }>;
    conflicts: Array<{
      id: string; kind: 'duplicate_application' | 'status_disagreement' | 'timeline_overlap' | 'document_disagreement' | 'deadline_collision';
      applicationCaseIds: string[]; reason: string; sourceReferences: string[];
    }>;
  };
}

export type AgentOrchestrationStatus = 'queued' | 'running' | 'waiting_for_gate' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'orphaned';
export type AgentOrchestrationGate = 'user_input' | 'approval' | 'evidence_complete' | 'review_complete';
export type AgentOrchestrationNodeStatus = 'pending' | 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'cancelled' | 'policy_blocked' | 'skipped' | 'orphaned';

export interface AgentOrchestrationArtifactReference {
  outputRef: string; artifactId: string; runId: string; sha256: string; lifecycle: 'proposed';
}

export type AgentOrchestrationConflictStrategy = 'accept_complementary' | 'select_variant';

export interface AgentOrchestrationConflictVariant {
  sourceNodeId: string; sourceRole: string; outputRef: string; runId: string; artifactId: string; sha256: string;
}

export interface AgentOrchestrationConflictResolution {
  strategy: AgentOrchestrationConflictStrategy; resolverId: string; resolutionReference: string;
  selectedArtifactId?: string; resolvedAt: string; resolvedAgainstRevision: number; variantsSha256: string;
}

export interface AgentOrchestrationConflict {
  id: string; targetNodeId: string; kind: 'ats_style_fan_in'; status: 'equivalent' | 'unresolved' | 'resolved';
  requiresDomainResolution: boolean; variantsSha256: string; variants: AgentOrchestrationConflictVariant[];
  resolution?: AgentOrchestrationConflictResolution;
}

export interface AgentOrchestrationRecord {
  schemaVersion: 1; id: string; revision: number; workflowId: AgentWorkflow['id']; workflowVersion: string; providerId: string;
  status: AgentOrchestrationStatus; producesSuggestionsOnly: true; promptSha256: string; redactedSummary: string;
  scope: {
    applicationCaseId?: string; applicationCaseRevision?: number; jobId?: string; companyKey?: string; mailId?: string;
    documentRevisionId?: string; workspaceRootId?: string; identityMode: 'none' | 'real' | 'incognito';
  };
  resolvedGates: Array<{ nodeId: string; gate: AgentOrchestrationGate; authority: 'server_evidence' | 'server_revision_confirmation'; bindingSha256: string }>;
  unresolvedGates: Array<{ nodeId: string; gate: AgentOrchestrationGate }>;
  conflicts?: AgentOrchestrationConflict[];
  nodes: Array<{
    nodeId: string; role: string; dependsOn: string[]; status: AgentOrchestrationNodeStatus; attempts: number; runIds: string[];
    inputDigests: Record<string, string>; artifacts: AgentOrchestrationArtifactReference[]; failureCategory?: string; reason?: string;
  }>;
  nodeRunIds: Record<string, string[]>; artifactRefs: AgentOrchestrationArtifactReference[];
  budget: { wallTimeMs: number; tokens: number; costMicros: number; toolCalls: number; iterations: number };
  createdAt: string; updatedAt: string; finishedAt?: string; failureReason?: string;
  recovery?: { recoveredAt: string; processAdoptionAllowed: false; reason: 'server_restart_no_pid_adoption' };
}

export interface AgentOrchestrationConfirmationInput {
  review?: { documentRevisionId: string; expectedSha256: string; confirmed: true };
  userInput?: { confirmed: true };
}

export interface AgentOrchestrationConflictResolutionRequest {
  expectedRevision: number; variantsSha256: string; strategy: AgentOrchestrationConflictStrategy;
  selectedArtifactId?: string; confirmed: true;
}

export interface AgentOrchestrationCreateRequest {
  workflowId: AgentWorkflow['id']; providerId: string; prompt: string; runtimeTarget: AgentRuntimeTarget; wslDistribution?: string;
  applicationCaseId?: string; mailId?: string; documentRevisionId?: string;
}

export type AgentQueueBlockReason = 'global_limit' | 'provider_limit' | 'workspace_limit' | 'owner_limit';

export interface AgentQueueLimits {
  global: number;
  perProvider: number;
  perWorkspace?: number;
  perOwner?: number;
  queuedGlobal?: number;
  queuedPerWorkspace?: number;
  queuedPerOwner?: number;
}

export interface AgentQueueEntry {
  runId: string;
  provider: string;
  workspaceRoot: string;
  ownerId?: string;
  position: number;
  basePriority: number;
  effectivePriority: number;
  waitMs: number;
  blockedBy: AgentQueueBlockReason[];
}

export interface AgentQueueSnapshot {
  capturedAt: string;
  depth: number;
  active: number;
  limits: AgentQueueLimits;
  activeByProvider: Record<string, number>;
  activeByWorkspace: Record<string, number>;
  activeByOwner: Record<string, number>;
  queue: AgentQueueEntry[];
}

export type AgentRecoveryDecision = 'cleanup' | 'resume';

export interface AgentRecoveryLeaseView {
  runId: string;
  operatorId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AgentRecoveryLease extends AgentRecoveryLeaseView {
  leaseId: string;
}

export interface AgentRecoveryRun {
  runId: string;
  state: AgentRunStatus;
  provider: string;
  providerSessionPresent: boolean;
  processAdoptionAllowed: false;
  allowedDecisions: AgentRecoveryDecision[];
  lease?: AgentRecoveryLeaseView;
}

export interface AgentRecoverySnapshot { runs: AgentRecoveryRun[]; }

export interface AgentRecoveryResolution {
  resolved: AgentRun;
  replacement?: AgentRun;
}
