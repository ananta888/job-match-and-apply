import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentCapabilities, AgentEvent, AgentProviderInstallation, AgentRun, AgentRunRequest, AgentRunnerPort, RuntimeTarget,
} from '../ports/agent-runner.js';
import type { CvFact, CvNormalizationConflict } from '../ports/cv-normalization.js';
import type { AgentConfigLoadResult, AgentProviderProfile } from '../agents/config-profile-store.js';
import { buildCvAiStructuringPrompt } from './cv-ai-structuring-prompt.js';
import {
  sealCvAiStructuringRun, type CvAiStructuringRunRecord, type CvAiStructuringRunStore,
  type CvAiStructuringMode, type CvAiStructuringSuggestion,
} from './cv-ai-structuring-store.js';

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PROVIDER_OUTPUT_BYTES = 512 * 1024;
const MAX_SELECTIONS = 2_000;
const DEFAULT_RUN_TTL_MS = 24 * 60 * 60_000;
const RETENTION_CANCEL_GRACE_MS = 60_000;
const MAX_RETENTION_CANCEL_ATTEMPTS = 3;
const SAFE_AGENT_FAILURE_CODES = new Set([
  'provider_reported_error', 'claude_runtime_conformance_mismatch', 'invalid_claude_event',
  'invalid_provider_event_shape', 'invalid_json', 'line_too_large', 'truncated_tail',
  'exit', 'crash', 'signal', 'timeout', 'idle_timeout', 'output_limit', 'memory_limit',
  'child_process_limit', 'resource_probe_error', 'raw_log_error', 'spawn_error', 'agent_run_failed',
]);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'validating', 'cancel_requested', 'applying']);
const TERMINAL_AGENT_STATES = new Set(['cancelled', 'failed', 'timed_out', 'succeeded']);

export interface CvAiStructuringImportSource {
  id: string;
  revision: number;
  sha256: string;
  sourceId: string;
  sourceSha256: string;
  extractedTextSha256: string;
  baseProposalSha256: string;
  /** Full private cv-import-proposal, read from the encrypted import vault. */
  baseProposalArtifact: unknown;
  /** Exact bounded manifest JSON; it is used transiently and never copied to this service's store. */
  lineManifestJson: string;
  lineManifestSha256: string;
  deterministicRecognitionVersionId: string;
}

export interface CvAiStructuringImportPort {
  loadAiSource(id: string): Promise<CvAiStructuringImportSource | undefined>;
  /** Finds an already committed atomic stage after a process/save interruption. */
  findAiStage(input: {
    id: string;
    runId: string;
    aiProposalSha256: string;
  }): Promise<{ revision: number; sha256: string; facts: CvFact[] } | undefined>;
  /** Atomically CAS-persist the full merged artifact and its mapped pending facts. */
  stageAiStructure(input: {
    id: string;
    expectedRevision: number;
    expectedSha256: string;
    runId: string;
    aiProposalSha256: string;
    expectedBaseProposalSha256: string;
    mergedProposalSha256: string;
    mergedArtifact: unknown;
    facts: CvFact[];
    selections: CvAiStructuringSelection[];
  }): Promise<{ revision: number; sha256: string; stagedFactIds: string[] }>;
  /** Creates or idempotently resolves one complete AI recognition version and activates it on first creation. */
  createAiRecognitionVersion(input: {
    id: string;
    expectedRevision: number;
    expectedSha256: string;
    label?: string;
    facts: CvFact[];
    warnings?: string[];
    unresolvedConflicts: CvNormalizationConflict[];
    normalizationArtifact: unknown;
    source: {
      deterministicRecognitionVersionId: string;
      sourceSha256: string;
      baseProposalSha256: string;
    };
    provenance: {
      runId: string;
      runSha256?: string;
      proposalSha256: string;
      artifactSha256: string;
      selections?: CvAiStructuringSelection[];
    };
    provider?: {
      id: string;
      runtimeTarget: 'windows' | 'wsl';
      version: string;
      adapterVersion: string;
      witnessSha256?: string;
    };
  }): Promise<{
    revision: number;
    sha256: string;
    recognitionVersionId: string;
    recognitionVersionCount: number;
    factIds: string[];
  }>;
}

export interface CvAiStructuringSelection {
  suggestionId: string;
  alternativeId: string | null;
}

export interface CvAiStructuringValidationPort {
  contract(): Promise<{
    outputContract: 'ai-cv-structure-proposal';
    outputContractVersion: '1.0';
    outputSchemaJson: string;
    outputSchemaSha256: string;
  }>;
  validateProposal(input: {
    baseProposalArtifact: unknown;
    expectedBaseProposalSha256: string;
    aiProposal: Readonly<Record<string, unknown>>;
  }): Promise<{
    contract: 'validated-ai-cv-structure-proposal';
    contractVersion: '1.0';
    status: 'unverified';
    binding: {
      sourceId: string;
      sourceSha256: string;
      extractedTextSha256: string;
      baseProposalSha256: string;
    };
    proposalSha256: string;
    suggestions: CvAiStructuringSuggestion[];
    /** Adapter-owned bundle retaining the exact provider proposal for apply-ai-structure. */
    privateArtifact: unknown;
  }>;
  applySelections(input: {
    baseProposalArtifact: unknown;
    expectedBaseProposalSha256: string;
    aiProposalArtifact: unknown;
    expectedAiProposalSha256: string;
    selections: CvAiStructuringSelection[];
  }): Promise<{
    mergedArtifact: unknown;
    mergedProposalSha256: string;
    facts: CvFact[];
    appliedSuggestionIds: string[];
  }>;
  materializeRecognitionVersion(input: {
    baseProposalArtifact: unknown;
    expectedBaseProposalSha256: string;
    aiProposalArtifact: unknown;
    expectedAiProposalSha256: string;
  }): Promise<{
    materializedArtifact: unknown;
    materializedProposalSha256: string;
    facts: CvFact[];
    warnings: string[];
    unresolvedConflicts: CvNormalizationConflict[];
    appliedSuggestionIds: string[];
  }>;
}

export interface CvAiAgentRunPort {
  enqueue(request: AgentRunRequest): Promise<AgentRun>;
  get(runId: string): Promise<AgentRun | undefined>;
  events(runId: string, afterSequence?: number): Promise<AgentEvent[]>;
  cancel(runId: string, reason?: string): Promise<void>;
}

export interface CvAiAgentRunPurger {
  deleteRuns(runIds: readonly string[]): Promise<Array<{ runId: string; events: number }>>;
}

export interface CvAiProviderSelection {
  providerId: string;
  runtimeTarget: Exclude<RuntimeTarget, 'container'>;
  wslDistribution?: string;
  expectedVersion: string;
  /** Optional per-run model override; falls back to the stored profile model. */
  model?: string;
}

export interface CvAiDisclosureConfirmation {
  version: '1.0';
  confirmed: true;
  sendExtractedCvTextToProvider: true;
  acknowledgeProviderControlPlaneNetwork: true;
}

export interface CvAiActor {
  id: string;
  type: 'local' | 'authenticated';
}

export interface CvAiStructuringPublicRun extends Omit<CvAiStructuringRunRecord, 'agentRunId' | 'proposal' | 'applyIntent' | 'retentionCleanup'> {
  proposal?: Omit<NonNullable<CvAiStructuringRunRecord['proposal']>, 'privateArtifact'>;
}

/**
 * Content-free trace sink, structurally satisfied by AgentLocalObservability.
 * Like that class it deliberately offers no message or detail parameter.
 */
export interface CvAiStructuringObservabilityPort {
  record(input: {
    level: 'debug' | 'info' | 'warn' | 'error';
    component: string;
    operation: string;
    code: string;
    runId?: string;
    provider?: string;
    eventSequence?: number;
    errorClass?: string;
  }): Promise<unknown>;
}

export interface CvAiStructuringServiceDependencies {
  store: CvAiStructuringRunStore;
  imports: CvAiStructuringImportPort;
  validation: CvAiStructuringValidationPort;
  agentRuns: CvAiAgentRunPort;
  purger: CvAiAgentRunPurger;
  observability?: CvAiStructuringObservabilityPort;
  providers: readonly AgentRunnerPort[];
  configProfiles: { load(): Promise<AgentConfigLoadResult> };
  workspaceRoot: string;
  now?: () => Date;
  id?: () => string;
  runTtlMs?: number;
  allowSyntheticProviders?: boolean;
  isEmergencyStopEnabled?: () => boolean;
}

interface ResolvedProvider {
  runner: AgentRunnerPort;
  installation: AgentProviderInstallation;
  capabilities: AgentCapabilities;
  profile: AgentProviderProfile;
}

export class CvAiStructuringError extends Error {
  readonly name = 'CvAiStructuringError';
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly stage: NonNullable<CvAiStructuringRunRecord['failure']>['stage'],
    readonly retryable = false,
  ) { super(code); }
}

/**
 * Peels the JSON object out of a provider answer.
 *
 * Demanding a bare object rejected answers that were perfectly valid, just
 * wrapped: CLI providers routinely introduce the result in prose and put it in
 * a ```json fence. Only the wrapper is tolerated here — the object itself is
 * still parsed strictly and still has to pass the schema validation that
 * follows, so nothing about what is accepted as a proposal changes.
 */
