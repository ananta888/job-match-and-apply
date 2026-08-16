import type { JobPosting } from '../domain/models.js';
import { SAFE_JOB_ID, safeJobId } from './job-normalization.js';

/**
 * Rewrites job identifiers that predate {@link safeJobId} to the normalized
 * form, in place, across a workspace envelope.
 *
 * Sources used to hand their own id straight through, so stored workspaces
 * carry posting URLs as job ids. Those fail the allowlist that agent
 * orchestration scopes, artifact metadata and the orchestration store apply,
 * which made every case-bound orchestration fail with an unmodeled 500.
 *
 * The new id derives from the job's stable identity key, so the mapping is
 * deterministic and the pass is idempotent: once every id is normalized, a
 * second run changes nothing. References whose job is no longer stored cannot
 * be derived and are left untouched rather than guessed at.
 */
export function migrateWorkspaceJobIds(workspace: unknown): { rewrittenJobs: number; rewrittenReferences: number } {
  if (!workspace || typeof workspace !== 'object') return { rewrittenJobs: 0, rewrittenReferences: 0 };
  const envelope = workspace as Record<string, unknown>;
  const mapping = new Map<string, string>();
  let rewrittenJobs = 0;
  let rewrittenReferences = 0;

  const rewriteJob = (job: unknown): void => {
    if (!job || typeof job !== 'object') return;
    const posting = job as Record<string, unknown>;
    const previous = posting.id;
    if (typeof previous !== 'string' || !previous) return;
    if (SAFE_JOB_ID.test(previous)) return;
    const next = safeJobId(posting as unknown as JobPosting);
    mapping.set(previous, next);
    posting.id = next;
    rewrittenJobs += 1;
  };

  for (const run of asArray(envelope.searchRuns)) {
    for (const match of asArray((run as Record<string, unknown>).matches)) {
      rewriteJob((match as Record<string, unknown>).job);
    }
  }
  for (const applicationCase of asArray(envelope.applicationCases)) {
    rewriteJob((applicationCase as Record<string, unknown>).job);
  }
  for (const entry of asArray(envelope.jobInventory)) {
    rewriteJob((entry as Record<string, unknown>).job);
  }

  if (mapping.size === 0) return { rewrittenJobs, rewrittenReferences };

  const remap = (value: unknown): string | undefined =>
    typeof value === 'string' ? mapping.get(value) : undefined;

  const rewriteScalar = (holder: unknown, key: string): void => {
    if (!holder || typeof holder !== 'object') return;
    const record = holder as Record<string, unknown>;
    const next = remap(record[key]);
    if (next === undefined) return;
    record[key] = next;
    rewrittenReferences += 1;
  };

  const rewriteList = (holder: unknown, key: string): void => {
    if (!holder || typeof holder !== 'object') return;
    const record = holder as Record<string, unknown>;
    const list = record[key];
    if (!Array.isArray(list)) return;
    record[key] = list.map((item) => {
      const next = remap(item);
      if (next === undefined) return item;
      rewrittenReferences += 1;
      return next;
    });
  };

  for (const decision of asArray(envelope.jobDecisions)) rewriteScalar(decision, 'jobId');
  for (const event of asArray(envelope.trackingEvents)) rewriteScalar(event, 'jobId');
  for (const revision of asArray(envelope.artifactRevisions)) rewriteScalar(revision, 'jobId');
  for (const applicationCase of asArray(envelope.applicationCases)) rewriteScalar(applicationCase, 'jobId');
  for (const event of asArray(envelope.applicationEvents)) rewriteScalar(event, 'jobId');
  for (const note of asArray(envelope.comparisonNotes)) rewriteList(note, 'jobIds');
  for (const entry of asArray(envelope.jobInventory)) rewriteList(entry, 'jobIds');
  for (const reminder of asArray(envelope.reminders)) rewriteScalar(reminder, 'jobId');

  return { rewrittenJobs, rewrittenReferences };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
