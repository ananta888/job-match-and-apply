import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeTarget } from '../ports/agent-runner.js';

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_INVENTORY = 1_000;
const MAX_RUNS_PER_IMPORT = 20;
const MAX_AUDIT_ENTRIES = 100;
const MAX_SUGGESTIONS = 2_000;
const MAX_IMPORT_RUNS = 1_001;
const MAX_ALTERNATIVES = 10;
const MAX_QUESTIONS = 10;
const RUN_STATUSES = new Set<CvAiStructuringRunStatus>([
  'queued', 'running', 'validating', 'suggestions_ready', 'cancel_requested',
  'cancelled', 'applying', 'applied', 'failed', 'expired',
]);
const AUDIT_ACTIONS = new Set<CvAiStructuringAuditEntry['action']>([
  'started', 'provider_completed', 'validated', 'cancel_requested', 'cancelled',
  'retried', 'apply_started', 'applied', 'failed', 'expired',
]);
export type CvAiStructuringRunStatus =
  | 'queued'
  | 'running'
  | 'validating'
  | 'suggestions_ready'
  | 'cancel_requested'
  | 'cancelled'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'expired';

export type CvAiStructuringMode = 'review_suggestions' | 'replace_with_ai_version';

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

/** Public, validator-owned projection. It never carries an authoritative fact decision. */
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

export interface CvAiStructuringAuditEntry {
  sequence: number;
  occurredAt: string;
  action: 'started' | 'provider_completed' | 'validated' | 'cancel_requested' | 'cancelled' | 'retried' | 'apply_started' | 'applied' | 'failed' | 'expired';
  actorId?: string;
  correlationId?: string;
  detailSha256?: string;
}

/** Private crash-recovery journal. It is encrypted at rest and never exposed by REST. */
export interface CvAiStructuringApplyIntent {
  expectedCvImportRevision: number;
  expectedCvImportSha256: string;
  selections: Array<{ suggestionId: string; alternativeId: string | null }>;
  confirmedBy: { id: string; type: 'local' | 'authenticated' };
  correlationId?: string;
}

export interface CvAiStructuringRetentionCleanup {
  cancelRequestedAt: string;
  cancelDeadlineAt: string;
  cancelAttempts: number;
}

