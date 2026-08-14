import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentRunStore } from '../ports/agent-runner.js';
import { TERMINAL_AGENT_STATES } from './state-machine.js';
import type { AgentArtifactDeletionPreview } from './artifact-store.js';
import { AgentArtifactStore } from './artifact-store.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function stable(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort)
    : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]))
      : entry;
  return JSON.stringify(sort(value));
}
function ensureContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('retention_path_escape');
}
function safeActor(actor: string): string {
  if (!actor || actor.length > 128 || actor.trim() !== actor || /[\u0000-\u001f\u007f]/.test(actor)) throw new Error('retention_actor_invalid');
  return actor;
}

export type LegalHoldScope = 'run' | 'artifact' | 'application_case';
export interface AgentLegalHold {
  schemaVersion: 1;
  id: string;
  scope: LegalHoldScope;
  referenceHash: string;
  reasonCode: string;
  createdAt: string;
  createdBy: string;
  releasedAt?: string;
  releasedBy?: string;
}

type RetentionJournalEntry =
  | { schemaVersion: 1; type: 'legal_hold_created'; sequence: number; timestamp: string; hold: AgentLegalHold }
  | { schemaVersion: 1; type: 'legal_hold_released'; sequence: number; timestamp: string; holdId: string; actor: string }
  | { schemaVersion: 1; type: 'deletion_previewed' | 'deletion_executed' | 'deletion_failed' | 'export_created'; sequence: number; timestamp: string; actor: string; actionDigest: string; resources: number; reasonCode?: string };

/** Append-only, fsynced legal-hold and operator-action journal. References are one-way hashed. */
export class AgentRetentionJournal {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path = resolve(process.cwd(), '.local-data', 'agent-retention', 'journal.jsonl')) {}

  async createHold(input: { scope: LegalHoldScope; referenceId: string; reasonCode: string; actor: string }, now = new Date()): Promise<AgentLegalHold> {
    if (!['run', 'artifact', 'application_case'].includes(input.scope) || !SAFE_ID.test(input.referenceId) || !SAFE_CODE.test(input.reasonCode)) {
      throw new Error('legal_hold_invalid');
    }
    const hold: AgentLegalHold = {
      schemaVersion: 1, id: randomUUID(), scope: input.scope, referenceHash: hash(input.referenceId),
      reasonCode: input.reasonCode, createdAt: now.toISOString(), createdBy: safeActor(input.actor)
    };
    await this.append((sequence) => ({ schemaVersion: 1, type: 'legal_hold_created', sequence, timestamp: now.toISOString(), hold }));
    return structuredClone(hold);
  }

  async releaseHold(holdId: string, actor: string, now = new Date()): Promise<AgentLegalHold> {
    if (!/^[0-9a-f-]{36}$/i.test(holdId)) throw new Error('legal_hold_id_invalid');
    const current = (await this.holds()).find((hold) => hold.id === holdId);
    if (!current) throw new Error('legal_hold_not_found');
    if (current.releasedAt) throw new Error('legal_hold_already_released');
    await this.append((sequence) => ({ schemaVersion: 1, type: 'legal_hold_released', sequence, timestamp: now.toISOString(), holdId, actor: safeActor(actor) }));
    return { ...current, releasedAt: now.toISOString(), releasedBy: actor };
  }

  async holds(): Promise<AgentLegalHold[]> {
    const entries = await this.read();
    const holds = new Map<string, AgentLegalHold>();
    for (const entry of entries) {
      if (entry.type === 'legal_hold_created') holds.set(entry.hold.id, structuredClone(entry.hold));
      if (entry.type === 'legal_hold_released') {
        const hold = holds.get(entry.holdId);
        if (!hold || hold.releasedAt) throw new Error('retention_journal_corrupt');
        hold.releasedAt = entry.timestamp; hold.releasedBy = entry.actor;
      }
    }
    return [...holds.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async audit(input: { type: 'deletion_previewed' | 'deletion_executed' | 'deletion_failed' | 'export_created'; actor: string; actionDigest: string; resources: number; reasonCode?: string }, now = new Date()): Promise<void> {
    if (!SHA256.test(input.actionDigest) || !Number.isSafeInteger(input.resources) || input.resources < 0
      || (input.reasonCode !== undefined && !SAFE_CODE.test(input.reasonCode))) throw new Error('retention_audit_invalid');
    await this.append((sequence) => ({ schemaVersion: 1, ...input, actor: safeActor(input.actor), sequence, timestamp: now.toISOString() }));
  }

  async auditEntries(): Promise<ReadonlyArray<RetentionJournalEntry>> { return this.read(); }

  private async append(build: (sequence: number) => RetentionJournalEntry): Promise<void> {
    await this.serialized(async () => {
      const entries = await this.read();
      const entry = build((entries.at(-1)?.sequence ?? 0) + 1);
      await mkdir(resolve(this.path, '..'), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      const handle = await open(this.path, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    });
  }

  private async read(): Promise<RetentionJournalEntry[]> {
    let text: string;
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('retention_journal_not_plain_file');
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: RetentionJournalEntry[] = [];
    for (const line of text.split('\n').filter(Boolean)) {
      let parsed: RetentionJournalEntry;
      try { parsed = JSON.parse(line) as RetentionJournalEntry; } catch { throw new Error('retention_journal_corrupt'); }
      if (parsed.schemaVersion !== 1 || parsed.sequence !== entries.length + 1 || !Number.isFinite(Date.parse(parsed.timestamp))) throw new Error('retention_journal_corrupt');
      entries.push(parsed);
    }
    return entries;
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous; try { return await action(); } finally { release(); }
  }
}

export interface AgentRawLogResource { id: string; runId: string; relativePath: string; bytes: number; }
export interface AgentRawLogRetentionPort {
  list(runId: string): Promise<AgentRawLogResource[]>;
  delete(runId: string, expected: readonly AgentRawLogResource[]): Promise<void>;
}

/** Retention adapter for ProcessSupervisor's root/runId/*.log layout. */
export class FileAgentRawLogRetentionPort implements AgentRawLogRetentionPort {
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || resolve(root) === resolve(root, '..')) throw new Error('raw_log_retention_root_invalid');
  }

  async list(runId: string): Promise<AgentRawLogResource[]> {
    if (!SAFE_ID.test(runId)) throw new Error('raw_log_retention_run_invalid');
    const configured = resolve(this.root);
    let canonicalRoot: string;
    try {
      const rootInfo = await lstat(configured);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('raw_log_retention_root_unsafe');
      canonicalRoot = await realpath(configured);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const directory = resolve(canonicalRoot, runId); ensureContained(canonicalRoot, directory);
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) throw new Error('raw_log_retention_directory_unsafe');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: AgentRawLogResource[] = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!/^(?:stdout|stderr)(?:\.\d+)?\.log$/.test(name)) throw new Error('raw_log_retention_unexpected_entry');
      const path = resolve(directory, name); ensureContained(directory, path);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || await realpath(path) !== path) throw new Error('raw_log_retention_file_unsafe');
      result.push({ id: `raw-log:${runId}:${name}`, runId, relativePath: `${runId}/${name}`, bytes: info.size });
    }
    return result;
  }

  async delete(runId: string, expected: readonly AgentRawLogResource[]): Promise<void> {
    const current = await this.list(runId);
    if (stable(current) !== stable(expected)) throw new Error('raw_log_deletion_preview_stale');
    if (current.length === 0) return;
    const canonicalRoot = await realpath(resolve(this.root));
    const directory = resolve(canonicalRoot, runId); ensureContained(canonicalRoot, directory);
    const stage = resolve(canonicalRoot, `.retention-${randomUUID()}`); ensureContained(canonicalRoot, stage);
    await rename(directory, stage);
    try { await rm(stage, { recursive: true, force: false }); }
    catch (error) { try { await rename(stage, directory); } catch { /* caller receives original deletion error */ } throw error; }
  }
}

