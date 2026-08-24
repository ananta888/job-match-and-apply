import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export type AgentArtifactLifecycle = 'proposed' | 'approved' | 'used' | 'rejected';

export interface AgentArtifactProvenance {
  runId: string;
  provider: string;
  providerVersion: string;
  adapterVersion: string;
  templateId: string;
  templateVersion: string;
  workflowId?: string;
  workflowVersion?: string;
  applicationCaseId?: string;
  applicationCaseRevision?: number;
  jobId?: string;
  companyKey?: string;
  mailId?: string;
  documentRevisionId?: string;
  /** Opaque configured workspace-root identifier; never an absolute local path. */
  workspaceRootId?: string;
  identityMode: 'none' | 'real' | 'incognito';
  claimIds?: string[];
  reviewIds?: string[];
}

export interface AgentArtifactRecord {
  schemaVersion: 1;
  id: string;
  kind: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  lifecycle: AgentArtifactLifecycle;
  relativePath?: string;
  provenance: AgentArtifactProvenance;
  review?: { decision: 'approved' | 'rejected'; actor: string; occurredAt: string };
  adoption?: { sourceReference: string; occurredAt: string };
  /** A used artifact keeps immutable provenance even after privacy-driven raw-content deletion. */
  contentState?: 'available' | 'deleted';
  contentDeletedAt?: string;
}

export interface AgentArtifactDeletionPreview {
  schemaVersion: 1;
  artifactIds: string[];
  artifacts: Array<{
    id: string;
    sha256: string;
    lifecycle: AgentArtifactLifecycle;
    contentState: 'available' | 'deleted';
    metadataAction: 'delete' | 'retain_used_metadata';
  }>;
  blobs: Array<{ sha256: string; bytes: number; action: 'delete' | 'retain_shared'; protectedBy: string[] }>;
  digest: string;
}

export interface AgentArtifactAdoptionPort {
  /** Must validate and import idempotently; browser/agent code never receives this port. */
  adopt(input: {
    artifact: Readonly<AgentArtifactRecord>;
    content: Buffer;
    idempotencyKey: string;
  }): Promise<{ applicationCaseId: string; jobId: string; companyKey: string; sourceReference: string }>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const SAFE_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_MEDIA_TYPE = /^(?:text\/(?:plain|markdown)|application\/json)(?:;\s*charset=utf-8)?$/i;
const FINAL_HTML_KIND = 'application-final-html';
const FINAL_HTML_MEDIA_TYPE = 'text/html; charset=utf-8';
const SOURCE_REFERENCE = /^[a-z][a-z0-9+.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._~:/-]{0,479}$/;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 20_000;
const MAX_DIFF_CHANGES = 2_000;
const MAX_DIFF_LINE_CHARS = 4_000;

function ensureRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isAbsolute(value) || value.includes('\0')) throw new Error('artifact_path_must_be_relative');
  const normalized = value.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment === '..' || segment === '.' || !SAFE_SEGMENT.test(segment))) {
    throw new Error('artifact_path_is_not_safe');
  }
  return normalized;
}

function ensureInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('artifact_store_escape');
}

function safeContext(value: string | undefined, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || !SAFE_CONTEXT.test(value)) throw new Error('artifact_provenance_invalid');
  return value;
}

function safeMetadata(value: string | undefined, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('artifact_provenance_invalid');
  }
  return value;
}

function artifactMediaTypeAllowed(kind: string, mediaType: string): boolean {
  return SAFE_MEDIA_TYPE.test(mediaType) || (kind === FINAL_HTML_KIND && mediaType === FINAL_HTML_MEDIA_TYPE);
}

function finalHtmlContentAllowed(kind: string, content: string | Uint8Array): boolean {
  if (kind !== FINAL_HTML_KIND) return true;
  return typeof content === 'string' && /^<!doctype html>/i.test(content)
    && content.includes('data-result="final-agent-html"')
    && content.includes("default-src 'none'")
    && !/<(?:script|iframe|object|embed|form|input|button|textarea|select|svg|math)(?:\s|>)/i.test(content)
    && !/<[^>]+\s(?:href|src|action|on[a-z]+)\s*=/i.test(content);
}

