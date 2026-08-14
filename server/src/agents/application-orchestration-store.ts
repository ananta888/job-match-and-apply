import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BudgetUsage, OrchestrationGate, NodeExecutionStatus } from './security-orchestration.js';

export type ApplicationOrchestrationStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_gate'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'orphaned';

export type ApplicationOrchestrationNodeStatus = NodeExecutionStatus | 'queued' | 'retrying' | 'orphaned';

export interface ApplicationOrchestrationArtifactReference {
  outputRef: string;
  artifactId: string;
  runId: string;
  sha256: string;
  lifecycle: 'proposed';
}

export interface ApplicationOrchestrationNodeRecord {
  nodeId: string;
  role: string;
  dependsOn: string[];
  status: ApplicationOrchestrationNodeStatus;
  attempts: number;
  runIds: string[];
  inputDigests: Record<string, string>;
  artifacts: ApplicationOrchestrationArtifactReference[];
  /** Cumulative, observed usage across every attempt of this node. */
  budget?: BudgetUsage;
  failureCategory?: string;
  reason?: string;
}

export interface ApplicationOrchestrationConflictVariant {
  sourceNodeId: string;
  sourceRole: string;
  outputRef: string;
  runId: string;
  artifactId: string;
  sha256: string;
}

export interface ApplicationOrchestrationConflictResolution {
  strategy: 'accept_complementary' | 'select_variant';
  resolverId: string;
  resolutionReference: string;
  selectedArtifactId?: string;
  resolvedAt: string;
  resolvedAgainstRevision: number;
  variantsSha256: string;
}

/**
 * A fan-in projection never votes. Byte-identical variants are equivalent;
 * every disagreement requires an explicit, revision-bound domain decision.
 */
export interface ApplicationOrchestrationConflict {
  id: string;
  targetNodeId: string;
  kind: 'ats_style_fan_in';
  status: 'equivalent' | 'unresolved' | 'resolved';
  requiresDomainResolution: boolean;
  variantsSha256: string;
  variants: ApplicationOrchestrationConflictVariant[];
  resolution?: ApplicationOrchestrationConflictResolution;
}

export interface ResolvedApplicationOrchestrationGate {
  nodeId: string;
  gate: OrchestrationGate;
  authority: 'server_evidence' | 'server_revision_confirmation';
  /** Hash of the server-verified gate binding; raw confirmations never enter this store. */
  bindingSha256: string;
}

export interface ApplicationOrchestrationScope {
  applicationCaseId?: string;
  applicationCaseRevision?: number;
  jobId?: string;
  companyKey?: string;
  mailId?: string;
  documentRevisionId?: string;
  workspaceRootId?: string;
  identityMode: 'none' | 'real' | 'incognito';
}

/**
 * Persisted orchestration projection. It intentionally excludes prompts,
 * candidate facts, mail bodies and agent output bytes.
 */
export interface ApplicationOrchestrationRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  workflowId: string;
  workflowVersion: string;
  providerId: string;
  status: ApplicationOrchestrationStatus;
  producesSuggestionsOnly: true;
  promptSha256: string;
  /** Server-generated and workflow-generic; never copied from the user prompt. */
  redactedSummary: string;
  scope: ApplicationOrchestrationScope;
  resolvedGates: ResolvedApplicationOrchestrationGate[];
  unresolvedGates: Array<{ nodeId: string; gate: OrchestrationGate }>;
  nodes: ApplicationOrchestrationNodeRecord[];
  nodeRunIds: Record<string, string[]>;
  artifactRefs: ApplicationOrchestrationArtifactReference[];
  /** Optional for backward compatibility with records written before v1 fan-in projection. */
  conflicts?: ApplicationOrchestrationConflict[];
  budget: BudgetUsage;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  failureReason?: string;
  recovery?: { recoveredAt: string; processAdoptionAllowed: false; reason: 'server_restart_no_pid_adoption' };
}

