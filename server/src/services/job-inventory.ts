import type {
  ApplicationArtifactRevision, ApplicationCase, ApplicationCaseState, ApplicationTrackingEvent,
  ApplicationTrackingStatus, JobInventoryCategory, JobInventoryEntry, JobInventoryMatch, JobPosting,
} from '../domain/models.js';
import { jobIdentityKey, mergeJob } from './job-normalization.js';

/** A search result folded into the inventory: the job plus its latest match summary. */
export interface JobInventoryFoldItem { job: JobPosting; match?: JobInventoryMatch }

/**
 * Pure logic for the durable central job inventory: folding search results in (cross-run
 * deduplication + enrichment), manual categorization, a manual applied mark, and a read-time
 * derived application-status projection joined from application cases, artifact revisions and
 * tracking events. No I/O — the workspace store wraps these in atomic mutations.
 */

export const JOB_INVENTORY_CATEGORIES: readonly JobInventoryCategory[] = ['inbox', 'apply', 'watchlist', 'archive'];
const MAX_RUN_IDS = 50;
const MAX_JOB_IDS = 50;
const MAX_INVENTORY = 5000;
/** Tracking statuses and case states that count as "actually applied". */
const APPLIED_TRACKING: readonly ApplicationTrackingStatus[] = ['manually_submitted', 'confirmed', 'interview', 'completed'];
const APPLIED_CASE_STATES: readonly ApplicationCaseState[] = ['submitted'];

function collectSourceIds(job: JobPosting): string[] {
  return [...new Set([job.sourceId, ...(job.sourceReferences ?? []).map((reference) => reference.sourceId)].filter(Boolean))];
}

/** Merge a run's matches into the inventory. Returns the updated list and the keys that were newly added. */
export function foldInventory(
  entries: JobInventoryEntry[], items: JobInventoryFoldItem[], runId: string, now: string,
): { entries: JobInventoryEntry[]; newKeys: string[] } {
  const byKey = new Map(entries.map((entry) => [entry.key, structuredClone(entry)]));
  const newKeys: string[] = [];
  for (const { job, match } of items) {
    const key = jobIdentityKey(job);
    const existing = byKey.get(key);
    if (existing) {
      existing.job = mergeJob(existing.job, job);
      existing.lastSeenAt = now;
      existing.updatedAt = now;
      existing.runIds = [runId, ...existing.runIds.filter((id) => id !== runId)].slice(0, MAX_RUN_IDS);
      existing.jobIds = [...new Set([job.id, ...existing.jobIds])].slice(0, MAX_JOB_IDS);
      existing.sourceIds = [...new Set([...existing.sourceIds, ...collectSourceIds(job)])];
      if (match) existing.match = structuredClone(match);
    } else {
      newKeys.push(key);
      byKey.set(key, {
        key, job: structuredClone(job), category: 'inbox',
        firstSeenAt: now, lastSeenAt: now, updatedAt: now,
        runIds: [runId], jobIds: [job.id], sourceIds: collectSourceIds(job),
        ...(match ? { match: structuredClone(match) } : {}),
      });
    }
  }
  const sorted = [...byKey.values()]
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.key.localeCompare(right.key))
    .slice(0, MAX_INVENTORY);
  return { entries: sorted, newKeys };
}

export function setInventoryCategory(
  entries: JobInventoryEntry[], key: string, category: JobInventoryCategory, now: string,
): { entries: JobInventoryEntry[]; entry?: JobInventoryEntry } {
  let updated: JobInventoryEntry | undefined;
  const next = entries.map((entry) => {
    if (entry.key !== key) return entry;
    updated = { ...structuredClone(entry), category, updatedAt: now };
    return updated;
  });
  return { entries: next, entry: updated };
}