function validateProvenance(value: AgentArtifactProvenance): AgentArtifactProvenance {
  if (!value || !['none', 'real', 'incognito'].includes(value.identityMode)) throw new Error('artifact_provenance_invalid');
  const provenance: AgentArtifactProvenance = {
    runId: safeContext(value.runId, true)!, provider: safeContext(value.provider, true)!,
    providerVersion: safeMetadata(value.providerVersion, true)!, adapterVersion: safeMetadata(value.adapterVersion, true)!,
    templateId: safeContext(value.templateId, true)!, templateVersion: safeMetadata(value.templateVersion, true)!,
    workflowId: safeContext(value.workflowId), workflowVersion: safeMetadata(value.workflowVersion),
    applicationCaseId: safeContext(value.applicationCaseId), jobId: safeMetadata(value.jobId),
    companyKey: safeContext(value.companyKey), mailId: safeContext(value.mailId),
    documentRevisionId: safeContext(value.documentRevisionId), workspaceRootId: safeContext(value.workspaceRootId),
    identityMode: value.identityMode,
    claimIds: value.claimIds?.map((item) => safeContext(item, true)!),
    reviewIds: value.reviewIds?.map((item) => safeContext(item, true)!),
  };
  if (value.applicationCaseRevision !== undefined) {
    if (!Number.isSafeInteger(value.applicationCaseRevision) || value.applicationCaseRevision < 0) throw new Error('artifact_provenance_invalid');
    provenance.applicationCaseRevision = value.applicationCaseRevision;
  }
  const hasDomainContext = Boolean(provenance.applicationCaseId || provenance.jobId || provenance.companyKey || provenance.mailId || provenance.documentRevisionId
    || provenance.applicationCaseRevision !== undefined);
  if (hasDomainContext && (!provenance.applicationCaseId || provenance.applicationCaseRevision === undefined
    || !provenance.jobId || !provenance.companyKey || provenance.identityMode === 'none')) {
    throw new Error('artifact_provenance_invalid');
  }
  return provenance;
}

function validateRecord(record: AgentArtifactRecord): AgentArtifactRecord {
  if (record.schemaVersion !== 1 || !ARTIFACT_ID.test(record.id) || !SAFE_SEGMENT.test(record.kind)
    || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0
    || !artifactMediaTypeAllowed(record.kind, record.mediaType) || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !['proposed', 'approved', 'used', 'rejected'].includes(record.lifecycle)
    || (record.contentState !== undefined && !['available', 'deleted'].includes(record.contentState))
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('artifact_record_invalid');
  }
  const reviewValid = Boolean(record.review && ['approved', 'rejected'].includes(record.review.decision)
    && record.review.actor.length >= 1 && record.review.actor.length <= 256 && record.review.actor.trim() === record.review.actor
    && !/[\u0000-\u001f\u007f]/.test(record.review.actor) && Number.isFinite(Date.parse(record.review.occurredAt)));
  const adoptionValid = Boolean(record.adoption && SOURCE_REFERENCE.test(record.adoption.sourceReference)
    && Number.isFinite(Date.parse(record.adoption.occurredAt)));
  if ((record.lifecycle === 'proposed' && (record.revision !== 0 || record.review || record.adoption))
    || (record.lifecycle === 'approved' && (record.revision !== 1 || !reviewValid || record.review?.decision !== 'approved' || record.adoption))
    || (record.lifecycle === 'rejected' && (record.revision !== 1 || !reviewValid || record.review?.decision !== 'rejected' || record.adoption))
    || (record.lifecycle === 'used' && (record.revision !== 2 || !reviewValid || record.review?.decision !== 'approved' || !adoptionValid))) {
    throw new Error('artifact_record_invalid');
  }
  if ((record.contentState === 'deleted' && (record.lifecycle !== 'used' || !record.contentDeletedAt
    || !Number.isFinite(Date.parse(record.contentDeletedAt))))
    || (record.contentState !== 'deleted' && record.contentDeletedAt !== undefined)) throw new Error('artifact_record_invalid');
  ensureRelativePath(record.relativePath);
  validateProvenance(record.provenance);
  return record;
}

