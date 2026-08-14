export type Section = 'overview' | 'search' | 'identity' | 'sources' | 'applications' | 'crm' | 'agents' | 'operations';
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
  searchProfile: SearchProfile; identities: IdentityProfile[]; activeIdentityId: string;
  mcp: { mode: 'demo' | 'stdio'; executionIsolation: 'trusted-host'; runtimeTarget?: 'windows' | 'wsl'; distribution?: string; command: string; args: string[]; env: Record<string, string>; configuredEnvironmentKeys?: string[] };
  assistant: { skillPath: string; candidateProfilePath: string; styleProfilePath: string };
}

export interface ApplicationDraft {
  jobId: string; identityId: string; documentType: 'cv' | 'cover_letter' | 'email'; content: string;
  strongestMatches: string[]; gaps: string[]; warnings: string[];
  lifecycle: 'preview' | 'final';
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
export interface CandidateMatchAnalysis { jobAnalysis: Record<string, unknown>; matchMatrix: { matches?: Array<{ competency: string; classification: 'direct_match' | 'transferable_match' | 'partial_match' | 'gap'; evidence_claim_ids: string[]; rationale: string }> }; }
export interface ApplicationCase {
  id: string; job: JobPosting; identityId: string; identityMode: 'real' | 'incognito'; documentType: 'cv' | 'cover_letter' | 'email';
  state: string; createdAt: string; updatedAt: string; revision: number;
}
export interface JobDecision { jobId: string; state: 'saved' | 'hidden' | 'neutral'; updatedAt: string }
export interface DataInventory { generatedAt: string; stores: Array<{ id: string; location: string; purpose: string; records: number | null; encryptedFields: string[] }> }
export interface SearchSchedule { id: string; name: string; enabled: boolean; intervalMinutes: number; nextRunAt: string }
export interface ProfileImportPreview {
  fileName: string; sourceKind: string; requiresUserConfirmation: boolean; persisted: boolean;
  proposals: Array<{ id: string; statement: string; status: 'unverified'; decision: 'pending'; conflict: null | { kind: 'duplicate' | 'possible_conflict'; existingClaimId: string; existingStatement: string }; source: { anchor: string; sha256: string } }>;
  warnings: string[];
}

export interface ArtifactRevision {
  id: string; applicationCaseId: string; companyKey: string; jobId: string;
  type: 'cv' | 'cover_letter' | 'application_email'; lifecycle: 'proposed' | 'approved' | 'used' | 'superseded';
  sha256: string; bytes: number; artifactPath: string; pipelineContractVersion: string;
  createdAt: string; usedAt?: string; usedForApplicationCaseId?: string;
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
    providerTooling: 'sandbox_managed';
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