export function setInventoryApplied(
  entries: JobInventoryEntry[], key: string, applied: boolean, note: string | undefined, now: string,
): { entries: JobInventoryEntry[]; entry?: JobInventoryEntry } {
  let updated: JobInventoryEntry | undefined;
  const next = entries.map((entry) => {
    if (entry.key !== key) return entry;
    const clone = structuredClone(entry);
    if (applied) clone.manualApplied = { at: now, ...(note ? { note } : {}) };
    else delete clone.manualApplied;
    clone.updatedAt = now;
    updated = clone;
    return updated;
  });
  return { entries: next, entry: updated };
}

export interface JobInventoryView {
  key: string;
  job: JobPosting;
  category: JobInventoryCategory;
  firstSeenAt: string;
  lastSeenAt: string;
  runCount: number;
  sourceIds: string[];
  match?: JobInventoryMatch;
  status: {
    applied: boolean;
    manualApplied?: { at: string; note?: string };
    cases: Array<{ id: string; documentType: ApplicationCase['documentType']; state: ApplicationCaseState; identityMode: ApplicationCase['identityMode']; updatedAt: string }>;
    documents: Array<{ revisionId: string; applicationCaseId: string; type: ApplicationArtifactRevision['type']; lifecycle: ApplicationArtifactRevision['lifecycle']; usedForApplicationCaseId?: string; usedAt?: string }>;
    appliedWith: Array<{ revisionId: string; applicationCaseId: string; type: ApplicationArtifactRevision['type']; usedAt?: string }>;
    tracking: Array<{ status: ApplicationTrackingStatus; occurredAt: string }>;
  };
}

/** Project one inventory entry with its derived application status from the workspace state. */
export function buildInventoryView(
  entry: JobInventoryEntry,
  cases: ApplicationCase[],
  artifacts: ApplicationArtifactRevision[],
  tracking: ApplicationTrackingEvent[],
): JobInventoryView {
  const jobIds = new Set(entry.jobIds);
  const relevantCases = cases.filter((item) => jobIds.has(item.job.id));
  const caseIds = new Set(relevantCases.map((item) => item.id));
  const relevantArtifacts = artifacts.filter((item) => jobIds.has(item.jobId) || caseIds.has(item.applicationCaseId));
  const relevantTracking = tracking.filter((item) => caseIds.has(item.applicationCaseId));

  const usedArtifacts = relevantArtifacts.filter((item) => item.lifecycle === 'used');
  const applied = Boolean(entry.manualApplied)
    || relevantCases.some((item) => APPLIED_CASE_STATES.includes(item.state))
    || relevantTracking.some((item) => APPLIED_TRACKING.includes(item.status))
    || usedArtifacts.length > 0;

  return {
    key: entry.key, job: structuredClone(entry.job), category: entry.category,
    firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt, runCount: entry.runIds.length,
    sourceIds: [...entry.sourceIds],
    ...(entry.match ? { match: structuredClone(entry.match) } : {}),
    status: {
      applied,
      ...(entry.manualApplied ? { manualApplied: structuredClone(entry.manualApplied) } : {}),
      cases: relevantCases.map((item) => ({
        id: item.id, documentType: item.documentType, state: item.state, identityMode: item.identityMode, updatedAt: item.updatedAt,
      })),
      documents: relevantArtifacts.map((item) => ({
        revisionId: item.id, applicationCaseId: item.applicationCaseId, type: item.type, lifecycle: item.lifecycle,
        ...(item.usedForApplicationCaseId ? { usedForApplicationCaseId: item.usedForApplicationCaseId } : {}),
        ...(item.usedAt ? { usedAt: item.usedAt } : {}),
      })),
      appliedWith: usedArtifacts.map((item) => ({
        revisionId: item.id, applicationCaseId: item.usedForApplicationCaseId ?? item.applicationCaseId, type: item.type,
        ...(item.usedAt ? { usedAt: item.usedAt } : {}),
      })),
      tracking: relevantTracking.map((item) => ({ status: item.status, occurredAt: item.occurredAt })),
    },
  };
}