export interface AgentDeletionResource {
  kind: 'run' | 'event_log' | 'raw_log' | 'artifact_metadata' | 'artifact_blob';
  id: string;
  runId?: string;
  action: 'delete' | 'retain_used_metadata' | 'retain_shared_content' | 'protected';
  reason?: 'legal_hold' | 'non_terminal' | 'shared_content';
  count?: number;
  bytes?: number;
  protectedBy?: string[];
}

export interface AgentDeletionPreview {
  schemaVersion: 1;
  requestedAt: string;
  runIds: string[];
  resources: AgentDeletionResource[];
  protectedReferences: string[];
  digest: string;
}

type DeletableRunStore = AgentRunStore & {
  deleteRuns(runIds: readonly string[], options?: { dryRun?: boolean }): Promise<Array<{ runId: string; events: number }>>;
};

/** Legal-hold-aware cascade coordinator; every preview and mutation is journaled. */
export class AgentRetentionCoordinator {
  constructor(
    private readonly runs: DeletableRunStore,
    private readonly artifacts: AgentArtifactStore,
    private readonly rawLogs: AgentRawLogRetentionPort,
    private readonly journal: AgentRetentionJournal,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async preview(runIds: readonly string[], actor: string): Promise<AgentDeletionPreview> {
    const preview = await this.buildPreview(runIds);
    await this.journal.audit({ type: 'deletion_previewed', actor, actionDigest: preview.digest, resources: preview.resources.length }, this.clock());
    return preview;
  }

  async execute(preview: AgentDeletionPreview, confirmationDigest: string, actor: string): Promise<{ deletedRuns: string[]; retainedUsedMetadata: string[] }> {
    safeActor(actor);
    if (confirmationDigest !== preview.digest) throw new Error('retention_confirmation_mismatch');
    const current = await this.buildPreview(preview.runIds);
    if (current.digest !== preview.digest) throw new Error('retention_preview_stale');
    if (current.resources.some((resource) => resource.action === 'protected')) throw new Error('retention_protected_references_present');
    const artifactIds = current.resources.filter((entry) => entry.kind === 'artifact_metadata').map((entry) => entry.id);
    const artifactPreview = artifactIds.length > 0 ? await this.artifacts.previewDeletion(artifactIds) : undefined;
    try {
      await this.runs.deleteRuns(current.runIds, { dryRun: true });
      const artifactResult = artifactPreview ? await this.artifacts.applyDeletion(artifactPreview) : { retainedUsedMetadata: [] };
      for (const runId of current.runIds) {
        const expected = current.resources.filter((resource) => resource.kind === 'raw_log' && resource.runId === runId).map((resource) => {
          const name = resource.id.slice(`raw-log:${runId}:`.length);
          return { id: resource.id, runId, relativePath: `${runId}/${name}`, bytes: resource.bytes! };
        });
        await this.rawLogs.delete(runId, expected);
      }
      await this.runs.deleteRuns(current.runIds);
      await this.journal.audit({ type: 'deletion_executed', actor, actionDigest: current.digest, resources: current.resources.length }, this.clock());
      return { deletedRuns: [...current.runIds], retainedUsedMetadata: artifactResult.retainedUsedMetadata };
    } catch (error) {
      await this.journal.audit({ type: 'deletion_failed', actor, actionDigest: current.digest, resources: current.resources.length, reasonCode: 'cascade_failed' }, this.clock());
      throw error;
    }
  }

  async auditExport(input: { actor: string; manifestSha256: string; runIds: readonly string[] }): Promise<void> {
    if (!SHA256.test(input.manifestSha256) || input.runIds.some((id) => !SAFE_ID.test(id))) throw new Error('retention_export_audit_invalid');
    const digest = hash(stable({ manifestSha256: input.manifestSha256, runIds: [...input.runIds].sort() }));
    await this.journal.audit({ type: 'export_created', actor: input.actor, actionDigest: digest, resources: input.runIds.length }, this.clock());
  }

  private async buildPreview(runIds: readonly string[]): Promise<AgentDeletionPreview> {
    const selected = [...new Set(runIds)].sort();
    if (selected.length === 0 || selected.length !== runIds.length || selected.some((id) => !SAFE_ID.test(id))) throw new Error('retention_selection_invalid');
    const activeHolds = (await this.journal.holds()).filter((hold) => !hold.releasedAt);
    const resources: AgentDeletionResource[] = [];
    const protectedReferences = new Set<string>();
    const eligibleArtifacts: string[] = [];
    const artifactRecords = [];
    for (const runId of selected) {
      const run = await this.runs.get(runId);
      if (!run) throw new Error(`retention_run_not_found:${runId}`);
      const artifacts = await this.artifacts.list({ runId }); artifactRecords.push(...artifacts);
      const runHeld = activeHolds.some((hold) => (hold.scope === 'run' && hold.referenceHash === hash(runId))
        || (hold.scope === 'application_case' && run.request.applicationCaseId && hold.referenceHash === hash(run.request.applicationCaseId)));
      const reason = runHeld ? 'legal_hold' as const : !TERMINAL_AGENT_STATES.has(run.state) ? 'non_terminal' as const : undefined;
      if (reason) protectedReferences.add(`run:${runId}`);
      const action = reason ? 'protected' as const : 'delete' as const;
      resources.push({ kind: 'run', id: runId, runId, action, reason });
      resources.push({ kind: 'event_log', id: `${runId}:events`, runId, action, reason, count: (await this.runs.events(runId)).length });
      for (const log of await this.rawLogs.list(runId)) resources.push({ kind: 'raw_log', id: log.id, runId, action, reason, bytes: log.bytes });
      for (const artifact of artifacts) {
        const held = runHeld || activeHolds.some((hold) => hold.scope === 'artifact' && hold.referenceHash === hash(artifact.id));
        if (held) {
          protectedReferences.add(`artifact:${artifact.id}`);
          resources.push({ kind: 'artifact_metadata', id: artifact.id, runId, action: 'protected', reason: 'legal_hold' });
        } else eligibleArtifacts.push(artifact.id);
      }
    }
    let artifactPreview: AgentArtifactDeletionPreview | undefined;
    if (eligibleArtifacts.length > 0) artifactPreview = await this.artifacts.previewDeletion(eligibleArtifacts);
    for (const artifact of artifactPreview?.artifacts ?? []) {
      resources.push({ kind: 'artifact_metadata', id: artifact.id, runId: artifactRecords.find((entry) => entry.id === artifact.id)?.provenance.runId,
        action: artifact.metadataAction === 'retain_used_metadata' ? 'retain_used_metadata' : 'delete' });
    }
    for (const blob of artifactPreview?.blobs ?? []) {
      const protectedShared = blob.action === 'retain_shared';
      if (protectedShared) for (const id of blob.protectedBy) protectedReferences.add(`artifact:${id}`);
      resources.push({ kind: 'artifact_blob', id: blob.sha256, action: protectedShared ? 'retain_shared_content' : 'delete',
        reason: protectedShared ? 'shared_content' : undefined, bytes: blob.bytes, protectedBy: blob.protectedBy });
    }
    resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    const unsigned = { schemaVersion: 1 as const, runIds: selected, resources, protectedReferences: [...protectedReferences].sort() };
    return { ...unsigned, requestedAt: this.clock().toISOString(), digest: hash(stable(unsigned)) };
  }
}