export interface CvAiStructuringRunRecord {
  contract: 'cv-ai-structuring-run';
  contractVersion: '1.0';
  id: string;
  cvImportId: string;
  revision: number;
  sha256: string;
  status: CvAiStructuringRunStatus;
  /** Missing only on records created before recognition-version support. */
  mode?: CvAiStructuringMode;
  attempt: number;
  retryOf?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  provider: {
    id: string;
    runtimeTarget: Exclude<RuntimeTarget, 'container'>;
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
  agentRunId: string;
  proposal?: {
    sha256: string;
    outputSha256: string;
    suggestions: CvAiStructuringSuggestion[];
    /** Validated submodule DTO, encrypted at rest and omitted from REST views. */
    privateArtifact: unknown;
  };
  applyIntent?: CvAiStructuringApplyIntent;
  retentionCleanup?: CvAiStructuringRetentionCleanup;
  result?: {
    cvImportRevision: number;
    cvImportSha256: string;
    stagedFactIds: string[];
    factsRemainPending: true;
    recognitionVersionId?: string;
    recognitionVersionCount?: number;
  };
  failure?: {
    code: string;
    stage: 'preflight' | 'agent' | 'validation' | 'retention' | 'apply';
    retryable: boolean;
  };
  auditTrail: CvAiStructuringAuditEntry[];
}

export interface CvAiStructuringRunStore {
  assertCanCreate(cvImportId: string): Promise<void>;
  create(record: CvAiStructuringRunRecord): Promise<void>;
  get(id: string): Promise<CvAiStructuringRunRecord | undefined>;
  listByImport(cvImportId: string, limit?: number): Promise<CvAiStructuringRunRecord[]>;
  compareAndSave(
    id: string,
    expectedRevision: number,
    expectedSha256: string,
    next: CvAiStructuringRunRecord,
  ): Promise<void>;
  compareAndDelete(id: string, expectedRevision: number, expectedSha256: string): Promise<boolean>;
  listExpired(now?: Date, limit?: number): Promise<CvAiStructuringRunRecord[]>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cv_ai_run_non_json_value');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') throw new Error('cv_ai_run_non_json_value');
  if (seen.has(value)) throw new Error('cv_ai_run_cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function recordHash(record: Omit<CvAiStructuringRunRecord, 'sha256'> | CvAiStructuringRunRecord): string {
  const { sha256: _ignored, ...body } = record as CvAiStructuringRunRecord;
  return hash(body);
}

function validDate(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAnchor(anchor: CvAiSourceAnchor | null): boolean {
  if (anchor === null) return true;
  return Number.isSafeInteger(anchor.lineStart) && anchor.lineStart >= 1
    && Number.isSafeInteger(anchor.lineEnd) && anchor.lineEnd >= anchor.lineStart
    && Number.isSafeInteger(anchor.charStart) && anchor.charStart >= 0
    && Number.isSafeInteger(anchor.charEnd)
    && (anchor.lineStart === anchor.lineEnd ? anchor.charEnd > anchor.charStart : anchor.charEnd >= 1)
    && boundedText(anchor.quote, 8_000);
}

function validValue(value: string | null): boolean {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 20_000 && !value.includes('\0'));
}

function assertRecord(record: CvAiStructuringRunRecord): void {
  if (record.contract !== 'cv-ai-structuring-run' || record.contractVersion !== '1.0') throw new Error('cv_ai_run_contract_invalid');
  if (!UUID.test(record.id) || !UUID.test(record.cvImportId) || !UUID.test(record.agentRunId) || (record.retryOf && !UUID.test(record.retryOf))) {
    throw new Error('cv_ai_run_id_invalid');
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.attempt) || record.attempt < 1) {
    throw new Error('cv_ai_run_revision_invalid');
  }
  if (!RUN_STATUSES.has(record.status)) throw new Error('cv_ai_run_status_invalid');
  if (record.mode !== undefined && !['review_suggestions', 'replace_with_ai_version'].includes(record.mode)) {
    throw new Error('cv_ai_run_mode_invalid');
  }
  if ((record.attempt === 1) === Boolean(record.retryOf)) throw new Error('cv_ai_run_retry_binding_invalid');
  if (![record.createdAt, record.updatedAt, record.expiresAt, record.disclosure.confirmedAt].every(validDate)) throw new Error('cv_ai_run_timestamp_invalid');
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt) || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
    throw new Error('cv_ai_run_timestamp_order_invalid');
  }
  if (!SAFE_ID.test(record.provider.id)
    || !['windows', 'wsl', 'linux', 'darwin'].includes(record.provider.runtimeTarget)
    || !boundedText(record.provider.version, 256)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(record.provider.adapterVersion)
    || (record.provider.runtimeTarget === 'wsl') !== Boolean(record.provider.wslDistribution)
    || (record.provider.wslDistribution !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.provider.wslDistribution))) {
    throw new Error('cv_ai_run_provider_invalid');
  }
  if (!SAFE_ID.test(record.disclosure.confirmedBy.id)
    || record.disclosure.extractedCvTextShared !== true
    || record.disclosure.providerControlPlaneNetworkAcknowledged !== true
    || record.disclosure.toolNetwork !== 'disabled'
    || record.disclosure.rootMcpTools.length !== 0
    || record.disclosure.jobSearchMcpAccessible !== false) throw new Error('cv_ai_run_disclosure_invalid');
  const digests = [
    record.sha256, record.binding.cvImportSha256, record.binding.sourceSha256,
    record.binding.extractedTextSha256, record.binding.baseProposalSha256,
    record.binding.lineManifestSha256, record.binding.promptSha256,
    record.binding.outputSchemaSha256, record.binding.inputSha256,
    record.proposal?.sha256, record.proposal?.outputSha256, record.result?.cvImportSha256,
    ...record.auditTrail.map((entry) => entry.detailSha256),
  ].filter((value): value is string => value !== undefined);
  if (digests.some((value) => !SHA256.test(value))) throw new Error('cv_ai_run_digest_invalid');
  if (!/^source-cv-[a-f0-9]{16}$/.test(record.binding.sourceId) || record.binding.promptTemplateVersion !== 'cv-ai-structuring/1.0'
    || record.binding.outputContractVersion !== '1.0') throw new Error('cv_ai_run_binding_invalid');
  if (record.auditTrail.length < 1 || record.auditTrail.length > MAX_AUDIT_ENTRIES
    || record.auditTrail.some((entry, index) => entry.sequence !== index + 1 || !validDate(entry.occurredAt)
      || !AUDIT_ACTIONS.has(entry.action)
      || (index > 0 && Date.parse(entry.occurredAt) < Date.parse(record.auditTrail[index - 1]!.occurredAt))
      || (entry.actorId !== undefined && !SAFE_ID.test(entry.actorId))
      || (entry.correlationId !== undefined && !SAFE_ID.test(entry.correlationId)))) throw new Error('cv_ai_run_audit_invalid');
  if (record.proposal) {
    if (record.proposal.suggestions.length > MAX_SUGGESTIONS) throw new Error('cv_ai_run_suggestion_limit');
    const ids = new Set<string>();
    for (const suggestion of record.proposal.suggestions) {
      if (!/^suggestion-[a-f0-9]{16}$/.test(suggestion.id) || ids.has(suggestion.id) || suggestion.status !== 'unverified'
        || !/^[a-z][a-z0-9_]*(?:\[[0-9]{1,4}\])?(?:\.[a-z][a-z0-9_]*(?:\[[0-9]{1,4}\])?)*$/.test(suggestion.path)
        || suggestion.path.length > 256
        || !/^[a-z][a-z0-9_]{0,63}$/.test(suggestion.collection)
        || (suggestion.recordId !== null && !SAFE_ID.test(suggestion.recordId))
        || !/^[a-z][a-z0-9_]*(?:\[[0-9]{1,4}\])?$/.test(suggestion.field)
        || !/^[a-z][a-z0-9_]{0,63}$/.test(suggestion.category)
        || typeof suggestion.mergeable !== 'boolean'
        || (suggestion.sectionKind !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(suggestion.sectionKind))
        || !validValue(suggestion.value) || !validAnchor(suggestion.sourceAnchor)
        || !Number.isFinite(suggestion.confidence) || suggestion.confidence < 0 || suggestion.confidence > 1
        || suggestion.alternatives.length > MAX_ALTERNATIVES
        || suggestion.questions.length > MAX_QUESTIONS
        || suggestion.questions.some((question) => !boundedText(question, 1_000))) throw new Error('cv_ai_run_suggestion_invalid');
      ids.add(suggestion.id);
      for (const alternative of suggestion.alternatives) {
        if (!/^alternative-[a-f0-9]{16}$/.test(alternative.id) || ids.has(alternative.id)
          || !validValue(alternative.value) || alternative.value === null || !validAnchor(alternative.sourceAnchor)
          || !Number.isFinite(alternative.confidence) || alternative.confidence < 0 || alternative.confidence > 1) {
          throw new Error('cv_ai_run_alternative_invalid');
        }
        ids.add(alternative.id);
      }
    }
  }
  if (record.applyIntent) {
    const intent = record.applyIntent;
    if (!Number.isSafeInteger(intent.expectedCvImportRevision) || intent.expectedCvImportRevision < 1
      || !SHA256.test(intent.expectedCvImportSha256)
      || !Array.isArray(intent.selections) || intent.selections.length < 1 || intent.selections.length > MAX_SUGGESTIONS
      || !SAFE_ID.test(intent.confirmedBy.id) || !['local', 'authenticated'].includes(intent.confirmedBy.type)
      || (intent.correlationId !== undefined && !SAFE_ID.test(intent.correlationId))) {
      throw new Error('cv_ai_run_apply_intent_invalid');
    }
    const suggestionIds = new Set<string>();
    const suggestions = new Map(record.proposal?.suggestions.map((item) => [item.id, item]) ?? []);
    for (const selection of intent.selections) {
      if (!selection || !/^suggestion-[a-f0-9]{16}$/.test(selection.suggestionId)
        || suggestionIds.has(selection.suggestionId)
        || (selection.alternativeId !== null && !/^alternative-[a-f0-9]{16}$/.test(selection.alternativeId))) {
        throw new Error('cv_ai_run_apply_intent_invalid');
      }
      const suggestion = suggestions.get(selection.suggestionId);
      if (!suggestion?.mergeable || (selection.alternativeId === null
        ? suggestion.value === null
        : !suggestion.alternatives.some((alternative) => alternative.id === selection.alternativeId))) {
        throw new Error('cv_ai_run_apply_intent_binding_invalid');
      }
      suggestionIds.add(selection.suggestionId);
    }
  }
  if (record.retentionCleanup) {
    const cleanup = record.retentionCleanup;
    if (!validDate(cleanup.cancelRequestedAt) || !validDate(cleanup.cancelDeadlineAt)
      || Date.parse(cleanup.cancelDeadlineAt) <= Date.parse(cleanup.cancelRequestedAt)
      || !Number.isSafeInteger(cleanup.cancelAttempts) || cleanup.cancelAttempts < 1 || cleanup.cancelAttempts > 3
      || record.status !== 'cancel_requested') throw new Error('cv_ai_run_retention_cleanup_invalid');
  }
  if (record.result && (!Number.isSafeInteger(record.result.cvImportRevision) || record.result.cvImportRevision < 1
    || record.result.factsRemainPending !== true || record.result.stagedFactIds.length > MAX_SUGGESTIONS
    || new Set(record.result.stagedFactIds).size !== record.result.stagedFactIds.length
    || record.result.stagedFactIds.some((id) => !SAFE_ID.test(id))
    || (record.result.recognitionVersionId !== undefined
      && !/^recognition-[a-f0-9]{16}$/.test(record.result.recognitionVersionId))
    || (record.result.recognitionVersionCount !== undefined
      && (!Number.isSafeInteger(record.result.recognitionVersionCount)
        || record.result.recognitionVersionCount < 1 || record.result.recognitionVersionCount > 20)))) {
    throw new Error('cv_ai_run_result_invalid');
  }
  const mode = record.mode ?? 'review_suggestions';
  if (mode === 'replace_with_ai_version' && record.status === 'applied'
    && (!record.result?.recognitionVersionId || !record.result.recognitionVersionCount)) {
    throw new Error('cv_ai_run_result_invalid');
  }
  if (mode === 'review_suggestions' && record.result?.recognitionVersionId !== undefined) {
    throw new Error('cv_ai_run_result_invalid');
  }
  if (record.failure && (!SAFE_ID.test(record.failure.code)
    || !['preflight', 'agent', 'validation', 'retention', 'apply'].includes(record.failure.stage)
    || typeof record.failure.retryable !== 'boolean')) throw new Error('cv_ai_run_failure_invalid');
  if (['queued', 'running', 'validating', 'cancel_requested', 'cancelled'].includes(record.status)
    && (record.proposal !== undefined || record.result !== undefined)) throw new Error('cv_ai_run_status_payload_invalid');
  if (record.status === 'suggestions_ready' && (!record.proposal || record.result || record.failure)) throw new Error('cv_ai_run_status_payload_invalid');
  if (record.status === 'applying' && (!record.proposal || !record.applyIntent || record.result || record.failure)) {
    throw new Error('cv_ai_run_status_payload_invalid');
  }
  if (record.status !== 'applying' && record.applyIntent) throw new Error('cv_ai_run_status_payload_invalid');
  if (record.status === 'applied' && (!record.proposal || !record.result || record.failure)) throw new Error('cv_ai_run_status_payload_invalid');
  if (record.status === 'failed' && !record.failure) throw new Error('cv_ai_run_status_payload_invalid');
  if (record.status !== 'failed' && record.failure) throw new Error('cv_ai_run_status_payload_invalid');
  if (record.sha256 !== recordHash(record)) throw new Error('cv_ai_run_hash_mismatch');
  canonical(record as unknown as Json);
}