export interface ApplicationOrchestrationStore {
  create(record: ApplicationOrchestrationRecord): Promise<ApplicationOrchestrationRecord>;
  get(id: string): Promise<ApplicationOrchestrationRecord | undefined>;
  list(): Promise<ApplicationOrchestrationRecord[]>;
  compareAndSwap(record: ApplicationOrchestrationRecord, expectedRevision: number): Promise<ApplicationOrchestrationRecord>;
  recoverOrphaned(at?: Date): Promise<string[]>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES: readonly ApplicationOrchestrationStatus[] = [
  'queued', 'running', 'waiting_for_gate', 'cancelling', 'cancelled', 'succeeded', 'failed', 'orphaned'
];
const NODE_STATUSES: readonly ApplicationOrchestrationNodeStatus[] = [
  'pending', 'queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled', 'policy_blocked', 'skipped', 'orphaned'
];

function clone<T>(value: T): T { return structuredClone(value); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function assertId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`application_orchestration_${label}_invalid`);
}

function assertOptionalSafe(value: string | undefined, label: string): void {
  if (value !== undefined && !SAFE.test(value)) throw new Error(`application_orchestration_${label}_invalid`);
}

function assertTimestamp(value: string | undefined, label: string): void {
  if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new Error(`application_orchestration_${label}_invalid`);
}