/** Immutable content-addressed blobs plus revisioned lifecycle metadata. */
export class AgentArtifactStore {
  private readonly blobRoot: string;
  private readonly recordRoot: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly root = resolve(process.cwd(), '..', '.local-data', 'agent-artifacts')) {
    this.blobRoot = resolve(root, 'blobs');
    this.recordRoot = resolve(root, 'records');
  }

  async create(input: {
    kind: string;
    content: string | Uint8Array;
    mediaType: string;
    relativePath?: string;
    provenance: AgentArtifactProvenance;
  }): Promise<AgentArtifactRecord> {
    const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact_too_large');
    if (!SAFE_SEGMENT.test(input.kind)) throw new Error('artifact_kind_is_not_safe');
    if (!artifactMediaTypeAllowed(input.kind, input.mediaType)) throw new Error('artifact_media_type_not_allowed');
    if (!finalHtmlContentAllowed(input.kind, input.content)) throw new Error('artifact_final_html_not_normalized');
    const relativePath = ensureRelativePath(input.relativePath);
    const provenance = validateProvenance(input.provenance);
    return this.serialized(async () => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const blobPath = resolve(this.blobRoot, sha256.slice(0, 2), sha256);
      ensureInside(this.blobRoot, blobPath);
      await mkdir(dirname(blobPath), { recursive: true });
      try { await writeFile(blobPath, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(blobPath);
        if (existing.byteLength !== bytes.byteLength || createHash('sha256').update(existing).digest('hex') !== sha256) {
          throw new Error('artifact_blob_collision_or_corruption');
        }
      }
      const now = new Date().toISOString();
      const record: AgentArtifactRecord = {
        schemaVersion: 1, id: randomUUID(), kind: input.kind, sha256, bytes: bytes.byteLength,
        mediaType: input.mediaType, createdAt: now, updatedAt: now, revision: 0,
        lifecycle: 'proposed', relativePath, provenance,
      };
      await this.writeRecord(record, true);
      return structuredClone(record);
    });
  }

  async get(id: string): Promise<AgentArtifactRecord | undefined> {
    if (!ARTIFACT_ID.test(id)) return undefined;
    try {
      const parsed = JSON.parse(await readFile(resolve(this.recordRoot, `${id}.json`), 'utf8')) as AgentArtifactRecord;
      return structuredClone(validateRecord(parsed));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(filter: { runId?: string; applicationCaseId?: string } = {}): Promise<AgentArtifactRecord[]> {
    await mkdir(this.recordRoot, { recursive: true });
    const names = (await readdir(this.recordRoot)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
    const records = (await Promise.all(names.map((name) => this.get(name.slice(0, -5))))).filter((item): item is AgentArtifactRecord => Boolean(item));
    return records.filter((record) => (!filter.runId || record.provenance.runId === filter.runId)
      && (!filter.applicationCaseId || record.provenance.applicationCaseId === filter.applicationCaseId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<{ record: AgentArtifactRecord; content: Buffer }> {
    const record = await this.get(id);
    if (!record) throw Object.assign(new Error('artifact_not_found'), { statusCode: 404 });
    if (record.contentState === 'deleted') throw Object.assign(new Error('artifact_content_deleted'), { statusCode: 410 });
    const blobPath = resolve(this.blobRoot, record.sha256.slice(0, 2), record.sha256);
    ensureInside(this.blobRoot, blobPath);
    const content = await readFile(blobPath);
    if (createHash('sha256').update(content).digest('hex') !== record.sha256 || content.byteLength !== record.bytes) {
      throw new Error('artifact_integrity_failed');
    }
    return { record, content };
  }

  async review(id: string, decision: 'approved' | 'rejected', expectedRevision: number, actor: string): Promise<AgentArtifactRecord> {
    if (!actor.trim()) throw new Error('artifact_review_actor_required');
    return this.serialized(async () => {
      const record = await this.required(id);
      this.assertRevision(record, expectedRevision);
      if (record.lifecycle !== 'proposed') throw Object.assign(new Error('artifact_lifecycle_conflict'), { statusCode: 409 });
      const now = new Date().toISOString();
      const updated: AgentArtifactRecord = {
        ...record, lifecycle: decision, revision: record.revision + 1, updatedAt: now,
        review: { decision, actor, occurredAt: now },
      };
      await this.writeRecord(updated, false);
      return structuredClone(updated);
    });
  }

  /** The sole approved -> used transition; intentionally not exposed as a generic REST operation. */
  async adopt(id: string, expectedRevision: number, port: AgentArtifactAdoptionPort): Promise<AgentArtifactRecord> {
    return this.serialized(async () => {
      const { record, content } = await this.read(id);
      this.assertRevision(record, expectedRevision);
      if (record.lifecycle !== 'approved') throw Object.assign(new Error('artifact_must_be_approved_before_adoption'), { statusCode: 409 });
      if (record.provenance.identityMode !== 'real') throw Object.assign(new Error('incognito_artifact_cannot_be_used'), { statusCode: 409 });
      const { applicationCaseId, jobId, companyKey } = record.provenance;
      if (!applicationCaseId || !jobId || !companyKey) throw new Error('artifact_adoption_provenance_incomplete');
      const adopted = await port.adopt({
        artifact: structuredClone(record), content: Buffer.from(content),
        idempotencyKey: `agent-artifact:${record.id}:${record.revision}:${record.sha256}`,
      });
      if (adopted.applicationCaseId !== applicationCaseId || adopted.jobId !== jobId || adopted.companyKey !== companyKey
        || !SOURCE_REFERENCE.test(adopted.sourceReference)) throw new Error('artifact_adoption_result_mismatch');
      const now = new Date().toISOString();
      const used: AgentArtifactRecord = {
        ...record, lifecycle: 'used', revision: record.revision + 1, updatedAt: now,
        adoption: { sourceReference: adopted.sourceReference, occurredAt: now },
      };
      await this.writeRecord(used, false);
      return structuredClone(used);
    });
  }

  async verify(): Promise<Array<{ id: string; valid: boolean; reason?: string }>> {
    return Promise.all((await this.list()).map(async (record) => {
      if (record.contentState === 'deleted') return { id: record.id, valid: true, reason: 'content_deleted_by_retention' };
      try { await this.read(record.id); return { id: record.id, valid: true }; }
      catch (error) { return { id: record.id, valid: false, reason: error instanceof Error ? error.message : String(error) }; }
    }));
  }

  /** Exact, hash-bound impact preview for privacy deletion and legal-hold orchestration. */
  async previewDeletion(artifactIds: readonly string[]): Promise<AgentArtifactDeletionPreview> {
    if (artifactIds.length === 0 || artifactIds.some((id) => !ARTIFACT_ID.test(id))) throw new Error('artifact_deletion_selection_invalid');
    const selectedIds = [...new Set(artifactIds)].sort();
    if (selectedIds.length !== artifactIds.length) throw new Error('artifact_deletion_selection_duplicate');
    const all = await this.list();
    const byId = new Map(all.map((record) => [record.id, record]));
    const selected = selectedIds.map((id) => {
      const record = byId.get(id);
      if (!record) throw new Error(`artifact_not_found:${id}`);
      return record;
    });
    const selectedSet = new Set(selectedIds);
    const byHash = new Map<string, AgentArtifactRecord[]>();
    for (const record of all.filter((entry) => entry.contentState !== 'deleted')) {
      const entries = byHash.get(record.sha256) ?? []; entries.push(record); byHash.set(record.sha256, entries);
    }
    const blobs = [...new Set(selected.filter((entry) => entry.contentState !== 'deleted').map((entry) => entry.sha256))]
      .sort().map((sha256) => {
        const references = (byHash.get(sha256) ?? []).filter((entry) => !selectedSet.has(entry.id)).map((entry) => entry.id).sort();
        const record = selected.find((entry) => entry.sha256 === sha256)!;
        return { sha256, bytes: record.bytes, action: references.length > 0 ? 'retain_shared' as const : 'delete' as const, protectedBy: references };
      });
    const unsigned = {
      schemaVersion: 1 as const, artifactIds: selectedIds,
      artifacts: selected.map((record) => ({
        id: record.id, sha256: record.sha256, lifecycle: record.lifecycle, contentState: record.contentState ?? 'available',
        metadataAction: record.lifecycle === 'used' ? 'retain_used_metadata' as const : 'delete' as const
      })).sort((left, right) => left.id.localeCompare(right.id)),
      blobs
    };
    return { ...unsigned, digest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') };
  }

  /** Applies only an unchanged preview; used provenance remains while raw bytes become unavailable. */
  async applyDeletion(preview: AgentArtifactDeletionPreview): Promise<{ deletedRecords: string[]; retainedUsedMetadata: string[]; deletedBlobs: string[] }> {
    return this.serialized(async () => {
      const current = await this.previewDeletion(preview.artifactIds);
      if (current.digest !== preview.digest) throw new Error('artifact_deletion_preview_stale');
      const rootInfo = await lstat(this.root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('artifact_store_root_unsafe');
      // Windows may expose the configured root with different casing or an
      // 8.3 alias. Derive every identity-sensitive staging path from the same
      // realpath result while still rejecting a reparse/symlinked staging dir.
      const canonicalRoot = await realpath(this.root);
      const stagingRoot = resolve(canonicalRoot, '.deletion-staging'); ensureInside(canonicalRoot, stagingRoot);
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const stagingInfo = await lstat(stagingRoot);
      if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory() || await realpath(stagingRoot) !== stagingRoot) throw new Error('artifact_deletion_staging_unsafe');
      const stage = resolve(stagingRoot, randomUUID()); ensureInside(stagingRoot, stage);
      await mkdir(resolve(stage, 'records'), { recursive: true, mode: 0o700 });
      await mkdir(resolve(stage, 'blobs'), { recursive: true, mode: 0o700 });
      const movedRecords: Array<{ original: string; staged: string; retained: boolean }> = [];
      const movedBlobs: Array<{ original: string; staged: string }> = [];
      try {
        for (const artifact of current.artifacts) {
          if (artifact.metadataAction === 'retain_used_metadata' && artifact.contentState === 'deleted') continue;
          const original = resolve(this.recordRoot, `${artifact.id}.json`); ensureInside(this.recordRoot, original);
          const staged = resolve(stage, 'records', `${artifact.id}.json`); ensureInside(stage, staged);
          await rename(original, staged);
          movedRecords.push({ original, staged, retained: artifact.metadataAction === 'retain_used_metadata' });
          if (artifact.metadataAction === 'retain_used_metadata') {
            const record = validateRecord(JSON.parse(await readFile(staged, 'utf8')) as AgentArtifactRecord);
            const now = new Date().toISOString();
            await this.writeRecord({ ...record, contentState: 'deleted', contentDeletedAt: now, updatedAt: now }, true);
          }
        }
        for (const blob of current.blobs.filter((entry) => entry.action === 'delete')) {
          const original = resolve(this.blobRoot, blob.sha256.slice(0, 2), blob.sha256); ensureInside(this.blobRoot, original);
          const staged = resolve(stage, 'blobs', blob.sha256); ensureInside(stage, staged);
          await rename(original, staged);
          movedBlobs.push({ original, staged });
        }
        await rm(stage, { recursive: true, force: false });
        return {
          deletedRecords: current.artifacts.filter((entry) => entry.metadataAction === 'delete').map((entry) => entry.id),
          retainedUsedMetadata: current.artifacts.filter((entry) => entry.metadataAction === 'retain_used_metadata').map((entry) => entry.id),
          deletedBlobs: current.blobs.filter((entry) => entry.action === 'delete').map((entry) => entry.sha256)
        };
      } catch (error) {
        for (const entry of [...movedRecords].reverse()) {
          if (entry.retained) await rm(entry.original, { force: true });
          try { await rename(entry.staged, entry.original); } catch (restoreError) {
            if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError;
          }
        }
        for (const entry of [...movedBlobs].reverse()) {
          await mkdir(dirname(entry.original), { recursive: true });
          try { await rename(entry.staged, entry.original); } catch (restoreError) {
            if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError;
          }
        }
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private async required(id: string): Promise<AgentArtifactRecord> {
    const record = await this.get(id);
    if (!record) throw Object.assign(new Error('artifact_not_found'), { statusCode: 404 });
    return record;
  }

  private assertRevision(record: AgentArtifactRecord, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || record.revision !== expectedRevision) {
      throw Object.assign(new Error('artifact_revision_conflict'), { statusCode: 409, currentRevision: record.revision });
    }
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  private async writeRecord(record: AgentArtifactRecord, createOnly: boolean): Promise<void> {
    validateRecord(record);
    await mkdir(this.recordRoot, { recursive: true });
    const finalPath = resolve(this.recordRoot, `${record.id}.json`);
    ensureInside(this.recordRoot, finalPath);
    if (createOnly) {
      await writeFile(finalPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return;
    }
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, finalPath);
    await stat(finalPath);
  }
}

export function textDiff(before: string, after: string): Array<{ line: number; before?: string; after?: string }> {
  if (Buffer.byteLength(before, 'utf8') + Buffer.byteLength(after, 'utf8') > MAX_DIFF_BYTES) throw new Error('artifact_diff_too_large');
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) throw new Error('artifact_diff_too_many_lines');
  const size = Math.max(left.length, right.length);
  const diff: Array<{ line: number; before?: string; after?: string }> = [];
  for (let index = 0; index < size; index += 1) {
    if (left[index] !== right[index]) {
      if (diff.length >= MAX_DIFF_CHANGES) throw new Error('artifact_diff_too_many_changes');
      diff.push({
        line: index + 1,
        before: left[index]?.slice(0, MAX_DIFF_LINE_CHARS),
        after: right[index]?.slice(0, MAX_DIFF_LINE_CHARS),
      });
    }
  }
  return diff;
}