export function extractProviderJsonObject(output: string): Readonly<Record<string, unknown>> | undefined {
  const asObject = (candidate: string): Readonly<Record<string, unknown>> | undefined => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Readonly<Record<string, unknown>> : undefined;
    } catch { return undefined; }
  };
  const direct = asObject(output.trim());
  if (direct) return direct;
  for (const fence of output.matchAll(/```(?:json|jsonc)?\s*\n?([\s\S]*?)```/gi)) {
    const fenced = asObject((fence[1] ?? '').trim());
    if (fenced) return fenced;
  }
  // Last resort: the first balanced {…} run, ignoring braces inside strings.
  const start = output.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return asObject(output.slice(start, index + 1));
    }
  }
  return undefined;
}

function error(code: string, statusCode: number, stage: CvAiStructuringError['stage'], retryable = false): never {
  throw new CvAiStructuringError(code, statusCode, stage, retryable);
}

/** The observability sink rejects anything outside `[a-z0-9_.:-]`, uppercase included. */
function observabilityClass(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]/g, '-').slice(0, 100);
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function assertSha(value: string, code: string): void { if (!SHA256.test(value)) error(code, 409, 'validation'); }
function assertUuid(value: string): void { if (!UUID.test(value)) error('cv_ai_run_id_invalid', 400, 'preflight'); }
function assertActor(actor: CvAiActor): void {
  if (!actor || !SAFE_ID.test(actor.id) || !['local', 'authenticated'].includes(actor.type)) error('cv_ai_actor_invalid', 400, 'preflight');
}
function assertDisclosure(value: CvAiDisclosureConfirmation): void {
  if (!value || value.version !== '1.0' || value.confirmed !== true || value.sendExtractedCvTextToProvider !== true
    || value.acknowledgeProviderControlPlaneNetwork !== true) error('cv_ai_disclosure_required', 409, 'preflight');
}
function effectiveMode(mode: CvAiStructuringMode | undefined): CvAiStructuringMode {
  return mode ?? 'review_suggestions';
}
function runNeedsRecovery(record: CvAiStructuringRunRecord): boolean {
  return ACTIVE_STATUSES.has(record.status)
    || (record.status === 'suggestions_ready' && effectiveMode(record.mode) === 'replace_with_ai_version');
}
function assertMode(mode: CvAiStructuringMode | undefined): CvAiStructuringMode {
  const effective = effectiveMode(mode);
  if (!['review_suggestions', 'replace_with_ai_version'].includes(effective)) {
    error('cv_ai_structuring_mode_invalid', 400, 'preflight');
  }
  return effective;
}
function assertImportCas(source: CvAiStructuringImportSource, revision: number, sha256: string): void {
  if (source.revision !== revision) error('cv_import_revision_conflict', 409, 'preflight');
  if (source.sha256 !== sha256) error('cv_import_sha_conflict', 409, 'preflight');
}
function assertRunCas(record: CvAiStructuringRunRecord, revision: number, sha256: string): void {
  if (record.revision !== revision) error('cv_ai_run_revision_conflict', 409, 'preflight');
  if (record.sha256 !== sha256) error('cv_ai_run_sha_conflict', 409, 'preflight');
}

export function publicCvAiStructuringRun(record: CvAiStructuringRunRecord): CvAiStructuringPublicRun {
  const cloned = structuredClone(record);
  const {
    agentRunId: _agentRunId, applyIntent: _applyIntent, retentionCleanup: _retentionCleanup, proposal, ...view
  } = cloned;
  if (!proposal || effectiveMode(record.mode) === 'replace_with_ai_version') return view;
  const { privateArtifact: _privateArtifact, ...publicProposal } = proposal;
  return { ...view, proposal: publicProposal };
}

function safeFailure(errorValue: unknown, fallback: string, stage: CvAiStructuringError['stage']): NonNullable<CvAiStructuringRunRecord['failure']> {
  if (errorValue instanceof CvAiStructuringError) {
    return { code: errorValue.code, stage: errorValue.stage, retryable: errorValue.retryable };
  }
  const candidate = errorValue && typeof errorValue === 'object'
    ? ('errorCode' in errorValue && typeof (errorValue as { errorCode?: unknown }).errorCode === 'string'
      ? (errorValue as { errorCode: string }).errorCode
      : 'code' in errorValue && typeof (errorValue as { code?: unknown }).code === 'string'
        ? (errorValue as { code: string }).code
        : fallback)
    : fallback;
  const code = SAFE_ID.test(candidate) ? candidate : fallback;
  const retryable = Boolean(errorValue && typeof errorValue === 'object'
    && 'retryable' in errorValue && (errorValue as { retryable?: unknown }).retryable === true);
  return { code, stage, retryable };
}

export class CvAiStructuringService {
  private readonly providers = new Map<string, AgentRunnerPort>();
  private readonly deletingImports = new Set<string>();
  private readonly importOperationTails = new Map<string, Promise<void>>();
  private readonly runRefreshes = new Map<string, Promise<CvAiStructuringRunRecord>>();
  private startAdmissionTail: Promise<void> = Promise.resolve();
  private retentionSweep?: Promise<string[]>;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly runTtlMs: number;

  constructor(private readonly dependencies: CvAiStructuringServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.id = dependencies.id ?? randomUUID;
    this.runTtlMs = dependencies.runTtlMs ?? DEFAULT_RUN_TTL_MS;
    if (!Number.isSafeInteger(this.runTtlMs) || this.runTtlMs < 60_000 || this.runTtlMs > 7 * 24 * 60 * 60_000) {
      throw new Error('cv_ai_run_ttl_invalid');
    }
    for (const provider of dependencies.providers) {
      if (this.providers.has(provider.provider)) throw new Error('cv_ai_provider_duplicate');
      this.providers.set(provider.provider, provider);
    }
  }

  async options(input: { cvImportId: string; expectedCvImportRevision: number; expectedCvImportSha256: string }) {
    const source = await this.requireSource(input.cvImportId);
    assertImportCas(source, input.expectedCvImportRevision, input.expectedCvImportSha256);
    const loaded = await this.dependencies.configProfiles.load();
    const providers = await Promise.all([...this.providers.values()].map(async (runner) => {
      const profile = loaded.profile.providers.find((entry) => entry.provider === runner.provider);
      const installations = (await runner.discover()).filter((installation) => installation.runtimeTarget !== 'container');
      return {
        providerId: runner.provider,
        installations: await Promise.all(installations.map(async (installation) => {
          let capabilities: AgentCapabilities | undefined;
          try { capabilities = installation.capabilities ?? await runner.capabilities(installation); } catch { /* blocker below */ }
          const blockers = this.providerBlockers(installation, capabilities, profile);
          return {
            runtimeTarget: installation.runtimeTarget, wslDistribution: installation.distribution,
            version: installation.version, adapterVersion: capabilities?.adapterVersion,
            support: installation.support, authStatus: installation.authStatus ?? 'unknown', ready: blockers.length === 0, blockers,
            network: {
              toolNetwork: 'disabled' as const, rootMcpTools: [] as [], jobSearchMcpAccessible: false as const,
              providerControlPlane: 'provider_managed_may_use_network' as const,
            },
          };
        })),
      };
    }));
    return {
      contract: 'cv-ai-structuring-options' as const, contractVersion: '1.0' as const, capturedAt: this.now().toISOString(),
      cvImport: { id: source.id, revision: source.revision, sha256: source.sha256 }, providers,
      disclosure: {
        required: true, version: '1.0' as const, extractedCvTextSentToSelectedProvider: true,
        toolNetwork: 'disabled' as const, rootMcpTools: [] as [], jobSearchMcpAccessible: false as const,
        providerControlPlane: 'provider_managed_may_use_network' as const,
      },
    };
  }

  async start(input: {
    cvImportId: string;
    expectedCvImportRevision: number;
    expectedCvImportSha256: string;
    provider: CvAiProviderSelection;
    disclosure: CvAiDisclosureConfirmation;
    mode?: CvAiStructuringMode;
    actor: CvAiActor;
    correlationId?: string;
  }): Promise<CvAiStructuringPublicRun> {
    return this.startInternal(input, { attempt: 1 });
  }

  async list(cvImportId: string): Promise<CvAiStructuringPublicRun[]> {
    assertUuid(cvImportId);
    const records = await this.dependencies.store.listByImport(cvImportId);
    const refreshed = await Promise.all(records.map((record) => this.refreshSingleflight(record)));
    return refreshed.map(publicCvAiStructuringRun);
  }

  async get(cvImportId: string, runId: string): Promise<CvAiStructuringPublicRun> {
    const record = await this.required(cvImportId, runId);
    return publicCvAiStructuringRun(await this.refreshSingleflight(record));
  }

  async cancel(input: {
    cvImportId: string;
    runId: string;
    expectedRunRevision: number;
    expectedRunSha256: string;
    confirmed: true;
    actor: CvAiActor;
    correlationId?: string;
  }): Promise<CvAiStructuringPublicRun> {
    if (input.confirmed !== true) error('cv_ai_cancel_confirmation_required', 409, 'preflight');
    assertActor(input.actor);
    let record = await this.required(input.cvImportId, input.runId); assertRunCas(record, input.expectedRunRevision, input.expectedRunSha256);
    if (!['queued', 'running', 'validating', 'cancel_requested'].includes(record.status)) error('cv_ai_run_not_cancellable', 409, 'preflight');
    await this.dependencies.agentRuns.cancel(record.agentRunId, 'CV-AI-Strukturierung durch Nutzer abgebrochen.');
    if (record.status !== 'cancel_requested') record = await this.save(record, { status: 'cancel_requested' }, {
      action: 'cancel_requested', actorId: input.actor.id, correlationId: input.correlationId,
    });
    return publicCvAiStructuringRun(record);
  }

