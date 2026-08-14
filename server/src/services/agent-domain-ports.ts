import { createHash } from 'node:crypto';
import type { ApplicationCaseState, AppConfig, FollowUpReminder, IdentityProfile, JobSourceCapabilities, SearchProfile } from '../domain/models.js';
import { LocalApplicationAssistantAdapter } from '../adapters/local-application-assistant.js';
import { assertTrustedHostMcpLaunch, McpJobSourceAdapter } from '../adapters/mcp-job-source.js';
import { canonicalJson } from '../agents/security-approval.js';
import type {
  ApplicationPipelineProxy,
  ApplicationReadPort,
  ConfirmedDomainCommand,
  DomainCommandPreview,
  DomainCommandPort,
  DomainProposalPort,
  JobReadPort,
  JobSearchProxy,
  MinimizedJob,
  MessageReadPort,
  PreparedDomainCommand,
  StoredProposal
} from '../agents/security-mcp-facade.js';
import type { JobSourcePort } from '../ports/job-source.js';
import type { ConfigStore } from './config-store.js';
import { transitionApplicationCase } from './application-case.js';
import type { EncryptedMailVault } from './mail-vault.js';
import { companyKey } from './mail-correlation.js';
import type { WorkspaceStore } from './workspace-store.js';

const statusValues = new Set<ApplicationCaseState>([
  'selected', 'analysis', 'questions', 'draft', 'review', 'approved', 'exported', 'dry_run', 'submitted', 'closed'
]);
const sourceId = (scheme: string, value: string): string =>
  `${scheme}:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_domain_payload_invalid');
  return value as Record<string, unknown>;
}

function valueString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result.trim()) throw new Error(`mcp_domain_payload_invalid:${key}`);
  return result;
}

function maskedIdentity(identity: IdentityProfile): IdentityProfile {
  if (identity.mode === 'incognito') return identity;
  return {
    id: `masked-${identity.id}`,
    label: 'Maskierte Agentenvorschau',
    mode: 'incognito',
    fullName: '{{VOLLSTAENDIGER_NAME}}',
    email: '{{E_MAIL}}',
    phone: '{{TELEFON}}',
    location: '{{ORT}}',
    linkedin: '{{PROFIL_URL}}',
    placeholders: {
      '{{VOLLSTAENDIGER_NAME}}': '{{VOLLSTAENDIGER_NAME}}',
      '{{E_MAIL}}': '{{E_MAIL}}',
      '{{TELEFON}}': '{{TELEFON}}',
      '{{ORT}}': '{{ORT}}',
      '{{PROFIL_URL}}': '{{PROFIL_URL}}'
    }
  };
}

export class WorkspaceAgentJobReadPort implements JobReadPort {
  constructor(private readonly workspace: WorkspaceStore) {}
  async search(input: { profileId: string; page: number; pageSize: number }) {
    const runs = await this.workspace.listSearchRuns();
    const run = input.profileId === 'active'
      ? runs[0]
      : runs.find((candidate) => candidate.id === input.profileId || candidate.profile.name === input.profileId);
    const all = run?.matches.map((match) => ({
      id: match.job.id,
      title: match.job.title,
      company: match.job.company,
      location: match.job.location,
      sourceId: match.job.sourceId,
      sourceReference: sourceId('job', `${match.job.sourceId}:${match.job.id}`),
      version: match.job.fetchedAt ?? run.createdAt
    })) ?? [];
    const start = input.page * input.pageSize;
    return {
      items: all.slice(start, start + input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      hasMore: start + input.pageSize < all.length
    };
  }
}

type TrustedHostJobSource = Pick<JobSourcePort, 'capabilities' | 'searchDetailed'>;
type TrustedHostJobSourceFactory = (settings: AppConfig['mcp']) => TrustedHostJobSource;

interface TrustedHostSearchSnapshot {
  profileHash: string;
  createdAt: number;
  snapshotReference: string;
  jobs: MinimizedJob[];
  failures: Array<{ sourceId: string; category: string; retryable: boolean }>;
}

const jobSearchRunIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const jobSearchSourceIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function checkedRunId(value: unknown): string {
  if (typeof value !== 'string' || !jobSearchRunIdPattern.test(value)) throw new Error('mcp_job_search_run_scope_invalid');
  return value;
}

function checkedText(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`mcp_job_search_upstream_invalid:${code}`);
  }
  return value;
}

function checkedSourceId(value: unknown): string {
  const source = checkedText(value, 'source_id', 64).toLowerCase();
  if (!jobSearchSourceIdPattern.test(source)) throw new Error('mcp_job_search_upstream_invalid:source_id');
  return source;
}

function searchArguments(value: unknown): { profileId: 'active'; page: number; pageSize: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_job_search_arguments_invalid');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['profileId', 'page', 'pageSize'].includes(key)) || input.profileId !== 'active'
    || !Number.isSafeInteger(input.page) || (input.page as number) < 0 || (input.page as number) > 99
    || !Number.isSafeInteger(input.pageSize) || (input.pageSize as number) < 1 || (input.pageSize as number) > 50) {
    throw new Error('mcp_job_search_arguments_invalid');
  }
  return { profileId: 'active', page: input.page as number, pageSize: input.pageSize as number };
}

function profileFingerprint(profile: SearchProfile): string {
  return createHash('sha256').update(JSON.stringify({
    query: profile.query, regions: profile.regions, radiusKm: profile.radiusKm,
    workModels: profile.workModels, employmentTypes: profile.employmentTypes,
    mustHave: profile.mustHave, niceToHave: profile.niceToHave, exclude: profile.exclude,
    minSalary: profile.minSalary ?? null, sourceIds: profile.sourceIds,
  }), 'utf8').digest('hex');
}

/**
 * Root-owned adapter for the only agent-visible Job-Search-MCP operations.
 * It launches through McpJobSourceAdapter's validated trusted-host stdio path;
 * no provider sandbox, raw MCP tool name, credential, login or session method
 * is accepted at this boundary.
 */
export class TrustedHostAgentJobSearchProxy implements JobSearchProxy {
  private readonly snapshots = new Map<string, TrustedHostSearchSnapshot>();

  constructor(
    private readonly config: ConfigStore,
    private readonly sourceFactory: TrustedHostJobSourceFactory = (settings) => new McpJobSourceAdapter(settings),
    private readonly now: () => number = Date.now,
  ) {}

  async capabilities(input: { runId: string }): Promise<unknown> {
    checkedRunId(input.runId);
    const { config, source } = await this.trustedHostSource();
    const capabilities = await source.capabilities();
    return this.minimizedCapabilities(capabilities, new Set(config.searchProfile.sourceIds.map((value) => value.toLowerCase())));
  }

  async callAllowedTool(input: { name: 'search'; arguments: unknown; runId: string }): Promise<unknown> {
    const runId = checkedRunId(input.runId);
    if (input.name !== 'search') throw new Error('mcp_job_search_operation_forbidden');
    const request = searchArguments(input.arguments);
    const { config, source } = await this.trustedHostSource();
    const profileHash = profileFingerprint(config.searchProfile);
    this.pruneSnapshots();
    let snapshot = this.snapshots.get(runId);
    if (snapshot && snapshot.profileHash !== profileHash) throw new Error('mcp_job_search_profile_changed_during_run');
    if (!snapshot) {
      const capabilities = await source.capabilities();
      this.assertSearchCapability(capabilities);
      const result = await source.searchDetailed(structuredClone(config.searchProfile));
      const allowedSourceIds = new Set(config.searchProfile.sourceIds.map((value) => value.toLowerCase()));
      const jobs = result.jobs.slice(0, 500).map((job): MinimizedJob => {
        const sourceIdValue = checkedSourceId(job.sourceId);
        if (!allowedSourceIds.has(sourceIdValue)) throw new Error('mcp_job_search_source_out_of_scope');
        const upstreamId = checkedText(job.id, 'job_id', 256);
        const upstreamReference = job.sourceReferences?.[0];
        const referenceMaterial = upstreamReference
          ? JSON.stringify({ sourceId: upstreamReference.sourceId, externalId: upstreamReference.externalId, fetchedAt: upstreamReference.fetchedAt })
          : `${sourceIdValue}:${upstreamId}:${job.fetchedAt ?? ''}`;
        return {
          id: sourceId('job-id', `${sourceIdValue}:${upstreamId}`),
          title: checkedText(job.title, 'job_title', 300),
          company: checkedText(job.company, 'job_company', 300),
          ...(job.location ? { location: checkedText(job.location, 'job_location', 300) } : {}),
          sourceId: sourceIdValue,
          sourceReference: sourceId('job', referenceMaterial),
          version: checkedText(job.fetchedAt ?? upstreamReference?.fetchedAt ?? 'unknown', 'job_version', 128),
        };
      });
      const failures = result.failures.slice(0, 50).map((failure) => {
        const failureSourceId = checkedSourceId(failure.sourceId);
        if (!allowedSourceIds.has(failureSourceId)) throw new Error('mcp_job_search_source_out_of_scope');
        return {
          sourceId: failureSourceId,
          category: checkedText(failure.category, 'failure_category', 64),
          retryable: Boolean(failure.retryable),
        };
      });
      snapshot = {
        profileHash,
        createdAt: this.now(),
        snapshotReference: sourceId('job-search-snapshot', `${runId}:${profileHash}:${this.now()}`),
        jobs,
        failures,
      };
      this.snapshots.set(runId, snapshot);
    }
    const start = request.page * request.pageSize;
    return {
      items: snapshot.jobs.slice(start, start + request.pageSize),
      page: request.page,
      pageSize: request.pageSize,
      hasMore: start + request.pageSize < snapshot.jobs.length,
      failures: structuredClone(snapshot.failures),
      snapshotReference: snapshot.snapshotReference,
    };
  }

  private async trustedHostSource(): Promise<{ config: AppConfig; source: TrustedHostJobSource }> {
    const config = await this.config.load();
    if (config.mcp.mode !== 'stdio' || config.mcp.executionIsolation !== 'trusted-host') {
      throw new Error('mcp_job_search_trusted_host_required');
    }
    try { assertTrustedHostMcpLaunch(config.mcp); }
    catch { throw new Error('mcp_job_search_trusted_host_launch_invalid'); }
    return { config, source: this.sourceFactory(structuredClone(config.mcp)) };
  }

  private minimizedCapabilities(capabilities: JobSourceCapabilities, allowedSourceIds: ReadonlySet<string>): Record<string, unknown> {
    this.assertSearchCapability(capabilities);
    if (capabilities.sources.length > 50) throw new Error('mcp_job_search_upstream_invalid:sources');
    return {
      contract: 'job-search-root-proxy',
      contractVersion: '1.0',
      upstreamContractVersion: checkedText(capabilities.contractVersion, 'contract_version', 32),
      compatible: true,
      executionIsolation: 'trusted-host',
      allowedOperations: ['capabilities', 'search'],
      sources: capabilities.sources.filter((source) => allowedSourceIds.has(source.id.toLowerCase())).map((source) => ({
        id: checkedSourceId(source.id),
        name: checkedText(source.name, 'source_name', 160),
        enabled: Boolean(source.enabled),
        access: checkedText(source.access, 'source_access', 80),
        filters: source.filters.slice(0, 20).map((filter) => checkedText(filter, 'source_filter', 80)),
        pagination: Boolean(source.pagination),
        policyStatus: checkedText(source.policyStatus, 'source_policy_status', 160),
        authenticationRequiredForSearch: Boolean(source.loginRequiredForSearch),
      })),
    };
  }

  private assertSearchCapability(capabilities: JobSourceCapabilities): void {
    if (capabilities.contract !== 'job-search-mcp' || capabilities.compatible !== true
      || !capabilities.tools.includes('mehrportal_suche')) throw new Error('mcp_job_search_contract_incompatible');
  }

  private pruneSnapshots(): void {
    const oldestAllowed = this.now() - 30 * 60_000;
    for (const [runId, snapshot] of this.snapshots) if (snapshot.createdAt < oldestAllowed) this.snapshots.delete(runId);
    while (this.snapshots.size >= 64) this.snapshots.delete(this.snapshots.keys().next().value as string);
  }
}

export class WorkspaceAgentApplicationReadPort implements ApplicationReadPort {
  constructor(private readonly workspace: WorkspaceStore) {}
  async get(applicationCaseId: string, _view: 'masked' | 'sensitive') {
    const application = await this.workspace.getApplicationCase(applicationCaseId);
    if (!application) return undefined;
    return {
      id: application.id,
      revision: application.revision,
      jobId: application.job.id,
      companyId: companyKey(application.job.company),
      status: application.state,
      identityMode: application.identityMode,
      sourceReferences: [sourceId('application', `${application.id}:${application.revision}`)],
      safeSummary: `${application.job.title} bei ${application.job.company}`
    };
  }
  async currentRevision(applicationCaseId: string): Promise<number | undefined> {
    return (await this.workspace.getApplicationCase(applicationCaseId))?.revision;
  }
  async getCompany(input: {
    applicationCaseId: string;
    companyId: string;
    allowedApplicationCaseIds: readonly string[];
  }) {
    const anchor = await this.workspace.getApplicationCase(input.applicationCaseId);
    if (!anchor || companyKey(anchor.job.company) !== input.companyId
      || !input.allowedApplicationCaseIds.includes(anchor.id)) return undefined;
    const allowed = new Set(input.allowedApplicationCaseIds);
    const applicationCases = (await this.workspace.listApplicationCases())
      .filter((item) => allowed.has(item.id) && companyKey(item.job.company) === input.companyId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        jobId: item.job.id,
        jobTitle: item.job.title,
        status: item.state,
        revision: item.revision,
        sourceReference: sourceId('application', `${item.id}:${item.revision}`),
      }));
    const version = sourceId('company-version', applicationCases.map((item) => `${item.id}:${item.revision}`).join('|'));
    return {
      id: input.companyId,
      name: anchor.job.company,
      version,
      applicationCases,
      sourceReferences: [sourceId('company', input.companyId), ...applicationCases.map((item) => item.sourceReference)],
    };
  }
  async listTracking(input: { applicationCaseId: string; page: number; pageSize: number }) {
    const application = await this.workspace.getApplicationCase(input.applicationCaseId);
    if (!application) throw new Error('mcp_application_case_not_found');
    const all = (await this.workspace.listTrackingEvents(application.id))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id))
      .map((event) => ({
        id: sourceId('tracking-event-id', event.id),
        status: event.status,
        occurredAt: event.occurredAt,
        source: event.source,
        version: sourceId('tracking-version', `${event.id}:${event.status}:${event.occurredAt}:${event.sourceReference ?? ''}`),
        sourceReference: sourceId('tracking-event', `${event.id}:${event.occurredAt}`),
      }));
    const start = input.page * input.pageSize;
    return {
      items: all.slice(start, start + input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      hasMore: start + input.pageSize < all.length,
      applicationCaseRevision: application.revision,
      sourceReferences: [
        sourceId('application', `${application.id}:${application.revision}`),
        ...all.slice(start, start + input.pageSize).map((item) => item.sourceReference),
      ],
    };
  }
}

export class VaultAgentMessageReadPort implements MessageReadPort {
  constructor(private readonly vault: EncryptedMailVault) {}
  async list(input: { applicationCaseId: string; page: number; pageSize: number; view: 'masked' | 'sensitive' }) {
    const matching = (await this.vault.listMessages())
      .filter((message) => message.correlation.applicationCaseId === input.applicationCaseId)
      .map((message) => ({
        id: message.id,
        applicationCaseId: input.applicationCaseId,
        receivedAt: message.sentAt,
        senderDomain: (message.from[0]?.split('@')[1] ?? 'unknown.invalid').toLowerCase(),
        subject: input.view === 'sensitive' ? message.subject : undefined,
        classification: message.responseKind,
        contentPreview: input.view === 'sensitive' ? message.text.slice(0, 500) : undefined,
        sourceReference: sourceId('mail', message.id)
      }));
    const start = input.page * input.pageSize;
    return {
      items: matching.slice(start, start + input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      hasMore: start + input.pageSize < matching.length
    };
  }
}

export class LocalAgentApplicationPipelineProxy implements ApplicationPipelineProxy {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly config: ConfigStore,
    private readonly workRoot?: string,
  ) {}
  async analyze(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }) {
    const application = await this.requiredCase(input.applicationCaseId);
    const settings = (await this.config.load()).assistant;
    return {
      payload: await new LocalApplicationAssistantAdapter(settings, this.workRoot).analyze(application.job, input.documentType),
      sourceReferences: [sourceId('application', `${application.id}:${application.revision}`), sourceId('job', application.job.id)]
    };
  }
  async audit(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }) {
    const application = await this.requiredCase(input.applicationCaseId);
    if (application.documentType !== input.documentType) throw new Error('mcp_application_pipeline_document_type_mismatch');
    const settings = (await this.config.load()).assistant;
    const assistant = new LocalApplicationAssistantAdapter(settings, this.workRoot);
    const capabilities = await assistant.capabilities();
    if (capabilities.contract !== 'bewerbungs-pipeline' || !/^1\./.test(capabilities.contractVersion)
      || !capabilities.compatible || capabilities.networkRequired) {
      throw new Error('mcp_application_pipeline_contract_incompatible');
    }
    const analysis = await assistant.analyze(application.job, input.documentType);
    const validation = await assistant.validateMatchMatrix(analysis.matchMatrix, input.documentType);
    const current = await this.requiredCase(input.applicationCaseId);
    const jobSnapshotSha256 = createHash('sha256').update(canonicalJson(application.job), 'utf8').digest('hex');
    if (current.revision !== application.revision
      || createHash('sha256').update(canonicalJson(current.job), 'utf8').digest('hex') !== jobSnapshotSha256) {
      throw new Error('mcp_application_pipeline_case_changed_during_audit');
    }
    const jobAnalysis = record(analysis.jobAnalysis);
    const matchMatrix = record(analysis.matchMatrix);
    const analysisVersion = valueString(jobAnalysis, 'analysis_version');
    const analysisSourceSha256 = valueString(jobAnalysis, 'source_sha256');
    if (jobAnalysis.contract !== 'bewerbungs-pipeline' || jobAnalysis.contract_version !== capabilities.contractVersion
      || matchMatrix.contract !== 'bewerbungs-pipeline' || matchMatrix.contract_version !== capabilities.contractVersion
      || !/^[a-f0-9]{64}$/.test(analysisSourceSha256)) {
      throw new Error('mcp_application_pipeline_cross_contract_invalid');
    }
    const sourceReferences = [
      sourceId('application', `${application.id}:${application.revision}`),
      sourceId('job', `${application.job.sourceId}:${application.job.id}:${jobSnapshotSha256}`),
      sourceId('pipeline-contract', `${capabilities.contract}:${capabilities.contractVersion}`),
    ];
    return {
      payload: {
        contract: 'application-pipeline-root-proxy',
        contractVersion: '1.0',
        applicationCaseId: application.id,
        applicationCaseRevision: application.revision,
        jobId: application.job.id,
        documentType: input.documentType,
        upstream: {
          contract: capabilities.contract,
          contractVersion: capabilities.contractVersion,
          compatible: true,
          networkRequired: false,
        },
        sourceVersion: {
          applicationCaseRevision: application.revision,
          jobSnapshotSha256,
          analysisVersion,
          analysisSourceSha256,
          pipelineContractVersion: capabilities.contractVersion,
        },
        jobAnalysis: structuredClone(jobAnalysis),
        matchMatrix: structuredClone(matchMatrix),
        validation: { valid: validation.valid, errors: [...validation.errors] },
        finalization: {
          executable: false,
          route: 'approved-artifact-review-adoption',
          proofContract: 'application-pipeline-proof@1.0',
        },
      },
      sourceReferences,
    };
  }
  async proposeDocumentRevision(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }) {
    const application = await this.requiredCase(input.applicationCaseId);
    const config = await this.config.load();
    const identity = config.identities.find((candidate) => candidate.id === application.identityId);
    if (!identity) throw new Error('mcp_application_identity_not_found');
    const draft = await new LocalApplicationAssistantAdapter(config.assistant, this.workRoot)
      .preview(application.job, maskedIdentity(identity), input.documentType);
    return {
      payload: draft,
      sourceReferences: [sourceId('application', `${application.id}:${application.revision}`), sourceId('job', application.job.id)]
    };
  }
  private async requiredCase(id: string) {
    const application = await this.workspace.getApplicationCase(id);
    if (!application) throw new Error('mcp_application_case_not_found');
    return application;
  }
}

export class LocalAgentDomainProposalPort implements DomainProposalPort {
  async propose(input: { kind: string; applicationCaseId: string; payload: unknown; runId: string }) {
    return {
      payload: structuredClone(input.payload),
      sourceReferences: [sourceId('application', input.applicationCaseId), sourceId('agent-run', input.runId)]
    };
  }
}

type PreparedCommand = PreparedDomainCommand;

export class LocalAgentDomainCommandPort implements DomainCommandPort {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly mailVault: EncryptedMailVault,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(input: {
    proposal: StoredProposal;
    expectedRevision: number;
    idempotencyKeySha256: string;
  }): Promise<DomainCommandPreview> {
    const application = await this.workspace.getApplicationCase(input.proposal.applicationCaseId);
    if (!application) throw new Error('mcp_application_case_not_found');
    if (application.revision !== input.expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
    const payload = record(input.proposal.payload);
    const binding = {
      applicationCaseId: application.id,
      proposalId: input.proposal.proposalId,
      proposalPayloadHash: input.proposal.payloadHash,
    };
    if (input.proposal.kind === 'application_status') {
      const target = valueString(payload, 'status') as ApplicationCaseState;
      if (!statusValues.has(target)) throw new Error('mcp_application_status_invalid');
      if (['approved', 'exported', 'dry_run', 'submitted'].includes(target)) {
        throw new Error('mcp_application_pipeline_gate_cannot_be_bypassed');
      }
      if (application.state === target) throw new Error('mcp_application_status_noop');
      transitionApplicationCase(application, target, this.now().toISOString());
      const prepared: PreparedCommand = {
        ...binding, kind: 'application_status', execution: 'local_write', from: application.state, target,
      };
      return {
        prepared,
        dryRun: { action: 'application_status', from: application.state, to: target, expectedRevision: input.expectedRevision },
      };
    }
    if (input.proposal.kind === 'mail_correlation') {
      const messageId = valueString(payload, 'messageId');
      const message = (await this.mailVault.listMessages()).find((candidate) => candidate.id === messageId);
      if (!message) throw new Error('mcp_mail_message_not_found');
      const prepared: PreparedCommand = { ...binding, kind: 'mail_correlation', execution: 'local_write', messageId };
      return {
        prepared,
        dryRun: { action: 'mail_correlation', messageReference: sourceId('mail', messageId), applicationCaseId: application.id },
      };
    }
    if (input.proposal.kind === 'follow_up_reminder') {
      const dueAt = valueString(payload, 'dueAt');
      const timeZone = valueString(payload, 'timeZone');
      const note = valueString(payload, 'note').trim();
      const dueMillis = Date.parse(dueAt);
      if (!Number.isFinite(dueMillis) || dueMillis <= this.now().getTime() || note.length > 500 || timeZone.length > 80
        || /[\u0000-\u001f\u007f]/.test(note)) throw new Error('mcp_reminder_payload_invalid');
      try { new Intl.DateTimeFormat('de-DE', { timeZone }).format(new Date(dueMillis)); }
      catch { throw new Error('mcp_reminder_timezone_invalid'); }
      const prepared: PreparedCommand = {
        ...binding, kind: 'follow_up_reminder', execution: 'local_write',
        dueAt: new Date(dueMillis).toISOString(), timeZone, note,
      };
      return {
        prepared,
        dryRun: {
          action: 'follow_up_reminder', dueAt: new Date(dueMillis).toISOString(), timeZone, note,
          applicationCaseId: application.id,
        },
      };
    }
    if (input.proposal.kind === 'document_revision') {
      const documentType = valueString(payload, 'documentType');
      if (!['cv', 'cover_letter', 'email'].includes(documentType) || payload.lifecycle !== 'preview') {
        throw new Error('mcp_document_revision_preview_invalid');
      }
      const _proposalOnly: PreparedCommand = {
        ...binding, kind: 'document_revision', execution: 'proposal_only',
        documentType: documentType as 'cv' | 'cover_letter' | 'email',
      };
      void _proposalOnly;
      throw new Error('mcp_document_revision_proposal_only_use_artifact_review_api');
    }
    throw new Error('mcp_domain_command_kind_forbidden');
  }

  async execute(input: ConfirmedDomainCommand): Promise<{ revision: number; result: unknown }> {
    const prepared = input.prepared;
    if (prepared.applicationCaseId !== input.applicationCaseId || prepared.proposalId !== input.proposalId
      || prepared.proposalPayloadHash !== input.proposalPayloadHash || prepared.execution !== 'local_write') {
      throw new Error('mcp_domain_command_not_prepared');
    }
    const application = await this.workspace.getApplicationCase(input.applicationCaseId);
    if (!application) throw new Error('mcp_application_case_not_found');
    if (prepared.kind === 'application_status') {
      let updated = application;
      if (application.revision === input.expectedRevision && application.state === prepared.from) {
        updated = transitionApplicationCase(application, prepared.target as ApplicationCaseState, this.now().toISOString());
        await this.workspace.saveApplicationCase(updated);
      } else if (application.revision !== input.expectedRevision + 1 || application.state !== prepared.target) {
        throw new Error('mcp_optimistic_concurrency_conflict');
      }
      const eventId = sourceId('domain-command-event', `${input.proposalId}:${input.proposalPayloadHash}`);
      if (!(await this.workspace.listApplicationEvents(application.id)).some((event) => event.id === eventId)) {
        await this.workspace.appendApplicationEvent({
          id: eventId, applicationCaseId: updated.id,
          from: prepared.from as ApplicationCaseState, to: prepared.target as ApplicationCaseState,
          occurredAt: updated.updatedAt, source: 'system', note: 'Vom Nutzer best\u00e4tigter lokaler Agentenvorschlag.'
        });
      }
      return { revision: updated.revision, result: { state: updated.state } };
    }
    if (prepared.kind === 'mail_correlation') {
      const existing = (await this.mailVault.listMessages()).find((message) => message.id === prepared.messageId);
      if (!existing) throw new Error('mcp_mail_message_not_found');
      if (existing.correlation.confirmed && existing.correlation.applicationCaseId === application.id
        && existing.correlation.companyKey === companyKey(application.job.company)) {
        return { revision: application.revision, result: { messageId: existing.id, correlationConfirmed: true } };
      }
      if (application.revision !== input.expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
      const message = await this.mailVault.confirmCorrelation(
        prepared.messageId, application.id, companyKey(application.job.company)
      );
      return { revision: application.revision, result: { messageId: message.id, correlationConfirmed: true } };
    }
    const reminderId = sourceId('domain-command-reminder', `${input.proposalId}:${input.proposalPayloadHash}`);
    const existingReminder = (await this.workspace.listReminders()).find((reminder) => reminder.id === reminderId);
    if (existingReminder) {
      if (existingReminder.applicationCaseId !== application.id || existingReminder.dueAt !== prepared.dueAt
        || existingReminder.timeZone !== prepared.timeZone || existingReminder.note !== prepared.note) {
        throw new Error('mcp_domain_command_effect_conflict');
      }
      return {
        revision: application.revision,
        result: { reminderId: existingReminder.id, dueAt: existingReminder.dueAt, timeZone: existingReminder.timeZone },
      };
    }
    if (application.revision !== input.expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
    const reminder: FollowUpReminder = {
      id: reminderId, applicationCaseId: application.id, dueAt: prepared.dueAt,
      timeZone: prepared.timeZone, note: prepared.note, completed: false, createdAt: this.now().toISOString(),
    };
    await this.workspace.saveReminder(reminder);
    return { revision: application.revision, result: { reminderId: reminder.id, dueAt: reminder.dueAt, timeZone: reminder.timeZone } };
  }
}

export function createRunBoundAgentDomainPorts(input: {
  workspace: WorkspaceStore;
  config: ConfigStore;
  mailVault: EncryptedMailVault;
}) {
  return {
    jobs: new WorkspaceAgentJobReadPort(input.workspace),
    applications: new WorkspaceAgentApplicationReadPort(input.workspace),
    messages: new VaultAgentMessageReadPort(input.mailVault),
    proposals: new LocalAgentDomainProposalPort(),
    commands: new LocalAgentDomainCommandPort(input.workspace, input.mailVault),
    applicationPipeline: new LocalAgentApplicationPipelineProxy(input.workspace, input.config),
    jobSearch: new TrustedHostAgentJobSearchProxy(input.config),
  };
}
