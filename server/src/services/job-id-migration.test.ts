import { describe, expect, it } from 'vitest';
import { migrateWorkspaceJobIds } from './job-id-migration.js';
import { SAFE_JOB_ID, deduplicateJobs, safeJobId } from './job-normalization.js';
import type { JobPosting } from '../domain/models.js';

const posting = (overrides: Partial<JobPosting> = {}): JobPosting => ({
  id: 'https://example.invalid/projekt/engineer?utm_source=x&utm_medium=y',
  sourceId: 'demo', title: 'Engineer', company: 'Beispiel GmbH', location: 'Remote',
  description: 'Synthetische Stelle.', skills: [],
  url: 'https://example.invalid/projekt/engineer?utm_source=x&utm_medium=y',
  ...overrides,
} as JobPosting);

describe('job id normalization', () => {
  it('replaces a source-shaped id with an allowlist-safe one at ingestion', () => {
    const [job] = deduplicateJobs([posting()]);
    expect(job!.id).toMatch(SAFE_JOB_ID);
    // The orchestration scope allowlist is the reason this exists.
    expect(job!.id).not.toContain('/');
    expect(job!.id).not.toContain('?');
    // Nothing is lost: the address stays on the posting.
    expect(job!.url).toBe('https://example.invalid/projekt/engineer?utm_source=x&utm_medium=y');
  });

  it('derives the same id for the same posting across runs and query variants', () => {
    const first = deduplicateJobs([posting()])[0]!;
    const second = deduplicateJobs([posting({ id: 'other-source-id' })])[0]!;
    expect(second.id).toBe(first.id);
    // The identity key strips the query, so tracking parameters cannot fork it.
    const tracked = deduplicateJobs([posting({ url: 'https://example.invalid/projekt/engineer?utm_source=zzz' })])[0]!;
    expect(tracked.id).toBe(first.id);
  });

  it('keeps distinct postings distinct', () => {
    const other = deduplicateJobs([posting({ url: 'https://example.invalid/projekt/andere' })])[0]!;
    expect(other.id).not.toBe(deduplicateJobs([posting()])[0]!.id);
  });
});

describe('migrateWorkspaceJobIds', () => {
  function storedWorkspace() {
    const legacy = 'https://example.invalid/projekt/engineer?utm_source=x&utm_medium=y';
    return {
      schemaVersion: 1,
      searchRuns: [{ id: 'run-1', matches: [{ job: posting() }] }],
      applicationCases: [{ id: 'case-1', jobId: legacy, job: posting() }],
      jobInventory: [{ key: 'https://example.invalid/projekt/engineer', job: posting(), jobIds: [legacy] }],
      jobDecisions: [{ jobId: legacy, state: 'saved' }],
      trackingEvents: [{ id: 'track-1', jobId: legacy }],
      artifactRevisions: [{ id: 'rev-1', jobId: legacy }],
      applicationEvents: [{ id: 'event-1', jobId: legacy }],
      comparisonNotes: [{ id: 'note-1', jobIds: [legacy, 'unknown-job'] }],
      reminders: [{ id: 'reminder-1', jobId: legacy }],
    };
  }

  it('rewrites every stored job and every reference to it', () => {
    const workspace = storedWorkspace();
    const expected = safeJobId(posting());
    const result = migrateWorkspaceJobIds(workspace);

    expect(result.rewrittenJobs).toBe(3);
    expect(workspace.searchRuns[0]!.matches[0]!.job.id).toBe(expected);
    expect(workspace.applicationCases[0]!.job.id).toBe(expected);
    expect(workspace.jobInventory[0]!.job.id).toBe(expected);
    expect(workspace.jobDecisions[0]!.jobId).toBe(expected);
    expect(workspace.trackingEvents[0]!.jobId).toBe(expected);
    expect(workspace.artifactRevisions[0]!.jobId).toBe(expected);
    expect(workspace.applicationEvents[0]!.jobId).toBe(expected);
    expect(workspace.applicationCases[0]!.jobId).toBe(expected);
    expect(workspace.reminders[0]!.jobId).toBe(expected);
    expect(workspace.comparisonNotes[0]!.jobIds).toEqual([expected, 'unknown-job']);
    expect(workspace.jobInventory[0]!.jobIds).toEqual([expected]);
    // The inventory key is the identity key, not the job id, and must survive.
    expect(workspace.jobInventory[0]!.key).toBe('https://example.invalid/projekt/engineer');
  });

  it('is idempotent, so it can run on every load', () => {
    const workspace = storedWorkspace();
    migrateWorkspaceJobIds(workspace);
    const snapshot = structuredClone(workspace);
    const second = migrateWorkspaceJobIds(workspace);
    expect(second).toEqual({ rewrittenJobs: 0, rewrittenReferences: 0 });
    expect(workspace).toEqual(snapshot);
  });

  it('leaves a reference untouched when its job is no longer stored', () => {
    const workspace = { schemaVersion: 1, searchRuns: [], jobDecisions: [{ jobId: 'https://gone.invalid/x', state: 'saved' }] };
    expect(migrateWorkspaceJobIds(workspace)).toEqual({ rewrittenJobs: 0, rewrittenReferences: 0 });
    expect(workspace.jobDecisions[0]!.jobId).toBe('https://gone.invalid/x');
  });

  it('tolerates an empty or malformed envelope', () => {
    expect(migrateWorkspaceJobIds(undefined)).toEqual({ rewrittenJobs: 0, rewrittenReferences: 0 });
    expect(migrateWorkspaceJobIds({ schemaVersion: 1 })).toEqual({ rewrittenJobs: 0, rewrittenReferences: 0 });
    expect(migrateWorkspaceJobIds({ searchRuns: [{ matches: [{ job: null }] }] }))
      .toEqual({ rewrittenJobs: 0, rewrittenReferences: 0 });
  });
});