  async deleteRun(input: {
    cvImportId: string;
    runId: string;
    expectedRunRevision: number;
    expectedRunSha256: string;
    confirmed: true;
    actor: CvAiActor;
  }): Promise<{ removed: number; id: string }> {
    if (input.confirmed !== true) error('cv_ai_delete_confirmation_required', 409, 'preflight');
    assertActor(input.actor);
    const record = await this.required(input.cvImportId, input.runId);
    assertRunCas(record, input.expectedRunRevision, input.expectedRunSha256);
    // Cancel a still-active agent run first so no orphaned raw run remains.
    if (['queued', 'starting', 'running', 'validating', 'cancel_requested'].includes(record.status)) {
      await this.dependencies.agentRuns.cancel(record.agentRunId, 'CV-AI-Lauf durch Nutzer gelöscht.').catch(() => undefined);
    }
    try { await this.purgeRawRun(record.agentRunId); } catch { /* raw run may already be purged */ }
    await this.dependencies.store.compareAndDelete(record.id, record.revision, record.sha256);
    return { removed: 1, id: record.id };
  }

  async retry(input: {
    cvImportId: string;
    runId: string;
    expectedRunRevision: number;
    expectedRunSha256: string;
    expectedCvImportRevision: number;
    expectedCvImportSha256: string;
    provider: CvAiProviderSelection;
    disclosure: CvAiDisclosureConfirmation;
    mode?: CvAiStructuringMode;
    actor: CvAiActor;
    correlationId?: string;
  }): Promise<CvAiStructuringPublicRun> {
    const previous = await this.required(input.cvImportId, input.runId); assertRunCas(previous, input.expectedRunRevision, input.expectedRunSha256);
    if (!['failed', 'cancelled'].includes(previous.status)) error('cv_ai_run_not_retryable', 409, 'preflight');
    const source = await this.requireSource(input.cvImportId); assertImportCas(source, input.expectedCvImportRevision, input.expectedCvImportSha256);
    if (source.sourceSha256 !== previous.binding.sourceSha256 || source.extractedTextSha256 !== previous.binding.extractedTextSha256
      || source.baseProposalSha256 !== previous.binding.baseProposalSha256) error('cv_ai_retry_import_binding_changed', 409, 'preflight');
    const previousMode = effectiveMode(previous.mode);
    const requestedMode = input.mode === undefined ? previousMode : assertMode(input.mode);
    if (previous.mode !== undefined && requestedMode !== previousMode) {
      error('cv_ai_retry_mode_changed', 409, 'preflight');
    }
    return this.startInternal({
      cvImportId: input.cvImportId, expectedCvImportRevision: input.expectedCvImportRevision,
      expectedCvImportSha256: input.expectedCvImportSha256, provider: input.provider,
      disclosure: input.disclosure, mode: requestedMode, actor: input.actor, correlationId: input.correlationId,
    }, { attempt: previous.attempt + 1, retryOf: previous.id });
  }

  async apply(input: {
    cvImportId: string;
    runId: string;
    expectedRunRevision: number;
    expectedRunSha256: string;
    expectedCvImportRevision: number;
    expectedCvImportSha256: string;
    selections: CvAiStructuringSelection[];
    confirmed: true;
    actor: CvAiActor;
    correlationId?: string;
  }): Promise<CvAiStructuringPublicRun> {
    return this.withImportOperation(input.cvImportId, () => this.applyExclusive(input));
  }

  private async applyExclusive(input: {
    cvImportId: string;
    runId: string;
    expectedRunRevision: number;
    expectedRunSha256: string;
    expectedCvImportRevision: number;
    expectedCvImportSha256: string;
    selections: CvAiStructuringSelection[];
    confirmed: true;
    actor: CvAiActor;
    correlationId?: string;
  }): Promise<CvAiStructuringPublicRun> {
    if (input.confirmed !== true) error('cv_ai_apply_confirmation_required', 409, 'apply');
    assertActor(input.actor);
    if (this.deletingImports.has(input.cvImportId)) error('cv_import_deletion_in_progress', 409, 'apply');
    let record = await this.required(input.cvImportId, input.runId); assertRunCas(record, input.expectedRunRevision, input.expectedRunSha256);
    if (effectiveMode(record.mode) !== 'review_suggestions') error('cv_ai_run_not_applyable', 409, 'apply');
    if (record.status !== 'suggestions_ready' || !record.proposal) error('cv_ai_run_not_applyable', 409, 'apply');
    const selections = this.validateSelections(record.proposal.suggestions, input.selections);
    const source = await this.requireSource(input.cvImportId); assertImportCas(source, input.expectedCvImportRevision, input.expectedCvImportSha256);
    if (source.baseProposalSha256 !== record.binding.baseProposalSha256 || source.sourceSha256 !== record.binding.sourceSha256
      || source.extractedTextSha256 !== record.binding.extractedTextSha256) error('cv_ai_apply_import_binding_changed', 409, 'apply');
    record = await this.save(record, {
      status: 'applying',
      applyIntent: {
        expectedCvImportRevision: input.expectedCvImportRevision,
        expectedCvImportSha256: input.expectedCvImportSha256,
        selections: structuredClone(selections),
        confirmedBy: structuredClone(input.actor),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      },
    }, {
      action: 'apply_started', actorId: input.actor.id, correlationId: input.correlationId,
      detailSha256: hash(JSON.stringify(selections)),
    });
    return publicCvAiStructuringRun(await this.completeApply(record, true));
  }

  /** Single-flight retention worker entry point. */
  async expireAndPrune(now = this.now()): Promise<string[]> {
    if (this.retentionSweep) return this.retentionSweep;
    const sweep = this.expireAndPruneExclusive(now);
    this.retentionSweep = sweep;
    try { return await sweep; }
    finally { if (this.retentionSweep === sweep) this.retentionSweep = undefined; }
  }