export function sealCvAiStructuringRun(
  input: Omit<CvAiStructuringRunRecord, 'sha256'> | CvAiStructuringRunRecord,
): CvAiStructuringRunRecord {
  const { sha256: _ignored, ...body } = input as CvAiStructuringRunRecord;
  const record = { ...structuredClone(body), sha256: recordHash(body as Omit<CvAiStructuringRunRecord, 'sha256'>) } as CvAiStructuringRunRecord;
  assertRecord(record);
  return record;
}

function assertId(value: string): void {
  if (!UUID.test(value)) throw new Error('cv_ai_run_id_invalid');
}

function assertCas(current: CvAiStructuringRunRecord | undefined, revision: number, sha256: string): asserts current is CvAiStructuringRunRecord {
  if (!current) throw new Error('cv_ai_run_not_found');
  if (current.revision !== revision) throw new Error('cv_ai_run_revision_conflict');
  if (current.sha256 !== sha256) throw new Error('cv_ai_run_sha_conflict');
}

function assertReplacement(current: CvAiStructuringRunRecord, next: CvAiStructuringRunRecord): void {
  assertRecord(next);
  if (next.id !== current.id || next.cvImportId !== current.cvImportId || next.createdAt !== current.createdAt
    || next.revision !== current.revision + 1 || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error('cv_ai_run_replacement_invalid');
  }
}

