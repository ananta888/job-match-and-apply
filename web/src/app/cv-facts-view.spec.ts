import { describe, expect, it } from 'vitest';
import { cvFactViewLabel, groupCvFactRecords, isCvDetailField, cvFactGroupIsRaw, cvFactIsSensitive } from './cv-facts-view';
import type { CvFact } from './models';

const fact = (overrides: Partial<CvFact>): CvFact => ({
  id: overrides.id ?? 'fact-1', category: 'employment', recordId: 'record-1', field: 'role',
  value: 'Entwicklung', decision: 'pending',
  provenance: { sourceSha256: 'a'.repeat(64), anchor: 'Zeile 1', origin: 'imported' },
  ...overrides,
});

describe('cv-facts-view', () => {
  it('groups by category:recordId and never merges the same recordId across categories', () => {
    const records = groupCvFactRecords([
      fact({ id: 'a', recordId: 'job-1', field: 'role', value: 'Entwicklung' }),
      fact({ id: 'b', recordId: 'job-1', category: 'education', field: 'institution', value: 'Schule' }),
      fact({ id: 'c', recordId: 'job-1', field: 'company', value: 'Beispiel GmbH' }),
    ]);
    expect(records).toHaveLength(2);
    const employment = records.find((record) => record.category === 'employment')!;
    expect(employment.facts.map((item) => item.id)).toEqual(['a', 'c']);
    expect(records.find((record) => record.category === 'education')!.facts.map((item) => item.id)).toEqual(['b']);
  });

  it('uses readable station titles instead of record hashes and keeps exact periods', () => {
    const records = groupCvFactRecords([
      fact({ id: 'a', recordId: 'rec-hash-1', field: 'start_date', value: '2024-03' }),
      fact({ id: 'b', recordId: 'rec-hash-2', field: 'role', value: 'Entwicklung', category: 'employment' }),
    ]);
    const untitled = records.find((record) => record.recordId === 'rec-hash-1')!;
    expect(untitled.title).toBe('Berufsstation 1');
    expect(untitled.period).toBe('2024-03 – heute');
    expect(records.find((record) => record.recordId === 'rec-hash-2')!.title).toBe('Entwicklung');
  });

  it('labels contact fields, task lines and unknown fields without data-model knowledge', () => {
    expect(cvFactViewLabel('contact.email', 'contact')).toBe('E-Mail');
    expect(cvFactViewLabel('details[2]', 'employment')).toBe('Tätigkeit');
    expect(cvFactViewLabel('employment_type', 'employment')).toBe('Beschäftigungsart');
    expect(cvFactViewLabel('custom_field', 'additional')).toBe('Custom field');
    expect(cvFactViewLabel('name', 'skill')).toBe('Fähigkeit');
    expect(isCvDetailField('details[3]')).toBe(true);
    expect(isCvDetailField('details')).toBe(false);
  });

  it('keeps raw groups detectable and masks identity/contact facts by default', () => {
    expect(cvFactGroupIsRaw({ recordId: 'r', category: 'additional', facts: [fact({})], title: 'x' })).toBe(true);
    expect(cvFactGroupIsRaw({ recordId: 'r', category: 'employment', facts: [fact({ field: 'other' })], title: 'x' })).toBe(true);
    expect(cvFactIsSensitive(fact({ category: 'contact', field: 'email' }))).toBe(true);
    expect(cvFactIsSensitive(fact({ category: 'profile', field: 'full_name' }))).toBe(true);
    expect(cvFactIsSensitive(fact({ field: 'role' }))).toBe(false);
  });
});