function validateRecord(value: ApplicationOrchestrationRecord): ApplicationOrchestrationRecord {
  if (!value || value.schemaVersion !== 1) throw new Error('application_orchestration_record_invalid');
  assertId(value.id, 'id');
  assertId(value.workflowId, 'workflow_id');
  assertId(value.providerId, 'provider_id');
  if (!/^\d+\.\d+\.\d+$/.test(value.workflowVersion)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !STATUSES.includes(value.status) || value.producesSuggestionsOnly !== true
    || !HASH.test(value.promptSha256)
    || typeof value.redactedSummary !== 'string' || value.redactedSummary.length < 1 || value.redactedSummary.length > 240
    || /[\u0000-\u001f\u007f]/.test(value.redactedSummary)) {
    throw new Error('application_orchestration_record_invalid');
  }
  assertOptionalSafe(value.scope.applicationCaseId, 'case_id');
  assertOptionalSafe(value.scope.jobId, 'job_id');
  assertOptionalSafe(value.scope.companyKey, 'company_key');
  assertOptionalSafe(value.scope.mailId, 'mail_id');
  assertOptionalSafe(value.scope.documentRevisionId, 'document_revision_id');
  assertOptionalSafe(value.scope.workspaceRootId, 'workspace_root_id');
  if (!['none', 'real', 'incognito'].includes(value.scope.identityMode)
    || (value.scope.applicationCaseRevision !== undefined
      && (!Number.isSafeInteger(value.scope.applicationCaseRevision) || value.scope.applicationCaseRevision < 0))) {
    throw new Error('application_orchestration_scope_invalid');
  }
  if (value.scope.applicationCaseId && value.scope.applicationCaseRevision === undefined) {
    throw new Error('application_orchestration_case_revision_required');
  }
  assertTimestamp(value.createdAt, 'created_at');
  assertTimestamp(value.updatedAt, 'updated_at');
  assertTimestamp(value.finishedAt, 'finished_at');
  if (value.recovery) {
    assertTimestamp(value.recovery.recoveredAt, 'recovered_at');
    if (value.recovery.processAdoptionAllowed !== false || value.recovery.reason !== 'server_restart_no_pid_adoption') {
      throw new Error('application_orchestration_recovery_invalid');
    }
  }
  if (!value.budget || Object.values(value.budget).some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new Error('application_orchestration_budget_invalid');
  }
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    assertId(node.nodeId, 'node_id');
    if (nodeIds.has(node.nodeId) || !node.role.trim() || node.role.length > 128 || !NODE_STATUSES.includes(node.status)
      || !Number.isSafeInteger(node.attempts) || node.attempts < 0) throw new Error('application_orchestration_node_invalid');
    nodeIds.add(node.nodeId);
    for (const dependency of node.dependsOn) assertId(dependency, 'dependency');
    for (const runId of node.runIds) assertId(runId, 'run_id');
    if (new Set(node.runIds).size !== node.runIds.length) throw new Error('application_orchestration_duplicate_run_id');
    for (const [reference, digest] of Object.entries(node.inputDigests)) {
      if (!reference.trim() || !HASH.test(digest)) throw new Error('application_orchestration_input_digest_invalid');
    }
    if (node.budget !== undefined
      && Object.values(node.budget).some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
      throw new Error('application_orchestration_node_budget_invalid');
    }
  }
  for (const node of value.nodes) {
    if (node.dependsOn.some((dependency) => !nodeIds.has(dependency))) throw new Error('application_orchestration_dependency_invalid');
    const topLevel = value.nodeRunIds[node.nodeId];
    if (!topLevel || JSON.stringify(topLevel) !== JSON.stringify(node.runIds)) throw new Error('application_orchestration_run_index_invalid');
  }
  if (Object.keys(value.nodeRunIds).some((nodeId) => !nodeIds.has(nodeId))) throw new Error('application_orchestration_run_index_invalid');
  const artifacts = value.nodes.flatMap((node) => node.artifacts);
  const artifactIds = new Set<string>();
  for (const artifact of artifacts) {
    assertId(artifact.outputRef, 'output_ref');
    assertId(artifact.artifactId, 'artifact_id');
    assertId(artifact.runId, 'artifact_run_id');
    if (!HASH.test(artifact.sha256) || artifact.lifecycle !== 'proposed' || artifactIds.has(artifact.artifactId)) {
      throw new Error('application_orchestration_artifact_invalid');
    }
    artifactIds.add(artifact.artifactId);
  }
  if (JSON.stringify(value.artifactRefs) !== JSON.stringify(artifacts)) throw new Error('application_orchestration_artifact_index_invalid');
  const conflictIds = new Set<string>();
  for (const conflict of value.conflicts ?? []) {
    assertId(conflict.id, 'conflict_id');
    assertId(conflict.targetNodeId, 'conflict_target_node_id');
    if (conflictIds.has(conflict.id) || !nodeIds.has(conflict.targetNodeId)
      || conflict.kind !== 'ats_style_fan_in'
      || !['equivalent', 'unresolved', 'resolved'].includes(conflict.status)
      || !HASH.test(conflict.variantsSha256)
      || conflict.variants.length < 2) throw new Error('application_orchestration_conflict_invalid');
    conflictIds.add(conflict.id);
    const variantIds = new Set<string>();
    for (const variant of conflict.variants) {
      assertId(variant.sourceNodeId, 'conflict_source_node_id');
      assertId(variant.outputRef, 'conflict_output_ref');
      assertId(variant.runId, 'conflict_run_id');
      assertId(variant.artifactId, 'conflict_artifact_id');
      if (!nodeIds.has(variant.sourceNodeId) || !variant.sourceRole.trim() || variant.sourceRole.length > 128
        || !HASH.test(variant.sha256) || variantIds.has(variant.artifactId)) {
        throw new Error('application_orchestration_conflict_variant_invalid');
      }
      const sourceNode = value.nodes.find((node) => node.nodeId === variant.sourceNodeId);
      const sourceArtifact = sourceNode?.artifacts.find((artifact) => artifact.artifactId === variant.artifactId);
      if (!sourceNode || sourceNode.role !== variant.sourceRole || !sourceArtifact
        || sourceArtifact.outputRef !== variant.outputRef || sourceArtifact.runId !== variant.runId
        || sourceArtifact.sha256 !== variant.sha256) {
        throw new Error('application_orchestration_conflict_provenance_invalid');
      }
      variantIds.add(variant.artifactId);
    }
    const sortedVariants = [...conflict.variants].sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId)
      || left.outputRef.localeCompare(right.outputRef) || left.artifactId.localeCompare(right.artifactId));
    if (JSON.stringify(sortedVariants) !== JSON.stringify(conflict.variants)
      || sha256(JSON.stringify(conflict.variants)) !== conflict.variantsSha256
      || (conflict.status === 'equivalent') !== conflict.variants.every((variant) => variant.sha256 === conflict.variants[0]!.sha256)) {
      throw new Error('application_orchestration_conflict_binding_invalid');
    }
    if (conflict.status === 'equivalent' && conflict.requiresDomainResolution
      || conflict.status === 'unresolved' && !conflict.requiresDomainResolution
      || conflict.status === 'resolved' && (conflict.requiresDomainResolution || !conflict.resolution)
      || conflict.status !== 'resolved' && conflict.resolution) {
      throw new Error('application_orchestration_conflict_status_invalid');
    }
    if (conflict.resolution) {
      assertId(conflict.resolution.resolverId, 'conflict_resolver_id');
      assertId(conflict.resolution.resolutionReference, 'conflict_resolution_reference');
      assertTimestamp(conflict.resolution.resolvedAt, 'conflict_resolved_at');
      if (!['accept_complementary', 'select_variant'].includes(conflict.resolution.strategy)
        || !HASH.test(conflict.resolution.variantsSha256)
        || conflict.resolution.variantsSha256 !== conflict.variantsSha256
        || !Number.isSafeInteger(conflict.resolution.resolvedAgainstRevision)
        || conflict.resolution.resolvedAgainstRevision < 0
        || conflict.resolution.resolvedAgainstRevision >= value.revision
        || (conflict.resolution.strategy === 'select_variant'
          ? !conflict.resolution.selectedArtifactId || !variantIds.has(conflict.resolution.selectedArtifactId)
          : conflict.resolution.selectedArtifactId !== undefined)) {
        throw new Error('application_orchestration_conflict_resolution_invalid');
      }
    }
  }
  for (const gate of [...value.resolvedGates, ...value.unresolvedGates]) {
    assertId(gate.nodeId, 'gate_node_id');
    if (!nodeIds.has(gate.nodeId) || !['user_input', 'approval', 'evidence_complete', 'review_complete'].includes(gate.gate)) {
      throw new Error('application_orchestration_gate_invalid');
    }
  }
  for (const gate of value.resolvedGates) {
    if (!HASH.test(gate.bindingSha256) || !['server_evidence', 'server_revision_confirmation'].includes(gate.authority)) {
      throw new Error('application_orchestration_gate_binding_invalid');
    }
  }
  if (value.failureReason !== undefined && !/^[a-z][a-z0-9_.:-]{0,239}$/i.test(value.failureReason)) {
    throw new Error('application_orchestration_failure_reason_invalid');
  }
  return value;
}

