export type WorkModel = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'freelance' | 'internship' | 'unknown';

export interface SearchProfile {
  name: string;
  query: string;
  regions: string[];
  radiusKm: number;
  workModels: WorkModel[];
  employmentTypes: EmploymentType[];
  mustHave: string[];
  niceToHave: string[];
  exclude: string[];
  minSalary?: number;
  sourceIds: string[];
}

export interface IdentityProfile {
  id: string;
  label: string;
  mode: 'real' | 'incognito';
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  placeholders: Record<string, string>;
}

export interface JobPosting {
  id: string;
  sourceId: string;
  title: string;
  company: string;
  location: string;
  workModel: WorkModel;
  employmentType: EmploymentType;
  description: string;
  skills: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  language?: string;
  url?: string;
  publishedAt?: string;
  fetchedAt?: string;
  sourceReferences?: SourceReference[];
  normalizationWarnings?: string[];
  fieldProvenance?: Record<string, { sourceId: string; externalId: string; strategy: string }>;
  mergeHistory?: Array<{ mergedAt: string; sourceIds: string[]; strategy: string }>;
}

export interface SourceReference {
  sourceId: string;
  externalId: string;
  url?: string;
  fetchedAt: string;
}

export interface SourceCapability {
  id: string;
  name: string;
  enabled: boolean;
  access: string;
  supportsLogin: boolean;
  loginRequiredForSearch: boolean;
  filters: string[];
  pagination: boolean;
  policyStatus: string;
  contractVersion?: string;
  compatible?: boolean;
}

export interface JobSourceCapabilities {
  contract: 'job-search-mcp';
  contractVersion: string;
  compatible: boolean;
  tools: string[];
  errorCategories: string[];
  sources: SourceCapability[];
}

export interface SearchPreferenceMatch {
  job: JobPosting;
  searchPreferenceScore: number;
  accepted: boolean;
  matchedMustHave: string[];
  missingMustHave: string[];
  matchedNiceToHave: string[];
  exclusions: string[];
  scoreBreakdown: {
    mustHave: number;
    niceToHave: number;
    region: number;
    workModel: number;
    exclusions: number;
  };
}

export interface SearchRun {
  id: string;
  createdAt: string;
  profile: SearchProfile;
  sourceIds: string[];
  matches: SearchPreferenceMatch[];
  partialFailures?: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }>;
}

export type ApplicationCaseState = 'selected' | 'analysis' | 'questions' | 'draft' | 'review' | 'approved' | 'exported' | 'dry_run' | 'submitted' | 'closed';

export interface ApplicationCase {
  id: string;
  job: JobPosting;
  identityId: string;
  identityMode: 'real' | 'incognito';
  documentType: 'cv' | 'cover_letter' | 'email';
  state: ApplicationCaseState;
  createdAt: string;
  updatedAt: string;
  artifactNames: string[];
  warnings: string[];
  revision: number;
  /** Exact human-approved, pipeline-verified document binding for use/export. */
  approvedArtifactRevisionId?: string;
  approvedArtifactSha256?: string;
  approvedAt?: string;
}

export interface ApplicationStatusEvent {
  id: string; applicationCaseId: string; from: ApplicationCaseState | null; to: ApplicationCaseState;
  occurredAt: string; source: 'user' | 'system' | 'portal'; note?: string;
}

export type ApplicationTrackingStatus = 'planned' | 'approved' | 'manually_submitted' | 'confirmed' | 'interview' | 'rejected' | 'withdrawn' | 'completed';
export interface ApplicationTrackingEvent {
  id: string; applicationCaseId: string; status: ApplicationTrackingStatus; occurredAt: string;
  source: 'user' | 'portal'; sourceReference?: string; correctionOf?: string; note?: string;
}

export interface ApplicationPackageManifest {
  applicationCaseId: string; jobId: string; identityId: string; approvedRevision: number;
  createdAt: string; files: Array<{ name: string; sha256: string; bytes: number }>;
  warnings: string[]; approved: boolean;
}

export interface SearchSchedule {
  id: string; name: string; enabled: boolean; profile: SearchProfile; intervalMinutes: number;
  quietHours: { start: number; end: number; timeZone: string };
  nextRunAt: string; lastSeenJobIds: string[]; updatedAt: string;
}

export interface FollowUpReminder {
  id: string; applicationCaseId: string; dueAt: string; timeZone: string; note: string;
  completed: boolean; createdAt: string;
}