  private async expireAndPruneExclusive(now: Date): Promise<string[]> {
    const expired = await this.dependencies.store.listExpired(now, 1_000);
    const removed: string[] = []; let cleanupFailed = false;
    for (let record of expired) {
      if (record.status === 'applying'
        || (record.status === 'suggestions_ready' && effectiveMode(record.mode) === 'replace_with_ai_version')) {
        try { record = await this.refreshSingleflight(record); }
        catch { cleanupFailed = true; continue; }
        if (runNeedsRecovery(record)) { cleanupFailed = true; continue; }
      }
      let agent: AgentRun | undefined;
      try { agent = await this.dependencies.agentRuns.get(record.agentRunId); }
      catch { cleanupFailed = true; continue; }
      if (agent && !TERMINAL_AGENT_STATES.has(agent.state)) {
        if (runNeedsRecovery(record)) {
          const cleanup = record.retentionCleanup;
          if (cleanup && now.getTime() < Date.parse(cleanup.cancelDeadlineAt)) continue;
          if (cleanup && cleanup.cancelAttempts >= MAX_RETENTION_CANCEL_ATTEMPTS) {
            cleanupFailed = true; continue;
          }
          try {
            if (record.status !== 'cancel_requested' || cleanup) {
              await this.dependencies.agentRuns.cancel(record.agentRunId, 'CV-AI-Lauf wegen Retention abgebrochen.');
            }
            const requestedAt = now.toISOString();
            await this.save(record, {
              status: 'cancel_requested', retentionCleanup: {
                cancelRequestedAt: cleanup?.cancelRequestedAt ?? requestedAt,
                cancelDeadlineAt: new Date(now.getTime() + RETENTION_CANCEL_GRACE_MS).toISOString(),
                cancelAttempts: (cleanup?.cancelAttempts ?? 0) + 1,
              },
            }, { action: 'expired' });
          } catch { cleanupFailed = true; }
        } else {
          try { await this.dependencies.agentRuns.cancel(record.agentRunId, 'Verwaister CV-AI-Raw-Run wegen Retention abgebrochen.'); }
          catch { cleanupFailed = true; }
        }
        continue;
      }
      if (agent) {
        try { await this.purgeRawRun(record.agentRunId); }
        catch { cleanupFailed = true; continue; }
      }
      try {
        if (await this.dependencies.store.compareAndDelete(record.id, record.revision, record.sha256)) removed.push(record.id);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new CvAiStructuringError('cv_ai_retention_cleanup_incomplete', 503, 'retention', true);
    return removed.sort();
  }

  /** Privacy-preserving cascade used before deleting the encrypted CV import itself. */
  async deleteForImport(cvImportId: string): Promise<string[]> {
    assertUuid(cvImportId);
    this.deletingImports.add(cvImportId);
    try {
      return await this.withImportOperation(cvImportId, async () => {
    let records = await this.dependencies.store.listByImport(cvImportId, 1_001);
    if (records.length > 1_000) error('cv_ai_import_run_limit_exceeded', 409, 'retention');
    records = await Promise.all(records.map(async (record) => record.status === 'applying' ? this.completeApply(record, false) : record));
    if (records.some((record) => record.status === 'applying')) error('cv_ai_import_apply_in_progress', 409, 'retention', true);

    // Phase one removes every raw prompt/output. Metadata remains recoverable until all purges are confirmed.
    for (const record of records) {
      let agent = await this.dependencies.agentRuns.get(record.agentRunId);
      if (agent && !TERMINAL_AGENT_STATES.has(agent.state)) {
        await this.dependencies.agentRuns.cancel(record.agentRunId, 'CV-Import und zugehörige KI-Daten werden gelöscht.');
        agent = await this.waitForAgentTerminal(record.agentRunId);
        if (agent && !TERMINAL_AGENT_STATES.has(agent.state)) {
          error('cv_ai_import_agent_cleanup_pending', 503, 'retention', true);
        }
      }
      if (agent) await this.purgeRawRun(record.agentRunId);
    }

    const removed: string[] = [];
    for (const record of records) {
      const current = await this.dependencies.store.get(record.id);
      if (!current) continue;
      if (await this.dependencies.store.compareAndDelete(current.id, current.revision, current.sha256)) removed.push(current.id);
    }
        return removed.sort();
      });
    } catch (caught) {
      if (caught instanceof CvAiStructuringError) throw caught;
      throw new CvAiStructuringError('cv_ai_import_cleanup_failed', 503, 'retention', true);
    }
  }

  private async startInternal(input: {
    cvImportId: string;
    expectedCvImportRevision: number;
    expectedCvImportSha256: string;
    provider: CvAiProviderSelection;
    disclosure: CvAiDisclosureConfirmation;
    mode?: CvAiStructuringMode;
    actor: CvAiActor;
    correlationId?: string;
  }, retry: { attempt: number; retryOf?: string }): Promise<CvAiStructuringPublicRun> {
    return this.withImportOperation(input.cvImportId, () => this.withStartAdmission(() => this.startInternalExclusive(input, retry)));
  }

  private async startInternalExclusive(input: {
    cvImportId: string;
    expectedCvImportRevision: number;
    expectedCvImportSha256: string;
    provider: CvAiProviderSelection;
    disclosure: CvAiDisclosureConfirmation;
    mode?: CvAiStructuringMode;
    actor: CvAiActor;
    correlationId?: string;
  }, retry: { attempt: number; retryOf?: string }): Promise<CvAiStructuringPublicRun> {
    if (this.dependencies.isEmergencyStopEnabled?.()) error('emergency_stop', 409, 'preflight');
    assertDisclosure(input.disclosure); assertActor(input.actor); assertUuid(input.cvImportId);
    const mode = assertMode(input.mode);
    if (this.deletingImports.has(input.cvImportId)) error('cv_import_deletion_in_progress', 409, 'preflight');
    if (input.correlationId !== undefined && !SAFE_ID.test(input.correlationId)) error('cv_ai_correlation_id_invalid', 400, 'preflight');
    const source = await this.requireSource(input.cvImportId); assertImportCas(source, input.expectedCvImportRevision, input.expectedCvImportSha256);
    const existingRuns = await this.dependencies.store.listByImport(input.cvImportId, 20);
    if (existingRuns.some((record) => record.status === 'suggestions_ready'
      && effectiveMode(record.mode) === 'replace_with_ai_version')) {
      error('cv_ai_run_already_active', 409, 'preflight');
    }
    const [contract, provider] = await Promise.all([this.dependencies.validation.contract(), this.resolveProvider(input.provider)]);
    const prompt = buildCvAiStructuringPrompt({
      sourceId: source.sourceId, sourceSha256: source.sourceSha256,
      extractedTextSha256: source.extractedTextSha256, baseProposalSha256: source.baseProposalSha256,
      lineManifestJson: source.lineManifestJson, lineManifestSha256: source.lineManifestSha256,
      outputContract: contract.outputContract, outputContractVersion: contract.outputContractVersion,
      outputSchemaJson: contract.outputSchemaJson, outputSchemaSha256: contract.outputSchemaSha256,
    });
    const id = this.id(); assertUuid(id);
    const limits = {
      wallTimeMs: 10 * 60_000, idleTimeMs: 2 * 60_000,
      stdoutBytes: 768 * 1024, stderrBytes: 256 * 1024, totalOutputBytes: 1024 * 1024,
      // The schema-bound CV manifest is the provider stdin payload. Interactive
      // follow-up remains impossible because approval/input capabilities are denied.
      maxInputBytes: 768 * 1024, maxResidentMemoryBytes: 1024 * 1024 * 1024, maxChildProcesses: 4,
    };
    if (provider.profile && typeof provider.profile === 'object') {
      // The fixed CV ceiling may only be tightened by the active profile.
      const configured = (await this.dependencies.configProfiles.load()).profile.budgets.maxRunDurationMs;
      if (configured !== undefined) limits.wallTimeMs = Math.min(limits.wallTimeMs, configured);
    }
    const request: AgentRunRequest = {
      provider: provider.runner.provider, task: prompt.task, workspaceRoot: this.dependencies.workspaceRoot,
      runtimeTarget: input.provider.runtimeTarget, wslDistribution: input.provider.wslDistribution,
      sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
      model: input.provider.model ?? provider.profile.model, limits,
      metadata: {
        workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], cvAiStructuringRunId: id,
        providerToolMode: 'none', cvAiStructuringMode: mode,
        cvImportId: source.id, ownerId: input.actor.id,
        expectedProviderVersion: provider.installation.version,
        expectedAdapterVersion: provider.capabilities.adapterVersion,
        sourceSha256: source.sourceSha256, extractedTextSha256: source.extractedTextSha256,
        baseProposalSha256: source.baseProposalSha256, lineManifestSha256: source.lineManifestSha256,
        promptTemplateVersion: prompt.templateVersion, promptSha256: prompt.promptSha256,
        outputSchemaSha256: contract.outputSchemaSha256, inputSha256: prompt.inputSha256,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      },
    };
    if (this.deletingImports.has(input.cvImportId)) error('cv_import_deletion_in_progress', 409, 'preflight');
    try { await this.dependencies.store.assertCanCreate(input.cvImportId); }
    catch { error('cv_ai_run_capacity_exceeded', 409, 'preflight'); }
    let agent: AgentRun;
    try { agent = await this.dependencies.agentRuns.enqueue(request); }
    catch (caught) { throw new CvAiStructuringError('cv_ai_agent_enqueue_failed', 503, 'agent', true); }
    const createdAt = this.now().toISOString();
    const record = sealCvAiStructuringRun({
      contract: 'cv-ai-structuring-run', contractVersion: '1.0', id, cvImportId: source.id, revision: 1,
      status: 'queued', mode, attempt: retry.attempt, ...(retry.retryOf ? { retryOf: retry.retryOf } : {}),
      createdAt, updatedAt: createdAt, expiresAt: new Date(Date.parse(createdAt) + this.runTtlMs).toISOString(),
      provider: {
        id: provider.runner.provider, runtimeTarget: input.provider.runtimeTarget,
        ...(input.provider.wslDistribution ? { wslDistribution: input.provider.wslDistribution } : {}),
        version: provider.installation.version!, adapterVersion: provider.capabilities.adapterVersion,
      },
      disclosure: {
        version: '1.0', confirmedAt: createdAt, confirmedBy: structuredClone(input.actor), extractedCvTextShared: true,
        providerControlPlaneNetworkAcknowledged: true, toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false,
      },
      binding: {
        cvImportRevision: source.revision, cvImportSha256: source.sha256, sourceId: source.sourceId,
        sourceSha256: source.sourceSha256, extractedTextSha256: source.extractedTextSha256,
        baseProposalSha256: source.baseProposalSha256, lineManifestSha256: source.lineManifestSha256,
        promptTemplateVersion: prompt.templateVersion, promptSha256: prompt.promptSha256,
        outputContractVersion: contract.outputContractVersion, outputSchemaSha256: contract.outputSchemaSha256,
        inputSha256: prompt.inputSha256,
      },
      agentRunId: agent.id,
      auditTrail: [{
        sequence: 1, occurredAt: createdAt, action: retry.retryOf ? 'retried' : 'started',
        actorId: input.actor.id, ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }],
    });
    if (this.deletingImports.has(input.cvImportId)) {
      try { await this.cleanupUntrackedAgentRun(agent.id, 'CV-Import wird gelöscht; neuer CV-AI-Lauf wurde verworfen.'); }
      catch {
        try { await this.dependencies.store.create(record); }
        catch { throw new CvAiStructuringError('cv_ai_agent_cleanup_untracked', 503, 'retention', true); }
        throw new CvAiStructuringError('cv_ai_agent_cleanup_pending', 503, 'retention', true);
      }
      error('cv_import_deletion_in_progress', 409, 'preflight');
    }
    try { await this.dependencies.store.create(record); }
    catch {
      let cleanupError: unknown;
      try { await this.cleanupUntrackedAgentRun(agent.id, 'CV-AI-Metadaten konnten nicht gespeichert werden.'); }
      catch (caught) { cleanupError = caught; }
      const existing = await this.dependencies.store.get(record.id).catch(() => undefined);
      if (cleanupError === undefined && existing) {
        await this.dependencies.store.compareAndDelete(existing.id, existing.revision, existing.sha256).catch(() => undefined);
      } else if (cleanupError !== undefined && !existing) {
        try { await this.dependencies.store.create(record); }
        catch { throw new CvAiStructuringError('cv_ai_agent_cleanup_untracked', 503, 'retention', true); }
      }
      if (cleanupError !== undefined) throw new CvAiStructuringError('cv_ai_agent_cleanup_pending', 503, 'retention', true);
      throw new CvAiStructuringError('cv_ai_run_store_failed', 503, 'retention', true);
    }
    if (this.deletingImports.has(input.cvImportId)) {
      await this.cleanupUntrackedAgentRun(agent.id, 'CV-Import wird gelöscht; CV-AI-Lauf wurde verworfen.');
      const current = await this.dependencies.store.get(record.id);
      if (current) await this.dependencies.store.compareAndDelete(current.id, current.revision, current.sha256);
      error('cv_import_deletion_in_progress', 409, 'preflight');
    }
    return publicCvAiStructuringRun(record);
  }

  private async resolveProvider(selection: CvAiProviderSelection): Promise<ResolvedProvider> {
    if (!selection || !SAFE_ID.test(selection.providerId) || !['windows', 'wsl', 'linux', 'darwin'].includes(selection.runtimeTarget)
      || !selection.expectedVersion?.trim() || (selection.runtimeTarget === 'wsl') !== Boolean(selection.wslDistribution)
      || (selection.model !== undefined
        && (typeof selection.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(selection.model)))) {
      error('cv_ai_provider_selection_invalid', 400, 'preflight');
    }
    const runner = this.providers.get(selection.providerId);
    if (!runner) error('provider_unknown', 409, 'preflight');
    const loaded = await this.dependencies.configProfiles.load();
    const profile = loaded.profile.providers.find((entry) => entry.provider === selection.providerId);
    const installation = (await runner.discover()).find((entry) => entry.runtimeTarget === selection.runtimeTarget
      && entry.distribution === selection.wslDistribution && entry.version === selection.expectedVersion);
    if (!installation) error('installation_unavailable', 409, 'preflight');
    let capabilities: AgentCapabilities;
    try { capabilities = installation.capabilities ?? await runner.capabilities(installation); }
    catch { error('provider_capabilities_unavailable', 409, 'preflight'); }
    const blockers = this.providerBlockers(installation, capabilities, profile);
    if (blockers.length) error(blockers[0]!, 409, 'preflight');
    return { runner, installation, capabilities, profile: profile! };
  }

  private providerBlockers(
    installation: AgentProviderInstallation,
    capabilities: AgentCapabilities | undefined,
    profile: AgentProviderProfile | undefined,
  ): string[] {
    const blockers: string[] = [];
    if (installation.provider === 'fake' && this.dependencies.allowSyntheticProviders !== true) {
      blockers.push('synthetic_provider_test_only');
    }
    if (!profile?.enabled) blockers.push('provider_disabled_by_profile');
    else {
      if (profile.runtimeTarget !== installation.runtimeTarget) blockers.push('runtime_blocked_by_profile');
      if (profile.wslDistribution && profile.wslDistribution !== installation.distribution) blockers.push('distribution_blocked_by_profile');
    }
    if (installation.support !== 'supported') blockers.push('installation_not_supported');
    if (installation.authStatus === 'unauthenticated') blockers.push('provider_not_authenticated');
    if (!installation.version) blockers.push('provider_version_unknown');
    if (!capabilities || !capabilities.structuredOutput) blockers.push('structured_output_not_supported');
    if (capabilities?.tools !== false
      && capabilities?.extensions?.serverOwnedNoToolsMode !== 'cv-ai-structuring-v1') {
      blockers.push('provider_zero_tools_not_supported');
    }
    if (capabilities && (typeof capabilities.extensions?.externalSandbox !== 'string'
      || capabilities.extensions.networkAccessClaim !== 'provider-control-plane-only')) {
      blockers.push('provider_runtime_attestation_not_supported');
    }
    if (!capabilities?.sandboxPolicies.includes('read-only')) blockers.push('read_only_not_supported');
    if (capabilities && !capabilities.supportedRuntimeTargets.includes(installation.runtimeTarget)) blockers.push('runtime_not_supported');
    if (capabilities && capabilities.provider !== installation.provider) blockers.push('capability_provider_mismatch');
    if (!capabilities?.providerVersion || capabilities.providerVersion !== installation.version) blockers.push('capability_version_mismatch');
    return [...new Set(blockers)];
  }

  private async refresh(record: CvAiStructuringRunRecord): Promise<CvAiStructuringRunRecord> {
    if (record.status === 'applying') {
      return this.withImportOperation(record.cvImportId, () => this.completeApply(record, false));
    }
    if (record.status === 'suggestions_ready' && effectiveMode(record.mode) === 'replace_with_ai_version') {
      return this.withImportOperation(record.cvImportId, () => this.completeRecognitionVersion(record));
    }
    if (!['queued', 'running', 'validating', 'cancel_requested'].includes(record.status)) return record;
    const agent = await this.dependencies.agentRuns.get(record.agentRunId);
    if (!agent) return this.fail(record, { code: 'agent_run_missing', stage: 'agent', retryable: true });
    if (!this.agentRequestBindingMatches(record, agent)) {
      return this.quarantineAgentRun(record, agent, 'agent_request_binding_mismatch');
    }
    if (record.status === 'cancel_requested') {
      if (!TERMINAL_AGENT_STATES.has(agent.state)) return record;
      try { await this.purgeRawRun(record.agentRunId); } catch { return record; }
      return this.save(record, { status: 'cancelled', retentionCleanup: undefined }, { action: 'cancelled' });
    }
    if (['queued', 'starting'].includes(agent.state)) return record;
    if (['running', 'cancelling'].includes(agent.state)) {
      return record.status === 'queued' ? this.save(record, { status: 'running' }) : record;
    }
    if (['waiting_for_input', 'waiting_for_approval', 'orphaned', 'recovering'].includes(agent.state)) {
      return this.quarantineAgentRun(record, agent, 'agent_interaction_forbidden');
    }
    if (agent.state === 'cancelled') {
      try { await this.purgeRawRun(record.agentRunId); } catch { return record; }
      return this.save(record, { status: 'cancelled', retentionCleanup: undefined }, { action: 'cancelled' });
    }
    if (agent.state === 'failed' || agent.state === 'timed_out') {
      const failure = await this.classifyAgentFailure(agent);
      try { await this.purgeRawRun(record.agentRunId); } catch { return record; }
      return this.fail(record, failure);
    }
    if (!this.agentCapabilitiesMatch(record, agent.capabilities)) {
      return this.quarantineAgentRun(record, agent, 'agent_capability_binding_mismatch');
    }
    if (agent.state !== 'succeeded') return record;

    let current = record;
    if (current.status !== 'validating') current = await this.save(current, { status: 'validating' }, { action: 'provider_completed' });
    try {
      const events = await this.dependencies.agentRuns.events(current.agentRunId);
      if (events.some((event) => /^(?:tool(?:_|$)|approval(?:_|$)|(?:user_)?input(?:_|$))/.test(event.kind))) {
        return this.quarantineAgentRun(current, agent, 'provider_tool_activity_forbidden');
      }
      if (!this.processAttestationMatches(current, agent.capabilities!, events)) {
        return this.quarantineAgentRun(current, agent, 'provider_process_attestation_mismatch');
      }
      const outputs = events.filter((event) => event.kind === 'agent_message_completed')
        .map((event) => (event.data as Record<string, unknown>).text)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      // A provider may stream one answer as several text blocks: the Claude CLI
      // emits an assistant event per block, so a long structure arrives in
      // fragments and no single message holds the object. Demanding exactly one
      // rejected those runs outright, and taking only the last one keeps just
      // the tail. Joining in order reconstructs the answer and leaves the
      // single-block case byte-identical.
      const output = outputs.join('');
      const withinCeiling = Boolean(output) && Buffer.byteLength(output, 'utf8') <= MAX_PROVIDER_OUTPUT_BYTES;
      const aiProposal = withinCeiling ? extractProviderJsonObject(output) : undefined;
      if (!aiProposal) {
        // Three paths reach this rejection — no message at all, an answer over
        // the byte ceiling, or text carrying no object — and the raw run is
        // purged moments later, so this is the only moment at which they can
        // still be told apart. Counts and event kinds only; never the answer.
        await this.recordProviderOutputShape(current, events, outputs, output);
        error('provider_output_not_strict_json', 502, 'validation');
      }
      const source = await this.requireSource(current.cvImportId);
      if (source.sourceId !== current.binding.sourceId || source.sourceSha256 !== current.binding.sourceSha256
        || source.extractedTextSha256 !== current.binding.extractedTextSha256
        || source.baseProposalSha256 !== current.binding.baseProposalSha256) error('cv_ai_validation_binding_changed', 409, 'validation');
      const validated = await this.dependencies.validation.validateProposal({
        baseProposalArtifact: source.baseProposalArtifact,
        expectedBaseProposalSha256: current.binding.baseProposalSha256,
        aiProposal,
      });
      if (validated.contract !== 'validated-ai-cv-structure-proposal' || validated.contractVersion !== '1.0'
        || validated.status !== 'unverified' || validated.binding.sourceId !== current.binding.sourceId
        || validated.binding.sourceSha256 !== current.binding.sourceSha256
        || validated.binding.extractedTextSha256 !== current.binding.extractedTextSha256
        || validated.binding.baseProposalSha256 !== current.binding.baseProposalSha256) error('cv_ai_validated_binding_mismatch', 502, 'validation');
      assertSha(validated.proposalSha256, 'cv_ai_proposal_digest_invalid');
      const validatedRecord = await this.save(current, {
        status: 'suggestions_ready', proposal: {
          sha256: validated.proposalSha256, outputSha256: hash(output),
          suggestions: structuredClone(validated.suggestions), privateArtifact: validated.privateArtifact,
        },
      }, { action: 'validated', detailSha256: validated.proposalSha256 });
      if (effectiveMode(validatedRecord.mode) === 'replace_with_ai_version') {
        return this.withImportOperation(validatedRecord.cvImportId, () => this.completeRecognitionVersion(validatedRecord));
      }
      try { await this.purgeRawRun(validatedRecord.agentRunId); }
      catch { error('agent_run_purge_failed', 503, 'retention', true); }
      return validatedRecord;
    } catch (caught) {
      try { await this.purgeRawRun(current.agentRunId); }
      catch { return current; }
      return this.fail(current, safeFailure(caught, 'cv_ai_validation_failed', 'validation'));
    }
  }

  private async completeRecognitionVersion(record: CvAiStructuringRunRecord): Promise<CvAiStructuringRunRecord> {
    if (record.status !== 'suggestions_ready' || effectiveMode(record.mode) !== 'replace_with_ai_version' || !record.proposal) {
      error('cv_ai_recognition_materialization_not_ready', 409, 'apply');
    }
    let created: Awaited<ReturnType<CvAiStructuringImportPort['createAiRecognitionVersion']>>;
    try {
      const source = await this.requireSource(record.cvImportId);
      if (source.sourceId !== record.binding.sourceId || source.sourceSha256 !== record.binding.sourceSha256
        || source.extractedTextSha256 !== record.binding.extractedTextSha256
        || source.baseProposalSha256 !== record.binding.baseProposalSha256) {
        error('cv_ai_materialization_binding_changed', 409, 'apply');
      }
      if (!/^recognition-[a-f0-9]{16}$/.test(source.deterministicRecognitionVersionId)) {
        error('cv_ai_deterministic_version_binding_invalid', 502, 'apply');
      }
      const materialized = await this.dependencies.validation.materializeRecognitionVersion({
        baseProposalArtifact: source.baseProposalArtifact,
        expectedBaseProposalSha256: source.baseProposalSha256,
        aiProposalArtifact: record.proposal.privateArtifact,
        expectedAiProposalSha256: record.proposal.sha256,
      });
      assertSha(materialized.materializedProposalSha256, 'cv_ai_materialized_proposal_digest_invalid');
      if (!materialized.materializedArtifact || typeof materialized.materializedArtifact !== 'object') {
        error('cv_ai_materialized_artifact_invalid', 502, 'apply');
      }
      const expectedSelections = record.proposal.suggestions
        .filter((suggestion) => suggestion.mergeable && suggestion.value !== null)
        .map((suggestion) => ({ suggestionId: suggestion.id, alternativeId: null }));
      const expectedIds = new Set(expectedSelections.map((selection) => selection.suggestionId));
      if (expectedIds.size < 1
        || materialized.appliedSuggestionIds.length !== expectedIds.size
        || new Set(materialized.appliedSuggestionIds).size !== materialized.appliedSuggestionIds.length
        || materialized.appliedSuggestionIds.some((id) => !expectedIds.has(id))) {
        error('cv_ai_materialized_selection_binding_mismatch', 502, 'apply');
      }
      const aiFacts = materialized.facts.filter((fact) => fact.provenance.recognition?.method === 'ai_assisted');
      if (aiFacts.length < 1 || aiFacts.length !== expectedIds.size
        || materialized.facts.some((fact) => fact.decision !== 'pending')
        || new Set(aiFacts.map((fact) => fact.provenance.recognition?.suggestionId)).size !== expectedIds.size
        || aiFacts.some((fact) => !expectedIds.has(fact.provenance.recognition?.suggestionId ?? ''))) {
        error('cv_ai_materialized_fact_binding_mismatch', 502, 'apply');
      }
      if (!['windows', 'wsl'].includes(record.provider.runtimeTarget)) {
        error('cv_ai_materialized_provider_witness_invalid', 502, 'apply');
      }
      created = await this.dependencies.imports.createAiRecognitionVersion({
        id: source.id,
        expectedRevision: record.binding.cvImportRevision,
        expectedSha256: record.binding.cvImportSha256,
        facts: materialized.facts,
        warnings: materialized.warnings,
        unresolvedConflicts: materialized.unresolvedConflicts,
        normalizationArtifact: materialized.materializedArtifact,
        source: {
          deterministicRecognitionVersionId: source.deterministicRecognitionVersionId,
          sourceSha256: source.sourceSha256,
          baseProposalSha256: source.baseProposalSha256,
        },
        provenance: {
          runId: record.id,
          proposalSha256: record.proposal.sha256,
          artifactSha256: materialized.materializedProposalSha256,
          selections: expectedSelections,
        },
        provider: {
          id: record.provider.id,
          runtimeTarget: record.provider.runtimeTarget as 'windows' | 'wsl',
          version: record.provider.version,
          adapterVersion: record.provider.adapterVersion,
        },
      });
      assertSha(created.sha256, 'cv_ai_materialized_import_digest_invalid');
      if (!/^recognition-[a-f0-9]{16}$/.test(created.recognitionVersionId)
        || !Number.isSafeInteger(created.recognitionVersionCount) || created.recognitionVersionCount < 2
        || created.recognitionVersionCount > 20 || created.factIds.length !== materialized.facts.length
        || new Set(created.factIds).size !== created.factIds.length
        || created.factIds.some((id) => !materialized.facts.some((fact) => fact.id === id))) {
        error('cv_ai_materialized_import_binding_mismatch', 502, 'apply');
      }
    } catch (caught) {
      try {
        if (await this.dependencies.agentRuns.get(record.agentRunId)) await this.purgeRawRun(record.agentRunId);
      } catch { return record; }
      const failed = await this.fail(record, safeFailure(caught, 'cv_ai_materialization_failed', 'apply'));
      if (caught instanceof CvAiStructuringError
        && ['cv_import_revision_conflict', 'cv_import_sha_conflict'].includes(caught.code)) throw caught;
      return failed;
    }

    try {
      if (await this.dependencies.agentRuns.get(record.agentRunId)) await this.purgeRawRun(record.agentRunId);
    } catch { return record; }
    return this.save(record, {
      status: 'applied', failure: undefined,
      result: {
        cvImportRevision: created.revision,
        cvImportSha256: created.sha256,
        stagedFactIds: [...created.factIds],
        factsRemainPending: true,
        recognitionVersionId: created.recognitionVersionId,
        recognitionVersionCount: created.recognitionVersionCount,
      },
    }, {
      action: 'applied', detailSha256: record.proposal.sha256,
    });
  }

  private async completeApply(record: CvAiStructuringRunRecord, rethrowFailure: boolean): Promise<CvAiStructuringRunRecord> {
    if (record.status !== 'applying' || !record.proposal || !record.applyIntent) {
      error('cv_ai_apply_intent_missing', 409, 'apply');
    }
    const intent = record.applyIntent;
    const alreadyStaged = await this.dependencies.imports.findAiStage({
      id: record.cvImportId, runId: record.id, aiProposalSha256: record.proposal.sha256,
    });
    if (alreadyStaged) {
      const committed = this.assertCommittedStage(record, alreadyStaged);
      return this.finalizeApplied(record, committed);
    }
    if (this.deletingImports.has(record.cvImportId)) {
      return this.save(record, {
        status: 'failed', applyIntent: undefined,
        failure: { code: 'cv_import_deletion_in_progress', stage: 'apply', retryable: false },
      }, {
        action: 'failed', actorId: intent.confirmedBy.id, correlationId: intent.correlationId,
      });
    }

    let completedStage: { revision: number; sha256: string; stagedFactIds: string[] } | undefined;
    try {
      const source = await this.requireSource(record.cvImportId);
      assertImportCas(source, intent.expectedCvImportRevision, intent.expectedCvImportSha256);
      if (source.baseProposalSha256 !== record.binding.baseProposalSha256
        || source.sourceSha256 !== record.binding.sourceSha256
        || source.extractedTextSha256 !== record.binding.extractedTextSha256) {
        error('cv_ai_apply_import_binding_changed', 409, 'apply');
      }
      const merged = await this.dependencies.validation.applySelections({
        baseProposalArtifact: source.baseProposalArtifact,
        expectedBaseProposalSha256: source.baseProposalSha256,
        aiProposalArtifact: record.proposal.privateArtifact,
        expectedAiProposalSha256: record.proposal.sha256,
        selections: intent.selections,
      });
      assertSha(merged.mergedProposalSha256, 'cv_ai_merged_proposal_digest_invalid');
      this.assertSelectionFacts(merged.facts, source.sourceSha256, intent.selections);
      const selectedIds = new Set(intent.selections.map((selection) => selection.suggestionId));
      if (!Array.isArray(merged.appliedSuggestionIds)
        || merged.appliedSuggestionIds.length !== selectedIds.size
        || new Set(merged.appliedSuggestionIds).size !== merged.appliedSuggestionIds.length
        || merged.appliedSuggestionIds.some((id) => !selectedIds.has(id))) {
        error('cv_ai_apply_result_binding_mismatch', 502, 'apply');
      }
      if (!merged.mergedArtifact || typeof merged.mergedArtifact !== 'object') error('cv_ai_merged_artifact_invalid', 502, 'apply');
      const staged = await this.dependencies.imports.stageAiStructure({
        id: source.id, expectedRevision: source.revision, expectedSha256: source.sha256,
        runId: record.id, aiProposalSha256: record.proposal.sha256,
        expectedBaseProposalSha256: source.baseProposalSha256,
        mergedProposalSha256: merged.mergedProposalSha256, mergedArtifact: merged.mergedArtifact,
        facts: merged.facts, selections: intent.selections,
      });
      assertSha(staged.sha256, 'cv_ai_staged_import_digest_invalid');
      const factIds = new Set(merged.facts.map((fact) => fact.id));
      if (staged.revision <= source.revision || staged.stagedFactIds.length !== factIds.size
        || new Set(staged.stagedFactIds).size !== staged.stagedFactIds.length
        || staged.stagedFactIds.some((id) => !factIds.has(id))) {
        error('cv_ai_staged_import_binding_mismatch', 502, 'apply');
      }
      const committed = await this.dependencies.imports.findAiStage({
        id: record.cvImportId, runId: record.id, aiProposalSha256: record.proposal.sha256,
      });
      if (!committed) error('cv_ai_staged_import_missing', 502, 'apply');
      completedStage = this.assertCommittedStage(record, committed);
    } catch (caught) {
      const committed = await this.dependencies.imports.findAiStage({
        id: record.cvImportId, runId: record.id, aiProposalSha256: record.proposal.sha256,
      });
      if (committed) return this.finalizeApplied(record, this.assertCommittedStage(record, committed));
      const failure = safeFailure(caught, 'cv_ai_apply_failed', 'apply');
      const failed = await this.save(record, { status: 'failed', failure, applyIntent: undefined }, {
        action: 'failed', actorId: intent.confirmedBy.id, correlationId: intent.correlationId,
      });
      if (rethrowFailure) throw caught;
      return failed;
    }
    return this.finalizeApplied(record, completedStage!);
  }

  private assertCommittedStage(
    record: CvAiStructuringRunRecord,
    staged: { revision: number; sha256: string; facts: CvFact[] },
  ): { revision: number; sha256: string; stagedFactIds: string[] } {
    const intent = record.applyIntent!;
    assertSha(staged.sha256, 'cv_ai_staged_import_digest_invalid');
    if (!Number.isSafeInteger(staged.revision) || staged.revision <= intent.expectedCvImportRevision) {
      error('cv_ai_staged_import_binding_mismatch', 502, 'apply');
    }
    this.assertSelectionFacts(staged.facts, record.binding.sourceSha256, intent.selections, {
      persistedBinding: { runId: record.id, proposalSha256: record.proposal!.sha256 },
      allowReviewedDecisions: true,
    });
    return { revision: staged.revision, sha256: staged.sha256, stagedFactIds: staged.facts.map((fact) => fact.id) };
  }

  private async finalizeApplied(
    record: CvAiStructuringRunRecord,
    staged: { revision: number; sha256: string; stagedFactIds: string[] },
  ): Promise<CvAiStructuringRunRecord> {
    const intent = record.applyIntent!;
    try {
      return await this.save(record, {
        status: 'applied', applyIntent: undefined, failure: undefined,
        result: {
          cvImportRevision: staged.revision, cvImportSha256: staged.sha256,
          stagedFactIds: [...staged.stagedFactIds], factsRemainPending: true,
        },
      }, {
        action: 'applied', actorId: intent.confirmedBy.id, correlationId: intent.correlationId,
        detailSha256: record.proposal!.sha256,
      });
    } catch (caught) {
      const current = await this.dependencies.store.get(record.id).catch(() => undefined);
      if (current?.status === 'applied' && current.result
        && current.result.cvImportRevision === staged.revision && current.result.cvImportSha256 === staged.sha256
        && current.result.stagedFactIds.length === staged.stagedFactIds.length
        && current.result.stagedFactIds.every((id) => staged.stagedFactIds.includes(id))) return current;
      throw caught;
    }
  }

  private agentRequestBindingMatches(record: CvAiStructuringRunRecord, agent: AgentRun): boolean {
    const metadata = agent.request.metadata;
    if (!metadata) return false;
    return agent.id === record.agentRunId
      && agent.provider === record.provider.id
      && agent.request.provider === record.provider.id
      && agent.request.runtimeTarget === record.provider.runtimeTarget
      && agent.request.wslDistribution === record.provider.wslDistribution
      && agent.request.sandbox === 'read-only'
      && agent.request.network === 'disabled'
      && agent.request.approvalMode === 'deny'
      && metadata.workflowId === 'cv-ai-structuring'
      && metadata.cvAiStructuringRunId === record.id
      && metadata.cvImportId === record.cvImportId
      && (metadata.cvAiStructuringMode === effectiveMode(record.mode)
        || (record.mode === undefined && metadata.cvAiStructuringMode === undefined))
      && metadata.providerToolMode === 'none'
      && Array.isArray(metadata.requiredRootMcpTools) && metadata.requiredRootMcpTools.length === 0
      && metadata.expectedProviderVersion === record.provider.version
      && metadata.expectedAdapterVersion === record.provider.adapterVersion
      && metadata.promptSha256 === record.binding.promptSha256
      && metadata.outputSchemaSha256 === record.binding.outputSchemaSha256;
  }

  private agentCapabilitiesMatch(record: CvAiStructuringRunRecord, capabilities: AgentCapabilities | undefined): boolean {
    if (!capabilities) return false;
    const noToolsNegotiated = capabilities.tools === false
      || capabilities.extensions?.serverOwnedNoToolsMode === 'cv-ai-structuring-v1';
    return capabilities.provider === record.provider.id
      && capabilities.providerVersion === record.provider.version
      && capabilities.adapterVersion === record.provider.adapterVersion
      && capabilities.structuredOutput === true
      && capabilities.sandboxPolicies.includes('read-only')
      && capabilities.supportedRuntimeTargets.includes(record.provider.runtimeTarget)
      && noToolsNegotiated;
  }

  private processAttestationMatches(
    record: CvAiStructuringRunRecord,
    capabilities: AgentCapabilities,
    events: readonly AgentEvent[],
  ): boolean {
    const started = events.filter((event) => event.kind === 'process_started');
    if (started.length !== 1) return false;
    const data = started[0]!.data as Record<string, unknown>;
    const declaredSandbox = capabilities.extensions?.externalSandbox;
    const expectedSandbox = record.provider.runtimeTarget === 'wsl'
      && ['opencode', 'claude-cli'].includes(record.provider.id)
      ? 'wsl-bubblewrap-v1'
      : declaredSandbox;
    const processMatches = typeof expectedSandbox === 'string' && expectedSandbox.length > 0
      && capabilities.extensions?.networkAccessClaim === 'provider-control-plane-only'
      && data.runtimeTarget === record.provider.runtimeTarget
      && data.sandboxEnforcement === expectedSandbox
      && data.networkAccessClaim === 'provider-control-plane-only';
    if (!processMatches) return false;
    if (record.provider.id !== 'claude-cli') return true;
    const initialized = events.filter((event) => event.kind === 'heartbeat'
      && (event.data as Record<string, unknown>).phase === 'initialized');
    if (initialized.length !== 1) return false;
    const heartbeat = initialized[0]!.data as Record<string, unknown>;
    return (heartbeat.providerVersion === '2.1.232' || heartbeat.providerVersion === '2.1.233')
      && heartbeat.permissionMode === 'plan'
      && Array.isArray(heartbeat.tools) && heartbeat.tools.length === 0;
  }

  private async classifyAgentFailure(
    agent: AgentRun,
  ): Promise<NonNullable<CvAiStructuringRunRecord['failure']>> {
    if (agent.state === 'timed_out') {
      return { code: 'agent_run_timed_out', stage: 'agent', retryable: true };
    }
    let eventCode: string | undefined;
    try {
      const events = await this.dependencies.agentRuns.events(agent.id);
      eventCode = events.filter((event) => event.kind === 'error').map((event) => {
        const value = (event.data as Record<string, unknown>).code;
        return typeof value === 'string' && SAFE_AGENT_FAILURE_CODES.has(value) ? value : undefined;
      }).find((value): value is string => value !== undefined);
    } catch { /* The terminal run failure below remains the safe fallback. */ }
    const agentCode = agent.failure?.code;
    const code = eventCode ?? (agentCode && SAFE_AGENT_FAILURE_CODES.has(agentCode) ? agentCode : 'agent_run_failed');
    return { code, stage: 'agent', retryable: agent.failure?.retryable ?? true };
  }

  private async quarantineAgentRun(
    record: CvAiStructuringRunRecord,
    observed: AgentRun,
    code: string,
  ): Promise<CvAiStructuringRunRecord> {
    let agent: AgentRun | undefined = observed;
    if (!TERMINAL_AGENT_STATES.has(agent.state)) {
      try { await this.dependencies.agentRuns.cancel(record.agentRunId, `CV-AI-Sicherheitsabbruch: ${code}`); }
      catch { return record; }
      try { agent = await this.dependencies.agentRuns.get(record.agentRunId); }
      catch { return record; }
      if (agent && !TERMINAL_AGENT_STATES.has(agent.state)) return record;
    }
    if (agent) {
      try { await this.purgeRawRun(record.agentRunId); }
      catch { return record; }
    }
    return this.fail(record, { code, stage: 'agent', retryable: false });
  }

  /**
   * Writes the shape of a rejected provider answer as counters, so that a
   * single failed run answers which rejection path was taken without the
   * answer, the prompt or any CV content leaving the process.
   */
  private async recordProviderOutputShape(
    record: CvAiStructuringRunRecord,
    events: readonly AgentEvent[],
    outputs: readonly string[],
    output: string,
  ): Promise<void> {
    const sink = this.dependencies.observability;
    if (!sink) return;
    const kinds = new Map<string, number>();
    for (const event of events) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    const counters: Array<readonly [string, number]> = [
      ['events_total', events.length],
      ['message_events', kinds.get('agent_message_completed') ?? 0],
      ['message_blocks_with_text', outputs.length],
      ['output_bytes', Buffer.byteLength(output, 'utf8')],
      ['open_braces', (output.match(/\{/g) ?? []).length],
      ...[...kinds].map(([kind, count]) => [`kind.${observabilityClass(kind)}`, count] as const),
    ];
    const provider = /^[a-z][a-z0-9-]{0,63}$/.test(record.provider.id) ? record.provider.id : undefined;
    for (const [errorClass, eventSequence] of counters) {
      // Diagnosis is best effort: one unloggable value must not turn a
      // diagnosable failure into a different, unrelated one.
      try {
        await sink.record({
          level: 'warn', component: 'cv_ai_structuring', operation: 'provider_output_shape',
          code: 'provider_output_not_strict_json', runId: record.agentRunId,
          provider, errorClass, eventSequence,
        });
      } catch { /* the failure itself is already being reported */ }
    }
  }

  private async purgeRawRun(runId: string): Promise<void> {
    const effects = await this.dependencies.purger.deleteRuns([runId]);
    if (!Array.isArray(effects) || effects.length !== 1 || effects[0]?.runId !== runId
      || !Number.isSafeInteger(effects[0].events) || effects[0].events < 0) {
      error('agent_run_purge_unconfirmed', 503, 'retention', true);
    }
  }

  private async waitForAgentTerminal(runId: string): Promise<AgentRun | undefined> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const agent = await this.dependencies.agentRuns.get(runId);
      if (!agent || TERMINAL_AGENT_STATES.has(agent.state)) return agent;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return this.dependencies.agentRuns.get(runId);
  }

  private async cleanupUntrackedAgentRun(runId: string, reason: string): Promise<void> {
    await this.dependencies.agentRuns.cancel(runId, reason);
    const agent = await this.waitForAgentTerminal(runId);
    if (agent && !TERMINAL_AGENT_STATES.has(agent.state)) {
      error('cv_ai_agent_cleanup_pending', 503, 'retention', true);
    }
    if (agent) await this.purgeRawRun(runId);
  }

  private async refreshSingleflight(record: CvAiStructuringRunRecord): Promise<CvAiStructuringRunRecord> {
    const pending = this.runRefreshes.get(record.id);
    if (pending) return pending;
    const refresh = (async () => {
      const latest = await this.required(record.cvImportId, record.id);
      return this.refresh(latest);
    })();
    this.runRefreshes.set(record.id, refresh);
    try { return await refresh; }
    finally {
      if (this.runRefreshes.get(record.id) === refresh) this.runRefreshes.delete(record.id);
    }
  }

  private async withImportOperation<T>(cvImportId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.importOperationTails.get(cvImportId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.importOperationTails.set(cvImportId, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.importOperationTails.get(cvImportId) === tail) this.importOperationTails.delete(cvImportId);
    }
  }

  private async withStartAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.startAdmissionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.startAdmissionTail = previous.then(() => current);
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private validateSelections(
    suggestions: CvAiStructuringSuggestion[],
    input: CvAiStructuringSelection[],
  ): CvAiStructuringSelection[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SELECTIONS) error('cv_ai_selections_invalid', 400, 'apply');
    const byId = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
    const seen = new Set<string>();
    return input.map((selection) => {
      if (!selection || !SAFE_ID.test(selection.suggestionId) || seen.has(selection.suggestionId)
        || (selection.alternativeId !== null && !SAFE_ID.test(selection.alternativeId))) error('cv_ai_selection_invalid', 400, 'apply');
      const suggestion = byId.get(selection.suggestionId);
      if (!suggestion?.mergeable || (selection.alternativeId === null ? suggestion.value === null
        : !suggestion.alternatives.some((alternative) => alternative.id === selection.alternativeId))) error('cv_ai_selection_unknown', 409, 'apply');
      seen.add(selection.suggestionId);
      return { suggestionId: selection.suggestionId, alternativeId: selection.alternativeId };
    });
  }