export class MemoryCvAiStructuringRunStore implements CvAiStructuringRunStore {
  private readonly records = new Map<string, CvAiStructuringRunRecord>();
  private inventoryTail: Promise<void> = Promise.resolve();

  async assertCanCreate(cvImportId: string): Promise<void> {
    assertId(cvImportId);
    await this.serializedInventory(async () => this.assertCapacity(cvImportId));
  }

  async create(record: CvAiStructuringRunRecord): Promise<void> {
    assertRecord(record);
    await this.serializedInventory(async () => {
      if (this.records.has(record.id)) throw new Error('cv_ai_run_exists');
      this.assertCapacity(record.cvImportId);
      this.records.set(record.id, structuredClone(record));
    });
  }

  async get(id: string): Promise<CvAiStructuringRunRecord | undefined> {
    assertId(id); const record = this.records.get(id); return record ? structuredClone(record) : undefined;
  }

  async listByImport(cvImportId: string, limit = 100): Promise<CvAiStructuringRunRecord[]> {
    assertId(cvImportId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_IMPORT_RUNS) throw new Error('cv_ai_run_list_limit_invalid');
    const bounded = limit;
    return [...this.records.values()].filter((record) => record.cvImportId === cvImportId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .slice(0, bounded).map((record) => structuredClone(record));
  }

  async compareAndSave(id: string, expectedRevision: number, expectedSha256: string, next: CvAiStructuringRunRecord): Promise<void> {
    const current = this.records.get(id); assertCas(current, expectedRevision, expectedSha256); assertReplacement(current, next);
    this.records.set(id, structuredClone(next));
  }

  async compareAndDelete(id: string, expectedRevision: number, expectedSha256: string): Promise<boolean> {
    const current = this.records.get(id); if (!current) return false; assertCas(current, expectedRevision, expectedSha256);
    return this.records.delete(id);
  }

  async listExpired(now = new Date(), limit = 100): Promise<CvAiStructuringRunRecord[]> {
    const bounded = Math.min(1_000, Math.max(1, limit));
    return [...this.records.values()].filter((record) => Date.parse(record.expiresAt) <= now.getTime())
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id))
      .slice(0, bounded).map((record) => structuredClone(record));
  }

  private assertCapacity(cvImportId: string): void {
    if (this.records.size >= MAX_INVENTORY) throw new Error('cv_ai_run_inventory_limit');
    if ([...this.records.values()].filter((record) => record.cvImportId === cvImportId).length >= MAX_RUNS_PER_IMPORT) {
      throw new Error('cv_ai_import_run_limit');
    }
  }

  private async serializedInventory<T>(action: () => Promise<T>): Promise<T> {
    const result = this.inventoryTail.then(action, action);
    this.inventoryTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface CipherEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedCvAiStructuringRunStore implements CvAiStructuringRunStore {
  private readonly locks = new Map<string, Promise<void>>();
  private inventoryTail: Promise<void> = Promise.resolve();
  private keyPromise?: Promise<Buffer>;

  constructor(
    private readonly root = resolve(process.cwd(), '..', '.local-data', 'cv-ai-structuring-runs'),
    private readonly keyPath = resolve(process.cwd(), '..', '.local-data', 'cv-ai-structuring-runs.key'),
  ) {}

  async assertCanCreate(cvImportId: string): Promise<void> {
    assertId(cvImportId);
    await this.serializedInventory(() => this.assertCapacityUnlocked(cvImportId));
  }

  async create(record: CvAiStructuringRunRecord): Promise<void> {
    assertRecord(record);
    await this.serializedInventory(async () => {
      await this.assertCapacityUnlocked(record.cvImportId);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const directory = this.directory(record.id);
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('cv_ai_run_exists');
        throw error;
      }
      try { await this.writeRecord(record); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    });
  }

  async get(id: string): Promise<CvAiStructuringRunRecord | undefined> {
    assertId(id);
    try {
      const envelope = JSON.parse(await readFile(join(this.directory(id), 'record.enc.json'), 'utf8')) as CipherEnvelope;
      if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('cv_ai_run_cipher_contract_invalid');
      const decipher = createDecipheriv('aes-256-gcm', await this.key(false), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(`cv-ai-structuring-run/${id}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const record = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final(),
      ]).toString('utf8')) as CvAiStructuringRunRecord;
      assertRecord(record); return structuredClone(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async listByImport(cvImportId: string, limit = 100): Promise<CvAiStructuringRunRecord[]> {
    assertId(cvImportId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_IMPORT_RUNS) throw new Error('cv_ai_run_list_limit_invalid');
    const bounded = limit;
    let names: string[];
    try { names = (await readdir(this.root)).filter((name) => UUID.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (names.length > MAX_INVENTORY) throw new Error('cv_ai_run_inventory_limit');
    const records = (await Promise.all(names.map((name) => this.get(name))))
      .filter((item): item is CvAiStructuringRunRecord => item !== undefined && item.cvImportId === cvImportId);
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)).slice(0, bounded);
  }

  async compareAndSave(id: string, expectedRevision: number, expectedSha256: string, next: CvAiStructuringRunRecord): Promise<void> {
    await this.serialized(id, async () => {
      const current = await this.get(id); assertCas(current, expectedRevision, expectedSha256); assertReplacement(current, next);
      await this.writeRecord(next);
    });
  }

  async compareAndDelete(id: string, expectedRevision: number, expectedSha256: string): Promise<boolean> {
    return this.serialized(id, async () => {
      const current = await this.get(id); if (!current) return false; assertCas(current, expectedRevision, expectedSha256);
      await rm(this.directory(id), { recursive: true, force: false }); return true;
    });
  }

  async listExpired(now = new Date(), limit = 100): Promise<CvAiStructuringRunRecord[]> {
    const bounded = Math.min(1_000, Math.max(1, limit));
    let names: string[];
    try { names = (await readdir(this.root)).filter((name) => UUID.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (names.length > MAX_INVENTORY) throw new Error('cv_ai_run_inventory_limit');
    const records = (await Promise.all(names.map((name) => this.get(name))))
      .filter((item): item is CvAiStructuringRunRecord => item !== undefined && Date.parse(item.expiresAt) <= now.getTime());
    return records.sort((left, right) => left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id)).slice(0, bounded);
  }

  private directory(id: string): string { assertId(id); return join(this.root, id); }

  private async key(create: boolean): Promise<Buffer> {
    this.keyPromise ??= this.loadKey(create).catch((error) => { this.keyPromise = undefined; throw error; });
    return this.keyPromise;
  }

  private async loadKey(create: boolean): Promise<Buffer> {
    try {
      const key = await readFile(this.keyPath); if (key.length !== 32) throw new Error('cv_ai_run_key_invalid'); return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      const generated = randomBytes(32);
      try { await writeFile(this.keyPath, generated, { mode: 0o600, flag: 'wx' }); return generated; }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        const existing = await readFile(this.keyPath); if (existing.length !== 32) throw new Error('cv_ai_run_key_invalid'); return existing;
      }
    }
  }

  private async writeRecord(record: CvAiStructuringRunRecord): Promise<void> {
    assertRecord(record); const directory = this.directory(record.id);
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await this.key(true), iv);
    cipher.setAAD(Buffer.from(`cv-ai-structuring-run/${record.id}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const envelope: CipherEnvelope = {
      version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    };
    const temporary = join(directory, `record.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await rename(temporary, join(directory, 'record.enc.json')); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    assertId(id); const previous = this.locks.get(id) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; }); const queued = previous.then(() => current);
    this.locks.set(id, queued); await previous;
    try { return await action(); } finally { release(); if (this.locks.get(id) === queued) this.locks.delete(id); }
  }

  private async serializedInventory<T>(action: () => Promise<T>): Promise<T> {
    const result = this.inventoryTail.then(action, action);
    this.inventoryTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async assertCapacityUnlocked(cvImportId: string): Promise<void> {
    let names: string[];
    try { names = (await readdir(this.root)).filter((name) => UUID.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (names.length >= MAX_INVENTORY) throw new Error('cv_ai_run_inventory_limit');
    let count = 0;
    for (const name of names) {
      const record = await this.get(name);
      if (record?.cvImportId === cvImportId) count += 1;
      if (count >= MAX_RUNS_PER_IMPORT) throw new Error('cv_ai_import_run_limit');
    }
  }
}