export interface JobDecision {
  jobId: string; state: 'saved' | 'hidden' | 'neutral'; updatedAt: string;
}

export interface ComparisonNote {
  id: string; jobIds: string[]; note: string;
  weights: { searchPreference: number; evidenceCoverage: number; gaps: number; salary: number };
  createdAt: string; updatedAt: string;
}

export interface ApplicationArtifactRevision {
  id: string; applicationCaseId: string; companyKey: string; jobId: string;
  type: 'cv' | 'cover_letter' | 'application_email'; lifecycle: 'proposed' | 'approved' | 'rejected' | 'used' | 'superseded';
  sha256: string; bytes: number; artifactPath: string; pipelineContractVersion: string;
  pipelineProof?: ApplicationPipelineProof;
  /** Immutable link back to an explicitly reviewed AgentArtifact proposal. */
  sourceAgentArtifactId?: string;
  adoptionIdempotencyKeySha256?: string;
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
  /** New proofs bind the deterministic job-analysis/match/question preparation. Legacy signed proofs may omit this field. */
  preparation?: {
    jobAnalysisSha256: string;
    matchMatrixSha256: string;
    unresolvedQuestionsSha256: string;
    matchMatrixValid: true;
  };
  languageCheck: {
    available: boolean;
    backend: string;
    language: string;
    issueCount: number;
    issuesSha256: string;
    checkedArtifactSha256: string;
  };
}

export interface ApplicationPipelineProof extends ApplicationPipelineEvidence {
  contract: 'application-pipeline-proof';
  contractVersion: '1.0';
  applicationCaseId: string;
  jobId: string;
  identityId: string;
  documentType: ApplicationArtifactRevision['type'];
  issuedAt: string;
  signature: string;
}

export type EmployerResponseKind = 'acknowledgement' | 'question' | 'interview' | 'rejection' | 'offer' | 'other';
export interface MailAccount {
  id: string; label: string; email: string; host: string; port: number; secure: boolean;
  username: string; enabled: boolean; mailbox: string; lastUid?: number; createdAt: string; updatedAt: string;
}
export interface CorrelatedMailMessage {
  id: string; accountId: string; messageId?: string; from: string[]; to: string[]; subject: string;
  sentAt: string; text: string; inReplyTo?: string; references: string[]; source: 'imap' | 'eml' | 'local_smtp';
  responseKind: EmployerResponseKind; calendarEvents: Array<{ uid?: string; title: string; start?: string; end?: string; location?: string }>;
  correlation: { applicationCaseId?: string; companyKey?: string; confidence: number; reasons: string[]; confirmed: boolean };
  importedAt: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  kind: 'mcp' | 'profile' | 'demo';
  enabled: boolean;
  connected: boolean;
  supportsLogin: boolean;
  sessionAvailable?: boolean;
  note: string;
}

export interface AppConfig {
  searchProfile: SearchProfile;
  identities: IdentityProfile[];
  activeIdentityId: string;
  mcp: {
    mode: 'demo' | 'stdio';
    /** Portal/browser integration must run as a trusted host process, never in an agent sandbox. */
    executionIsolation: 'trusted-host';
    /** Bound to the versioned private launch contract when setup has selected a runtime. */
    runtimeTarget?: 'windows' | 'wsl';
    distribution?: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    /** Read-only response metadata; ignored by the persisted launch contract. */
    configuredEnvironmentKeys?: string[];
  };
  assistant: {
    skillPath: string;
    candidateProfilePath: string;
    styleProfilePath: string;
  };
}

export interface ApplicationDraft {
  jobId: string;
  identityId: string;
  documentType: 'cv' | 'cover_letter' | 'email';
  content: string;
  strongestMatches: string[];
  gaps: string[];
  warnings: string[];
  lifecycle: 'preview' | 'final';
  pipelineEvidence?: ApplicationPipelineEvidence;
}

export interface ApplicationPipelineCapabilities {
  contract: 'bewerbungs-pipeline';
  contractVersion: string;
  compatible: boolean;
  stages: string[];
  documentTypes: string[];
  blockingSeverities: string[];
  publishableClaimStatuses: string[];
  networkRequired: boolean;
}

export interface CandidateMatchAnalysis {
  jobAnalysis: Record<string, unknown>;
  matchMatrix: Record<string, unknown>;
}