function recovered(record: ApplicationOrchestrationRecord, at: Date): ApplicationOrchestrationRecord {
  // waiting_for_gate keeps its raw prompt/input only in process memory. After a
  // restart it therefore cannot be resumed honestly and becomes orphaned too.
  if (!['queued', 'running', 'waiting_for_gate', 'cancelling'].includes(record.status)) return record;
  const updatedAt = at.toISOString();
  const nodes = record.nodes.map((node) => ['queued', 'running', 'retrying'].includes(node.status)
    ? { ...node, status: 'orphaned' as const, reason: 'server_restart_no_pid_adoption' }
    : node);
  return validateRecord({
    ...record,
    revision: record.revision + 1,
    status: 'orphaned',
    nodes,
    updatedAt,
    finishedAt: updatedAt,
    failureReason: 'server_restart_no_pid_adoption',
    recovery: { recoveredAt: updatedAt, processAdoptionAllowed: false, reason: 'server_restart_no_pid_adoption' },
  });
}

export class MemoryApplicationOrchestrationStore implements ApplicationOrchestrationStore {
  private readonly records = new Map<string, ApplicationOrchestrationRecord>();

  async create(record: ApplicationOrchestrationRecord): Promise<ApplicationOrchestrationRecord> {
    validateRecord(record);
    if (this.records.has(record.id)) throw new Error('application_orchestration_exists');
    this.records.set(record.id, clone(record));
    return clone(record);
  }