  private assertSelectionFacts(
    facts: CvFact[],
    sourceSha256: string,
    selections: readonly CvAiStructuringSelection[],
    options: {
      persistedBinding?: { runId: string; proposalSha256: string };
      allowReviewedDecisions?: boolean;
    } = {},
  ): void {
    if (!Array.isArray(facts) || facts.length !== selections.length || facts.length < 1 || facts.length > MAX_SELECTIONS) {
      error('cv_ai_pending_facts_invalid', 502, 'apply');
    }
    const ids = new Set<string>(); const selected = new Map(selections.map((item) => [item.suggestionId, item]));
    const witnessed = new Set<string>();
    for (const fact of facts) {
      const recognition = fact?.provenance?.recognition;
      const selection = recognition?.suggestionId ? selected.get(recognition.suggestionId) : undefined;
      const decisionIsAllowed = fact?.decision === 'pending'
        || (options.allowReviewedDecisions === true && (fact?.decision === 'confirmed' || fact?.decision === 'rejected'));
      if (!fact || !SAFE_ID.test(fact.id) || ids.has(fact.id) || !decisionIsAllowed
        || fact.provenance?.origin !== 'imported' || fact.provenance.sourceSha256 !== sourceSha256
        || recognition?.method !== 'ai_assisted' || !selection || witnessed.has(selection.suggestionId)
        || (selection.alternativeId === null
          ? recognition.selectedAlternativeId !== undefined
          : recognition.selectedAlternativeId !== selection.alternativeId)
        || (options.persistedBinding !== undefined && (recognition.runId !== options.persistedBinding.runId
          || recognition.proposalSha256 !== options.persistedBinding.proposalSha256))) {
        error('cv_ai_pending_facts_invalid', 502, 'apply');
      }
      ids.add(fact.id); witnessed.add(selection.suggestionId);
    }
    if (witnessed.size !== selected.size) error('cv_ai_pending_facts_invalid', 502, 'apply');
  }

