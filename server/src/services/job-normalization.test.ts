import { describe, expect, it } from 'vitest';
import type { JobPosting } from '../domain/models.js';
import { deduplicateJobs } from './job-normalization.js';

const job = (sourceId: string, id: string, url?: string): JobPosting => ({
  id, sourceId, title: 'Senior Engineer', company: 'Example GmbH', location: 'Berlin',
  workModel: 'unknown', employmentType: 'unknown', description: sourceId === 'one' ? 'Kurz' : 'Eine längere Beschreibung',
  skills: sourceId === 'one' ? ['TypeScript'] : ['Angular'], url,
  sourceReferences: [{ sourceId, externalId: id, url, fetchedAt: '2026-08-13T00:00:00Z' }]
});

describe('deduplicateJobs', () => {
  it('merges duplicates without losing source provenance', () => {
    const result = deduplicateJobs([job('one', '1'), job('two', '2')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.sourceReferences).toHaveLength(2);
    expect(result[0]?.skills.sort()).toEqual(['Angular', 'TypeScript']);
    expect(result[0]?.normalizationWarnings?.[0]).toContain('zusammengeführt');
    expect(result[0]?.fieldProvenance?.description).toMatchObject({ sourceId: 'two', strategy: 'longest_non_empty' });
    expect(result[0]?.mergeHistory?.[0]?.sourceIds).toEqual(['one', 'two']);
  });

  it('keeps semantically different jobs separate', () => {
    const second = job('two', '2'); second.title = 'Product Manager';
    expect(deduplicateJobs([job('one', '1'), second])).toHaveLength(2);
  });
});