  async get(id: string): Promise<ApplicationOrchestrationRecord | undefined> {
    if (!ID.test(id)) return undefined;
    const value = this.records.get(id);
    return value ? clone(validateRecord(value)) : undefined;
  }

  async list(): Promise<ApplicationOrchestrationRecord[]> {
    return [...this.records.values()].map((record) => clone(validateRecord(record)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  async compareAndSwap(record: ApplicationOrchestrationRecord, expectedRevision: number): Promise<ApplicationOrchestrationRecord> {
    const existing = this.records.get(record.id);
    if (!existing) throw new Error('application_orchestration_not_found');
    if (existing.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
      throw Object.assign(new Error('application_orchestration_revision_conflict'), { statusCode: 409 });
    }
    validateRecord(record);
    this.records.set(record.id, clone(record));
    return clone(record);
  }

  async recoverOrphaned(at = new Date()): Promise<string[]> {
    const ids: string[] = [];
    for (const [id, record] of this.records) {
      const next = recovered(record, at);
      if (next !== record) { this.records.set(id, clone(next)); ids.push(id); }
    }
    return ids.sort();
  }
}

export class JsonApplicationOrchestrationStore implements ApplicationOrchestrationStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  private path(id: string): string {
    assertId(id, 'id');
    const base = resolve(this.root);
    const candidate = resolve(base, `${id}.json`);
    const rel = relative(base, candidate);
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      throw new Error('application_orchestration_store_escape');
    }
    return candidate;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(id: string): Promise<ApplicationOrchestrationRecord | undefined> {
    try { return validateRecord(JSON.parse(await readFile(this.path(id), 'utf8')) as ApplicationOrchestrationRecord); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async atomicWrite(record: ApplicationOrchestrationRecord, createOnly = false): Promise<void> {
    validateRecord(record);
    const path = this.path(record.id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (createOnly) {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }

  async create(record: ApplicationOrchestrationRecord): Promise<ApplicationOrchestrationRecord> {
    return this.serialized(async () => {
      try { await this.atomicWrite(record, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('application_orchestration_exists');
        throw error;
      }
      return clone(record);
    });
  }

  async get(id: string): Promise<ApplicationOrchestrationRecord | undefined> {
    if (!ID.test(id)) return undefined;
    await this.queue;
    const record = await this.read(id);
    return record ? clone(record) : undefined;
  }

  async list(): Promise<ApplicationOrchestrationRecord[]> {
    await this.queue;
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = (await Promise.all(names.filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name))
      .map((name) => this.read(name.slice(0, -5))))).filter((item): item is ApplicationOrchestrationRecord => Boolean(item));
    return records.map(clone).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  async compareAndSwap(record: ApplicationOrchestrationRecord, expectedRevision: number): Promise<ApplicationOrchestrationRecord> {
    return this.serialized(async () => {
      const existing = await this.read(record.id);
      if (!existing) throw new Error('application_orchestration_not_found');
      if (existing.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw Object.assign(new Error('application_orchestration_revision_conflict'), { statusCode: 409 });
      }
      await this.atomicWrite(record);
      return clone(record);
    });
  }

  async recoverOrphaned(at = new Date()): Promise<string[]> {
    return this.serialized(async () => {
      let names: string[];
      try { names = await readdir(this.root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const ids: string[] = [];
      for (const name of names.filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(entry)).sort()) {
        const record = await this.read(name.slice(0, -5));
        if (!record) continue;
        const next = recovered(record, at);
        if (next !== record) { await this.atomicWrite(next); ids.push(record.id); }
      }
      return ids;
    });
  }
}

export function newApplicationOrchestrationId(): string { return randomUUID(); }
