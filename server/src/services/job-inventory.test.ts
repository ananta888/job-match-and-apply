import { describe, expect, it } from 'vitest';
import type { ApplicationArtifactRevision, ApplicationCase, ApplicationTrackingEvent, JobInventoryEntry, JobPosting } from '../domain/models.js';
import { buildInventoryView, foldInventory, setInventoryApplied, setInventoryCategory } from './job-inventory.js';

function job(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: 'job-1', sourceId: 'demo', title: 'Angular Engineer', company: 'Beispiel GmbH', location: 'Berlin',
    workModel: 'hybrid', employmentType: 'full_time', description: 'Beschreibung', skills: ['Angular'],
    ...overrides,
  };
}

const T1 = '2026-08-15T10:00:00.000Z';
const T2 = '2026-08-15T11:00:00.000Z';
const items = (...jobs: JobPosting[]) => jobs.map((job) => ({ job }));

describe('foldInventory', () => {
  it('adds new jobs on first sight and marks them as new', () => {
    const { entries, newKeys } = foldInventory([], items(job(), job({ id: 'job-2', title: 'React Dev', company: 'Acme', location: 'Köln' })), 'run-1', T1);
    expect(entries).toHaveLength(2);
    expect(newKeys).toHaveLength(2);
    expect(entries.every((entry) => entry.category === 'inbox')).toBe(true);
  });

  it('captures the discovery date and search settings on new jobs and backfills existing ones', () => {
    const settings = {
      query: 'Angular', regions: ['Berlin'], workModels: ['hybrid'], employmentTypes: ['full_time'],
      mustHave: ['Angular'], niceToHave: ['RxJS'], minSalary: 60000, sourceIds: ['demo'],
    };
    const first = foldInventory([], items(job()), 'run-1', T1, settings);
    const entry = first.entries[0]!;
    expect(entry.firstSeenAt).toBe(T1);
    expect(entry.discoveredWith).toEqual({ runId: 'run-1', capturedAt: T1, ...settings });

    // An entry added without settings gets them backfilled on the next fold.
    const legacy = foldInventory([], items(job({ id: 'job-legacy' })), 'run-0', T1);
    expect(legacy.entries[0]!.discoveredWith).toBeUndefined();
    const backfilled = foldInventory(legacy.entries, items(job({ id: 'job-legacy-b' })), 'run-2', T2, settings);
    expect(backfilled.entries[0]!.discoveredWith).toMatchObject({ runId: 'run-2', capturedAt: T2, query: 'Angular' });
    expect(backfilled.entries[0]!.firstSeenAt).toBe(T1);
  });

  it('deduplicates the same posting across runs and enriches instead of duplicating', () => {
    const first = foldInventory([], items(job({ skills: ['Angular'] })), 'run-1', T1);
    const second = foldInventory(first.entries, items(job({ id: 'job-1-b', sourceId: 'other', skills: ['RxJS'] })), 'run-2', T2);
    expect(second.entries).toHaveLength(1);
    expect(second.newKeys).toHaveLength(0);
    const entry = second.entries[0]!;
    expect(entry.job.skills).toEqual(expect.arrayContaining(['Angular', 'RxJS']));
    expect(entry.jobIds).toEqual(expect.arrayContaining(['job-1', 'job-1-b']));
    expect(entry.sourceIds).toEqual(expect.arrayContaining(['demo', 'other']));
    expect(entry.runIds).toEqual(['run-2', 'run-1']);
    expect(entry.firstSeenAt).toBe(T1);
    expect(entry.lastSeenAt).toBe(T2);
  });

  it('treats a normalized URL as the identity even when title differs', () => {
    const first = foldInventory([], items(job({ url: 'https://jobs.example/x?utm=1' })), 'run-1', T1);
    const second = foldInventory(first.entries, items(job({ id: 'job-9', title: 'Anderer Titel', url: 'https://jobs.example/x?utm=2#frag' })), 'run-2', T2);
    expect(second.entries).toHaveLength(1);
    expect(second.newKeys).toHaveLength(0);
  });

  it('preserves the user category across enrichment', () => {
    const first = foldInventory([], items(job()), 'run-1', T1);
    const categorized = setInventoryCategory(first.entries, first.entries[0]!.key, 'apply', T1);
    const second = foldInventory(categorized.entries, items(job({ id: 'job-1-b' })), 'run-2', T2);
    expect(second.entries[0]!.category).toBe('apply');
  });

  it('records the latest match summary and refreshes it on re-run', () => {
    const first = foldInventory([], [{ job: job(), match: { score: 61, accepted: false, matchedMustHave: ['Angular'], missingMustHave: ['Kubernetes'], matchedNiceToHave: [] } }], 'run-1', T1);
    expect(first.entries[0]!.match).toMatchObject({ score: 61, matchedMustHave: ['Angular'] });
    const second = foldInventory(first.entries, [{ job: job({ id: 'job-1-b' }), match: { score: 88, accepted: true, matchedMustHave: ['Angular', 'Kubernetes'], missingMustHave: [], matchedNiceToHave: ['RxJS'] } }], 'run-2', T2);
    expect(second.entries[0]!.match).toMatchObject({ score: 88, accepted: true });
  });
});