  private async requireSource(id: string): Promise<CvAiStructuringImportSource> {
    assertUuid(id); const source = await this.dependencies.imports.loadAiSource(id);
    if (!source) error('cv_import_not_found', 404, 'preflight');
    for (const value of [source.sha256, source.sourceSha256, source.extractedTextSha256, source.baseProposalSha256, source.lineManifestSha256]) {
      if (!SHA256.test(value)) error('cv_ai_import_binding_invalid', 409, 'preflight');
    }
    if (source.id !== id || !Number.isSafeInteger(source.revision) || source.revision < 1
      || !/^source-cv-[a-f0-9]{16}$/.test(source.sourceId) || !source.baseProposalArtifact || typeof source.baseProposalArtifact !== 'object') {
      error('cv_ai_import_binding_invalid', 409, 'preflight');
    }
    return source;
  }

  private async required(cvImportId: string, runId: string): Promise<CvAiStructuringRunRecord> {
    assertUuid(cvImportId); assertUuid(runId); const record = await this.dependencies.store.get(runId);
    if (!record || record.cvImportId !== cvImportId) error('cv_ai_run_not_found', 404, 'preflight');
    return record;
  }

  private async save(
    current: CvAiStructuringRunRecord,
    patch: Partial<CvAiStructuringRunRecord>,
    audit?: Omit<CvAiStructuringRunRecord['auditTrail'][number], 'sequence' | 'occurredAt'>,
  ): Promise<CvAiStructuringRunRecord> {
    const occurredAt = this.now().toISOString();
    const auditTrail = audit ? [...current.auditTrail, {
      sequence: current.auditTrail.length + 1, occurredAt,
      ...audit,
    }] : current.auditTrail;
    const next = sealCvAiStructuringRun({
      ...current, ...patch, revision: current.revision + 1, updatedAt: occurredAt, auditTrail,
    });
    await this.dependencies.store.compareAndSave(current.id, current.revision, current.sha256, next);
    return next;
  }

  private async fail(
    record: CvAiStructuringRunRecord,
    failure: NonNullable<CvAiStructuringRunRecord['failure']>,
  ): Promise<CvAiStructuringRunRecord> {
    return this.save(record, { status: 'failed', failure, retentionCleanup: undefined }, { action: 'failed' });
  }
}