describe('setInventoryCategory / setInventoryApplied', () => {
  it('updates category and returns the entry', () => {
    const base = foldInventory([], items(job()), 'run-1', T1).entries;
    const result = setInventoryCategory(base, base[0]!.key, 'archive', T2);
    expect(result.entry?.category).toBe('archive');
    expect(setInventoryCategory(base, 'missing-key', 'archive', T2).entry).toBeUndefined();
  });

  it('sets and clears a manual applied mark', () => {
    const base = foldInventory([], items(job()), 'run-1', T1).entries;
    const applied = setInventoryApplied(base, base[0]!.key, true, 'Direkt über die Firmenseite beworben', T2);
    expect(applied.entry?.manualApplied).toMatchObject({ at: T2, note: 'Direkt über die Firmenseite beworben' });
    const cleared = setInventoryApplied(applied.entries, base[0]!.key, false, undefined, T2);
    expect(cleared.entry?.manualApplied).toBeUndefined();
  });
});

describe('buildInventoryView', () => {
  const entry: JobInventoryEntry = {
    key: 'k', job: job(), category: 'apply', firstSeenAt: T1, lastSeenAt: T2, updatedAt: T2,
    runIds: ['run-1'], jobIds: ['job-1'], sourceIds: ['demo'],
  };
  const applicationCase: ApplicationCase = {
    id: 'case-1', job: job(), identityId: 'id-1', identityMode: 'real', documentType: 'cv', state: 'submitted',
    createdAt: T1, updatedAt: T2, artifactNames: [], warnings: [], revision: 3,
  };
  const usedCv: ApplicationArtifactRevision = {
    id: 'rev-1', applicationCaseId: 'case-1', companyKey: 'beispiel-gmbh', jobId: 'job-1', type: 'cv',
    lifecycle: 'used', sha256: 'a'.repeat(64), bytes: 10, artifactPath: 'p', pipelineContractVersion: '1.0.0',
    createdAt: T1, usedAt: T2, usedForApplicationCaseId: 'case-1',
  };
  const tracking: ApplicationTrackingEvent = { id: 'trk-1', applicationCaseId: 'case-1', status: 'manually_submitted', occurredAt: T2, source: 'user' };

  it('derives applied status, generated documents and applied-with from workspace state', () => {
    const view = buildInventoryView(entry, [applicationCase], [usedCv], [tracking]);
    expect(view.status.applied).toBe(true);
    expect(view.status.cases).toEqual([expect.objectContaining({ id: 'case-1', state: 'submitted', documentType: 'cv' })]);
    expect(view.status.documents).toEqual([expect.objectContaining({ revisionId: 'rev-1', type: 'cv', lifecycle: 'used' })]);
    expect(view.status.appliedWith).toEqual([expect.objectContaining({ revisionId: 'rev-1', type: 'cv' })]);
    expect(view.status.tracking).toEqual([expect.objectContaining({ status: 'manually_submitted' })]);
  });

  it('is not applied when only a draft case exists', () => {
    const view = buildInventoryView(entry, [{ ...applicationCase, state: 'draft' }], [{ ...usedCv, lifecycle: 'proposed', usedAt: undefined, usedForApplicationCaseId: undefined }], []);
    expect(view.status.applied).toBe(false);
    expect(view.status.appliedWith).toEqual([]);
    expect(view.status.documents).toHaveLength(1);
  });

  it('honours a manual applied mark with no in-app case', () => {
    const view = buildInventoryView({ ...entry, manualApplied: { at: T2, note: 'extern' } }, [], [], []);
    expect(view.status.applied).toBe(true);
    expect(view.status.manualApplied).toMatchObject({ note: 'extern' });
  });
});
